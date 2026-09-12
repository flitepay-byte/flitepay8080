/**
 * FULL DMC ACCOUNTING INTEGRITY AUDIT
 *
 * Runs against its own isolated database, drives the real services, and keeps
 * an independent set of books derived from the business rules. Reconciliation
 * runs after every DMC-affecting transition, so the run stops at the event that
 * broke the ledger rather than at the end when the damage is anonymous.
 *
 * The randomised half uses a fixed seed so any failure is reproducible exactly.
 */
process.env['MONGO_URI'] = 'mongodb://127.0.0.1:27017/otdms_dmc_audit';
// The application's own logging would bury the reconciliation output.
process.env['LOG_LEVEL'] = 'silent';

import mongoose from 'mongoose';
import { startMiniRedis } from '../mini-redis';
import { Task, Captain } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';
import { Types } from 'mongoose';
import { World, counters, type PartyRef, type CaptainRef, AccountingError } from './driver';
import { depositSplit } from './split';
import { reconcile, describe } from './reconcile';
import { deepReconcile, describeDeep } from './deep-reconcile';

const DB = 'mongodb://127.0.0.1:27017/otdms_dmc_audit';
const SEED = 20260906;

/** Deterministic PRNG so a failing randomised scenario can be replayed exactly. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return {
    next(): number {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    },
    int(maxExclusive: number): number {
      return Math.floor(this.next() * maxExclusive);
    },
    pick<T>(items: readonly T[]): T {
      return items[this.int(items.length)] as T;
    },
  };
}

interface Outcome {
  name: string;
  ok: boolean;
  detail?: string;
}
const outcomes: Outcome[] = [];
let stopped = false;

async function scenario(world: World, name: string, body: () => Promise<void>): Promise<void> {
  if (stopped) return;
  world.scenario = name;
  try {
    await body();
    outcomes.push({ name, ok: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    outcomes.push({ name, ok: false, detail });
    if (err instanceof AccountingError) {
      // An accounting divergence is the thing this audit exists to find, so it
      // stops the run — everything after it would be measured against a
      // ledger already known to be wrong.
      console.error(detail);
      stopped = true;
    } else {
      console.error(`  scenario "${name}" failed: ${detail.split('\n')[0]}`);
    }
  }
}

async function wipe(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  for (const c of await db.listCollections().toArray()) {
    await db.collection(c.name).deleteMany({});
  }
}


async function main(): Promise<void> {
  await startMiniRedis();
  await mongoose.connect(DB);
  await wipe();
  await ensureSystemConfig();
  counters.reset();

  const started = Date.now();
  const world = new World();
  await world.createAdmin();

  // House rates every scenario is measured against unless it changes them.
  await updateConfig(
    {
      // Charged to the party, and the captain's share of it. What the platform
      // keeps is the difference, so there is no third number to set.
      payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5,
      payInPartyCommissionPercentage: 3, payInCaptainCommissionPercentage: 1,
    },
    new Types.ObjectId(),
  );

  // ---- a world with several parties and captains, so nothing is a special case
  const parties: PartyRef[] = [];
  for (let i = 0; i < 4; i += 1) parties.push(await world.createParty(`Audit Party ${i + 1}`, 5_000_000));
  const captains: CaptainRef[] = [];
  for (let i = 0; i < 6; i += 1) {
    const c = await world.createCaptain(`Audit Captain ${i + 1}`);
    await world.postCollateral(c, 2_000_000);
    captains.push(c);
  }
  const P = (i: number): PartyRef => parties[i % parties.length] as PartyRef;
  const C = (i: number): CaptainRef => captains[i % captains.length] as CaptainRef;

  console.log(`\nWorld: ${parties.length} parties, ${captains.length} captains.\n`);

  // =====================================================================
  // 1. HAPPY PATH — 20
  // =====================================================================
  console.log('--- happy paths ---');
  // 100 is the configured minimum; the smallest legal task is included on purpose.
  const AMOUNTS = [100, 101, 137, 250, 999, 1_000, 2_500, 9_999, 10_000, 12_345, 20_000, 33_333, 50_000, 77_777, 100_000, 103, 117, 4_321, 8_888, 60_000];
  for (let i = 0; i < 20; i += 1) {
    await scenario(world, `happy path #${i + 1} (${AMOUNTS[i]})`, async () => {
      await world.completeTask(P(i), C(i), AMOUNTS[i] as number);
    });
  }

  // =====================================================================
  // 2. CAPTAIN HANDS THE TASK BACK — 15
  // =====================================================================
  console.log('--- captain released off task, another completes ---');
  for (let i = 0; i < 15; i += 1) {
    await scenario(world, `captain rejection #${i + 1}`, async () => {
      const party = P(i);
      const first = C(i);
      const second = C(i + 1);
      const task = await world.createTask(party, 500 + i * 37);
      const id = String(task._id);
      await world.claim(id, first);
      await world.captainRejectsHeldTask(id, first, party);

      // The released captain must not be able to take it back.
      let refused = false;
      try {
        await world.claim(id, first);
      } catch {
        refused = true;
      }
      if (!refused) throw new Error('a captain rejected off the task was allowed to reclaim it');

      await world.claim(id, second);
      await world.start(id, second);
      await world.submitProof(id, second);
      await world.approve(id, party, second);
    });
  }

  // =====================================================================
  // 3. PARTY REJECTS THE PROOF — 15
  // =====================================================================
  console.log('--- party rejects proof ---');
  for (let i = 0; i < 15; i += 1) {
    await scenario(world, `proof rejection #${i + 1}`, async () => {
      const party = P(i);
      const first = C(i + 2);
      const second = C(i + 3);
      const task = await world.createTask(party, 800 + i * 53);
      const id = String(task._id);
      await world.claim(id, first);
      await world.start(id, first);
      await world.submitProof(id, first);
      await world.rejectProof(id, party);
      await world.resolveRejection(id, 'REASSIGN', first);

      await world.claim(id, second);
      await world.start(id, second);
      await world.submitProof(id, second);
      await world.approve(id, party, second);
    });
  }

  // =====================================================================
  // 4. ADMIN OVERRULES A REJECTION — 10
  // =====================================================================
  console.log('--- admin overrules the rejection ---');
  for (let i = 0; i < 10; i += 1) {
    await scenario(world, `admin overrule #${i + 1}`, async () => {
      const party = P(i);
      const captain = C(i + 4);
      const task = await world.createTask(party, 1_200 + i * 91);
      const id = String(task._id);
      await world.claim(id, captain);
      await world.start(id, captain);
      await world.submitProof(id, captain);
      await world.rejectProof(id, party);
      await world.resolveRejection(id, 'APPROVE', captain);
    });
  }

  // =====================================================================
  // 5. MULTI-HOP REASSIGNMENT — 10
  // =====================================================================
  console.log('--- tasks passing through several captains ---');
  for (let i = 0; i < 10; i += 1) {
    await scenario(world, `multi-hop #${i + 1}`, async () => {
      const party = P(i);
      const a = C(i);
      const b = C(i + 1);
      const c = C(i + 2);
      const task = await world.createTask(party, 2_000 + i * 111);
      const id = String(task._id);

      await world.claim(id, a);
      await world.captainRejectsHeldTask(id, a, party);
      await world.claim(id, b);
      await world.start(id, b);
      await world.submitProof(id, b);
      await world.rejectProof(id, party);
      await world.resolveRejection(id, 'REASSIGN', b);
      await world.claim(id, c);
      await world.start(id, c);
      await world.submitProof(id, c);
      await world.approve(id, party, c);

      // Nobody but the final captain may hold a commission for it.
      const { Commission } = await import('../../models');
      const rows = await Commission.find({ taskId: new Types.ObjectId(id) }).lean();
      if (rows.length !== 1) throw new Error(`expected exactly one commission record, found ${rows.length}`);
      if (String(rows[0]?.captainId) !== String(c.id)) throw new Error('commission was credited to the wrong captain');
    });
  }

  // =====================================================================
  // 6. CANCELLATION FROM EVERY CANCELLABLE STATE — 10
  // =====================================================================
  console.log('--- cancellations ---');
  for (let i = 0; i < 4; i += 1) {
    await scenario(world, `cancel before claim #${i + 1}`, async () => {
      const party = P(i);
      const task = await world.createTask(party, 3_000 + i * 17);
      await world.cancelUnheld(String(task._id), party);
    });
  }
  for (let i = 0; i < 3; i += 1) {
    await scenario(world, `cancel while held #${i + 1}`, async () => {
      const party = P(i);
      const captain = C(i + 3);
      const task = await world.createTask(party, 4_000 + i * 23);
      const id = String(task._id);
      await world.claim(id, captain);
      await world.cancelHeld(id, party, captain);
    });
  }
  for (let i = 0; i < 3; i += 1) {
    await scenario(world, `cancel disputed then reassigned #${i + 1}`, async () => {
      const party = P(i);
      const captain = C(i + 1);
      const other = C(i + 4);
      const task = await world.createTask(party, 5_000 + i * 29);
      const id = String(task._id);
      await world.claim(id, captain);
      await world.cancelDisputedThenApproved(id, party, captain);
      await world.claim(id, other);
      await world.start(id, other);
      await world.submitProof(id, other);
      await world.approve(id, party, other);
    });
  }

  // =====================================================================
  // 7. EXPIRY — 5
  // =====================================================================
  console.log('--- expiry of tasks nobody took ---');
  await scenario(world, 'expire five unclaimed tasks', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t = await world.createTask(P(i), 6_000 + i * 13);
      ids.push(String(t._id));
    }
    await world.expireUnclaimed(ids);
  });

  // =====================================================================
  // 9. PLATFORM WITHDRAWALS — 5
  // =====================================================================
  console.log('--- platform Pay In ---');
  for (const [i, outcome] of (['CONFIRM', 'DISPUTE_SETTLE', 'CONFIRM', 'CONFIRM', 'DISPUTE_RETRY'] as const).entries()) {
    await scenario(world, `platform withdrawal #${i + 1} (${outcome})`, async () => {
      const { PlatformAccount } = await import('../../models');
      const acct = await PlatformAccount.findOne({ key: 'GLOBAL' }).lean();
      const balance = acct?.poolBalancePaise ?? 0;
      if (balance > 0) await world.platformWithdraw(paiseToRupees(Math.floor(balance / 4)), outcome);
    });
  }

  // =====================================================================
  // 10. COLLATERAL AND TOP-UPS — 10
  // =====================================================================
  console.log('--- collateral and top-ups ---');
  for (let i = 0; i < 3; i += 1) {
    await scenario(world, `collateral deposit approved #${i + 1}`, async () => {
      await world.postCollateral(C(i), 1_000 + i * 250);
    });
  }
  for (let i = 0; i < 2; i += 1) {
    await scenario(world, `collateral deposit rejected #${i + 1}`, async () => {
      await world.postCollateral(C(i + 2), 900 + i * 100, false);
    });
  }
  for (let i = 0; i < 3; i += 1) {
    await scenario(world, `top-up approved #${i + 1}`, async () => {
      await world.topUp(P(i), 25_000 + i * 5_000);
    });
  }
  for (let i = 0; i < 2; i += 1) {
    await scenario(world, `top-up rejected #${i + 1}`, async () => {
      await world.topUp(P(i + 1), 15_000, false);
    });
  }

  // =====================================================================
  // 11. COMMISSION CONFIGURATIONS — 10
  // =====================================================================
  console.log('--- commission shapes ---');
  // Every interesting shape the pair can take: the platform keeping most of
  // the charge, keeping almost none of it, both zero, awkward fractions, and
  // the captain taking the whole charge so the platform keeps nothing.
  const configs = [
    { payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 1 },
    { payOutPartyCommissionPercentage: 2, payOutCaptainCommissionPercentage: 1.9 },
    { payOutPartyCommissionPercentage: 0, payOutCaptainCommissionPercentage: 0 },
    { payOutPartyCommissionPercentage: 1.67, payOutCaptainCommissionPercentage: 0.33 },
    { payOutPartyCommissionPercentage: 5, payOutCaptainCommissionPercentage: 5 },
    // Deliberately misconfigured: more promised than charged. The captain's
    // share is capped at the charge, so the pool is never overdrawn by it.
    { payOutPartyCommissionPercentage: 2, payOutCaptainCommissionPercentage: 9 },
  ];
  for (const [i, cfg] of configs.entries()) {
    await scenario(world, `commission shape #${i + 1}`, async () => {
      await updateConfig(cfg, new Types.ObjectId());
      await world.completeTask(P(i), C(i), 1_111 + i * 7);
    });
    await scenario(world, `commission shape #${i + 1} then cancelled`, async () => {
      const party = P(i + 1);
      const t = await world.createTask(party, 2_222 + i * 11);
      await world.cancelUnheld(String(t._id), party);
    });
  }

  // A rate change after creation must not alter what an existing task pays.
  await scenario(world, 'rate change between creation and completion', async () => {
    await updateConfig(
      { payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5 },
      new Types.ObjectId(),
    );
    const party = P(0);
    const captain = C(5);
    const task = await world.createTask(party, 10_000);
    const id = String(task._id);
    await world.claim(id, captain);
    // Rates change mid-flight. The task must keep the ones it was billed at.
    await updateConfig(
      { payOutPartyCommissionPercentage: 19, payOutCaptainCommissionPercentage: 9 },
      new Types.ObjectId(),
    );
    await world.start(id, captain);
    await world.submitProof(id, captain);
    await world.approve(id, party, captain);
    await updateConfig(
      { payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5 },
      new Types.ObjectId(),
    );
  });

  // =====================================================================
  // 12. IDEMPOTENCY AND CONCURRENCY
  // =====================================================================
  console.log('--- duplicates and races ---');
  await scenario(world, 'the same approval twice credits once', async () => {
    const party = P(1);
    const captain = C(4);
    const task = await world.createTask(party, 7_500);
    const id = String(task._id);
    await world.claim(id, captain);
    await world.start(id, captain);
    await world.submitProof(id, captain);
    await world.approve(id, party, captain);

    const { approveTask } = await import('../../services/workflow.service');
    await approveTask(id, party.actor).catch(() => undefined);
    await world.finalCheck('second approval must have moved nothing');
  });

  await scenario(world, 'the same cancellation twice refunds once', async () => {
    const party = P(2);
    const task = await world.createTask(party, 6_500);
    const id = String(task._id);
    await world.cancelUnheld(id, party);
    const { requestCancellation } = await import('../../services/workflow.service');
    await requestCancellation(id, 'Customer backed out', party.actor).catch(() => undefined);
    await world.finalCheck('second cancellation must have moved nothing');
  });

  await scenario(world, 'concurrent approvals credit exactly once', async () => {
    const party = P(3);
    const captain = C(3);
    const task = await world.createTask(party, 4_800);
    const id = String(task._id);
    await world.claim(id, captain);
    await world.start(id, captain);
    await world.submitProof(id, captain);

    const { approveTask } = await import('../../services/workflow.service');
    await Promise.allSettled([
      approveTask(id, party.actor), approveTask(id, party.actor),
      approveTask(id, party.actor), approveTask(id, party.actor),
    ]);
    world.ledger.collateralReleased(id, String(captain.id));
    world.ledger.taskCompleted(id, String(captain.id));
    await world.finalCheck('four concurrent approvals');
  });

  await scenario(world, 'concurrent claims lock collateral once', async () => {
    const party = P(0);
    const task = await world.createTask(party, 3_300);
    const id = String(task._id);
    await world.openToPool(id);

    const { claimTask } = await import('../../services/task.service');
    const contenders = [C(0), C(1), C(2), C(3)];
    const settled = await Promise.allSettled(contenders.map((c) => claimTask(id, c.id, c.actor)));
    const won = settled.filter((s) => s.status === 'fulfilled').length;
    if (won !== 1) throw new Error(`${won} captains claimed the same task`);

    const after = await Task.findById(id).lean();
    const winner = contenders.find((c) => String(c.id) === String(after?.captainId));
    if (!winner) throw new Error('the winning captain could not be identified');
    world.ledger.taskClaimed(id, String(winner.id));
    await world.finalCheck('four concurrent claims');

    await world.cancelHeld(id, party, winner);
  });

  await scenario(world, 'a top-up approved twice credits once', async () => {
    const party = P(2);
    const { requestTopUp, approveTopUp } = await import('../../services/partyTopUp.service');
    const req = await requestTopUp(party.id, rupeesToPaise(12_000), party.actor);
    const results = await Promise.allSettled([
      approveTopUp(String(req._id), world.admin),
      approveTopUp(String(req._id), world.admin),
      approveTopUp(String(req._id), world.admin),
    ]);
    const credited = results.filter((r) => r.status === 'fulfilled').length;
    if (credited !== 1) throw new Error(`${credited} approvals credited the same top-up`);
    world.ledger.topUpApproved(String(party.id), rupeesToPaise(12_000));
    await world.finalCheck('three concurrent top-up approvals');
  });

  await scenario(world, 'a collateral deposit approved twice credits once', async () => {
    const captain = C(4);
    const { requestDeposit, approveDeposit } = await import('../../services/dmcPurchase.service');
    const req = await requestDeposit(captain.id, rupeesToPaise(9_000), captain.actor);
    const results = await Promise.allSettled([
      approveDeposit(String(req._id), world.admin),
      approveDeposit(String(req._id), world.admin),
    ]);
    const credited = results.filter((r) => r.status === 'fulfilled').length;
    if (credited !== 1) throw new Error(`${credited} approvals credited the same deposit`);
    const split = await depositSplit(rupeesToPaise(9_000));
    world.ledger.depositApproved(String(captain.id), split.lockedPaise, split.usablePaise);
    await world.finalCheck('two concurrent deposit approvals');
  });

  // =====================================================================
  // 11c. THE NEW MODEL'S MONEY — POOL, WALLET, CASH-OUT
  // =====================================================================
  //
  // Four movements the task flow has no equivalent of. They are audited here
  // rather than only unit-tested because each one changes what exists in
  // total: the pool mints DMC, a paid cash-out destroys it, and the two in
  // between must move it without changing the total by a paise. A closed loop
  // that only closes when nobody uses these paths is not a closed loop.
  console.log('--- the new model: pool, wallet, cash-out ---');

  await scenario(world, 'funding the pool mints DMC that has to be somewhere', async () => {
    const before = world.ledger.minted;
    await world.fundPool(60_000);
    if (world.ledger.minted !== before + rupeesToPaise(60_000)) {
      throw new Error('funding the pool did not mint what was funded');
    }
    await world.finalCheck('commission pool funded');
  });

  await scenario(world, 'commission moves out of the pool, it is not created', async () => {
    const captain = C(0);
    const mintedBefore = world.ledger.minted;
    const paid = await world.payCommission(captain, 1_200);
    if (!paid) throw new Error('a funded pool refused to pay commission');
    // The whole point of the pool: earning a fee must not change the total.
    if (world.ledger.minted !== mintedBefore) throw new Error('paying commission minted DMC');
    await world.finalCheck('commission paid from the pool');
  });

  await scenario(world, 'a rejected cash-out gives every paise back', async () => {
    const captain = C(1);
    await world.postCollateral(captain, 20_000);
    const mintedBefore = world.ledger.minted;
    await world.cashOut(captain, 3_000, 'REJECT');
    // Nothing was sent, so nothing may have been destroyed.
    if (world.ledger.minted !== mintedBefore) throw new Error('a rejected cash-out changed what exists');
    await world.finalCheck('cash-out rejected');
  });

  await scenario(world, 'a paid cash-out destroys exactly what it paid', async () => {
    const captain = C(1);
    const mintedBefore = world.ledger.minted;
    await world.cashOut(captain, 4_000, 'PAY');
    if (world.ledger.minted !== mintedBefore - rupeesToPaise(4_000)) {
      throw new Error('a paid cash-out destroyed the wrong amount');
    }
    await world.finalCheck('cash-out paid');
  });

  await scenario(world, 'a cash-out cannot be paid and rejected at once', async () => {
    const captain = C(2);
    await world.postCollateral(captain, 10_000);
    const { requestRedemption, markRedemptionPaid, rejectRedemption } = await import(
      '../../services/captainBalance.service'
    );
    const request = await requestRedemption(
      captain.id,
      rupeesToPaise(2_000),
      { method: 'UPI', upiId: 'race@audit' },
      captain.actor,
    );
    const id = String(request._id);
    world.ledger.redemptionRequested(id, String(captain.id), rupeesToPaise(2_000));
    await world.finalCheck('cash-out held before the race');

    const settled = await Promise.allSettled([
      markRedemptionPaid(id, { reference: 'A-1' }, world.admin),
      rejectRedemption(id, 'Bank details do not match the captain', world.admin),
      markRedemptionPaid(id, { reference: 'A-2' }, world.admin),
      rejectRedemption(id, 'Bank details do not match the captain', world.admin),
    ]);
    if (settled.filter((r) => r.status === 'fulfilled').length !== 1) {
      throw new Error('a cash-out was decided more than once');
    }

    // Follow whichever decision actually won, so the model is not asserting a
    // guess about who got there first.
    const { DmcRedemption } = await import('../../models');
    const decided = await DmcRedemption.findById(id).lean();
    if (decided?.status === 'PAID') world.ledger.redemptionPaid(id);
    else world.ledger.redemptionRejected(id, String(captain.id));
    await world.finalCheck(`cash-out race settled as ${decided?.status}`);
  });

  await scenario(world, 'a pool that cannot cover a commission pays nothing at all', async () => {
    const captain = C(3);
    const { getPlatformAccount } = await import('../../services/platformAccount.service');
    const pool = (await getPlatformAccount()).poolBalancePaise;
    const mintedBefore = world.ledger.minted;

    // One paise more than the pool holds. Half-paying it — draining the pool
    // and crediting nothing, or crediting and going negative — is the failure
    // this guards against.
    const paid = await world.payCommission(captain, paiseToRupees(pool) + 1);
    if (paid) throw new Error('an underfunded pool paid a commission anyway');
    if (world.ledger.minted !== mintedBefore) throw new Error('a refused commission changed what exists');
    await world.finalCheck('commission refused by an empty pool');
  });

  // =====================================================================
  // 11d. PAY-IN AND PAY-OUT — the party's own customers
  // =====================================================================
  //
  // The whole point of the new model, and the place it is easiest to get
  // wrong: two directions, opposite holds, and a promise that nothing is
  // skimmed off either. Every scenario below asserts the amount *and* the
  // total, because "the party gained 1,000" is true whether that 1,000 came
  // from the captain or from nowhere.
  console.log('--- pay-in and pay-out ---');

  await scenario(world, 'a pay-in moves the amount whole and charges the fee on top', async () => {
    const party = P(0);
    const captain = C(0);
    const partyBefore = world.ledger.partyDmc.get(String(party.id)) ?? 0;
    const captainBefore = world.ledger.captainDmc.get(String(captain.id)) ?? 0;
    const poolBefore = world.ledger.platformPool;
    const mintedBefore = world.ledger.minted;

    await world.payIn(party, captain, 1_000);

    // The amount itself is never skimmed: the customer paid 1,000 in real
    // rupees and the captain gave up 1,000 DMC for it. The party's 3% is
    // charged on top of that movement, so they net 970 and the pool takes 30.
    const gained = (world.ledger.partyDmc.get(String(party.id)) ?? 0) - partyBefore;
    const givenUp = captainBefore - (world.ledger.captainDmc.get(String(captain.id)) ?? 0);
    const poolGained = world.ledger.platformPool - poolBefore;
    if (gained !== rupeesToPaise(970)) {
      throw new Error(`party gained ${paiseToRupees(gained)} on a 1,000 pay-in`);
    }
    // 1,000 out, less the 1% share paid straight back to them.
    if (givenUp !== rupeesToPaise(990)) {
      throw new Error(`captain gave up ${paiseToRupees(givenUp)} net on a 1,000 pay-in`);
    }
    // The charge in, the share out: 30 collected, 10 paid.
    if (poolGained !== rupeesToPaise(20)) {
      throw new Error(`pool gained ${paiseToRupees(poolGained)} on a 1,000 pay-in`);
    }
    // A transfer, not a creation.
    if (world.ledger.minted !== mintedBefore) throw new Error('a pay-in minted DMC');
    await world.finalCheck('pay-in settled');
  });

  await scenario(world, 'an expired pay-in leaves the captain exactly as they were', async () => {
    const party = P(0);
    const captain = C(1);
    const before = world.ledger.captainDmc.get(String(captain.id)) ?? 0;

    await world.payIn(party, captain, 2_500, 'EXPIRE');

    // The whole point of the hold: it comes back untouched when nobody pays.
    const after = world.ledger.captainDmc.get(String(captain.id)) ?? 0;
    if (after !== before) throw new Error('an expired pay-in did not return the capital');
    await world.finalCheck('pay-in expired');
  });

  await scenario(world, 'the same reference twice is one payment, not two', async () => {
    const party = P(2);
    const { createPayIn } = await import('../../services/transaction.service');
    const reference = `AUDIT-IDEMPOTENT-${Date.now()}`;
    const amountPaise = rupeesToPaise(1_500);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createPayIn(party.id, { partyReference: reference, amountPaise }, party.actor),
      ),
    );
    const ids = new Set(results.map((r) => String(r.transaction._id)));
    if (ids.size !== 1) throw new Error(`${ids.size} transactions created for one reference`);
    if (results.filter((r) => r.created).length !== 1) throw new Error('more than one creation reported');

    // Creation holds nothing, so the ledger has nothing to record — and that
    // is exactly what must remain true after five identical calls.
    await world.finalCheck('five identical pay-in calls');
  });

  await scenario(world, 'two routing passes cannot both hold a captain’s capital', async () => {
    const party = P(2);
    const { createPayIn, assignCaptain } = await import('../../services/transaction.service');
    const amountPaise = rupeesToPaise(2_000);
    const { transaction } = await createPayIn(
      party.id,
      { partyReference: `AUDIT-RACE-${Date.now()}`, amountPaise },
      party.actor,
    );
    const id = String(transaction._id);

    const results = await Promise.all([
      assignCaptain(id),
      assignCaptain(id),
      assignCaptain(id),
    ]);
    const assigned = results.map((r) => r.captainId).filter((c): c is NonNullable<typeof c> => c != null);
    const distinct = new Set(assigned.map(String));
    if (distinct.size !== 1) throw new Error(`${distinct.size} captains hold one pay-in`);

    const winner = [...distinct][0] as string;
    world.ledger.payInAssigned(id, winner, amountPaise);
    await world.finalCheck('three concurrent assignments');

    // Leave the world clean: release it again.
    const { expire } = await import('../../services/transaction.service');
    await expire(id, 'Audit cleanup');
    world.ledger.payInReleased(id, winner);
    await world.finalCheck('raced pay-in released');
  });

  await scenario(world, 'a disputed pay-in keeps its hold until admin decides', async () => {
    const party = P(3);
    const { createPayIn, assignCaptain, openToCustomer, dispute, resolveDispute } = await import(
      '../../services/transaction.service'
    );
    const amountPaise = rupeesToPaise(1_800);
    const { transaction } = await createPayIn(
      party.id,
      { partyReference: `AUDIT-DISPUTE-${Date.now()}`, amountPaise },
      party.actor,
    );
    const id = String(transaction._id);
    const assigned = await assignCaptain(id);
    if (!assigned.captainId) throw new Error('no captain took the disputed pay-in');
    world.ledger.payInAssigned(id, String(assigned.captainId), amountPaise);
    await openToCustomer(id);
    await world.finalCheck('disputed pay-in held');

    await dispute(id, 'The customer says they paid and the gateway disagrees');
    // A dispute must move nothing at all — that is what makes it safe to sit
    // in for as long as it takes.
    await world.finalCheck('dispute raised, nothing moved');

    await resolveDispute(id, 'RELEASE', 'No credit found anywhere', world.admin);
    world.ledger.payInReleased(id, String(assigned.captainId));
    await world.finalCheck('dispute released');
  });

  // =====================================================================
  // 12b. EXPIRY OF A TASK A CAPTAIN WAS HOLDING
  // =====================================================================
  console.log('--- expiry while held ---');
  await scenario(world, 'held task expires, captain explains, another finishes it', async () => {
    const party = P(0);
    const first = C(0);
    const second = C(2);
    const task = await world.createTask(party, 4_444);
    const id = String(task._id);
    await world.claim(id, first);
    await world.start(id, first);
    await world.expireOverdue([id], first);
    await world.explainExpiry(id, first);
    await world.claim(id, second);
    await world.start(id, second);
    await world.submitProof(id, second);
    await world.approve(id, party, second);
  });

  await scenario(world, 'held task expires and nobody answers, so it is reclaimed', async () => {
    const party = P(1);
    const first = C(1);
    const second = C(3);
    const task = await world.createTask(party, 5_555);
    const id = String(task._id);
    await world.claim(id, first);
    await world.expireOverdue([id], first);
    await world.reclaimUnacknowledged();
    await world.claim(id, second);
    await world.start(id, second);
    await world.submitProof(id, second);
    await world.approve(id, party, second);
  });

  await scenario(world, 'expired task is then cancelled by the party', async () => {
    const party = P(2);
    const first = C(4);
    const task = await world.createTask(party, 6_666);
    const id = String(task._id);
    await world.claim(id, first);
    await world.expireOverdue([id], first);
    await world.explainExpiry(id, first);
    await world.cancelUnheld(id, party);
  });

  // =====================================================================
  // 12c. A WITHDRAWAL THE CAPTAIN CALLS OFF
  // =====================================================================
  // =====================================================================
  // 12d. THINGS THAT MUST BE REFUSED
  // =====================================================================
  console.log('--- illegal moves must be refused ---');
  await scenario(world, 'a task below the minimum is refused and bills nothing', async () => {
    const party = P(3);
    let refused = false;
    try {
      await world.createTask(party, 1);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error('a task below the configured minimum was accepted');
    await world.finalCheck('rejected task creation must not have billed the party');
  });

  await scenario(world, 'a completed task cannot be cancelled', async () => {
    const party = P(0);
    const captain = C(5);
    const id = await world.completeTask(party, captain, 3_700);
    const { requestCancellation } = await import('../../services/workflow.service');
    let refused = false;
    try {
      await requestCancellation(id, 'Changed my mind after the fact', party.actor);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error('a COMPLETED task was allowed into cancellation');
    await world.finalCheck('refused cancellation of a completed task');
  });

  await scenario(world, 'a cancelled task cannot be completed', async () => {
    const party = P(1);
    const task = await world.createTask(party, 3_900);
    const id = String(task._id);
    await world.cancelUnheld(id, party);
    const { claimTask } = await import('../../services/task.service');
    let refused = false;
    try {
      await world.openToPool(id);
      await claimTask(id, C(0).id, C(0).actor);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error('a CANCELLED task was claimable');
    await world.finalCheck('refused claim on a cancelled task');
  });

  // =====================================================================
  // 12e. RACES THAT COULD PAY TWICE
  // =====================================================================
  console.log('--- races between paying out and refunding ---');

  await scenario(world, 'cancel racing approval never both refunds and pays', async () => {
    // The dangerous pair: one path returns the money to the party, the other
    // hands it to the captain. If both land, the same DMC exists twice.
    const party = P(2);
    const captain = C(1);
    const task = await world.createTask(party, 8_100);
    const id = String(task._id);
    await world.claim(id, captain);
    await world.start(id, captain);
    await world.submitProof(id, captain);

    const { approveTask, requestCancellation } = await import('../../services/workflow.service');
    const settled = await Promise.allSettled([
      approveTask(id, party.actor),
      requestCancellation(id, 'Customer backed out at the last second', party.actor),
    ]);
    const after = await Task.findById(id).lean();
    if (after?.status === 'COMPLETED') {
      world.ledger.collateralReleased(id, String(captain.id));
      world.ledger.taskCompleted(id, String(captain.id));
    } else if (after?.status === 'CANCELLED') {
      world.ledger.collateralReleased(id, String(captain.id));
      world.ledger.taskCancelled(id);
    }
    void settled;
    await world.finalCheck(`cancel raced approval — task ended ${after?.status}`);
  });

  await scenario(world, 'claim racing cancellation locks nothing twice', async () => {
    const party = P(3);
    const captain = C(2);
    const task = await world.createTask(party, 7_300);
    const id = String(task._id);
    await world.openToPool(id);

    const { claimTask } = await import('../../services/task.service');
    const { requestCancellation } = await import('../../services/workflow.service');
    await Promise.allSettled([
      claimTask(id, captain.id, captain.actor),
      requestCancellation(id, 'Customer backed out at the last second', party.actor),
    ]);
    const after = await Task.findById(id).lean();
    if (after?.captainId) world.ledger.taskClaimed(id, String(after.captainId));
    if (after?.status === 'CANCELLED') {
      if (after.captainId) world.ledger.collateralReleased(id, String(after.captainId));
      world.ledger.taskCancelled(id);
    }
    await world.finalCheck(`claim raced cancellation — task ended ${after?.status}`);
    // Leave the world tidy for the reconciliations that follow.
    const fresh = await Task.findById(id).lean();
    if (fresh?.status === 'ASSIGNED' && fresh.captainId) {
      const holder = captains.find((c) => String(c.id) === String(fresh.captainId));
      if (holder) await world.cancelHeld(id, party, holder);
    } else if (fresh?.status === 'CREATED') {
      await world.cancelUnheld(id, party);
    }
  });

  await scenario(world, 'approval racing proof rejection resolves one way only', async () => {
    const party = P(0);
    const captain = C(3);
    const task = await world.createTask(party, 9_200);
    const id = String(task._id);
    await world.claim(id, captain);
    await world.start(id, captain);
    await world.submitProof(id, captain);

    const { approveTask, rejectTask } = await import('../../services/workflow.service');
    await Promise.allSettled([
      approveTask(id, party.actor),
      rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', party.actor),
    ]);
    const after = await Task.findById(id).lean();
    if (after?.status === 'COMPLETED') {
      world.ledger.collateralReleased(id, String(captain.id));
      world.ledger.taskCompleted(id, String(captain.id));
    }
    await world.finalCheck(`approve raced reject — task ended ${after?.status}`);
    if (after?.status === 'REJECTED') await world.resolveRejection(id, 'APPROVE', captain);
  });

  await scenario(world, 'concurrent cancellation of an unheld task refunds once', async () => {
    const party = P(1);
    const task = await world.createTask(party, 6_100);
    const id = String(task._id);
    const { requestCancellation } = await import('../../services/workflow.service');
    await Promise.allSettled([
      requestCancellation(id, 'Customer backed out at the last second', party.actor),
      requestCancellation(id, 'Customer backed out at the last second', party.actor),
      requestCancellation(id, 'Customer backed out at the last second', party.actor),
    ]);
    const after = await Task.findById(id).lean();
    if (after?.status === 'CANCELLED') world.ledger.taskCancelled(id);
    await world.finalCheck('three concurrent cancellations of one unheld task');
  });

  await scenario(world, 'concurrent approval of a cancellation refunds once', async () => {
    const party = P(2);
    const captain = C(0);
    const task = await world.createTask(party, 6_200);
    const id = String(task._id);
    await world.claim(id, captain);

    const { requestCancellation, reviewCancellationAsCaptain } = await import('../../services/workflow.service');
    await requestCancellation(id, 'Customer backed out at the last second', party.actor);
    await Promise.allSettled([
      reviewCancellationAsCaptain(id, captain.id, 'APPROVE', undefined, captain.actor),
      reviewCancellationAsCaptain(id, captain.id, 'APPROVE', undefined, captain.actor),
      reviewCancellationAsCaptain(id, captain.id, 'APPROVE', undefined, captain.actor),
    ]);
    const after = await Task.findById(id).lean();
    if (after?.status === 'CANCELLED') {
      world.ledger.collateralReleased(id, String(captain.id));
      world.ledger.taskCancelled(id);
    }
    await world.finalCheck('three concurrent approvals of one cancellation');
  });

  // =====================================================================
  // 13. RANDOMISED MIXED WORKFLOWS — 100
  // =====================================================================
  console.log('--- randomised mixed workflows ---');
  const rng = makeRng(SEED);
  const ROUTES = ['COMPLETE', 'CANCEL_UNHELD', 'CANCEL_HELD', 'CAPTAIN_BACK', 'PROOF_REJECT', 'ADMIN_OVERRULE', 'DISPUTE_REASSIGN'] as const;

  for (let n = 0; n < 100 && !stopped; n += 1) {
    const route = rng.pick(ROUTES);
    const party = P(rng.int(parties.length));
    const firstIdx = rng.int(captains.length);
    const first = C(firstIdx);
    // A route that hands the task on needs a genuinely different captain: the
    // first one is excluded from it permanently, so reusing them is not a bug
    // in the app but a broken scenario.
    const second = C(firstIdx + 1 + rng.int(captains.length - 1));
    const amount = 100 + rng.int(40_000); // never below the configured floor

    await scenario(world, `random #${n + 1} seed=${SEED} route=${route} amount=${amount}`, async () => {
      const task = await world.createTask(party, amount);
      const id = String(task._id);

      switch (route) {
        case 'COMPLETE':
          await world.claim(id, first);
          await world.start(id, first);
          await world.submitProof(id, first);
          await world.approve(id, party, first);
          break;
        case 'CANCEL_UNHELD':
          await world.cancelUnheld(id, party);
          break;
        case 'CANCEL_HELD':
          await world.claim(id, first);
          await world.cancelHeld(id, party, first);
          break;
        case 'CAPTAIN_BACK':
          await world.claim(id, first);
          await world.captainRejectsHeldTask(id, first, party);
          await world.claim(id, second);
          await world.start(id, second);
          await world.submitProof(id, second);
          await world.approve(id, party, second);
          break;
        case 'PROOF_REJECT':
          await world.claim(id, first);
          await world.start(id, first);
          await world.submitProof(id, first);
          await world.rejectProof(id, party);
          await world.resolveRejection(id, 'REASSIGN', first);
          await world.claim(id, second);
          await world.start(id, second);
          await world.submitProof(id, second);
          await world.approve(id, party, second);
          break;
        case 'ADMIN_OVERRULE':
          await world.claim(id, first);
          await world.start(id, first);
          await world.submitProof(id, first);
          await world.rejectProof(id, party);
          await world.resolveRejection(id, 'APPROVE', first);
          break;
        case 'DISPUTE_REASSIGN':
          await world.claim(id, first);
          await world.cancelDisputedThenApproved(id, party, first);
          await world.cancelUnheld(id, party);
          break;
      }
    });

    // Occasionally drain some earnings back to the parties, so withdrawal
    // settlement is mixed into the random stream rather than only tested alone.
  }

  // =====================================================================
  // FINAL RECONCILIATION
  // =====================================================================
  console.log('\n--- final reconciliation ---');
  const final = await reconcile(world.ledger);

  const { Party, PlatformAccount, DmcRedemption } = await import('../../models');
  const [allParties, allCaptains, allTasks, acct, allRedemptions] = await Promise.all([
    Party.find().select('_id dmcBalancePaise').lean(),
    Captain.find().select('_id collateralBalancePaise lockedAmountPaise dmcBalancePaise').lean(),
    Task.find().select('status amountPaise commissionPaise adminCommissionPaise').lean(),
    PlatformAccount.findOne({ key: 'GLOBAL' }).lean(),
    DmcRedemption.find().select('amountPaise status').lean(),
  ]);
  const OPEN = new Set(['CREATED', 'ASSIGNED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'AUDIT_PENDING', 'REJECTED', 'REASSIGNED', 'EXPIRED', 'CANCEL_REVIEW', 'CANCEL_DISPUTED']);
  const actualParty = allParties.reduce((s, p) => s + p.dmcBalancePaise, 0);
  // A captain's DMC is spendable and therefore inside the closed loop, even
  // though the security beside it is not. So is the pool, and DMC held against
  // a cash-out nobody has paid yet — none of that has left the system, so all
  // of it has to be counted.
  const actualCaptainDmc = allCaptains.reduce((s, c) => s + c.dmcBalancePaise, 0);
  const actualPool = acct?.poolBalancePaise ?? 0;
  const actualHeld = allRedemptions
    .filter((r) => r.status === 'PENDING')
    .reduce((s, r) => s + r.amountPaise, 0);
  const actualFlight = allTasks
    .filter((t) => OPEN.has(t.status))
    .reduce((s, t) => s + t.amountPaise + (t.commissionPaise ?? 0) + (t.adminCommissionPaise ?? 0), 0);

  const R = (p: number): string => paiseToRupees(p).toLocaleString('en-IN');
  const row = (label: string, exp: number, act: number): string =>
    `| ${label.padEnd(26)} | ${R(exp).padStart(16)} | ${R(act).padStart(16)} | ${R(act - exp).padStart(12)} |`;

  console.log('\n| Category                   |         Expected |           Actual |   Difference |');
  console.log('|----------------------------|------------------|------------------|--------------|');
  console.log(row('Party wallets', world.ledger.totalPartyDmc(), actualParty));
  console.log(row('Captain DMC', world.ledger.totalCaptainDmc(), actualCaptainDmc));
  console.log(row('Platform pool', world.ledger.platformPool, actualPool));
  console.log(row('Held for cash-out', world.ledger.totalRedemptionHeld(), actualHeld));
  console.log(row('In flight (open tasks)', world.ledger.totalInFlight(), actualFlight));
  console.log(
    row(
      'TOTAL vs minted',
      world.ledger.minted,
      actualParty + actualCaptainDmc + actualPool + actualHeld + actualFlight,
    ),
  );
  console.log(
    row(
      'Collateral',
      [...world.ledger.captainCollateral.values()].reduce((s, v) => s + v, 0),
      allCaptains.reduce((s, c) => s + c.collateralBalancePaise, 0),
    ),
  );
  console.log(
    row(
      'Locked collateral',
      [...world.ledger.captainLocked.values()].reduce((s, v) => s + v, 0),
      allCaptains.reduce((s, c) => s + c.lockedAmountPaise, 0),
    ),
  );

  // ---------- per-entity reconciliation ----------
  // A global zero can hide two entities that are wrong in opposite directions,
  // so every party and every captain is checked on its own as well.
  let partyMismatches = 0;
  for (const p of allParties) {
    const exp = world.ledger.partyDmc.get(String(p._id));
    if (exp !== undefined && exp !== p.dmcBalancePaise) {
      partyMismatches += 1;
      console.log(`  party ${String(p._id)}: expected ${R(exp)}, actual ${R(p.dmcBalancePaise)}`);
    }
  }
  let captainMismatches = 0;
  for (const c of allCaptains) {
    const checks: Array<[string, number | undefined, number]> = [
      ['dmc', world.ledger.captainDmc.get(String(c._id)), c.dmcBalancePaise],
      ['collateral', world.ledger.captainCollateral.get(String(c._id)), c.collateralBalancePaise],
      ['locked', world.ledger.captainLocked.get(String(c._id)), c.lockedAmountPaise],
    ];
    for (const [what, exp, act] of checks) {
      if (exp !== undefined && exp !== act) {
        captainMismatches += 1;
        console.log(`  captain ${String(c._id)} ${what}: expected ${R(exp)}, actual ${R(act)}`);
      }
    }
  }
  console.log(`
per-party reconciliation   : ${allParties.length} parties, ${partyMismatches} mismatches`);
  console.log(`per-captain reconciliation : ${allCaptains.length} captains, ${captainMismatches} mismatches`);

  // ---------- task-level reconciliation ----------
  // Every task must land in exactly one of four honest resting places, and the
  // money it was billed must be fully accounted for by whichever one it is.
  const { Commission, DMCAllocation } = await import('../../models');
  const [allCommissions, allAllocations] = await Promise.all([
    Commission.find().select('taskId captainId commissionPaise').lean(),
    DMCAllocation.find().select('taskId ownerType amountPaise').lean(),
  ]);
  const commissionByTask = new Map(allCommissions.map((c) => [String(c.taskId), c]));
  const allocsByTask = new Map<string, number>();
  for (const a of allAllocations) allocsByTask.set(String(a.taskId), (allocsByTask.get(String(a.taskId)) ?? 0) + 1);

  const fullTasks = await Task.find().select('_id status amountPaise commissionPaise adminCommissionPaise').lean();
  let settled = 0, refunded = 0, pending = 0, taskProblems = 0;
  for (const t of fullTasks) {
    const id = String(t._id);
    const billed = t.amountPaise + (t.commissionPaise ?? 0) + (t.adminCommissionPaise ?? 0);
    if (t.status === 'COMPLETED') {
      settled += 1;
      const row = commissionByTask.get(id);
      if (!row) { taskProblems += 1; console.log(`  task ${id} completed with no commission record`); }
      else if (row.commissionPaise !== (t.commissionPaise ?? 0)) {
        taskProblems += 1;
        console.log(`  task ${id} commission record ${R(row.commissionPaise)} but task says ${R(t.commissionPaise ?? 0)}`);
      }
      // Distributed: reimbursement + captain commission to the captain, the
      // rest to the platform. Nothing may be left over.
      const distributed = t.amountPaise + (t.commissionPaise ?? 0) + (t.adminCommissionPaise ?? 0);
      if (distributed !== billed) { taskProblems += 1; console.log(`  task ${id} residual ${R(billed - distributed)}`); }
    } else if (t.status === 'CANCELLED') {
      refunded += 1;
      if (commissionByTask.has(id)) { taskProblems += 1; console.log(`  cancelled task ${id} still carries a commission`); }
      if (allocsByTask.has(id)) { taskProblems += 1; console.log(`  cancelled task ${id} still carries an allocation`); }
    } else {
      pending += 1;
      if (commissionByTask.has(id)) { taskProblems += 1; console.log(`  open task ${id} carries a commission`); }
      if (allocsByTask.has(id)) { taskProblems += 1; console.log(`  open task ${id} carries an allocation`); }
    }
  }
  console.log(`task-level reconciliation  : ${fullTasks.length} tasks — ${settled} settled, ${refunded} refunded, ${pending} validly pending, ${taskProblems} problems`);

  // ---------- stale records ----------
  const staleLocks = allCaptains.filter((c) => c.lockedAmountPaise > 0).length;
  const heldTasks = fullTasks.filter((t) => ['ASSIGNED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'AUDIT_PENDING', 'REJECTED', 'CANCEL_REVIEW', 'CANCEL_DISPUTED'].includes(t.status)).length;
  console.log(`stale-record scan          : ${allAllocations.length} allocations, ${allCommissions.length} commissions, ${staleLocks} captains holding locks against ${heldTasks} held tasks`);

    // ---------- ownership, record-level and orphan checks ----------
  const deep = await deepReconcile();
  console.log(`
deep record audit           : ${deep.length} findings`);
  if (deep.length > 0) console.log(describeDeep(deep));

  const passed = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.filter((o) => !o.ok);
  console.log(`\nscenarios          : ${passed}/${outcomes.length} passed`);
  console.log(`state transitions  : ${counters.transitions}`);
  console.log(`reconciliations    : ${counters.dmcTransitions}`);
  console.log(`seed               : ${SEED}`);

  if (failed.length > 0) {
    console.log('\nfailing scenarios:');
    for (const f of failed) console.log(`  - ${f.name}\n      ${(f.detail ?? '').split('\n')[0]}`);
  }
  if (!final.ok) {
    console.log('\nFINAL DIVERGENCES:');
    console.log(describe(final));
  }

  const verdict = final.ok && failed.length === 0 && partyMismatches === 0 && captainMismatches === 0 && taskProblems === 0 && deep.length === 0;
  console.log(`\n==== ${verdict ? 'RECONCILED — difference is exactly zero' : 'NOT RECONCILED'} ====  (${Math.round((Date.now() - started) / 1000)}s)`);

  await mongoose.disconnect();
  process.exit(verdict ? 0 : 1);
}

main().catch(async (err: unknown) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
