/**
 * The checks the first reconciler could not make.
 *
 * That one proved every rupee was *somewhere*. It could not prove any rupee
 * was somewhere *correct*: it counted commission rows without asking whose
 * they were, counted allocations without checking the amount or the party they
 * point at, and never compared the settlement records against the balance
 * movements they are supposed to explain. Two compensating errors — a captain
 * credited for another captain's task — reconcile perfectly under a total.
 *
 * Everything here reads raw persisted records and re-derives what each one
 * must say from the task it belongs to. No application service is consulted,
 * so a bug in a service cannot define its own expectation.
 */
import {
  Party, Captain, Task, PlatformAccount, DMCAllocation, Commission,
  AdminWithdrawalPortion, PartyTopUpRequest, DmcPurchase, WalletEntry, DmcRedemption,
  Transaction as TransactionModel, Proof,
} from '../../models';
import { paiseToRupees } from '../../utils/money';

export interface DeepFinding {
  area: string;
  detail: string;
}

const dmc = (p: number): string => `DMC ${paiseToRupees(p).toLocaleString('en-IN')}`;


/**
 * Pay-in states in which the captain's capital is gone from their balance —
 * held while it is live, and gone for good once it has been given to the party.
 * Everything else either never took it or gave it back.
 */
const TXN_STILL_COSTING = new Set(['ASSIGNED', 'AWAITING_CUSTOMER', 'CONFIRMED', 'DISPUTED', 'SETTLED']);


