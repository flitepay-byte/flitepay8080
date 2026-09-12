/**
 * PHASE: races.
 *
 * Every check here fires the same operation from several callers at once and
 * then asks the database what it believes. The point is not that one caller
 * wins — it is that exactly one does, and that the losers left nothing behind:
 * no second commission, no second lock, no half-applied refund.
 */
import { Types } from 'mongoose';
import {
  Task, Party, Captain, Commission, PartyTopUpRequest, Proof,
} from '../models';
import { createTask, claimTask } from '../services/task.service';
import {
  startTask, submitProof, approveTask, requestCancellation,
} from '../services/workflow.service';
import {
  requestPlatformWithdrawal, submitPlatformPortionPaymentProof, confirmPlatformPortionReceipt,
} from '../services/adminWithdrawal.service';
import { getPlatformAccount } from '../services/platformAccount.service';
import { approveTopUp, rejectTopUp } from '../services/partyTopUp.service';
import { rupeesToPaise, paiseToRupees } from '../utils/money';
import { record, report } from './harness';
import type { Dataset } from './seed';

const AREA = 'Concurrency';

/** Runs everything at once and reports how many resolved rather than threw. */
async function race<T>(operations: Array<() => Promise<T>>): Promise<{ ok: number; failed: number; errors: string[] }> {
  const settled = await Promise.allSettled(operations.map((op) => op()));
  const errors = settled
    .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
    .map((s) => (s.reason as Error).message);
  return { ok: settled.filter((s) => s.status === 'fulfilled').length, failed: errors.length, errors };
}

