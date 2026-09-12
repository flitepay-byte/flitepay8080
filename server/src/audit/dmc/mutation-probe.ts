/**
 * MUTATION PROBE — is the reconciler capable of failing?
 *
 * A clean audit means one of two things: the books are right, or the checks
 * cannot see what is wrong with them. Nothing so far distinguishes those, and
 * a reconciler that always passes is worse than none because it manufactures
 * confidence.
 *
 * So: build a healthy world, verify it reconciles, then corrupt the database
 * one way at a time — each corruption standing for a real failure the system
 * could suffer — and assert the reconciler *catches* it. A corruption that
 * slips through is a blind spot, and the blind spot is the finding.
 *
 * Note that Commission enforces immutability at the schema layer — every
 * update and delete is refused with "post a correcting entry instead" — so the
 * commission mutations here go through the raw driver, which is the only way a
 * real corruption could reach them.
 *
 * The corruptions are deliberately chosen to mirror partial failures that are
 * genuinely possible here: this deployment has no MongoDB transactions (single
 * node), so every multi-step money operation can in principle be interrupted
 * between its steps. Each mutation below is one of those interruptions frozen
 * in place.
 */
process.env['LOG_LEVEL'] = 'silent';
import mongoose, { Types } from 'mongoose';
import { startMiniRedis } from '../mini-redis';
import { Party, Captain, Task, Commission, DMCAllocation, PlatformAccount, WalletEntry, DmcRedemption } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { supportsTransactions } from '../../config/db';
import { rupeesToPaise } from '../../utils/money';
import { World, type PartyRef, type CaptainRef } from './driver';
import { reconcile } from './reconcile';
import { deepReconcile } from './deep-reconcile';
import { ExpectedLedger } from './model';

const DB = 'mongodb://127.0.0.1:27017/otdms_mutation_probe';

interface Mutation {
  name: string;
  /** Stands for this real-world partial failure. */
  standsFor: string;
  apply: (ctx: Ctx) => Promise<void>;
}

interface Ctx {
  party: PartyRef;
  captain: CaptainRef;
  otherCaptain: CaptainRef;
  otherParty: PartyRef;
  completedTaskId: string;
  openTaskId: string;
}

async function snapshot(): Promise<string> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('not connected');
  const out: Record<string, unknown[]> = {};
  for (const c of await db.listCollections().toArray()) {
    out[c.name] = await db.collection(c.name).find({}).toArray();
  }
  return JSON.stringify(out);
}

async function restore(json: string): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('not connected');
  const data = JSON.parse(json) as Record<string, unknown[]>;
  for (const [name, docs] of Object.entries(data)) {
    await db.collection(name).deleteMany({});
    if (docs.length > 0) {
      await db.collection(name).insertMany(
        docs.map((d) => reviveDates(d as Record<string, unknown>)) as never[],
      );
    }
  }
}

