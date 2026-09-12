/**
 * Comparing the independent model against what the database actually holds.
 *
 * Run after every DMC-affecting transition rather than only at the end,
 * because a ledger that is wrong in two places can reconcile to zero overall.
 * Catching it at the transition that caused it is the difference between "the
 * books are off by 200" and "cancelling a task after the platform withdrew its
 * commission refunds money that has already been paid out".
 */
import { Party, Captain, Task, PlatformAccount, DMCAllocation, Commission, DmcRedemption, Transaction } from '../../models';
import { paiseToRupees } from '../../utils/money';
import type { ExpectedLedger } from './model';

export interface Divergence {
  category: string;
  subject: string;
  expectedPaise: number;
  actualPaise: number;
}

export interface ReconResult {
  ok: boolean;
  divergences: Divergence[];
  /** Everything that is true regardless of the model — floors and duplicates. */
  violations: string[];
}

const dmc = (paise: number): string => `DMC ${paiseToRupees(paise).toLocaleString('en-IN')}`;

/** Task states in which the party's money has been committed but not resolved. */
const IN_FLIGHT_STATES = new Set([
  'CREATED', 'ASSIGNED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'AUDIT_PENDING',
  'REJECTED', 'REASSIGNED', 'EXPIRED', 'CANCEL_REVIEW', 'CANCEL_DISPUTED',
]);