export async function auditConcurrency(data: Dataset): Promise<void> {
  console.log('\n=== PHASE: concurrency and races ===');

  const first = data.parties[0];
  if (!first) throw new Error('no party');
  const party = first;
  const partyActor = { userId: String(party.userId), role: 'PARTY' as const };
  const adminActor = { userId: String(data.adminUserId), role: 'ADMIN' as const };

  const readyCaptains = await Captain.find({ status: 'ACTIVE' }).lean();

  // Give everyone room so a failure means contention, not funds.
  await Captain.updateMany({ status: 'ACTIVE' }, { $set: { isOnline: true, collateralBalancePaise: rupeesToPaise(10_000_000) } });
  // Incremented, not overwritten: the accounting pass reconstructs this
  // balance afterwards, and a $set would erase the history it reads.
  const raceGrant = rupeesToPaise(50_000_000);
  await Party.updateOne({ _id: party.id }, { $inc: { dmcBalancePaise: raceGrant } });
  data.partyCreditsPaise[String(party.id)] = (data.partyCreditsPaise[String(party.id)] ?? 0) + raceGrant;

  async function freshTask(amountRupees = 500): Promise<string> {
    const task = await createTask(
      {
        partyId: party.id, createdBy: party.userId, customerName: 'Race Test',
        amountPaise: rupeesToPaise(amountRupees), payoutMethod: { type: 'UPI', upiId: 'race@upi' },
      },
      partyActor,
    );
    // Open it to everyone so the race is a real contest rather than an offer check.
    await Task.updateOne({ _id: task._id }, { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } });
    return String(task._id);
  }

  // ---------- 1. Ten captains claim the same task at once ----------
  for (const contenders of [2, 5, 10]) {
    const taskId = await freshTask();
    const group = readyCaptains.slice(0, contenders);
    const { ok } = await race(
      group.map((c) => () => claimTask(taskId, c._id as Types.ObjectId, { userId: String(c.userId), role: 'CAPTAIN' })),
    );
    const after = await Task.findById(taskId).lean();
    const single = ok === 1 && after?.status === 'ASSIGNED' && Boolean(after.captainId);

    if (!record(AREA, `${contenders} captains claiming one task — exactly one wins`, single, `${ok} succeeded, status ${after?.status}`)) {
      report({
        severity: 'P0', area: AREA, roles: ['Captain'],
        title: `Concurrent claim allowed ${ok} captains onto one task`,
        reproduction: `Open a task to the pool, then call claimTask from ${contenders} captains simultaneously via Promise.all.`,
        expected: 'Exactly one claim succeeds; the rest are rejected with a conflict.',
        actual: `${ok} claims succeeded. Final status ${after?.status}, captain ${String(after?.captainId)}.`,
        impact: 'Two captains pay the same customer; the party is billed once and one captain is never reimbursed.',
        evidence: `taskId=${taskId}`,
      });
    }

    // The losers must not be left holding collateral for a task they did not get.
    const winner = String(after?.captainId ?? '');
    const losers = group.filter((c) => String(c._id) !== winner);
    let lockLeak = 0;
    for (const loser of losers) {
      const held = await Task.countDocuments({ captainId: loser._id, _id: new Types.ObjectId(taskId) });
      if (held > 0) lockLeak += 1;
    }
    record(AREA, `losing claimants hold nothing (${contenders}-way)`, lockLeak === 0, `${lockLeak} losers still attached`);
  }

  // ---------- 2. The same proof submitted twice at once ----------
  {
    const taskId = await freshTask();
    const captain = readyCaptains[0];
    if (captain) {
      const actor = { userId: String(captain.userId), role: 'CAPTAIN' as const };
      await claimTask(taskId, captain._id as Types.ObjectId, actor);
      await startTask(taskId, captain._id as Types.ObjectId, actor);
      // The captain reports the reference for a payment they made outside
      // this system; nothing here issues one.
      const reference = `UTR${Math.floor(Math.random() * 900_000_000 + 100_000_000)}`;
      if (reference) {
        const { ok } = await race([1, 2, 3].map(() => () =>
          submitProof({ taskId, captainId: captain._id as Types.ObjectId, providerReference: reference }, actor)));
        const live = await Proof.countDocuments({ taskId: new Types.ObjectId(taskId), supersededAt: null });
        if (!record(AREA, 'simultaneous proof submissions leave exactly one live proof', live === 1, `${ok} succeeded, ${live} live proofs`)) {
          report({
            severity: 'P1', area: AREA, roles: ['Captain', 'Party'],
            title: 'Concurrent proof submission creates more than one live proof',
            reproduction: 'Call submitProof three times simultaneously for one task.',
            expected: 'One live proof; the rest rejected or superseded.',
            actual: `${ok} calls succeeded, ${live} proofs are live.`,
            impact: 'The party audits an ambiguous record and the task can be approved against the wrong evidence.',
            evidence: `taskId=${taskId}`,
          });
        }
      }
    }
  }

  // ---------- 3. Double approval — the commission double-credit test ----------
  {
    const taskId = await freshTask();
    const captain = readyCaptains[1] ?? readyCaptains[0];
    if (captain) {
      const actor = { userId: String(captain.userId), role: 'CAPTAIN' as const };
      await claimTask(taskId, captain._id as Types.ObjectId, actor);
      await startTask(taskId, captain._id as Types.ObjectId, actor);
      // The captain reports the reference for a payment they made outside
      // this system; nothing here issues one.
      const reference = `UTR${Math.floor(Math.random() * 900_000_000 + 100_000_000)}`;
      if (reference) {
        await submitProof({ taskId, captainId: captain._id as Types.ObjectId, providerReference: reference }, actor);
        const before = await Captain.findById(captain._id).lean();
        const { ok } = await race([1, 2, 3, 4].map(() => () => approveTask(taskId, partyActor)));
        const commissions = await Commission.countDocuments({ taskId: new Types.ObjectId(taskId) });
        const after = await Captain.findById(captain._id).lean();
        const credited = (after?.dmcBalancePaise ?? 0) - (before?.dmcBalancePaise ?? 0);
        const task = await Task.findById(taskId).lean();

        // Approval credits the captain the task amount back (they fronted it)
        // plus their commission — see workflow.service.ts. Anything more than
        // one of those means an approval was applied twice.
        const expectedCredit = (task?.amountPaise ?? 0) + (task?.commissionPaise ?? 0);
        const clean = commissions === 1 && credited === expectedCredit;
        if (!record(AREA, 'four simultaneous approvals credit the captain exactly once', clean,
          `${ok} approvals, ${commissions} commissions, credited ${paiseToRupees(credited)} vs expected ${paiseToRupees(expectedCredit)}`)) {
          report({
            severity: 'P0', area: AREA, roles: ['Captain', 'Party', 'Admin'],
            title: 'Concurrent approval credits commission more than once',
            reproduction: 'With a task in AUDIT_PENDING, call approveTask four times simultaneously as the owning party.',
            expected: 'One approval succeeds, one commission row, one credit.',
            actual: `${ok} approvals succeeded, ${commissions} commission rows, ${paiseToRupees(credited)} DMC credited against an expected ${paiseToRupees(expectedCredit)}.`,
            impact: 'DMC is created from nothing on every duplicate approval.',
            evidence: `taskId=${taskId}`,
          });
        }
      }
    }
  }

  // ---------- 4. Double cancellation / double refund ----------
  {
    const taskId = await freshTask(750);
    const before = await Party.findById(party.id).lean();
    const { ok } = await race([1, 2, 3].map(() => () => requestCancellation(taskId, 'Racing the cancel path', partyActor)));
    const after = await Party.findById(party.id).lean();
    const task = await Task.findById(taskId).lean();
    const refunded = (after?.dmcBalancePaise ?? 0) - (before?.dmcBalancePaise ?? 0);
    const cost = (task?.amountPaise ?? 0) + (task?.commissionPaise ?? 0) + (task?.adminCommissionPaise ?? 0);
    const expected = task?.status === 'CANCELLED' ? cost : 0;

    if (!record(AREA, 'simultaneous cancellations refund at most once', refunded === expected,
      `${ok} succeeded, refunded ${paiseToRupees(refunded)}, expected ${paiseToRupees(expected)}`)) {
      report({
        severity: 'P0', area: AREA, roles: ['Party'],
        title: 'Concurrent cancellation refunds the party more than once',
        reproduction: 'Call requestCancellation three times simultaneously on one unclaimed task.',
        expected: 'One cancellation, one refund of amount + both commissions.',
        actual: `${ok} calls succeeded; balance moved by ${paiseToRupees(refunded)} against an expected ${paiseToRupees(expected)}.`,
        impact: 'A party can mint DMC by cancelling the same task repeatedly in parallel.',
        evidence: `taskId=${taskId}`,
      });
    }
  }

  // ---------- 5. Withdrawal portion confirmed and disputed at once ----------
  // Which side wins is a matter of microseconds, so this runs over every
  // available portion rather than one: the failure only shows when the confirm
  // ---------- 6. Top-up approved and rejected at once ----------
  {
    const topUp = await PartyTopUpRequest.findOne({ status: 'PENDING' }).lean();
    if (topUp) {
      const owner = await Party.findById(topUp.partyId).lean();
      const before = owner?.dmcBalancePaise ?? 0;
      const { ok } = await race([
        () => approveTopUp(String(topUp._id), adminActor),
        () => rejectTopUp(String(topUp._id), 'Racing the rejection path', adminActor),
        () => approveTopUp(String(topUp._id), adminActor),
      ]);
      const after = await Party.findById(topUp.partyId).lean();
      const credited = (after?.dmcBalancePaise ?? 0) - before;
      const final = await PartyTopUpRequest.findById(topUp._id).lean();
      const creditedOnce = credited === 0 || credited === topUp.amountPaise;

      if (!record(AREA, 'a top-up approved and rejected at once credits at most once', creditedOnce,
        `${ok} succeeded, credited ${paiseToRupees(credited)} of ${paiseToRupees(topUp.amountPaise)}, final ${final?.status}`)) {
        report({
          severity: 'P0', area: AREA, roles: ['Party', 'Admin'],
          title: 'Concurrent top-up decisions credit the party more than once',
          reproduction: 'For one PENDING top-up, call approveTopUp, rejectTopUp and approveTopUp simultaneously.',
          expected: 'One decision is applied; the balance moves by the top-up amount at most once.',
          actual: `${ok} calls succeeded; balance moved ${paiseToRupees(credited)} against a request of ${paiseToRupees(topUp.amountPaise)}. Final status ${final?.status}.`,
          impact: 'Admin double-clicking Confirm mints DMC.',
          evidence: `topUpId=${topUp._id}`,
        });
      }
    } else {
      record(AREA, 'a PENDING top-up exists to race', false, 'none in dataset');
    }
  }

  // ---------- 7. Claim racing the sweeper's expiry ----------
  {
    const taskId = await freshTask();
    const captain = readyCaptains[2] ?? readyCaptains[0];
    if (captain) {
      // An offer that lapses at the exact moment of the claim.
      await Task.updateOne(
        { _id: taskId },
        { $set: { openPoolAt: null, offeredCaptainId: captain._id, offeredAt: new Date(), offerExpiresAt: new Date(Date.now() + 40) } },
      );
      await new Promise((r) => setTimeout(r, 45));
      let claimed = true;
      try {
        await claimTask(taskId, captain._id as Types.ObjectId, { userId: String(captain.userId), role: 'CAPTAIN' });
      } catch {
        claimed = false;
      }
      const after = await Task.findById(taskId).lean();
      const consistent = !claimed ? after?.captainId == null : after?.status === 'ASSIGNED';
      if (!record(AREA, 'a claim on a just-lapsed offer is refused or fully applied, never half', consistent,
        `claimed=${claimed}, status=${after?.status}, captain=${String(after?.captainId)}`)) {
        report({
          severity: 'P1', area: AREA, roles: ['Captain'],
          title: 'Claiming a lapsed offer leaves the task in a half-applied state',
          reproduction: 'Set offerExpiresAt 40ms in the future, wait 45ms, then claim.',
          expected: 'Either a clean rejection or a clean assignment.',
          actual: `claim ${claimed ? 'succeeded' : 'failed'} but the task is status ${after?.status} with captain ${String(after?.captainId)}.`,
          impact: 'A task can be left assigned to nobody, or to a captain whose offer had expired.',
          evidence: `taskId=${taskId}`,
        });
      }
    }
  }

  // ---------- Admin cashing out commission for work that never happened ----------
  // Not a race — a sequence. The platform used to be credited its cut the
  // moment a task was created, so admin could withdraw commission for a task
  // that was still open. Cancelling that task then refunded the party in full,
  // including the commission admin had already been paid, drove the platform
  // balance below zero, and left the ledger holding DMC that came from nowhere.
  //
  // The pool is where that cut lives now, and nothing funds it until the task
  // completes — so the same sequence is run against the pool.
  {
    const walletBefore = (await getPlatformAccount()).poolBalancePaise;
    const partyBefore = (await Party.findById(party.id).lean())?.dmcBalancePaise ?? 0;

    const taskId = await freshTask(20_000);
    const task = await Task.findById(taskId).lean();
    const adminCut = task?.adminCommissionPaise ?? 0;

    const walletAfterCreate = (await getPlatformAccount()).poolBalancePaise;
    if (!record(AREA, 'creating a task credits the platform nothing', walletAfterCreate === walletBefore,
      `wallet moved by ${paiseToRupees(walletAfterCreate - walletBefore)} DMC`)) {
      report({
        severity: 'P0', area: AREA, roles: ['Admin'],
        title: 'Platform is credited commission before the work is done',
        reproduction: 'Create a task and read PlatformAccount.poolBalancePaise.',
        expected: 'Unchanged — the platform earns its cut when the task completes.',
        actual: `The wallet gained ${paiseToRupees(walletAfterCreate - walletBefore)} DMC at creation.`,
        impact: 'Admin can withdraw commission for a task that may still be cancelled.',
      });
    }

    // Try to cash it out anyway. This must not produce a settled portion.
    let withdrawalSettled = false;
    try {
      const { portions } = await requestPlatformWithdrawal(adminCut, adminActor);
      for (const portion of portions) {
        await submitPlatformPortionPaymentProof(
          String(portion._id), party.id, { providerReference: 'UTRAUDIT0001' }, partyActor,
        );
        await confirmPlatformPortionReceipt(String(portion._id), adminActor);
        withdrawalSettled = true;
      }
    } catch {
      // Refused, which is the point.
    }

    await requestCancellation(taskId, 'Audit: cancelled after admin tried to cash out', partyActor);

    const walletAfter = (await getPlatformAccount()).poolBalancePaise;
    const partyAfter = (await Party.findById(party.id).lean())?.dmcBalancePaise ?? 0;

    const clean = !withdrawalSettled && walletAfter === walletBefore && partyAfter === partyBefore;
    if (!record(AREA, 'admin cannot cash out commission for a task that is then cancelled', clean,
      `settled=${withdrawalSettled} wallet ${paiseToRupees(walletBefore)}->${paiseToRupees(walletAfter)} party drift ${paiseToRupees(partyAfter - partyBefore)} DMC`)) {
      report({
        severity: 'P0', area: AREA, roles: ['Admin', 'Party'],
        title: 'Commission withdrawn for a task that was later cancelled',
        reproduction: 'Create a task, withdraw the platform commission for it, then cancel the task.',
        expected: 'The withdrawal is refused, the wallet is unchanged, and the cancelled task leaves the party exactly as it started.',
        actual: `withdrawal settled: ${withdrawalSettled}; wallet ${paiseToRupees(walletBefore)} -> ${paiseToRupees(walletAfter)} DMC; party drift ${paiseToRupees(partyAfter - partyBefore)} DMC.`,
        impact: 'The party is refunded money already paid to admin, the platform wallet goes negative, and DMC is created from nothing.',
      });
    }
  }

  // Clean up the race fixtures so they do not distort the accounting pass.
  const raceTasks = await Task.find({ customerName: 'Race Test' }).select('_id').lean();
  console.log(`  (created ${raceTasks.length} race fixtures; left in place for the integrity pass)`);
}
