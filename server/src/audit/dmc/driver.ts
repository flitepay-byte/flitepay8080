/**
 * Driving the real application while keeping independent books.
 *
 * Every action here does three things in order: perform the operation through
 * the same service the HTTP layer calls, apply the business rule to the
 * independent ledger, then reconcile. The reconciliation is deliberately after
 * *every* DMC-affecting step rather than at the end of a scenario — a ledger
 * wrong in two places can add up to right, and the transition that broke it is
 * the only thing that identifies the bug.
 *
 * When a step diverges the run stops and prints everything needed to
 * reproduce: the scenario, the event, both sets of numbers, and the task's own
 * state history.
 */
import { Types } from 'mongoose';
import {
  User, Party, Captain, Task, AdminWithdrawalPortion,
  hashPassword, type ITask,
} from '../../models';
import { getConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import {
  startTask, submitProof, approveTask, rejectTask, resolveTaskRejection,
  requestCancellation, reviewCancellationAsCaptain, reviewCancellationAsParty,
  resolveCancelDispute, expireStaleUnclaimedTasks, expireOverdueTasks,
  rejectExpiredTask, reclaimUnacknowledgedExpiredTasks,
} from '../../services/workflow.service';
import {
  requestPlatformWithdrawal, submitPlatformPortionPaymentProof,
  confirmPlatformPortionReceipt, disputePlatformPortionReceipt, resolvePlatformPortionDispute,
} from '../../services/adminWithdrawal.service';
import { requestTopUp, approveTopUp, rejectTopUp } from '../../services/partyTopUp.service';
import { requestDeposit, approveDeposit, rejectDeposit } from '../../services/dmcPurchase.service';
import { fundPlatformPool } from '../../services/platformAccount.service';
import {
  createPayIn,
  assignCaptain,
  openToCustomer,
  confirmMovement,
  settle as settleTransaction,
  expire as expireTransaction,
} from '../../services/transaction.service';
import {
  payCommissionToCaptain,
  requestRedemption,
  markRedemptionPaid,
  rejectRedemption,
} from '../../services/captainBalance.service';
import { percentOfPaise, rupeesToPaise, paiseToRupees } from '../../utils/money';
import { ExpectedLedger } from './model';
import { reconcile, describe } from './reconcile';
import { depositSplit } from './split';

export interface Actor {
  userId: string;
  role: 'ADMIN' | 'PARTY' | 'CAPTAIN';
}

export interface PartyRef {
  id: Types.ObjectId;
  userId: Types.ObjectId;
  actor: Actor;
}
export interface CaptainRef {
  id: Types.ObjectId;
  userId: Types.ObjectId;
  actor: Actor;
}

export class AccountingError extends Error {}

let transitions = 0;
let dmcTransitions = 0;
export const counters = {
  get transitions(): number {
    return transitions;
  },
  get dmcTransitions(): number {
    return dmcTransitions;
  },
  reset(): void {
    transitions = 0;
    dmcTransitions = 0;
  },
};

export class World {
  readonly ledger = new ExpectedLedger();
  admin!: Actor;
  scenario = '(setup)';

  /** Where the run stops. Everything needed to reproduce goes in the message. */
  private async check(event: string, subject?: { taskId?: string }): Promise<void> {
    dmcTransitions += 1;
    const result = await reconcile(this.ledger);
    if (result.ok) return;

    const lines = [
      '',
      '================ DMC ACCOUNTING DIVERGENCE ================',
      `scenario : ${this.scenario}`,
      `event    : ${event}`,
    ];
    if (subject?.taskId) {
      const task = await Task.findById(subject.taskId).lean();
      lines.push(`task     : ${task?.taskCode ?? subject.taskId} (${task?.status ?? 'unknown'})`);
      if (task) {
        lines.push(
          `amounts  : amount ${paiseToRupees(task.amountPaise)}` +
          ` captainComm ${paiseToRupees(task.commissionPaise ?? 0)}` +
          ` platformComm ${paiseToRupees(task.adminCommissionPaise ?? 0)}`,
        );
        lines.push(`captain  : ${task.captainId ? String(task.captainId) : 'none'}`);
        lines.push(`previous : ${(task.previousCaptainIds ?? []).map(String).join(', ') || 'none'}`);
        lines.push('history  :');
        for (const h of task.stateHistory ?? []) {
          lines.push(`    ${h.from ?? 'null'} -> ${h.to}  by ${h.actorRole ?? 'system'}${h.reason ? ` (${h.reason})` : ''}`);
        }
      }
    }
    lines.push('divergences:', describe(result), '===========================================================');
    throw new AccountingError(lines.join('\n'));
  }

  // -------------------------------------------------------------- world set-up

  async createParty(label: string, openingRupees?: number): Promise<PartyRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `party-${unique}@dmc.audit`,
      passwordHash: await hashPassword('Demo@12345'),
      name: label,
      role: 'PARTY',
    });
    const config = await getConfig();
    const opening = openingRupees != null ? rupeesToPaise(openingRupees) : config.partyRegistrationDmcPaise;
    const party = await Party.create({
      userId: user._id,
      partyCode: `PARTY-${unique.slice(-6).toUpperCase()}`,
      companyName: label,
      contactEmail: user.email,
      dmcBalancePaise: opening,
    });
    this.ledger.registerParty(String(party._id), opening);
    return { id: party._id, userId: user._id, actor: { userId: String(user._id), role: 'PARTY' } };
  }

  async createCaptain(label: string): Promise<CaptainRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@dmc.audit`,
      passwordHash: await hashPassword('Demo@12345'),
      name: label,
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${unique.slice(-6).toUpperCase()}`,
      displayName: label,
      collateralBalancePaise: 0,
      lockedAmountPaise: 0,
      isOnline: true,
      status: 'ACTIVE',
    });
    this.ledger.registerCaptain(String(captain._id));
    return { id: captain._id, userId: user._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  async createAdmin(): Promise<Actor> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `admin-${unique}@dmc.audit`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Audit Admin',
      role: 'ADMIN',
    });
    this.admin = { userId: String(user._id), role: 'ADMIN' };
    return this.admin;
  }

  // ------------------------------------------------------------- collateral

  /** Post security money and have admin confirm it. Collateral, never DMC. */
  async postCollateral(captain: CaptainRef, rupees: number, approve = true): Promise<void> {
    const amountPaise = rupeesToPaise(rupees);
    const req = await requestDeposit(captain.id, amountPaise, captain.actor);
    transitions += 1;
    if (approve) {
      const approved = await approveDeposit(String(req._id), this.admin);
      // Derived from the rule, not read back from the captain's row.
      const split = await depositSplit(approved.securityPaise);
      this.ledger.depositApproved(String(captain.id), split.lockedPaise, split.usablePaise);
      await this.check(`collateral deposit approved (${rupees})`);
    } else {
      await rejectDeposit(String(req._id), 'Payment never arrived in the account', this.admin);
      this.ledger.depositRejected();
      await this.check(`collateral deposit rejected (${rupees})`);
    }
  }

  // ----------------------------------------------------------------- top-ups

  async topUp(party: PartyRef, rupees: number, approve = true): Promise<void> {
    const amountPaise = rupeesToPaise(rupees);
    const req = await requestTopUp(party.id, amountPaise, party.actor);
    transitions += 1;
    if (approve) {
      await approveTopUp(String(req._id), this.admin);
      this.ledger.topUpApproved(String(party.id), amountPaise);
      await this.check(`top-up approved (${rupees})`);
    } else {
      await rejectTopUp(String(req._id), 'Payment never arrived in the account', this.admin);
      this.ledger.topUpRejected();
      await this.check(`top-up rejected (${rupees})`);
    }
  }

  // ------------------------------------------------------------------- tasks

  /**
   * Create a task and independently derive what it must cost.
   *
   * The commissions are computed here from the configured rates rather than
   * read off the created task, so a task billed at the wrong rate shows up as
   * a divergence rather than being quietly adopted as "expected".
   */
  async createTask(party: PartyRef, amountRupees: number, customerName = 'Audit Customer'): Promise<ITask> {
    const config = await getConfig();
    const amountPaise = rupeesToPaise(amountRupees);

    // Derived from the rule, not read back from the task. One rate is charged
    // to the party; the captain's share is capped at it and the remainder is
    // the platform's — so the two halves always add back to what was billed.
    const partyChargePaise = percentOfPaise(amountPaise, config.payOutPartyCommissionPercentage);
    const captainCommissionPaise = Math.min(
      percentOfPaise(amountPaise, config.payOutCaptainCommissionPercentage),
      partyChargePaise,
    );
    const platformCommissionPaise = partyChargePaise - captainCommissionPaise;

    const task = await createTask(
      {
        partyId: party.id,
        createdBy: party.userId,
        customerName,
        amountPaise,
        payoutMethod: { type: 'UPI', upiId: 'audit@bank' },
      },
      party.actor,
    );
    transitions += 1;

    this.ledger.taskCreated({
      taskId: String(task._id),
      partyId: String(party.id),
      amountPaise,
      captainCommissionPaise,
      platformCommissionPaise,
    });
    await this.check(`task created (${amountRupees})`, { taskId: String(task._id) });
    return task;
  }

  /** Open the task to anyone, so a chosen captain can claim it deterministically. */
  async openToPool(taskId: string): Promise<void> {
    await Task.updateOne(
      { _id: taskId },
      { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } },
    );
  }

  async claim(taskId: string, captain: CaptainRef): Promise<void> {
    await this.openToPool(taskId);
    await claimTask(taskId, captain.id, captain.actor);
    transitions += 1;
    this.ledger.taskClaimed(taskId, String(captain.id));
    await this.check('task claimed', { taskId });
  }

  async start(taskId: string, captain: CaptainRef): Promise<void> {
    await startTask(taskId, captain.id, captain.actor);
    transitions += 1;
  }

  async submitProof(taskId: string, captain: CaptainRef, reference?: string): Promise<void> {
    await submitProof(
      { taskId, captainId: captain.id, providerReference: reference ?? `UTR${Date.now()}${Math.floor(Math.random() * 10_000)}` },
      captain.actor,
    );
    transitions += 1;
  }

  async approve(taskId: string, party: PartyRef, captain: CaptainRef): Promise<void> {
    await approveTask(taskId, party.actor);
    transitions += 1;
    this.ledger.collateralReleased(taskId, String(captain.id));
    this.ledger.taskCompleted(taskId, String(captain.id));
    await this.check('proof approved -> task completed', { taskId });
  }

  /** The party rejects the proof. Money does not move; the task waits for admin. */
  async rejectProof(taskId: string, party: PartyRef, reason = 'Beneficiary never received it'): Promise<void> {
    await rejectTask(taskId, reason, 'NOT_RECEIVED', party.actor);
    transitions += 1;
    await this.check('proof rejected by party', { taskId });
  }

  /** Admin's ruling on a rejected proof: overrule it, or send it back to the pool. */
  async resolveRejection(taskId: string, decision: 'APPROVE' | 'REASSIGN', captain: CaptainRef): Promise<void> {
    await resolveTaskRejection(taskId, decision, this.admin);
    transitions += 1;
    this.ledger.collateralReleased(taskId, String(captain.id));
    if (decision === 'APPROVE') this.ledger.taskCompleted(taskId, String(captain.id));
    await this.check(`admin resolved rejection (${decision})`, { taskId });
  }

  /** A captain hands back a task they hold; it returns to the pool. */
  async captainRejectsHeldTask(taskId: string, captain: CaptainRef, party: PartyRef): Promise<void> {
    await requestCancellation(taskId, 'Cannot complete this one', captain.actor);
    transitions += 1;
    await reviewCancellationAsParty(taskId, party.id, 'REJECT', 'Please continue', party.actor);
    transitions += 1;
    // Party disputed the captain's cancellation -> admin decides.
    await resolveCancelDispute(taskId, 'REASSIGN', this.admin);
    transitions += 1;
    this.ledger.collateralReleased(taskId, String(captain.id));
    await this.check('captain released off task by admin', { taskId });
  }

  // ------------------------------------------------------------ cancellation

  /** Cancel a task nobody holds. Straight to CANCELLED with a full refund. */
  async cancelUnheld(taskId: string, party: PartyRef): Promise<void> {
    await requestCancellation(taskId, 'Customer backed out', party.actor);
    transitions += 1;
    this.ledger.taskCancelled(taskId);
    await this.check('unheld task cancelled', { taskId });
  }

  /** Cancel a task a captain holds: they must approve it first. */
  async cancelHeld(taskId: string, party: PartyRef, captain: CaptainRef): Promise<void> {
    await requestCancellation(taskId, 'Customer backed out', party.actor);
    transitions += 1;
    await reviewCancellationAsCaptain(taskId, captain.id, 'APPROVE', undefined, captain.actor);
    transitions += 1;
    this.ledger.collateralReleased(taskId, String(captain.id));
    this.ledger.taskCancelled(taskId);
    await this.check('held task cancelled by agreement', { taskId });
  }

  /** The captain disputes the cancellation and admin cancels it anyway. */
  async cancelDisputedThenApproved(taskId: string, party: PartyRef, captain: CaptainRef): Promise<void> {
    await requestCancellation(taskId, 'Customer backed out', party.actor);
    transitions += 1;
    await reviewCancellationAsCaptain(taskId, captain.id, 'REJECT', 'I already started work', captain.actor);
    transitions += 1;
    await resolveCancelDispute(taskId, 'REASSIGN', this.admin);
    transitions += 1;
    this.ledger.collateralReleased(taskId, String(captain.id));
    await this.check('cancellation disputed, admin reassigned', { taskId });
  }

  // ------------------------------------------------------------------ expiry

  /** Sweep tasks nobody ever claimed. They are cancelled and refunded. */
  async expireUnclaimed(taskIds: string[]): Promise<void> {
    const cutoff = new Date(Date.now() - 48 * 60 * 60_000);
    // Straight through the driver: Mongoose marks `createdAt` immutable under
    // `timestamps: true`, so a model-level $set on it is silently dropped and
    // the tasks stay young — which made this whole scenario a no-op.
    await Task.collection.updateMany(
      { _id: { $in: taskIds.map((id) => new Types.ObjectId(id)) } },
      { $set: { createdAt: cutoff } },
    );
    const cancelled = await expireStaleUnclaimedTasks();
    transitions += cancelled.length;
    for (const t of cancelled) {
      if (this.ledger.hasTerms(String(t._id))) this.ledger.taskCancelled(String(t._id));
    }
    // A sweep that quietly cancels nothing reconciles perfectly and proves
    // nothing, so the scenario asserts it really ran.
    if (cancelled.length !== taskIds.length) {
      throw new Error(`expected ${taskIds.length} tasks to expire, but ${cancelled.length} did`);
    }
    await this.check(`expired ${cancelled.length} unclaimed tasks`);
  }

  /**
   * The captain's completion deadline runs out while they still hold it.
   *
   * Their collateral is released — they are no longer on the hook — but the
   * money stays in flight, because the task itself is not resolved: it is
   * waiting for them to explain, and then goes back to the pool.
   */
  async expireOverdue(taskIds: string[], captain: CaptainRef): Promise<void> {
    await Task.updateMany(
      { _id: { $in: taskIds }, status: { $in: ['ASSIGNED', 'IN_PROGRESS'] } },
      { $set: { expiresAt: new Date(Date.now() - 60_000) } },
    );
    const expired = await expireOverdueTasks();
    transitions += expired;
    for (const id of taskIds) this.ledger.collateralReleased(id, String(captain.id));
    await this.check(`${expired} held tasks passed their deadline`);
  }

  /** The captain explains, and the task goes back to the pool for someone else. */
  async explainExpiry(taskId: string, captain: CaptainRef): Promise<void> {
    await rejectExpiredTask(taskId, captain.id, 'Bank was down all evening', captain.actor);
    transitions += 1;
    await this.check('captain explained the expiry; task returned to the pool', { taskId });
  }

  /** The captain never answers, so the system takes the task back. */
  async reclaimUnacknowledged(): Promise<void> {
    await Task.updateMany(
      { status: 'EXPIRED', expiryAckDeadline: { $ne: null } },
      { $set: { expiryAckDeadline: new Date(Date.now() - 60_000) } },
    );
    const reclaimed = await reclaimUnacknowledgedExpiredTasks();
    transitions += reclaimed.length;
    await this.check(`${reclaimed.length} unacknowledged expired tasks reclaimed`);
  }

  // --------------------------------------------------- platform's own Pay In

  async platformWithdraw(rupees: number, outcome: 'CONFIRM' | 'DISPUTE_SETTLE' | 'DISPUTE_RETRY'): Promise<void> {
    const amountPaise = rupeesToPaise(rupees);
    const { portions } = await requestPlatformWithdrawal(amountPaise, this.admin);
    transitions += 1;

    for (const portion of portions) {
      const partyUser = await Party.findById(portion.partyId).select('userId').lean();
      const partyActor: Actor = { userId: String(partyUser?.userId), role: 'PARTY' };

      await submitPlatformPortionPaymentProof(
        String(portion._id), portion.partyId, { providerReference: `UTR${Date.now()}${Math.floor(Math.random() * 10_000)}` }, partyActor,
      );
      transitions += 1;

      if (outcome === 'CONFIRM') {
        await confirmPlatformPortionReceipt(String(portion._id), this.admin);
        transitions += 1;
        this.ledger.platformWithdrawalSettled(String(portion.partyId), portion.amountPaise);
        await this.check(`platform withdrawal portion confirmed (${paiseToRupees(portion.amountPaise)})`);
      } else {
        await disputePlatformPortionReceipt(String(portion._id), 'Reference does not match our statement', this.admin);
        transitions += 1;
        await this.check('platform disputed a withdrawal portion');

        if (outcome === 'DISPUTE_SETTLE') {
          await resolvePlatformPortionDispute(String(portion._id), 'SETTLE', this.admin);
          transitions += 1;
          this.ledger.platformWithdrawalSettled(String(portion.partyId), portion.amountPaise);
          await this.check('admin settled the disputed platform portion');
        } else {
          await resolvePlatformPortionDispute(String(portion._id), 'RETRY', this.admin);
          transitions += 1;
          this.ledger.withdrawalRetried();
          await this.check('platform portion sent back for another attempt');
        }
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  /** The whole happy path in one call, since most scenarios start with it. */
  async completeTask(party: PartyRef, captain: CaptainRef, amountRupees: number): Promise<string> {
    const task = await this.createTask(party, amountRupees);
    const id = String(task._id);
    await this.claim(id, captain);
    await this.start(id, captain);
    await this.submitProof(id, captain);
    await this.approve(id, party, captain);
    return id;
  }

  // -------------------------------------------------- the new model's money
  //
  // Four movements the old model had no equivalent of, each checked the moment
  // it happens. Between them they are the only ways DMC enters or leaves other
  // than a task: the pool mints it, commission and conversion move it around,
  // and a paid cash-out is the single place it is destroyed.

  /** Admin puts real money behind the commission captains earn. */
  async fundPool(rupees: number): Promise<void> {
    const amountPaise = rupeesToPaise(rupees);
    await fundPlatformPool(amountPaise);
    this.ledger.poolFunded(amountPaise);
    transitions += 1;
    await this.check(`commission pool funded (${rupees})`);
  }

  /**
   * A captain earns commission. Returns whether the pool could cover it, so a
   * scenario can deliberately drain the pool and assert that nothing was paid.
   */
  async payCommission(captain: CaptainRef, rupees: number): Promise<boolean> {
    const amountPaise = rupeesToPaise(rupees);
    const paid = await payCommissionToCaptain(captain.id, amountPaise);
    if (paid) this.ledger.commissionPaidFromPool(String(captain.id), amountPaise);
    transitions += 1;
    await this.check(`commission ${paid ? 'paid' : 'refused'} (${rupees})`);
    return paid;
  }

  /**
   * A cash-out, from request to decision. The request itself moves money —
   * out of the captain's balance and into a hold — so it is checked before
   * the decision is made, not only after.
   */
  async cashOut(captain: CaptainRef, rupees: number, outcome: 'PAY' | 'REJECT'): Promise<void> {
    const amountPaise = rupeesToPaise(rupees);
    const request = await requestRedemption(
      captain.id,
      amountPaise,
      { method: 'UPI', upiId: `cap-${String(captain.id)}@audit` },
      captain.actor,
    );
    const id = String(request._id);
    this.ledger.redemptionRequested(id, String(captain.id), amountPaise);
    transitions += 1;
    await this.check(`cash-out requested (${rupees})`);

    if (outcome === 'PAY') {
      await markRedemptionPaid(id, { reference: `NEFT-${Date.now()}` }, this.admin);
      this.ledger.redemptionPaid(id);
      transitions += 1;
      await this.check(`cash-out paid and burned (${rupees})`);
    } else {
      await rejectRedemption(id, 'Bank details do not match the captain', this.admin);
      this.ledger.redemptionRejected(id, String(captain.id));
      transitions += 1;
      await this.check(`cash-out rejected and returned (${rupees})`);
    }
  }

  // ------------------------------------------------- pay-ins and pay-outs
  //
  // The new model's two directions, driven end to end. Each step that moves
  // money is checked the moment it happens, because a pay-in that holds the
  // wrong amount and settles the wrong amount reconciles perfectly at the end
  // while having been wrong the whole way through.

  /**
   * A party's customer pays money in. The captain hands over DMC and receives
   * the cash, so their capital is held at assignment and given to the party at
   * settlement.
   */
  async payIn(
    party: PartyRef,
    captain: CaptainRef,
    amountRupees: number,
    outcome: 'SETTLE' | 'EXPIRE' = 'SETTLE',
  ): Promise<string> {
    const amountPaise = rupeesToPaise(amountRupees);
    const { transaction } = await createPayIn(
      party.id,
      { partyReference: `AUDIT-IN-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, amountPaise },
      party.actor,
    );
    const id = String(transaction._id);
    transitions += 1;
    // Creation moves nothing: there is nobody to hold anything from yet.
    await this.check(`pay-in created (${amountRupees})`);

    const assigned = await assignCaptain(id);
    if (!assigned.captainId) throw new Error('no captain took the pay-in');
    this.ledger.payInAssigned(id, String(assigned.captainId), amountPaise);
    transitions += 1;
    await this.check(`pay-in assigned, capital held (${amountRupees})`);

    await openToCustomer(id, { gatewayOrderId: `GW-${id.slice(-8)}` });
    transitions += 1;

    if (outcome === 'EXPIRE') {
      await expireTransaction(id, 'Customer never paid');
      this.ledger.payInReleased(id, String(assigned.captainId));
      transitions += 1;
      await this.check(`pay-in expired, capital returned (${amountRupees})`);
      return id;
    }

    await confirmMovement(id, `UPI-${id.slice(-10)}`);
    transitions += 1;
    // Confirmation is a claim, not a settlement — nothing has moved yet.
    await this.check(`pay-in confirmed (${amountRupees})`);

    const settled = await settleTransaction(id);
    this.ledger.payInSettled(id, String(party.id), settled.partyCommissionPaise, String(assigned.captainId));
    if (settled.commissionPaid && settled.commissionPaise > 0) {
      this.ledger.commissionPaidFromPool(String(assigned.captainId), settled.commissionPaise);
    }
    transitions += 1;
    await this.check(`pay-in settled (${amountRupees})`);
    void captain;
    return id;
  }

  async finalCheck(label: string): Promise<void> {
    await this.check(`FINAL: ${label}`);
  }
}

/**
 * Withdrawals still in flight — admin's own, which is the only kind left. A
 * captain cashing out through a party is gone, so there is no second number.
 */
export async function countLivePortions(): Promise<{ platform: number }> {
  const platform = await AdminWithdrawalPortion.countDocuments({
    status: { $in: ['PENDING', 'PARTY_PAID', 'DISPUTED'] },
  });
  return { platform };
}