/** JSON round-trips dates and ObjectIds to strings; put them back. */
function reviveDates(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (typeof v === 'string' && /^[0-9a-f]{24}$/.test(v) && (k === '_id' || k.endsWith('Id'))) {
      out[k] = new Types.ObjectId(v);
    } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      out[k] = new Date(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === 'object' && item !== null
          ? reviveDates(item as Record<string, unknown>)
          : typeof item === 'string' && /^[0-9a-f]{24}$/.test(item)
            ? new Types.ObjectId(item)
            : item,
      );
    } else if (typeof v === 'object' && v !== null) {
      out[k] = reviveDates(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'captain credited but no commission row',
    standsFor: 'a crash between writing the commission and crediting the captain, with no transaction to undo it',
    apply: async (ctx) => {
      await Commission.collection.deleteOne({ taskId: new Types.ObjectId(ctx.completedTaskId) });
    },
  },
  {
    name: 'commission row survives on a task that was reassigned',
    standsFor: 'the stale-commission defect found in the first audit',
    apply: async (ctx) => {
      await Task.updateOne({ _id: ctx.completedTaskId }, { $set: { status: 'REASSIGNED', captainId: null } });
    },
  },
  {
    name: 'commission names a captain who did not do the work',
    standsFor: 'a reassignment crediting the wrong captain — invisible to any total',
    apply: async (ctx) => {
      await Commission.collection.updateOne(
        { taskId: new Types.ObjectId(ctx.completedTaskId) },
        { $set: { captainId: ctx.otherCaptain.id } },
      );
    },
  },
  {
    name: 'commission amount drifts from the task',
    standsFor: 'a rounding or recomputation bug at completion',
    apply: async (ctx) => {
      await Commission.collection.updateOne({ taskId: new Types.ObjectId(ctx.completedTaskId) }, { $inc: { commissionPaise: 1 } });
    },
  },
  {
    name: 'captain wallet credited twice',
    standsFor: 'a retried completion double-crediting the captain',
    apply: async (ctx) => {
      await Captain.updateOne({ _id: ctx.captain.id }, { $inc: { dmcBalancePaise: rupeesToPaise(50) } });
    },
  },
  {
    name: 'party refunded money it was never billed',
    standsFor: 'a double refund on a cancellation',
    apply: async (ctx) => {
      await Party.updateOne({ _id: ctx.party.id }, { $inc: { dmcBalancePaise: rupeesToPaise(500) } });
    },
  },
  {
    name: 'the pool holds more than the commission collected explains',
    standsFor: 'an early credit, or a reversal that should never have run',
    apply: async () => {
      await PlatformAccount.updateOne({ key: 'GLOBAL' }, { $inc: { poolBalancePaise: rupeesToPaise(25) } });
    },
  },
  {
    name: 'collateral appears without a deposit behind it',
    standsFor: 'a lock release crediting collateral instead of unlocking it',
    apply: async (ctx) => {
      await Captain.updateOne({ _id: ctx.captain.id }, { $inc: { collateralBalancePaise: rupeesToPaise(1_000) } });
    },
  },
  {
    name: 'a lock survives the task that justified it',
    standsFor: 'a release that never ran after completion or cancellation',
    apply: async (ctx) => {
      await Captain.updateOne({ _id: ctx.captain.id }, { $inc: { lockedAmountPaise: rupeesToPaise(100) } });
    },
  },
  {
    name: 'an allocation exists for a task still in flight',
    standsFor: 'the platform-commission-at-creation defect found in the first audit',
    apply: async (ctx) => {
      const open = await Task.findById(ctx.openTaskId).lean();
      await DMCAllocation.create({
        ownerType: 'ADMIN',
        ownerId: new Types.ObjectId('000000000000000000000001'),
        sourcePartyId: open?.partyId,
        taskId: open?._id,
        taskCode: open?.taskCode,
        customerName: open?.customerName,
        amountPaise: open?.adminCommissionPaise ?? 100,
        availableAmountPaise: open?.adminCommissionPaise ?? 100,
        sourceTransactionId: open?.taskCode,
      });
    },
  },
  {
    name: 'an allocation is sourced from the wrong party',
    standsFor: 'cross-party leakage — a captain drawing against a party they never worked for',
    apply: async (ctx) => {
      await DMCAllocation.updateOne(
        { taskId: new Types.ObjectId(ctx.completedTaskId), ownerType: 'CAPTAIN' },
        { $set: { sourcePartyId: ctx.otherParty.id } },
      );
    },
  },
  {
    name: 'an allocation amount does not match what the task owed',
    standsFor: 'a captain credited more than the task was worth',
    apply: async (ctx) => {
      await DMCAllocation.updateOne(
        { taskId: new Types.ObjectId(ctx.completedTaskId), ownerType: 'CAPTAIN' },
        { $inc: { amountPaise: rupeesToPaise(10) } },
      );
    },
  },
  {
    name: 'a completed task loses its captain allocation',
    standsFor: 'a crash after crediting the wallet but before writing the allocation',
    apply: async (ctx) => {
      await DMCAllocation.deleteOne({ taskId: new Types.ObjectId(ctx.completedTaskId), ownerType: 'CAPTAIN' });
    },
  },
  {
    name: 'a captain balance drifts from its own ledger',
    standsFor: 'a commission credit that never wrote the entry behind it',
    apply: async (ctx) => {
      // The pool is drained to match, so the closed loop still adds up and
      // only the per-captain rebuild can tell that the entry is missing.
      await Captain.updateOne({ _id: ctx.captain.id }, { $inc: { dmcBalancePaise: rupeesToPaise(250) } });
      await PlatformAccount.updateOne({ key: 'GLOBAL' }, { $inc: { poolBalancePaise: -rupeesToPaise(250) } });
    },
  },
  {
    name: 'commission drains the pool without reaching anybody',
    standsFor: 'the pool debit succeeding and the wallet credit failing after it',
    apply: async () => {
      await PlatformAccount.updateOne({ key: 'GLOBAL' }, { $inc: { poolBalancePaise: -rupeesToPaise(500) } });
    },
  },
  {
    name: 'working capital appears without a deposit or a conversion',
    standsFor: 'a pay-out crediting capital it was never given',
    apply: async (ctx) => {
      await Captain.updateOne({ _id: ctx.captain.id }, { $inc: { dmcBalancePaise: rupeesToPaise(750) } });
    },
  },
  {
    name: 'a paid cash-out hands the DMC back as well as the rupees',
    standsFor: 'a burn that refunded instead of destroying, paying the captain twice',
    apply: async (ctx) => {
      const paid = await DmcRedemption.findOne({ captainId: ctx.captain.id, status: 'PAID' }).lean();
      if (!paid) throw new Error('probe world has no paid cash-out to corrupt');
      await Captain.updateOne({ _id: ctx.captain.id }, { $inc: { dmcBalancePaise: paid.amountPaise } });
    },
  },
  {
    name: 'a wallet entry exists for money that never moved',
    standsFor: 'a ledger write that survived a rolled-back credit',
    apply: async (ctx) => {
      await WalletEntry.create({
        captainId: ctx.captain.id,
        kind: 'COMMISSION_EARNED',
        amountPaise: rupeesToPaise(400),
        walletBalanceAfterPaise: rupeesToPaise(400),
      });
    },
  },
  {
    name: 'a task points at a party that does not exist',
    standsFor: 'a dangling reference left by a bad migration or manual edit',
    apply: async (ctx) => {
      await Task.updateOne({ _id: ctx.openTaskId }, { $set: { partyId: new Types.ObjectId() } });
    },
  },
  {
    name: 'a captain is both holding a task and excluded from it',
    standsFor: 'a reassignment that failed halfway through',
    apply: async (ctx) => {
      await Task.updateOne({ _id: ctx.openTaskId }, { $set: { captainId: ctx.captain.id }, $push: { previousCaptainIds: ctx.captain.id } });
    },
  },
];