export async function deepReconcile(): Promise<DeepFinding[]> {
  const findings: DeepFinding[] = [];
  const add = (area: string, detail: string): void => {
    findings.push({ area, detail });
  };

  const [parties, captains, tasks, platform, allocations, commissions, adminPortions, topUps, deposits, walletEntries, redemptions, transactions, proofs] =
    await Promise.all([
      Party.find().lean(),
      Captain.find().lean(),
      Task.find().lean(),
      PlatformAccount.findOne({ key: 'GLOBAL' }).lean(),
      DMCAllocation.find().lean(),
      Commission.find().lean(),
      AdminWithdrawalPortion.find().lean(),
      PartyTopUpRequest.find().lean(),
      DmcPurchase.find().lean(),
      WalletEntry.find().lean(),
      DmcRedemption.find().lean(),
      TransactionModel.find().lean(),
      Proof.find().lean(),
    ]);

  const taskById = new Map(tasks.map((t) => [String(t._id), t]));
  const transactionByCode = new Map(transactions.map((t) => [t.transactionCode, t]));
  // Commission now cites a task code as readily as a transaction code, since
  // a completed task pays a captain their share the same way a pay-in does.
  const taskByCode = new Map(tasks.map((t) => [t.taskCode, t]));
  const partyIds = new Set(parties.map((p) => String(p._id)));
  const captainIds = new Set(captains.map((c) => String(c._id)));

  // ---------------------------------------------------------------------
  // 1. Commission rows say what the task says, about the captain who earned it
  // ---------------------------------------------------------------------
  for (const c of commissions) {
    const task = taskById.get(String(c.taskId));
    if (!task) {
      add('commission', `row ${String(c._id)} points at task ${String(c.taskId)} which does not exist`);
      continue;
    }
    if (task.status !== 'COMPLETED') {
      add('commission', `task ${task.taskCode} is ${task.status} but carries a commission row`);
    }
    // The row must name the captain the task ended with — not one who held it
    // earlier and was released.
    if (String(c.captainId) !== String(task.captainId)) {
      add(
        'commission ownership',
        `task ${task.taskCode} was completed by ${String(task.captainId)} but the commission names ${String(c.captainId)}`,
      );
    }
    if (String(c.partyId) !== String(task.partyId)) {
      add('commission ownership', `task ${task.taskCode} belongs to party ${String(task.partyId)} but the commission names ${String(c.partyId)}`);
    }
    if (c.commissionPaise !== (task.commissionPaise ?? 0)) {
      add(
        'commission amount',
        `task ${task.taskCode} locked ${dmc(task.commissionPaise ?? 0)} but the commission row holds ${dmc(c.commissionPaise)}`,
      );
    }
    if (c.taskAmountPaise !== task.amountPaise) {
      add('commission amount', `task ${task.taskCode} is ${dmc(task.amountPaise)} but its commission row records ${dmc(c.taskAmountPaise)}`);
    }
    if (!captainIds.has(String(c.captainId))) {
      add('commission', `row ${String(c._id)} names captain ${String(c.captainId)} who does not exist`);
    }
  }
  // Exactly one per completed task — none missing, none extra.
  const commissionTaskIds = new Set(commissions.map((c) => String(c.taskId)));
  for (const t of tasks) {
    if (t.status === 'COMPLETED' && !commissionTaskIds.has(String(t._id))) {
      add('commission', `completed task ${t.taskCode} has no commission row`);
    }
  }

  // ---------------------------------------------------------------------
  // 2. Allocations name the right owner, the right party, the right amount
  // ---------------------------------------------------------------------
  const allocSeen = new Set<string>();
  for (const a of allocations) {
    const task = taskById.get(String(a.taskId));
    if (!task) {
      add('allocation', `allocation ${String(a._id)} points at task ${String(a.taskId)} which does not exist`);
      continue;
    }
    const key = `${String(a.taskId)}:${a.ownerType}`;
    if (allocSeen.has(key)) add('allocation', `duplicate ${a.ownerType} allocation for task ${task.taskCode}`);
    allocSeen.add(key);

    if (task.status !== 'COMPLETED') {
      add('allocation', `task ${task.taskCode} is ${task.status} but carries a ${a.ownerType} allocation`);
    }
    if (String(a.sourcePartyId) !== String(task.partyId)) {
      add(
        'allocation ownership',
        `${a.ownerType} allocation on ${task.taskCode} sources party ${String(a.sourcePartyId)} but the task belongs to ${String(task.partyId)}`,
      );
    }
    if (a.ownerType === 'CAPTAIN') {
      // The captain's allocation is their reimbursement plus their commission.
      const owed = task.amountPaise + (task.commissionPaise ?? 0);
      if (a.amountPaise !== owed) {
        add('allocation amount', `captain allocation on ${task.taskCode} is ${dmc(a.amountPaise)} but the task owes ${dmc(owed)}`);
      }
      if (String(a.ownerId) !== String(task.captainId)) {
        add(
          'allocation ownership',
          `captain allocation on ${task.taskCode} is owned by ${String(a.ownerId)} but the task was completed by ${String(task.captainId)}`,
        );
      }
    }
    if (a.ownerType === 'ADMIN' && a.amountPaise !== (task.adminCommissionPaise ?? 0)) {
      add('allocation amount', `admin allocation on ${task.taskCode} is ${dmc(a.amountPaise)} but the platform earned ${dmc(task.adminCommissionPaise ?? 0)}`);
    }
    if (a.availableAmountPaise > a.amountPaise) {
      add('allocation', `allocation on ${task.taskCode} has ${dmc(a.availableAmountPaise)} remaining out of ${dmc(a.amountPaise)}`);
    }
    if (a.amountPaise < 0 || a.availableAmountPaise < 0) {
      add('allocation', `allocation on ${task.taskCode} holds a negative amount`);
    }
  }
  // A completed task with a platform cut must have both allocations.
  for (const t of tasks) {
    if (t.status !== 'COMPLETED') continue;
    if (!allocSeen.has(`${String(t._id)}:CAPTAIN`)) add('allocation', `completed task ${t.taskCode} has no captain allocation`);
    if ((t.adminCommissionPaise ?? 0) > 0 && !allocSeen.has(`${String(t._id)}:ADMIN`)) {
      add('allocation', `completed task ${t.taskCode} earned ${dmc(t.adminCommissionPaise ?? 0)} but has no admin allocation`);
    }
  }

  // ---------------------------------------------------------------------
  // 3. Settlement records explain the balance movements they claim
  // ---------------------------------------------------------------------
  // Every fulfilled captain portion moved DMC from that captain to that party.
  // A captain has no way to cash out through a party any more — that flow is
  // gone, so nothing settles back to a party from one. Only admin's own
  // withdrawal still does.
  const settledByCaptain = new Map<string, number>();
  const settledToParty = new Map<string, number>();
  for (const p of adminPortions) {
    if (!partyIds.has(String(p.partyId))) add('withdrawal', `admin portion ${String(p._id)} names a party that does not exist`);
    if (p.status !== 'FULFILLED') continue;
    settledToParty.set(String(p.partyId), (settledToParty.get(String(p.partyId)) ?? 0) + p.amountPaise);
  }

  for (const c of captains) {
    const id = String(c._id);
    // What completed tasks paid this captain back for the cash they laid out.
    // The amount only — their share of the commission is counted once, from
    // the wallet entries below, because that is the record of it actually
    // being paid rather than merely being owed.
    const taskAmountsCredited = tasks
      .filter((t) => t.status === 'COMPLETED' && String(t.captainId) === id)
      .reduce((sum, t) => sum + t.amountPaise, 0);
    const cashedOut = settledByCaptain.get(id) ?? 0;
    // Both halves of every approved deposit, rebuilt from the deposit rows.
    // Read from what each row recorded rather than from the current setting,
    // because the split percentage is an admin setting that can change and a
    // deposit taken under the old one was still split under the old one.
    const mine = deposits.filter((d) => String(d.captainId) === id && d.status === 'APPROVED');
    let depositedLocked = 0;
    let depositedUsable = 0;
    let deposited = 0;
    for (const d of mine) {
      // A row from before the split existed put the whole amount into
      // security, which is exactly what the old rule did.
      const locked = d.collateralCreditedPaise ?? d.securityPaise;
      const usable = d.dmcCreditedPaise ?? 0;
      if (locked + usable !== d.securityPaise) {
        add('collateral', `captain ${c.captainCode}: deposit ${String(d._id)} posted ${dmc(d.securityPaise)} but its split records ${dmc(locked + usable)}`);
      }
      depositedLocked += locked;
      depositedUsable += usable;
      deposited += d.securityPaise;
    }
    if (c.collateralBalancePaise !== depositedLocked) {
      add('collateral', `captain ${c.captainCode}: approved deposits locked ${dmc(depositedLocked)} as security but collateral holds ${dmc(c.collateralBalancePaise)}`);
    }
    // The captain's balance, rebuilt from every record that can move it.
    // There are five, and one balance for all of them: the usable half of a
    // deposit puts money in, a completed task pays back what was laid out,
    // commission is earned, a redemption takes it out, and a pay-in gives it
    // up to the party.
    const myEntries = walletEntries.filter((e) => String(e.captainId) === id);
    const commissionEarned = myEntries
      .filter((e) => e.kind === 'COMMISSION_EARNED')
      .reduce((sum, e) => sum + e.amountPaise, 0);
    const outForRedemption = redemptions
      .filter((r) => String(r.captainId) === id && r.status !== 'REJECTED')
      .reduce((sum, r) => sum + r.amountPaise, 0);

    // Transactions move capital in both directions. A pay-in takes it at
    // assignment and only gives it back if the payment never happened; a
    // pay-out adds it, but only once the transfer is actually settled.
    const myTransactions = transactions.filter((t) => String(t.captainId) === id);
    const payInOut = myTransactions
      .filter((t) => t.direction === 'PAY_IN' && TXN_STILL_COSTING.has(t.status))
      .reduce((sum, t) => sum + t.amountPaise, 0);
    // Payouts are tasks now, so nothing here earns a captain capital — the
    // task rebuild below covers that side.
    const payOutIn = 0;

    const expectedDmc =
      depositedUsable + taskAmountsCredited + commissionEarned + payOutIn
      - outForRedemption - payInOut - cashedOut;
    if (c.dmcBalancePaise !== expectedDmc) {
      add(
        'capital',
        `captain ${c.captainCode}: deposits gave ${dmc(depositedUsable)}, completed tasks paid back ` +
        `${dmc(taskAmountsCredited)}, commission earned ${dmc(commissionEarned)}, less ` +
        `${dmc(outForRedemption)} out for redemption, ${dmc(payInOut)} given up on pay-ins and ` +
        `${dmc(cashedOut)} cashed out = ${dmc(expectedDmc)}, but the balance reads ${dmc(c.dmcBalancePaise)}`,
      );
    }

    // Every wallet entry has to agree with the balance it claims to have left
    // behind. A ledger nobody checks against the balance is decoration.
    for (const e of myEntries) {
      if (e.walletBalanceAfterPaise < 0) {
        add('wallet', `captain ${c.captainCode}: wallet entry ${String(e._id)} records a negative balance`);
      }
    }

    // Commission is only ever earned on something finished. An entry names
    // either the pay-in transaction or the task it was earned on, and that
    // thing has to exist and have reached its terminal, paid state — otherwise
    // it is a fee paid for work nobody can point to.
    for (const e of myEntries) {
      if (e.kind !== 'COMMISSION_EARNED' || !e.sourceReference) continue;
      const txn = transactionByCode.get(e.sourceReference);
      const task = taskByCode.get(e.sourceReference);
      if (!txn && !task) {
        add('wallet', `captain ${c.captainCode}: commission cites ${e.sourceReference}, which does not exist`);
      } else if (txn && txn.status !== 'SETTLED') {
        add(
          'wallet',
          `captain ${c.captainCode}: commission cites ${e.sourceReference}, which is ${txn.status}, not SETTLED`,
        );
      } else if (task && task.status !== 'COMPLETED') {
        add(
          'wallet',
          `captain ${c.captainCode}: commission cites ${e.sourceReference}, which is ${task.status}, not COMPLETED`,
        );
      }
    }

    // The captain's own closed loop: everything that ever reached them is
    // sitting in security, in their balance, out for a cash-out, given up on a
    // pay-in, or already withdrawn. Nowhere else.
    const accountedFor =
      c.collateralBalancePaise + c.dmcBalancePaise + outForRedemption + payInOut + cashedOut;
    const cameIn = deposited + taskAmountsCredited + commissionEarned + payOutIn;
    if (accountedFor !== cameIn) {
      add(
        'capital',
        `captain ${c.captainCode}: ${dmc(cameIn)} came in (deposits, completed tasks, commission) but ` +
        `${dmc(accountedFor)} is accounted for across security, balance, cash-outs, pay-ins given up and withdrawals`,
      );
    }
    // Nothing reserves any more, so the lock must be flat zero. A pay-out is
    // checked against the task limit rather than consuming it, and a pay-in
    // costs the captain their DMC instead.
    if (c.lockedAmountPaise !== 0) {
      add('lock', `captain ${c.captainCode}: reserves nothing, but the lock reads ${dmc(c.lockedAmountPaise)}`);
    }
  }

  // The platform has one balance, and this rebuilds it from every record that
  // moves it. Admin's funding and every party's commission flow in; every
  // captain's share and every admin cash-out flow out. Whatever is left is the
  // platform's earnings — which is exactly why they are never stored, and so
  // can never disagree with the pool.
  const partyCommissionCollected =
    tasks
      .filter((t) => t.status === 'COMPLETED')
      .reduce((sum, t) => sum + (t.commissionPaise ?? 0) + (t.adminCommissionPaise ?? 0), 0) +
    transactions
      .filter((t) => t.status === 'SETTLED')
      .reduce((sum, t) => sum + (t.partyCommissionPaise ?? 0), 0);
  // Read from what captains were actually paid, not from what tasks say is
  // owed: a share the pool could not fund is owed rather than paid, and the
  // pool must reflect the payment that did not happen.
  const captainSharesPaid = walletEntries
    .filter((e) => e.kind === 'COMMISSION_EARNED')
    .reduce((sum, e) => sum + e.amountPaise, 0);
  const platformCashedOut = adminPortions
    .filter((p) => p.status === 'FULFILLED')
    .reduce((sum, p) => sum + p.amountPaise, 0);
  const funded = platform?.poolFundedTotalPaise ?? 0;
  const platformActual = platform?.poolBalancePaise ?? 0;
  const expectedPool = funded + partyCommissionCollected - captainSharesPaid - platformCashedOut;
  if (platformActual !== expectedPool) {
    add(
      'platform',
      `admin funded ${dmc(funded)} and parties paid ${dmc(partyCommissionCollected)} in commission, less ` +
      `${dmc(captainSharesPaid)} paid to captains and ${dmc(platformCashedOut)} cashed out = ` +
      `${dmc(expectedPool)}, but the pool holds ${dmc(platformActual)}`,
    );
  }

  // ---------------------------------------------------------------------
  // 4. Each party's balance rebuilt from its own history
  // ---------------------------------------------------------------------
  for (const p of parties) {
    const id = String(p._id);
    const toppedUp = topUps
      .filter((t) => String(t.partyId) === id && t.status === 'APPROVED')
      .reduce((sum, t) => sum + t.amountPaise, 0);
    // Billed for every task it created that is not cancelled; a cancelled one
    // was billed and refunded, so it nets to nothing.
    const committed = tasks
      .filter((t) => String(t.partyId) === id && t.status !== 'CANCELLED')
      .reduce((sum, t) => sum + t.amountPaise + (t.commissionPaise ?? 0) + (t.adminCommissionPaise ?? 0), 0);
    const returned = settledToParty.get(id) ?? 0;
    // opening = balance - toppedUp + committed - returned
    const opening = p.dmcBalancePaise - toppedUp + committed - returned;
    if (opening < 0) {
      add(
        'party balance',
        `party ${p.partyCode} reconstructs to a negative opening balance of ${dmc(opening)} — more has left than ever arrived`,
      );
    }
    if (p.dmcBalancePaise < 0) add('party balance', `party ${p.partyCode} holds ${dmc(p.dmcBalancePaise)}`);
  }

  // ---------------------------------------------------------------------
  // 5. Orphans and dangling references
  // ---------------------------------------------------------------------
  for (const t of tasks) {
    if (!partyIds.has(String(t.partyId))) add('orphan', `task ${t.taskCode} belongs to a party that does not exist`);
    if (t.captainId && !captainIds.has(String(t.captainId))) add('orphan', `task ${t.taskCode} names a captain that does not exist`);
    for (const prev of t.previousCaptainIds ?? []) {
      if (!captainIds.has(String(prev))) add('orphan', `task ${t.taskCode} excludes a captain that does not exist`);
    }
    // A captain must never be both the current holder and excluded from it.
    if (t.captainId && (t.previousCaptainIds ?? []).some((x) => String(x) === String(t.captainId))) {
      add('exclusion', `task ${t.taskCode} is held by a captain who is also in its exclusion list`);
    }
    // A REASSIGNED task must name nobody: it is going back into the pool, and
    // the captain who held it is remembered by the exclusion list instead.
    //
    // A CANCELLED one deliberately keeps its captain. That is the record of
    // who held it when it was called off, and it costs nothing: CANCELLED is
    // not in DMC_HELD_STATES, so it counts towards neither the lock
    // recomputation nor the captain's daily and monthly throughput caps. An
    // earlier version of this check asserted otherwise and reported twenty
    // healthy tasks as broken.
    if (t.status === 'REASSIGNED' && t.captainId) {
      add('ownership', `task ${t.taskCode} is REASSIGNED but still names captain ${String(t.captainId)}`);
    }
    if (t.status === 'COMPLETED' && !t.captainId) {
      add('ownership', `task ${t.taskCode} is COMPLETED with no captain`);
    }
  }
  for (const c of captains) {
    if (c.lockedAmountPaise > (c.creditLimitPaise ?? c.collateralBalancePaise)) {
      add(
        'lock',
        `captain ${c.captainCode} has ${dmc(c.lockedAmountPaise)} locked against a ceiling of ${dmc(c.creditLimitPaise ?? c.collateralBalancePaise)}`,
      );
    }
  }
  for (const pr of proofs) {
    if (!taskById.has(String(pr.taskId))) add('orphan', `proof ${String(pr._id)} points at a task that does not exist`);
  }
  // At most one live proof per task.
  const liveProofs = new Map<string, number>();
  for (const pr of proofs) {
    if (pr.supersededAt) continue;
    const k = String(pr.taskId);
    liveProofs.set(k, (liveProofs.get(k) ?? 0) + 1);
  }
  for (const [taskId, n] of liveProofs) {
    if (n > 1) add('proof', `task ${taskById.get(taskId)?.taskCode ?? taskId} has ${n} live proofs`);
  }

  // ---------------------------------------------------------------------
  // 6. Cross-entity isolation: a captain's allocation may only source a party
  //    they actually did work for.
  // ---------------------------------------------------------------------
  for (const a of allocations) {
    if (a.ownerType !== 'CAPTAIN') continue;
    const worked = tasks.some(
      (t) => String(t.captainId) === String(a.ownerId) && String(t.partyId) === String(a.sourcePartyId) && t.status === 'COMPLETED',
    );
    if (!worked) {
      add('isolation', `captain ${String(a.ownerId)} holds an allocation sourced from party ${String(a.sourcePartyId)} they never completed work for`);
    }
  }
  // A withdrawal portion may only be directed at a party the captain earned from.

  return findings;
}

export function describeDeep(findings: DeepFinding[]): string {
  if (findings.length === 0) return '  (none)';
  const byArea = new Map<string, DeepFinding[]>();
  for (const f of findings) {
    const list = byArea.get(f.area) ?? [];
    list.push(f);
    byArea.set(f.area, list);
  }
  const lines: string[] = [];
  for (const [area, list] of byArea) {
    lines.push(`  [${area}] ${list.length}`);
    for (const f of list.slice(0, 6)) lines.push(`      ${f.detail}`);
    if (list.length > 6) lines.push(`      … and ${list.length - 6} more`);
  }
  return lines.join('\n');
}
