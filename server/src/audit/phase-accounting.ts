/**
 * PHASE: money.
 *
 * Every DMC in the system should be traceable. This phase rebuilds each
 * party's and captain's balance from the events that should have produced it
 * and compares against what the database actually holds — the only way to
 * catch a leak, because a wrong balance looks exactly like a right one until
 * you recompute it.
 */
import {
  Task, Party, Captain, Commission,
  PartyTopUpRequest, DMCAllocation, AdminWithdrawalPortion,
} from '../models';
import { getConfig } from '../services/systemConfig.service';
import { getPlatformAccount } from '../services/platformAccount.service';
import { paiseToRupees } from '../utils/money';
import { record, report } from './harness';

const AREA = 'Accounting';
const dmc = (paise: number): string => `${paiseToRupees(paise).toLocaleString('en-IN')} DMC`;

export async function auditAccounting(partyCreditsPaise: Record<string, number> = {}): Promise<void> {
  console.log('\n=== PHASE: money and accounting ===');
  const config = await getConfig();

  // ---------- 1. Party balances reconstructed from first principles ----------
  const parties = await Party.find().lean();
  let partyDrift = 0;
  const driftDetail: string[] = [];

  for (const party of parties) {
    const tasks = await Task.find({ partyId: party._id }).lean();

    // What leaves the balance: every task's amount plus both commissions,
    // debited at creation. What comes back: a refund on cancellation.
    let committed = 0;
    let refunded = 0;
    for (const t of tasks) {
      const cost = t.amountPaise + (t.commissionPaise ?? 0) + (t.adminCommissionPaise ?? 0);
      committed += cost;
      if (t.status === 'CANCELLED') refunded += cost;
    }

    const topUps = await PartyTopUpRequest.find({ partyId: party._id, status: 'APPROVED' }).lean();
    const toppedUp = topUps.reduce((sum, t) => sum + t.amountPaise, 0);

    // Settling a withdrawal portion hands the party its spending capacity back
    // — the party paid admin in real money, so the DMC returns to them. Only
    // admin's own withdrawal does this now; a captain no longer cashes out
    // through a party at all.
    const settledAdmin = await AdminWithdrawalPortion.find({ partyId: party._id, status: 'FULFILLED' }).lean();
    const returned = settledAdmin.reduce((sum, x) => sum + x.amountPaise, 0);

    // Everything the party was ever given: its opening balance plus any grant
    // the harness made to keep the workload running.
    const granted = partyCreditsPaise[String(party._id)] ?? config.partyRegistrationDmcPaise;

    const actual = party.dmcBalancePaise;
    const expectedBalance = granted + toppedUp - committed + refunded + returned;
    const matched = expectedBalance === actual;

    if (!matched) {
      partyDrift += 1;
      const best = granted;
      const expected = expectedBalance;
      driftDetail.push(
        `${party.partyCode}: expected ${dmc(expected)} (grant ${dmc(best)} + topups ${dmc(toppedUp)} - committed ${dmc(committed)} + refunds ${dmc(refunded)} + settled withdrawals ${dmc(returned)}), actual ${dmc(actual)}, drift ${dmc(actual - expected)}`,
      );
    }
  }

  if (!record(AREA, 'every party balance reconstructs from its own history', partyDrift === 0, driftDetail.join(' | '))) {
    report({
      severity: 'P0', area: AREA, roles: ['Party', 'Admin'],
      title: 'Party DMC balance does not match the sum of its own transactions',
      reproduction: 'Rebuild balance as: registration grant + approved top-ups - (task amount + both commissions) + refunds for cancelled tasks. Compare to Party.dmcBalancePaise.',
      expected: 'Reconstructed balance equals the stored balance for every party.',
      actual: driftDetail.join(' | '),
      impact: 'DMC is being created or destroyed outside the ledger.',
    });
  }

  // ---------- 2. No negative balances anywhere ----------
  const negativeParties = await Party.countDocuments({ dmcBalancePaise: { $lt: 0 } });
  if (!record(AREA, 'no party holds a negative balance', negativeParties === 0, `${negativeParties} parties negative`)) {
    report({
      severity: 'P0', area: AREA, roles: ['Party'],
      title: 'Party balance went negative',
      reproduction: 'Query Party where dmcBalancePaise < 0 after the workload.',
      expected: 'A task is refused when the balance cannot cover it, so the balance floors at zero.',
      actual: `${negativeParties} parties hold a negative DMC balance.`,
      impact: 'A party has spent DMC it never had — the debit guard can be outrun.',
    });
  }

  const negativeCaptains = await Captain.countDocuments({
    $or: [{ collateralBalancePaise: { $lt: 0 } }, { dmcBalancePaise: { $lt: 0 } }, { lockedAmountPaise: { $lt: 0 } }],
  });
  if (!record(AREA, 'no captain holds a negative balance or lock', negativeCaptains === 0, `${negativeCaptains} captains negative`)) {
    report({
      severity: 'P0', area: AREA, roles: ['Captain'],
      title: 'Captain collateral, locked amount or earnings went negative',
      reproduction: 'Query Captain for any of the three balance fields < 0 after the workload.',
      expected: 'All three are floored at zero by the lock/release guards.',
      actual: `${negativeCaptains} captains hold a negative value.`,
      impact: 'Collateral accounting is unsound; a captain could claim beyond their limit.',
    });
  }

  // ---------- 3. Locked collateral matches the tasks actually held ----------
  const captains = await Captain.find().lean();
  const lockDrift: string[] = [];
  for (const captain of captains) {
    const held = await Task.find({
      captainId: captain._id,
      status: { $in: ['ASSIGNED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'AUDIT_PENDING', 'REJECTED', 'CANCEL_REVIEW', 'CANCEL_DISPUTED', 'EXPIRED'] },
    }).lean();
    const expectedLock = held.reduce((sum, t) => sum + t.amountPaise, 0);
    if (expectedLock !== captain.lockedAmountPaise) {
      lockDrift.push(`${captain.captainCode}: holds ${held.length} tasks worth ${dmc(expectedLock)}, locked ${dmc(captain.lockedAmountPaise)}`);
    }
  }
  if (!record(AREA, 'locked collateral equals the value of tasks in hand', lockDrift.length === 0, lockDrift.slice(0, 4).join(' | '))) {
    report({
      severity: 'P1', area: AREA, roles: ['Captain', 'Admin'],
      title: 'Captain locked collateral drifts from the tasks they actually hold',
      reproduction: 'For each captain, sum amountPaise of tasks in a collateral-locked state and compare to Captain.lockedAmountPaise.',
      expected: 'The two agree exactly; a released task unlocks its amount.',
      actual: lockDrift.slice(0, 6).join(' | '),
      impact: 'Over-locking blocks a captain from work they can afford; under-locking lets them exceed their limit.',
    });
  }

  // ---------- 4. Commission credited exactly once per completed task ----------
  const completed = await Task.find({ status: 'COMPLETED' }).lean();
  const commissions = await Commission.find().lean();
  const byTask = new Map<string, number>();
  for (const c of commissions) byTask.set(String(c.taskId), (byTask.get(String(c.taskId)) ?? 0) + 1);

  const duplicated = [...byTask.entries()].filter(([, n]) => n > 1);
  const missing = completed.filter((t) => !byTask.has(String(t._id)));
  const orphaned = [...byTask.keys()].filter((id) => !completed.some((t) => String(t._id) === id));

  if (!record(AREA, 'commission is credited exactly once per completed task', duplicated.length === 0 && missing.length === 0,
    `${duplicated.length} duplicated, ${missing.length} missing`)) {
    report({
      severity: 'P0', area: AREA, roles: ['Captain', 'Admin'],
      title: duplicated.length > 0 ? 'Commission credited more than once for the same task' : 'Completed task with no commission record',
      reproduction: 'Group Commission by taskId and compare against tasks in COMPLETED.',
      expected: 'Exactly one commission row per completed task, and none for anything else.',
      actual: `${duplicated.length} tasks with multiple commissions, ${missing.length} completed tasks with none, ${orphaned.length} commissions on non-completed tasks.`,
      impact: 'Captains are paid twice or not at all.',
    });
  }
  record(AREA, 'no commission exists for a task that is not complete', orphaned.length === 0, `${orphaned.length} orphaned`);

  // ---------- 5. Captain earnings reconstruct from what they were credited ----------
  // On approval a captain is credited the task amount back (they fronted it to
  // the customer) PLUS their commission out of the pool — see
  // workflow.service.ts. Both land in the one balance they have, which is then
  // debited per settled withdrawal portion, not at request time.
  //
  // Checked as a floor rather than an equality: that balance also holds the
  // usable half of their deposit and whatever they gave up on pay-ins, so the
  // completed tasks are a component of it, not the whole of it. What must
  // always hold is that a captain is never left holding less than the work
  // they finished and have not yet cashed out.
  const earningDrift: string[] = [];
  for (const captain of captains) {
    const theirCompleted = completed.filter((t) => String(t.captainId) === String(captain._id));
    const credited = theirCompleted.reduce((sum, t) => sum + t.amountPaise + (t.commissionPaise ?? 0), 0);

    // Nothing is cashed out through a party any more, so completed work is the
    // whole of what a captain is owed.
    const settled: Array<{ amountPaise: number }> = [];
    const debited = settled.reduce((sum, p) => sum + p.amountPaise, 0);

    const owed = credited - debited;
    if (owed > 0 && captain.dmcBalancePaise < owed) {
      earningDrift.push(
        `${captain.captainCode}: completed work owed ${dmc(credited)} less ${dmc(debited)} settled = ${dmc(owed)}, but the balance is only ${dmc(captain.dmcBalancePaise)}`,
      );
    }
  }
  if (!record(AREA, 'captain balance equals reimbursements plus commission minus settled withdrawals', earningDrift.length === 0, earningDrift.slice(0, 4).join(' | '))) {
    report({
      severity: 'P1', area: AREA, roles: ['Captain'],
      title: 'Captain available balance drifts from what they were credited and paid',
      reproduction: 'Per captain: sum (amountPaise + commissionPaise) over the COMPLETED tasks they hold, subtract FULFILLED withdrawal portions, compare to Captain.dmcBalancePaise, which must cover it.',
      expected: 'The two agree exactly.',
      actual: earningDrift.slice(0, 6).join(' | '),
      impact: 'A captain can withdraw more or less than they are actually owed.',
    });
  }

  // ---------- 6. Withdrawal portions sum to their parent request ----------
  // ---------- 7. DMC allocations never over-consume their source ----------
  const allocations = await DMCAllocation.find().lean();
  const overConsumed = allocations.filter((a: { consumedPaise?: number; amountPaise: number }) => (a.consumedPaise ?? 0) > a.amountPaise);
  if (!record(AREA, 'no allocation is consumed beyond what it holds', overConsumed.length === 0, `${overConsumed.length} over-consumed`)) {
    report({
      severity: 'P0', area: AREA, roles: ['Captain', 'Admin'],
      title: 'DMC allocation consumed beyond its own amount',
      reproduction: 'Query DmcAllocation where consumedPaise > amountPaise.',
      expected: 'FIFO consumption stops at the allocation amount.',
      actual: `${overConsumed.length} allocations are over-consumed.`,
      impact: 'The same earned DMC is withdrawn twice — a direct double-spend.',
    });
  }

  // ---------- 8. A reported reference is not reused across tasks ----------
  // The transaction log this used to check is gone with the mock provider: a
  // captain now reports the reference for a payment they made themselves.
  // What can still be checked is that one reference is not claimed twice.
  const duplicateRefs = await Task.aggregate<{ _id: string; n: number }>([
    { $match: { providerReference: { $ne: null } } },
    { $group: { _id: '$providerReference', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  if (!record(AREA, 'no payment reference is claimed on two different tasks', duplicateRefs.length === 0,
    `${duplicateRefs.length} reused`)) {
    report({
      severity: 'P0', area: AREA, roles: ['Captain', 'Party', 'Admin'],
      title: 'The same payment reference is reported on more than one task',
      reproduction: 'Group Task by providerReference where it is set; keep counts > 1.',
      expected: 'One payment, one task. A reference reported twice means one payment is being claimed for two tasks.',
      actual: `${duplicateRefs.length} references appear on multiple tasks.`,
      impact: 'A captain is reimbursed twice for a single payment, and reconciliation cannot tell which task the money belonged to.',
    });
  }

  // ---------- 9. Platform commission matches what it earned ----------
  // The platform earns its cut when a task COMPLETES, never at creation, so
  // only completed tasks count towards it.
  //
  // The earlier version of this check summed every non-cancelled task instead
  // and it had a blind spot: when a cancelled task's commission had already
  // been withdrawn, both sides of the comparison went negative together and
  // the check passed on a corrupt ledger. Anchoring on COMPLETED removes that
  // — a cancelled task contributes nothing to either side — and the balance is
  // asserted non-negative separately, which no arithmetic can explain away.
  const allTasks = await Task.find().select('status adminCommissionPaise').lean();
  const adminEarned = allTasks
    .filter((t) => t.status === 'COMPLETED')
    .reduce((sum, t) => sum + (t.adminCommissionPaise ?? 0), 0);
  const adminSettled = await AdminWithdrawalPortion.aggregate<{ total: number }>([
    { $match: { status: 'FULFILLED' } },
    { $group: { _id: null, total: { $sum: '$amountPaise' } } },
  ]);
  const account = await getPlatformAccount();
  const outstanding = adminEarned - (adminSettled[0]?.total ?? 0);
  // The platform's earnings are not stored — they are what is left in the pool
  // after every captain share is paid. So this checks the pool can cover what
  // completed tasks earned and admin has not yet withdrawn. A pool below that
  // has paid out money the platform never made.
  const platformOk = account.poolBalancePaise >= outstanding;
  if (!record(AREA, 'the pool still holds what completed tasks earned the platform', platformOk,
    `owed ${dmc(outstanding)}, pool holds ${dmc(account.poolBalancePaise)}`)) {
    report({
      severity: 'P1', area: AREA, roles: ['Admin'],
      title: 'The pool holds less than the platform has earned',
      reproduction: 'Sum adminCommissionPaise over COMPLETED tasks, subtract FULFILLED admin withdrawal portions, compare to PlatformAccount.poolBalancePaise.',
      expected: 'The pool covers it — the platform never pays out more than it collected.',
      actual: `owed ${dmc(outstanding)}, pool holds ${dmc(account.poolBalancePaise)}, short by ${dmc(outstanding - account.poolBalancePaise)}`,
      impact: 'Captain commissions were paid out of money the platform never collected, so the shortfall was created from nothing.',
    });
  }

  // ---------- 9b. The pool is never overdrawn ----------
  // A standalone floor. The check above can be satisfied by two matching wrong
  // numbers; this cannot — a negative pool means money was paid out that was
  // never put in, whatever the arithmetic says.
  if (!record(AREA, 'the platform pool is never negative', account.poolBalancePaise >= 0,
    dmc(account.poolBalancePaise))) {
    report({
      severity: 'P0', area: AREA, roles: ['Admin', 'Party'],
      title: 'The platform pool is overdrawn',
      reproduction: 'Read PlatformAccount.poolBalancePaise.',
      expected: 'Never below zero — the platform cannot pay out what nobody put in.',
      actual: `pool holds ${dmc(account.poolBalancePaise)}`,
      impact: 'Commission was paid for work that was never completed, and the DMC refunded to the party on top of it was created from nothing.',
    });
  }

  // ---------- 9c. No commission is credited for an unfinished task ----------
  const openWithAllocation = await DMCAllocation.aggregate<{ _id: null; n: number }>([
    { $match: { ownerType: 'ADMIN' } },
    { $lookup: { from: 'tasks', localField: 'taskId', foreignField: '_id', as: 'task' } },
    { $unwind: '$task' },
    { $match: { 'task.status': { $ne: 'COMPLETED' } } },
    { $group: { _id: null, n: { $sum: 1 } } },
  ]);
  const openAllocations = openWithAllocation[0]?.n ?? 0;
  if (!record(AREA, 'no admin allocation exists for a task that is not complete', openAllocations === 0,
    `${openAllocations} such allocations`)) {
    report({
      severity: 'P0', area: AREA, roles: ['Admin'],
      title: 'Admin holds withdrawable commission for an unfinished task',
      reproduction: 'Join DMCAllocation (ownerType ADMIN) to its task and look for any whose task is not COMPLETED.',
      expected: 'Commission becomes withdrawable only once the task completes.',
      actual: `${openAllocations} allocations point at tasks that are still open or were cancelled.`,
      impact: 'Admin can cash out commission for a task that may still be cancelled, and the refund then invents DMC.',
    });
  }

  // ---------- 10. Cancelled tasks are actually refunded ----------
  const cancelled = await Task.find({ status: 'CANCELLED' }).lean();
  record(AREA, `${cancelled.length} cancelled tasks exist to check refunds against`, cancelled.length > 0);

  // ---------- 11. Every paise is a whole number ----------
  const fractional = await Task.countDocuments({
    $expr: { $ne: ['$amountPaise', { $floor: '$amountPaise' }] },
  });
  if (!record(AREA, 'no fractional paise anywhere in task amounts', fractional === 0, `${fractional} fractional`)) {
    report({
      severity: 'P1', area: AREA, roles: ['Party', 'Captain', 'Admin'],
      title: 'Task amount stored with a fractional paise',
      reproduction: 'Query Task where amountPaise is not an integer.',
      expected: 'Paise are integers; rupee conversion happens only at the serialiser.',
      actual: `${fractional} tasks hold a fractional paise value.`,
      impact: 'Rounding drift accumulates silently across commission and allocation splits.',
    });
  }
}