async function main(): Promise<void> {
  await startMiniRedis();
  await mongoose.connect(DB);
  const db = mongoose.connection.db;
  if (db) for (const c of await db.listCollections().toArray()) await db.collection(c.name).deleteMany({});
  await ensureSystemConfig();

  const transactional = await supportsTransactions();
  console.log(`MongoDB transactions available : ${transactional}`);
  if (!transactional) {
    console.log('  -> every multi-step money operation can be interrupted between steps,');
    console.log('     so the mutations below are reachable states, not hypotheticals.\n');
  }

  await updateConfig(
    {
      payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5,
      payInPartyCommissionPercentage: 3, payInCaptainCommissionPercentage: 1,
      partyDailyLimitPaise: 900_000_000_000, partyMonthlyLimitPaise: 9_000_000_000_000,
      captainDailyLimitPaise: 900_000_000_000, captainMonthlyLimitPaise: 9_000_000_000_000,
    },
    new Types.ObjectId(),
  );

  // ---- a small, healthy world ----
  const world = new World();
  await world.createAdmin();
  const party = await world.createParty('Probe Party', 1_000_000);
  const otherParty = await world.createParty('Probe Party Two', 1_000_000);
  const captain = await world.createCaptain('Probe Captain');
  const otherCaptain = await world.createCaptain('Probe Captain Two');
  await world.postCollateral(captain, 500_000);
  await world.postCollateral(otherCaptain, 500_000);

  // The new model's money has to be present in the healthy world, or the
  // corruptions below would be mutating balances nothing ever touches — which
  // proves nothing about whether a real drift would be caught.
  await world.fundPool(20_000);
  await world.payCommission(captain, 3_000);
  await world.cashOut(captain, 2_000, 'PAY');
  await world.cashOut(captain, 500, 'REJECT');

  const completedTaskId = await world.completeTask(party, captain, 5_000);
  const openTask = await world.createTask(party, 3_000);
  const openTaskId = String(openTask._id);
  await world.completeTask(otherParty, otherCaptain, 2_000);

  const ctx: Ctx = { party, captain, otherCaptain, otherParty, completedTaskId, openTaskId };

  // Baseline: the healthy world must reconcile, or nothing below means anything.
  const baseFlat = await reconcile(world.ledger);
  const baseDeep = await deepReconcile();
  console.log(`baseline: ${baseFlat.ok ? 'reconciled' : 'DIVERGED'}, ${baseDeep.length} record findings`);
  if (!baseFlat.ok || baseDeep.length > 0) {
    console.log('baseline is not clean; the probe cannot distinguish anything.');
    process.exit(1);
  }

  const clean = await snapshot();
  // Every part of it, not some of it. An earlier version restored four of
  // the ledger's parts and left the rest, so a mutation that moved a captain's
  // DMC or the pool left the model dirty for every mutation after it — and the
  // probe was then measuring the previous round's damage.
  const ledgerSnapshot = JSON.stringify({
    partyDmc: [...world.ledger.partyDmc],
    captainCollateral: [...world.ledger.captainCollateral],
    captainDmc: [...world.ledger.captainDmc],
    captainLocked: [...world.ledger.captainLocked],
    platformPool: world.ledger.platformPool,
    redemptionHeld: [...world.ledger.redemptionHeld],
    transactionInFlight: [...world.ledger.transactionInFlight],
    inFlight: [...world.ledger.inFlight],
    minted: world.ledger.minted,
  });

  const restoreLedger = (): ExpectedLedger => {
    const snap = JSON.parse(ledgerSnapshot) as {
      partyDmc: Array<[string, number]>; captainCollateral: Array<[string, number]>;
      captainDmc: Array<[string, number]>; captainLocked: Array<[string, number]>;
      platformPool: number; redemptionHeld: Array<[string, number]>;
      transactionInFlight: Array<[string, number]>;
      inFlight: Array<[string, number]>; minted: number;
    };
    const l = world.ledger;
    const reload = (m: Map<string, number>, rows: Array<[string, number]>): void => {
      m.clear();
      for (const [k, v] of rows) m.set(k, v);
    };
    reload(l.partyDmc, snap.partyDmc);
    reload(l.captainCollateral, snap.captainCollateral);
    reload(l.captainDmc, snap.captainDmc);
    reload(l.captainLocked, snap.captainLocked);
    reload(l.redemptionHeld, snap.redemptionHeld);
    reload(l.transactionInFlight, snap.transactionInFlight);
    reload(l.inFlight, snap.inFlight);
    l.platformPool = snap.platformPool;
    l.minted = snap.minted;
    return l;
  };

  console.log('\n--- mutations ---');
  const undetected: Mutation[] = [];
  for (const m of MUTATIONS) {
    await restore(clean);
    restoreLedger();
    await m.apply(ctx);

    const flat = await reconcile(world.ledger);
    const deep = await deepReconcile();
    const caught = !flat.ok || deep.length > 0;
    const by = !flat.ok && deep.length > 0 ? 'both' : !flat.ok ? 'balance' : 'records';
    console.log(`  ${caught ? 'caught ' : 'MISSED '} [${caught ? by : '—'}] ${m.name}`);
    if (!caught) undetected.push(m);
  }

  await restore(clean);
  restoreLedger();

  console.log(`\n${MUTATIONS.length - undetected.length}/${MUTATIONS.length} corruptions detected`);
  if (undetected.length > 0) {
    console.log('\nBLIND SPOTS — these corruptions reconcile cleanly:');
    for (const m of undetected) console.log(`  - ${m.name}\n      stands for: ${m.standsFor}`);
  }

  if (db) await db.dropDatabase();
  await mongoose.disconnect();
  process.exit(undetected.length === 0 ? 0 : 1);
}

main().catch(async (err: unknown) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
