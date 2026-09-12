/**
 * ADVERSARIAL DMC ROUND
 *
 * The first audit asked "does the ledger balance?". This one assumes it does
 * and goes looking for the ways that could still be true while the books are
 * wrong: money in the right total but the wrong hands, a record that describes
 * a transition that did not happen, a race whose two winners cancel out.
 *
 * Everything here is new: new seeds, new shapes, deliberately hostile
 * orderings. Reconciliation runs after every DMC-affecting transition (via the
 * driver), and the record-level audit — ownership, amounts, orphans, isolation
 * — runs at the end of every database.
 *
 * Run as: tsx src/audit/dmc/adversarial.ts [seed ...]
 */
import mongoose, { Types } from 'mongoose';
import { startMiniRedis } from '../mini-redis';
import {
  Task, Captain, Party, PlatformAccount, Commission, DMCAllocation,
} from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { claimTask } from '../../services/task.service';
import {
  approveTask, rejectTask, requestCancellation, reviewCancellationAsCaptain,
  expireOverdueTasks, expireStaleUnclaimedTasks,
  reclaimUnacknowledgedExpiredTasks, rejectExpiredTask,
} from '../../services/workflow.service';
import { requestTopUp, approveTopUp, rejectTopUp } from '../../services/partyTopUp.service';
import { requestDeposit, approveDeposit, rejectDeposit } from '../../services/dmcPurchase.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';
import { World, counters, type PartyRef, type CaptainRef, AccountingError } from './driver';
import { depositSplit } from './split';
import { reconcile, describe } from './reconcile';
import { deepReconcile, describeDeep } from './deep-reconcile';

const SEEDS = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
const DEFAULT_SEEDS = [20260907, 20260908, 20260909];

function makeRng(seed: number) {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  return {
    next,
    int: (n: number): number => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p: number): boolean => next() < p,
  };
}

interface Tally {
  scenarios: number;
  failures: Array<{ name: string; detail: string }>;
  concurrentRequests: number;
  duplicateRequests: number;
}

export interface RunResult {
  seed: number;
  ok: boolean;
  tally: Tally;
  transitions: number;
  reconciliations: number;
  deepFindings: number;
}