export async function reconcile(expected: ExpectedLedger): Promise<ReconResult> {
  const divergences: Divergence[] = [];
  const violations: string[] = [];

  const [parties, captains, tasks, platform, allocations, commissions, redemptions, transactions] = await Promise.all([
    Party.find().select('_id dmcBalancePaise').lean(),
    Captain.find().select('_id collateralBalancePaise lockedAmountPaise dmcBalancePaise').lean(),
    Task.find().select('_id status amountPaise commissionPaise adminCommissionPaise captainId').lean(),
    PlatformAccount.findOne({ key: 'GLOBAL' }).lean(),
    DMCAllocation.find().select('taskId ownerType ownerId amountPaise availableAmountPaise status').lean(),
    Commission.find().select('taskId captainId commissionPaise').lean(),
    DmcRedemption.find().select('captainId amountPaise status').lean(),
    Transaction.find().select('_id direction status amountPaise captainId').lean(),
  ]);

  // A transaction in flight has taken DMC out of one balance without putting
  // it into another yet. Read from the transaction rows rather than from the
  // model, so a transaction the model forgot about still shows up here.
  const TXN_HELD = new Set(['ASSIGNED', 'AWAITING_CUSTOMER', 'CONFIRMED', 'DISPUTED']);
  // A pay-in commits nothing until a captain actually holds it. Payouts are
  // tasks and are counted with the tasks.
  const transactionInFlight = transactions.reduce(
    (sum, t) => (TXN_HELD.has(t.status) ? sum + t.amountPaise : sum),
    0,
  );

  // DMC a captain has asked to cash out: out of their balance, not yet out of
  // the system. It is still inside the closed loop until admin actually pays.
  const heldForRedemption = redemptions
    .filter((r) => r.status === 'PENDING')
    .reduce((sum, r) => sum + r.amountPaise, 0);

  // ---------- 1. Per-party spendable balance ----------
  for (const p of parties) {
    const id = String(p._id);
    const exp = expected.partyDmc.get(id);
    if (exp === undefined) continue;
    if (p.dmcBalancePaise !== exp) {
      divergences.push({ category: 'Party DMC', subject: id, expectedPaise: exp, actualPaise: p.dmcBalancePaise });
    }
    if (p.dmcBalancePaise < 0) violations.push(`Party ${id} holds a negative balance (${dmc(p.dmcBalancePaise)})`);
  }

  // ---------- 2. Per-captain balance, collateral and locks ----------
  for (const c of captains) {
    const id = String(c._id);
    const expDmc = expected.captainDmc.get(id);
    if (expDmc !== undefined && c.dmcBalancePaise !== expDmc) {
      divergences.push({ category: 'Captain DMC', subject: id, expectedPaise: expDmc, actualPaise: c.dmcBalancePaise });
    }
    const expColl = expected.captainCollateral.get(id);
    if (expColl !== undefined && c.collateralBalancePaise !== expColl) {
      divergences.push({ category: 'Captain collateral', subject: id, expectedPaise: expColl, actualPaise: c.collateralBalancePaise });
    }
    const expLock = expected.captainLocked.get(id);
    if (expLock !== undefined && c.lockedAmountPaise !== expLock) {
      divergences.push({ category: 'Captain locked', subject: id, expectedPaise: expLock, actualPaise: c.lockedAmountPaise });
    }
    if (c.collateralBalancePaise < 0) violations.push(`Captain ${id} has negative collateral (${dmc(c.collateralBalancePaise)})`);
    if (c.dmcBalancePaise < 0) violations.push(`Captain ${id} has a negative balance (${dmc(c.dmcBalancePaise)})`);
    if (c.lockedAmountPaise < 0) violations.push(`Captain ${id} has a negative lock (${dmc(c.lockedAmountPaise)})`);
  }

  // ---------- 3. The platform's balance ----------
  // One number: admin's funding plus every party commission collected, less
  // every captain share paid out. The platform's earnings are what is left in
  // it, which is why there is nothing else to check here.
  const actualPool = platform?.poolBalancePaise ?? 0;
  if (actualPool !== expected.platformPool) {
    divergences.push({ category: 'Commission pool', subject: 'GLOBAL', expectedPaise: expected.platformPool, actualPaise: actualPool });
  }
  if (actualPool < 0) violations.push(`Platform pool is overdrawn (${dmc(actualPool)})`);
  if (transactionInFlight !== expected.totalTransactionInFlight()) {
    divergences.push({
      category: 'Transactions in flight',
      subject: 'all open pay-ins and pay-outs',
      expectedPaise: expected.totalTransactionInFlight(),
      actualPaise: transactionInFlight,
    });
  }
  if (heldForRedemption !== expected.totalRedemptionHeld()) {
    divergences.push({
      category: 'Held for redemption',
      subject: 'all pending redemptions',
      expectedPaise: expected.totalRedemptionHeld(),
      actualPaise: heldForRedemption,
    });
  }

  // ---------- 4. In flight, read back from the tasks themselves ----------
  // Derived from task rows rather than from the model, so a task the model
  // forgot about (or one the app resolved without telling anyone) still shows.
  let actualInFlight = 0;
  for (const t of tasks) {
    if (!IN_FLIGHT_STATES.has(t.status)) continue;
    actualInFlight += t.amountPaise + (t.commissionPaise ?? 0) + (t.adminCommissionPaise ?? 0);
  }
  const expectedInFlight = expected.totalInFlight();
  if (actualInFlight !== expectedInFlight) {
    divergences.push({ category: 'In flight', subject: 'all open tasks', expectedPaise: expectedInFlight, actualPaise: actualInFlight });
  }

  // ---------- 5. The closed loop ----------
  // Independent of every per-entity check above: whatever was minted has to be
  // somewhere. Two compensating errors cancel in a per-entity view but not here.
  //
  // A pay-out the captain is holding has taken its amount out of their balance
  // and given it to nobody, so it has to be counted here too — otherwise every
  // live pay-out reads as DMC that vanished.
  const HELD_BY_CAPTAIN = new Set([
    'ASSIGNED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'AUDIT_PENDING', 'REJECTED',
    'CANCEL_REVIEW', 'CANCEL_DISPUTED',
  ]);
  const captainHolds = tasks.reduce(
    (sum, t) => (t.captainId && HELD_BY_CAPTAIN.has(t.status) ? sum + t.amountPaise : sum),
    0,
  );

  const actualTotal =
    parties.reduce((s, p) => s + p.dmcBalancePaise, 0) +
    captains.reduce((s, c) => s + c.dmcBalancePaise, 0) +
    actualPool +
    heldForRedemption +
    transactionInFlight +
    captainHolds +
    actualInFlight;
  if (actualTotal !== expected.minted) {
    divergences.push({ category: 'CLOSED LOOP', subject: 'minted vs held', expectedPaise: expected.minted, actualPaise: actualTotal });
  }

  // ---------- 6. Locks must match the tasks actually in hand ----------
  // Nothing reserves any more: a pay-out is checked against the task limit
  // rather than consuming it, and a pay-in costs the captain their DMC
  // instead. So the lock must be flat zero, and anything else is a leftover
  // from a path that should no longer write one.
  for (const c of captains) {
    if (c.lockedAmountPaise !== 0) {
      divergences.push({ category: 'Lock left behind', subject: String(c._id), expectedPaise: 0, actualPaise: c.lockedAmountPaise });
    }
  }

  // ---------- 7. Nothing credited twice, nothing stale ----------
  const commissionCount = new Map<string, number>();
  for (const c of commissions) {
    const key = String(c.taskId);
    commissionCount.set(key, (commissionCount.get(key) ?? 0) + 1);
  }
  for (const [taskId, n] of commissionCount) {
    if (n > 1) violations.push(`Task ${taskId} has ${n} commission records`);
  }
  const statusById = new Map(tasks.map((t) => [String(t._id), t.status]));
  for (const c of commissions) {
    const status = statusById.get(String(c.taskId));
    if (status && status !== 'COMPLETED') {
      violations.push(`Commission exists for task ${String(c.taskId)} which is ${status}, not COMPLETED`);
    }
  }
  for (const a of allocations) {
    const status = statusById.get(String(a.taskId));
    if (status && status !== 'COMPLETED') {
      violations.push(`${a.ownerType} allocation exists for task ${String(a.taskId)} which is ${status}, not COMPLETED`);
    }
    if (a.amountPaise < 0) violations.push(`Allocation on task ${String(a.taskId)} has a negative amount`);
    if ((a.availableAmountPaise ?? 0) < 0) violations.push(`Allocation on task ${String(a.taskId)} has a negative remainder`);
  }
  const allocSeen = new Set<string>();
  for (const a of allocations) {
    const key = `${String(a.taskId)}:${a.ownerType}`;
    if (allocSeen.has(key)) violations.push(`Duplicate ${a.ownerType} allocation for task ${String(a.taskId)}`);
    allocSeen.add(key);
  }

  return { ok: divergences.length === 0 && violations.length === 0, divergences, violations };
}

export function describe(result: ReconResult): string {
  const lines: string[] = [];
  for (const d of result.divergences) {
    lines.push(
      `  [${d.category}] ${d.subject}\n` +
      `      expected ${dmc(d.expectedPaise)}   actual ${dmc(d.actualPaise)}   difference ${dmc(d.actualPaise - d.expectedPaise)}`,
    );
  }
  for (const v of result.violations) lines.push(`  [violation] ${v}`);
  return lines.join('\n');
}