async function runOneDatabase(seed: number): Promise<RunResult> {
  const dbName = `otdms_adv_${seed}`;
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`);
  const db = mongoose.connection.db;
  if (db) {
    for (const c of await db.listCollections().toArray()) await db.collection(c.name).deleteMany({});
  }
  await ensureSystemConfig();
  counters.reset();

  const tally: Tally = { scenarios: 0, failures: [], concurrentRequests: 0, duplicateRequests: 0 };
  let stopped = false;
  const world = new World();
  await world.createAdmin();

  const rng = makeRng(seed);

  const scenario = async (name: string, body: () => Promise<void>): Promise<void> => {
    if (stopped) return;
    world.scenario = `[seed ${seed}] ${name}`;
    tally.scenarios += 1;
    try {
      await body();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      tally.failures.push({ name, detail });
      if (err instanceof AccountingError) {
        console.error(detail);
        stopped = true;
      }
    }
  };

  await updateConfig(
    {
      payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5,
      payInPartyCommissionPercentage: 3, payInCaptainCommissionPercentage: 1,
      // The daily and monthly throughput caps are real rules, and a long
      // randomised run legitimately walks into them. They are raised here so
      // the round tests accounting rather than re-testing the cap; the cap
      // itself gets a scenario of its own below, which is the part that
      // matters for money — that a refusal leaves nothing behind.
      captainDailyLimitPaise: 900_000_000_000,
      captainMonthlyLimitPaise: 9_000_000_000_000,
      partyDailyLimitPaise: 900_000_000_000,
      partyMonthlyLimitPaise: 9_000_000_000_000,
    },
    new Types.ObjectId(),
  );

  // A wider world than the first audit used: more captains, and ceilings that
  // differ from collateral so the claim guard is exercised on both.
  const parties: PartyRef[] = [];
  for (let i = 0; i < 5; i += 1) parties.push(await world.createParty(`Adv Party ${i + 1}`, 8_000_000));
  const captains: CaptainRef[] = [];
  for (let i = 0; i < 8; i += 1) {
    const c = await world.createCaptain(`Adv Captain ${i + 1}`);
    await world.postCollateral(c, 1_000_000 + i * 250_000);
    captains.push(c);
  }
  // Ceilings below collateral for some captains: the limit, not the security,
  // is what the claim guard must honour.
  for (const [i, c] of captains.entries()) {
    if (i % 3 === 0) {
      await Captain.updateOne({ _id: c.id }, { $set: { creditLimitPaise: rupeesToPaise(400_000) } });
    }
  }

  const P = (i: number): PartyRef => parties[Math.abs(i) % parties.length] as PartyRef;
  const C = (i: number): CaptainRef => captains[Math.abs(i) % captains.length] as CaptainRef;

  // ===================================================================
  // A. LONG REJECTION CHAINS — every hop verified, not just the last
  // ===================================================================
  for (let n = 0; n < 12; n += 1) {
    await scenario(`rejection chain #${n + 1}`, async () => {
      const party = P(n);
      const chain = [C(n), C(n + 1), C(n + 2), C(n + 3), C(n + 4)];
      const task = await world.createTask(party, 1_000 + n * 311);
      const id = String(task._id);

      // A hands it back; B hands it back; C has its proof rejected; D is
      // rejected and admin upholds it; E finishes it.
      await world.claim(id, chain[0] as CaptainRef);
      await world.captainRejectsHeldTask(id, chain[0] as CaptainRef, party);
      await world.claim(id, chain[1] as CaptainRef);
      await world.captainRejectsHeldTask(id, chain[1] as CaptainRef, party);
      await world.claim(id, chain[2] as CaptainRef);
      await world.start(id, chain[2] as CaptainRef);
      await world.submitProof(id, chain[2] as CaptainRef);
      await world.rejectProof(id, party);
      await world.resolveRejection(id, 'REASSIGN', chain[2] as CaptainRef);
      await world.claim(id, chain[3] as CaptainRef);
      await world.start(id, chain[3] as CaptainRef);
      await world.submitProof(id, chain[3] as CaptainRef);
      await world.rejectProof(id, party);
      await world.resolveRejection(id, 'REASSIGN', chain[3] as CaptainRef);
      await world.claim(id, chain[4] as CaptainRef);
      await world.start(id, chain[4] as CaptainRef);
      await world.submitProof(id, chain[4] as CaptainRef);
      await world.approve(id, party, chain[4] as CaptainRef);

      // Every earlier captain: no commission, no allocation, no lock, and no
      // way back in.
      const finisher = chain[4] as CaptainRef;
      for (const earlier of chain.slice(0, 4)) {
        const c = earlier as CaptainRef;
        const comm = await Commission.countDocuments({ taskId: task._id, captainId: c.id });
        if (comm !== 0) throw new Error(`released captain ${String(c.id)} holds a commission for this task`);
        const alloc = await DMCAllocation.countDocuments({ taskId: task._id, ownerId: c.id });
        if (alloc !== 0) throw new Error(`released captain ${String(c.id)} holds an allocation for this task`);
        let refused = false;
        try {
          await world.claim(id, c);
        } catch {
          refused = true;
        }
        if (!refused) throw new Error(`released captain ${String(c.id)} was able to reclaim the task`);
      }
      const rows = await Commission.find({ taskId: task._id }).lean();
      if (rows.length !== 1) throw new Error(`expected one commission, found ${rows.length}`);
      if (String(rows[0]?.captainId) !== String(finisher.id)) throw new Error('commission names the wrong captain');
    });
  }

  // ===================================================================
  // C. WIDE CLAIM RACES — 8 captains, one task, many times
  // ===================================================================
  for (let n = 0; n < 10; n += 1) {
    await scenario(`eight-way claim race #${n + 1}`, async () => {
      const party = P(n);
      const task = await world.createTask(party, 2_000 + n * 97);
      const id = String(task._id);
      await world.openToPool(id);

      const before = new Map<string, number>();
      for (const c of captains) {
        const doc = await Captain.findById(c.id).select('lockedAmountPaise').lean();
        before.set(String(c.id), doc?.lockedAmountPaise ?? 0);
      }

      tally.concurrentRequests += captains.length;
      const settled = await Promise.allSettled(captains.map((c) => claimTask(id, c.id, c.actor)));
      const won = settled.filter((r) => r.status === 'fulfilled').length;
      if (won !== 1) throw new Error(`${won} captains claimed the same task`);

      const after = await Task.findById(id).lean();
      const winner = captains.find((c) => String(c.id) === String(after?.captainId));
      if (!winner) throw new Error('no identifiable winner');

      // Every loser moved nothing at all.
      for (const c of captains) {
        if (String(c.id) === String(winner.id)) continue;
        const doc = await Captain.findById(c.id).select('lockedAmountPaise').lean();
        if ((doc?.lockedAmountPaise ?? 0) !== before.get(String(c.id))) {
          throw new Error(`losing captain ${String(c.id)} had collateral locked`);
        }
      }
      world.ledger.taskClaimed(id, String(winner.id));
      await world.finalCheck('eight-way claim race');
      await world.cancelHeld(id, party, winner);
    });
  }

  // ===================================================================
  // D. APPROVAL STORMS — approve, reject, cancel, admin, all at once
  // ===================================================================
  for (let n = 0; n < 10; n += 1) {
    await scenario(`decision storm #${n + 1}`, async () => {
      const party = P(n);
      const captain = C(n + 2);
      const task = await world.createTask(party, 3_000 + n * 131);
      const id = String(task._id);
      await world.claim(id, captain);
      await world.start(id, captain);
      await world.submitProof(id, captain);

      const attempts = [
        () => approveTask(id, party.actor),
        () => approveTask(id, party.actor),
        () => rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', party.actor),
        () => rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', party.actor),
        () => requestCancellation(id, 'Customer backed out at the last second', party.actor),
        () => approveTask(id, party.actor),
        () => rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', party.actor),
        () => approveTask(id, party.actor),
      ];
      tally.concurrentRequests += attempts.length;
      await Promise.allSettled(attempts.map((fn) => fn()));

      const after = await Task.findById(id).lean();
      if (after?.status === 'COMPLETED') {
        world.ledger.collateralReleased(id, String(captain.id));
        world.ledger.taskCompleted(id, String(captain.id));
      }
      await world.finalCheck(`decision storm settled as ${after?.status}`);

      // Whatever won, exactly one commission exists if and only if it completed.
      const rows = await Commission.countDocuments({ taskId: task._id });
      if (after?.status === 'COMPLETED' && rows !== 1) throw new Error(`completed task has ${rows} commissions`);
      if (after?.status !== 'COMPLETED' && rows !== 0) throw new Error(`${after?.status} task has ${rows} commissions`);

      // Leave the world tidy.
      const fresh = await Task.findById(id).lean();
      if (fresh?.status === 'REJECTED') await world.resolveRejection(id, 'APPROVE', captain);
      else if (fresh?.status === 'CANCEL_REVIEW') {
        await reviewCancellationAsCaptain(id, captain.id, 'APPROVE', undefined, captain.actor);
        world.ledger.collateralReleased(id, String(captain.id));
        world.ledger.taskCancelled(id);
        await world.finalCheck('storm leftover cancelled');
      }
    });
  }

  // ===================================================================
  // E. SWEEPER SWARMS — three sweepers on the same tasks
  // ===================================================================
  await scenario('three sweepers race on held tasks', async () => {
    const ids: string[] = [];
    const holders: CaptainRef[] = [];
    for (let i = 0; i < 4; i += 1) {
      const party = P(i);
      const captain = C(i + 1);
      const t = await world.createTask(party, 1_500 + i * 41);
      const id = String(t._id);
      await world.claim(id, captain);
      ids.push(id);
      holders.push(captain);
    }
    await Task.updateMany({ _id: { $in: ids } }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
    // Verify the ageing actually landed before trusting the sweep.
    const due = await Task.countDocuments({ _id: { $in: ids }, expiresAt: { $lte: new Date() } });
    if (due !== ids.length) throw new Error(`only ${due} of ${ids.length} tasks are actually overdue`);

    tally.concurrentRequests += 3;
    await Promise.allSettled([expireOverdueTasks(), expireOverdueTasks(), expireOverdueTasks()]);
    for (const [i, id] of ids.entries()) world.ledger.collateralReleased(id, String((holders[i] as CaptainRef).id));
    await world.finalCheck('three concurrent overdue sweeps');

    // Now three reclaimers at once.
    await Task.updateMany(
      { _id: { $in: ids }, status: 'EXPIRED' },
      { $set: { expiryAckDeadline: new Date(Date.now() - 60_000) } },
    );
    tally.concurrentRequests += 3;
    await Promise.allSettled([
      reclaimUnacknowledgedExpiredTasks(), reclaimUnacknowledgedExpiredTasks(), reclaimUnacknowledgedExpiredTasks(),
    ]);
    await world.finalCheck('three concurrent reclaim sweeps');

    for (const id of ids) {
      const t = await Task.findById(id).lean();
      if (t?.reassignmentCount !== 1) throw new Error(`task walked out of the pool ${t?.reassignmentCount} times`);
      if ((t?.previousCaptainIds ?? []).length !== 1) throw new Error('exclusion list has the wrong length');
    }
  });

  await scenario('stale sweep races a claim', async () => {
    const party = P(1);
    const captain = C(3);
    const t = await world.createTask(party, 2_600);
    const id = String(t._id);
    await world.openToPool(id);
    // Age it through the driver: createdAt is immutable at the model layer.
    await Task.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { createdAt: new Date(Date.now() - 90 * 24 * 60 * 60_000) } },
    );
    const aged = await Task.findById(id).lean();
    if (!aged || aged.createdAt.getTime() > Date.now() - 60_000) throw new Error('ageing write did not land');

    tally.concurrentRequests += 4;
    await Promise.allSettled([
      expireStaleUnclaimedTasks(),
      claimTask(id, captain.id, captain.actor),
      expireStaleUnclaimedTasks(),
      claimTask(id, C(4).id, C(4).actor),
    ]);
    const after = await Task.findById(id).lean();
    if (after?.status === 'CANCELLED') {
      world.ledger.taskCancelled(id);
    } else if (after?.captainId) {
      world.ledger.taskClaimed(id, String(after.captainId));
    }
    await world.finalCheck(`stale sweep vs claim settled as ${after?.status}`);
    const tidy = await Task.findById(id).lean();
    if (tidy?.status === 'ASSIGNED' && tidy.captainId) {
      const holder = captains.find((c) => String(c.id) === String(tidy.captainId));
      if (holder) await world.cancelHeld(id, party, holder);
    } else if (tidy?.status === 'CREATED' || tidy?.status === 'REASSIGNED') {
      await world.cancelUnheld(id, party);
    }
  });

  // ===================================================================
  // F. DUPLICATE REQUEST STORMS — ten identical calls
  // ===================================================================
  await scenario('ten identical top-up approvals credit once', async () => {
    const party = P(2);
    const amount = rupeesToPaise(30_000);
    const req = await requestTopUp(party.id, amount, party.actor);
    tally.duplicateRequests += 10;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => approveTopUp(String(req._id), world.admin)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    if (ok !== 1) throw new Error(`${ok} approvals credited the same top-up`);
    world.ledger.topUpApproved(String(party.id), amount);
    await world.finalCheck('ten identical top-up approvals');
  });

  await scenario('approve and reject the same top-up at once', async () => {
    const party = P(3);
    const amount = rupeesToPaise(18_000);
    const req = await requestTopUp(party.id, amount, party.actor);
    tally.concurrentRequests += 6;
    const results = await Promise.allSettled([
      approveTopUp(String(req._id), world.admin),
      rejectTopUp(String(req._id), 'Payment never arrived in the account', world.admin),
      approveTopUp(String(req._id), world.admin),
      rejectTopUp(String(req._id), 'Payment never arrived in the account', world.admin),
      approveTopUp(String(req._id), world.admin),
      rejectTopUp(String(req._id), 'Payment never arrived in the account', world.admin),
    ]);
    if (results.filter((r) => r.status === 'fulfilled').length !== 1) {
      throw new Error('a top-up was decided more than once');
    }
    const decided = await (await import('../../models')).PartyTopUpRequest.findById(req._id).lean();
    if (decided?.status === 'APPROVED') world.ledger.topUpApproved(String(party.id), amount);
    await world.finalCheck(`top-up approve vs reject settled as ${decided?.status}`);
  });

  await scenario('ten identical deposit approvals credit collateral once', async () => {
    const captain = C(5);
    const amount = rupeesToPaise(12_000);
    const req = await requestDeposit(captain.id, amount, captain.actor);
    tally.duplicateRequests += 10;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => approveDeposit(String(req._id), world.admin)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    if (ok !== 1) throw new Error(`${ok} approvals credited the same deposit`);
    const split = await depositSplit(amount);
    world.ledger.depositApproved(String(captain.id), split.lockedPaise, split.usablePaise);
    await world.finalCheck('ten identical deposit approvals');
  });

  await scenario('approve and reject the same deposit at once', async () => {
    const captain = C(6);
    const amount = rupeesToPaise(7_000);
    const req = await requestDeposit(captain.id, amount, captain.actor);
    tally.concurrentRequests += 4;
    const results = await Promise.allSettled([
      approveDeposit(String(req._id), world.admin),
      rejectDeposit(String(req._id), 'Payment never arrived in the account', world.admin),
      approveDeposit(String(req._id), world.admin),
      rejectDeposit(String(req._id), 'Payment never arrived in the account', world.admin),
    ]);
    if (results.filter((r) => r.status === 'fulfilled').length !== 1) {
      throw new Error('a deposit was decided more than once');
    }
    const decided = await (await import('../../models')).DmcPurchase.findById(req._id).lean();
    if (decided?.status === 'APPROVED') {
      const split = await depositSplit(amount);
      world.ledger.depositApproved(String(captain.id), split.lockedPaise, split.usablePaise);
    }
    await world.finalCheck(`deposit approve vs reject settled as ${decided?.status}`);
  });

  // ===================================================================
  // H. STALE CLIENT — a decision made against a state that has moved
  // ===================================================================
  await scenario('a stale reject after an approval moves nothing', async () => {
    const party = P(4);
    const captain = C(1);
    const task = await world.createTask(party, 5_200);
    const id = String(task._id);
    await world.claim(id, captain);
    await world.start(id, captain);
    await world.submitProof(id, captain);

    // Client A has the task at AUDIT_PENDING. Client B approves it.
    await world.approve(id, party, captain);
    // Client A now submits its rejection against the state it still believes in.
    let refused = false;
    try {
      await rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', party.actor);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error('a stale rejection was accepted after completion');
    await world.finalCheck('stale rejection refused');
  });

  await scenario('a stale cancellation after a cancellation moves nothing', async () => {
    const party = P(0);
    const task = await world.createTask(party, 4_100);
    const id = String(task._id);
    await world.cancelUnheld(id, party);
    tally.duplicateRequests += 5;
    const again = await Promise.allSettled(
      Array.from({ length: 5 }, () => requestCancellation(id, 'Customer backed out at the last second', party.actor)),
    );
    if (again.some((r) => r.status === 'fulfilled')) throw new Error('a cancelled task was cancelled again');
    await world.finalCheck('five stale cancellations refused');
  });

  // ===================================================================
  // H2. A REFUSED CLAIM LEAVES NOTHING BEHIND
  // ===================================================================
  await scenario('a claim refused at the ceiling moves nothing', async () => {
    const party = P(2);
    const captain = C(0);
    // A ceiling far below the task: the claim guard must refuse it.
    await Captain.updateOne({ _id: captain.id }, { $set: { creditLimitPaise: rupeesToPaise(500) } });
    const before = await Captain.findById(captain.id).lean();

    const task = await world.createTask(party, 150_000);
    const id = String(task._id);
    await world.openToPool(id);

    let refused = false;
    try {
      await claimTask(id, captain.id, captain.actor);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error('a claim beyond the ceiling was accepted');

    const after = await Captain.findById(captain.id).lean();
    if (after?.lockedAmountPaise !== before?.lockedAmountPaise) throw new Error('a refused claim locked collateral');
    if (after?.dmcBalancePaise !== before?.dmcBalancePaise) throw new Error('a refused claim moved the balance');
    const held = await Task.findById(id).lean();
    if (held?.captainId) throw new Error('a refused claim still took ownership of the task');
    await world.finalCheck('claim refused at the ceiling');

    await Captain.updateOne({ _id: captain.id }, { $unset: { creditLimitPaise: 1 } });
    await world.cancelUnheld(id, party);
  });

  await scenario('a task beyond every ceiling stays unclaimed and refundable', async () => {
    const party = P(4);
    for (const c of captains) {
      await Captain.updateOne({ _id: c.id }, { $set: { creditLimitPaise: rupeesToPaise(200) } });
    }
    const task = await world.createTask(party, 199_000);
    const id = String(task._id);
    await world.openToPool(id);

    tally.concurrentRequests += captains.length;
    const settled = await Promise.allSettled(captains.map((c) => claimTask(id, c.id, c.actor)));
    if (settled.some((r) => r.status === 'fulfilled')) throw new Error('a task beyond every ceiling was claimed');
    await world.finalCheck('nobody could afford the task');

    for (const c of captains) await Captain.updateOne({ _id: c.id }, { $unset: { creditLimitPaise: 1 } });
    await world.cancelUnheld(id, party);
  });

  await scenario('a task refused at the party spending cap bills nothing', async () => {
    const party = P(3);
    // A cap far below the task: creation must be refused before any billing.
    await updateConfig({ partyDailyLimitPaise: rupeesToPaise(500) }, new Types.ObjectId());
    const before = await Party.findById(party.id).lean();

    let refused = false;
    try {
      await world.createTask(party, 150_000);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error('a task beyond the party cap was accepted');

    const after = await Party.findById(party.id).lean();
    if (after?.dmcBalancePaise !== before?.dmcBalancePaise) throw new Error('a refused task creation still billed the party');
    await world.finalCheck('task creation refused at the party cap');

    await updateConfig({ partyDailyLimitPaise: 900_000_000_000 }, new Types.ObjectId());
  });

  // ===================================================================
  // I. SCALE — one captain, many simultaneous tasks
  // ===================================================================
  await scenario('one captain holding fifty tasks at once', async () => {
    const party = P(2);
    const captain = C(2);
    await Captain.updateOne({ _id: captain.id }, { $unset: { creditLimitPaise: 1 } });
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const t = await world.createTask(party, 120 + i);
      const id = String(t._id);
      await world.claim(id, captain);
      ids.push(id);
    }
    // Half complete, half cancel — one task's accounting must not touch another.
    for (const [i, id] of ids.entries()) {
      if (i % 2 === 0) {
        await world.start(id, captain);
        await world.submitProof(id, captain);
        await world.approve(id, party, captain);
      } else {
        await world.cancelHeld(id, party, captain);
      }
    }
    const held = await Task.countDocuments({ captainId: captain.id, status: { $in: ['ASSIGNED', 'IN_PROGRESS'] } });
    if (held !== 0) throw new Error(`${held} tasks still held after settling all fifty`);
  });

  // ===================================================================
  // J. COMMISSION CONFIGURATION CHANGES MID-FLIGHT
  // ===================================================================
  await scenario('two tasks straddling a rate change each keep their own rate', async () => {
    const party = P(3);
    const a = C(0);
    const b = C(4);
    await updateConfig(
      { payOutPartyCommissionPercentage: 3, payOutCaptainCommissionPercentage: 1 },
      new Types.ObjectId(),
    );

    const first = await world.createTask(party, 10_000);
    const firstId = String(first._id);
    await world.claim(firstId, a);

    await updateConfig(
      { payOutPartyCommissionPercentage: 10, payOutCaptainCommissionPercentage: 4 },
      new Types.ObjectId(),
    );
    const second = await world.createTask(party, 10_000);
    const secondId = String(second._id);
    await world.claim(secondId, b);

    // Change again before either completes.
    await updateConfig(
      { payOutPartyCommissionPercentage: 18, payOutCaptainCommissionPercentage: 9 },
      new Types.ObjectId(),
    );

    for (const [id, captain] of [[firstId, a], [secondId, b]] as Array<[string, CaptainRef]>) {
      await world.start(id, captain);
      await world.submitProof(id, captain);
      await world.approve(id, party, captain);
    }

    const one = await Task.findById(firstId).lean();
    const two = await Task.findById(secondId).lean();
    // 3%/1% on the first, 10%/4% on the second. Each keeps the pair it was
    // priced at, and the platform's half is the difference in both cases.
    if (paiseToRupees(one?.commissionPaise ?? 0) !== 100) throw new Error(`first task kept ${paiseToRupees(one?.commissionPaise ?? 0)} instead of 100`);
    if (paiseToRupees(one?.adminCommissionPaise ?? 0) !== 200) throw new Error('first task platform cut drifted');
    if (paiseToRupees(two?.commissionPaise ?? 0) !== 400) throw new Error(`second task kept ${paiseToRupees(two?.commissionPaise ?? 0)} instead of 400`);
    if (paiseToRupees(two?.adminCommissionPaise ?? 0) !== 600) throw new Error('second task platform cut drifted');

    await updateConfig(
      { payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5 },
      new Types.ObjectId(),
    );
  });

  // ===================================================================
  // K. RESTART — reconnect mid-workflow and carry on
  // ===================================================================
  await scenario('a workflow survives a restart', async () => {
    const party = P(1);
    const captain = C(3);
    const task = await world.createTask(party, 7_700);
    const id = String(task._id);
    await world.claim(id, captain);
    await world.start(id, captain);
    await world.submitProof(id, captain);

    // Drop every connection and reconnect, as a redeploy would.
    await mongoose.disconnect();
    await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`);
    await world.finalCheck('accounting survived the reconnect');

    await world.approve(id, party, captain);
  });

  // ===================================================================
  // L. RANDOMISED MIXED WORKFLOWS
  // ===================================================================
  const ROUTES = [
    'COMPLETE', 'CANCEL_UNHELD', 'CANCEL_HELD', 'CAPTAIN_BACK', 'PROOF_REJECT',
    'ADMIN_OVERRULE', 'DISPUTE_REASSIGN', 'EXPIRE_RECOVER', 'RACE_DECIDE',
  ] as const;
  const AMOUNT_BANDS: Array<[number, number]> = [[100, 200], [201, 2_000], [2_001, 50_000], [50_001, 199_999]];

  const RANDOM_COUNT = 330;
  for (let n = 0; n < RANDOM_COUNT && !stopped; n += 1) {
    const route = rng.pick(ROUTES);
    const party = P(rng.int(parties.length));
    const firstIdx = rng.int(captains.length);
    const first = C(firstIdx);
    const second = C(firstIdx + 1 + rng.int(captains.length - 1));
    const [lo, hi] = rng.pick(AMOUNT_BANDS);
    const amount = lo + rng.int(hi - lo + 1);

    // Vary the rates so rounding is exercised across every task. The pair is
    // drawn independently, so misconfigured rounds — more promised than
    // charged — happen too, and the cap has to hold on those.
    if (n % 11 === 0) {
      await updateConfig(
        {
          payOutPartyCommissionPercentage: rng.pick([0, 0.33, 1.67, 3, 7, 12.5]),
          payOutCaptainCommissionPercentage: rng.pick([0, 0.25, 1, 2.5, 5, 9]),
          payInPartyCommissionPercentage: rng.pick([0, 0.5, 1, 3, 7.5]),
          payInCaptainCommissionPercentage: rng.pick([0, 0.25, 1, 2, 3.75]),
        },
        new Types.ObjectId(),
      );
    }

    await scenario(`random #${n + 1} seed=${seed} route=${route} amount=${amount}`, async () => {
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
        case 'EXPIRE_RECOVER': {
          await world.claim(id, first);
          await world.start(id, first);
          await Task.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
          await expireOverdueTasks();
          world.ledger.collateralReleased(id, String(first.id));
          await world.finalCheck('task expired while held');
          await rejectExpiredTask(id, first.id, 'Bank was down all evening', first.actor);
          await world.finalCheck('captain explained the expiry');
          await world.claim(id, second);
          await world.start(id, second);
          await world.submitProof(id, second);
          await world.approve(id, party, second);
          break;
        }
        case 'RACE_DECIDE': {
          await world.claim(id, first);
          await world.start(id, first);
          await world.submitProof(id, first);
          tally.concurrentRequests += 3;
          await Promise.allSettled([
            approveTask(id, party.actor),
            rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', party.actor),
            approveTask(id, party.actor),
          ]);
          const after = await Task.findById(id).lean();
          if (after?.status === 'COMPLETED') {
            world.ledger.collateralReleased(id, String(first.id));
            world.ledger.taskCompleted(id, String(first.id));
          }
          await world.finalCheck(`raced decision settled as ${after?.status}`);
          if (after?.status === 'REJECTED') await world.resolveRejection(id, 'APPROVE', first);
          break;
        }
      }
    });

    if (!stopped && n % 37 === 36) {
      await scenario(`random #${n + 1} platform withdrawal`, async () => {
        const acct = await PlatformAccount.findOne({ key: 'GLOBAL' }).lean();
        const balance = acct?.poolBalancePaise ?? 0;
        const { AdminWithdrawalRequest } = await import('../../models');
        const busy = await AdminWithdrawalRequest.exists({ status: 'PENDING' });
        if (!busy && balance > 0) {
          await world.platformWithdraw(paiseToRupees(Math.floor(balance / 3)), rng.chance(0.3) ? 'DISPUTE_SETTLE' : 'CONFIRM');
        }
      });
    }
  }

  // ===================================================================
  // FINAL: independent reconciliation + record-level audit
  // ===================================================================
  const final = await reconcile(world.ledger);
  const deep = await deepReconcile();

  if (!final.ok) {
    console.log(`\n[seed ${seed}] FINAL DIVERGENCES:`);
    console.log(describe(final));
  }
  if (deep.length > 0) {
    console.log(`\n[seed ${seed}] RECORD-LEVEL FINDINGS:`);
    console.log(describeDeep(deep));
  }

  const ok = final.ok && deep.length === 0 && tally.failures.length === 0;
  const result: RunResult = {
    seed,
    ok,
    tally,
    transitions: counters.transitions,
    reconciliations: counters.dmcTransitions,
    deepFindings: deep.length,
  };

  console.log(
    `\n[seed ${seed}] ${ok ? 'RECONCILED' : 'NOT RECONCILED'} — ` +
    `${tally.scenarios} scenarios, ${counters.transitions} transitions, ${counters.dmcTransitions} reconciliations, ` +
    `${tally.concurrentRequests} concurrent, ${tally.duplicateRequests} duplicate, ${deep.length} record findings`,
  );
  if (tally.failures.length > 0) {
    console.log(`[seed ${seed}] failing scenarios:`);
    for (const f of tally.failures.slice(0, 12)) console.log(`  - ${f.name}\n      ${f.detail.split('\n')[0]}`);
  }

  await mongoose.disconnect();
  return result;
}

async function main(): Promise<void> {
  await startMiniRedis();
  const seeds = SEEDS.length > 0 ? SEEDS : DEFAULT_SEEDS;
  const started = Date.now();
  const results: RunResult[] = [];

  for (const seed of seeds) {
    console.log(`\n================ FRESH DATABASE, SEED ${seed} ================`);
    results.push(await runOneDatabase(seed));
  }

  console.log('\n================ ADVERSARIAL ROUND SUMMARY ================');
  let scenarios = 0;
  let transitions = 0;
  let reconciliations = 0;
  let concurrent = 0;
  let duplicate = 0;
  for (const r of results) {
    scenarios += r.tally.scenarios;
    transitions += r.transitions;
    reconciliations += r.reconciliations;
    concurrent += r.tally.concurrentRequests;
    duplicate += r.tally.duplicateRequests;
    console.log(`  seed ${r.seed}: ${r.ok ? 'reconciled' : 'FAILED'} (${r.tally.failures.length} scenario failures, ${r.deepFindings} record findings)`);
  }
  console.log(`\n  databases            : ${results.length} fresh`);
  console.log(`  scenarios            : ${scenarios}`);
  console.log(`  state transitions    : ${transitions}`);
  console.log(`  reconciliations      : ${reconciliations}`);
  console.log(`  concurrent requests  : ${concurrent}`);
  console.log(`  duplicate requests   : ${duplicate}`);
  console.log(`  elapsed              : ${Math.round((Date.now() - started) / 1000)}s`);

  const allOk = results.every((r) => r.ok);
  console.log(`\n==== ${allOk ? 'ALL DATABASES RECONCILED — difference exactly zero' : 'NOT RECONCILED'} ====`);
  process.exit(allOk ? 0 : 1);
}

main().catch(async (err: unknown) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
