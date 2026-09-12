import {
  emitToCaptainPool,
  emitToCaptain,
  emitToParty,
  emitToAdmins,
} from '../sockets';
import { paiseToRupees } from '../utils/money';
import type {
  ITask,
  IAdminWithdrawalPortion,
  IPartyTopUpRequest,
  IDmcPurchase,
  IDmcRedemption,
  ICaptainLimitPurchase,
} from '../models';

/**
 * Notification payloads are shaped here rather than at call sites so the
 * client has one stable contract per event, and so no internal field leaks
 * into a broadcast by accident.
 */

/**
 * What a captain may be told about a task.
 *
 * Built as its own shape rather than by deleting a field from the party's,
 * so a field added to the party payload later is not silently inherited here
 * — the same allow-list reasoning the serialisers use. Note what is absent:
 * `externalRef`, the party's tracking reference, which a captain must never
 * receive on any channel. See CaptainSafePayload in sockets/index.ts, which
 * makes sending it a compile error.
 */
export interface CaptainTaskNotification {
  taskId: string;
  taskCode: string;
  amount: number;
  status: string;
  createdAt: string;
  commission?: number;
}

/** Party and admin see the same, plus the tracking reference they own. */
export interface TaskNotification extends CaptainTaskNotification {
  externalRef: string;
}

function toCaptainNotification(task: ITask, commissionPaise?: number | null): CaptainTaskNotification {
  return {
    taskId: String(task._id),
    // The opaque code, never the party-scoped one — `task.taskCode` reads
    // TASK-PARTY-003-... and names the owner outright.
    taskCode: task.captainTaskCode ?? task.taskCode,
    amount: paiseToRupees(task.amountPaise),
    status: task.status,
    createdAt: task.createdAt.toISOString(),
    ...(commissionPaise != null ? { commission: paiseToRupees(commissionPaise) } : {}),
  };
}

function toNotification(task: ITask, commissionPaise?: number | null): TaskNotification {
  return { ...toCaptainNotification(task, commissionPaise), externalRef: task.externalRef };
}

/**
 * The task's identifier, phrased for whoever is being told.
 *
 * Several notifications below go to both sides of the same event, and it is
 * tempting to build one payload and emit it twice. The identifier is what
 * makes that unsafe: the party- and admin-facing code spells out the owning
 * party, so a captain reading the shared payload learns exactly what the rest
 * of the system withholds.
 */
function codeFor(task: ITask, audience: 'CAPTAIN' | 'OTHER'): string {
  return audience === 'CAPTAIN' ? task.captainTaskCode ?? task.taskCode : task.taskCode;
}

/**
 * A task has entered the system. Admin is told immediately; captains are not
 * broadcast to, because a task is offered to one captain at a time now (see
 * taskRouting.service.ts) — notifyTaskOffered tells whoever's turn it is.
 */
export function notifyTaskAvailable(task: ITask, estimatedCommissionPaise: number): void {
  void estimatedCommissionPaise;
  emitToAdmins('admin:task-created', toNotification(task));
}

/**
 * This captain, and only this captain, now holds an exclusive offer on the
 * task, with a deadline to accept it.
 */
export function notifyTaskOffered(
  task: ITask,
  captainId: string,
  commissionPaise: number,
  offerExpiresAt: Date,
): void {
  emitToCaptain(captainId, 'task:offered', {
    ...toCaptainNotification(task, commissionPaise),
    offerExpiresAt: offerExpiresAt.toISOString(),
    message: 'A task has been offered to you',
  });
}

/**
 * The task fell back to the open pool: routing found no one to offer it to
 * exclusively, so anyone eligible may now take it.
 *
 * Addressed to those captains individually rather than broadcast to every
 * connected one. A captain rejected off this task is barred from it for good,
 * and one who cannot cover it is refused at the claim — announcing it to them
 * only produces an alert for work they will never be allowed to take, and the
 * task is not even in their queue when they go looking for it.
 */
export function notifyTaskOpenedToPool(
  task: ITask,
  commissionPaise: number,
  eligibleCaptainIds: string[],
): void {
  const payload = {
    ...toCaptainNotification(task, commissionPaise),
    message: 'A task is open to all captains',
  };
  for (const captainId of eligibleCaptainIds) {
    emitToCaptain(captainId, 'task:available', payload);
  }
}

/**
 * The system took an expired task back because the captain never acknowledged
 * it. Both sides are told: the captain because it is no longer theirs and it
 * counts against them, the party because their task is moving again.
 */
export function notifyExpiredTaskReclaimed(task: ITask, captainId: string | null): void {
  if (captainId) {
    emitToCaptain(captainId, 'task:updated', {
      ...toCaptainNotification(task),
      message: 'An expired task was reclaimed because it was not acknowledged in time',
    });
  }
  emitToParty(String(task.partyId), 'task:updated', {
    ...toNotification(task),
    message: 'The captain did not respond — your task has been offered to someone else',
  });
}

/** Nobody accepted in time — the task is cancelled and the party refunded. */
export function notifyTaskUnfulfilled(task: ITask): void {
  emitToParty(String(task.partyId), 'task:updated', {
    ...toNotification(task),
    reason: task.cancelReason ?? null,
    message: 'No captain accepted this task in time — it was cancelled and your DMC refunded',
  });
  emitToAdmins('admin:task-unfulfilled', {
    ...toNotification(task),
    reason: task.cancelReason ?? null,
  });
}

/**
 * A task has run out of captains: every one of them has held it and been
 * rejected off it, so routing can never place it again.
 *
 * Admin only. The party is deliberately not told — they would learn nothing
 * they can act on, and telling them a captain "rejected" their task would
 * cross the identity boundary that keeps the two sides apart. Admin can either
 * onboard a captain or let the party cancel it, and only admin can see enough
 * to make that call.
 */
export function notifyRoutingStalled(task: ITask): void {
  emitToAdmins('admin:task-routing-stalled', {
    ...toNotification(task),
    rejectedOffCount: (task.previousCaptainIds ?? []).length,
    message: 'No captain is left who has not been rejected off this task',
  });
}

/**
 * Tell the pool a task is gone, so stale cards can be removed.
 *
 * This is a cache signal, not news. It goes to every connected captain because
 * every one of them may be looking at a queue that still lists the task — but
 * the only correct response is to drop that card. The client must not raise it
 * as a notification: one captain claiming work is not an event in another
 * captain's day, and alerting them about it is how each captain ended up being
 * told what the other was doing.
 */
export function notifyTaskClaimed(task: ITask, captainId: string): void {
  emitToCaptainPool('task:claimed', {
    taskId: String(task._id),
    taskCode: task.captainTaskCode ?? task.taskCode,
    claimedBy: captainId,
  });
  emitToParty(String(task.partyId), 'task:updated', toNotification(task));
  emitToAdmins('admin:task-claimed', { ...toNotification(task), captainId });
}

export function notifyAuditRequired(task: ITask): void {
  emitToAdmins('admin:audit-required', { ...toNotification(task), message: 'Audit required' });
  emitToParty(String(task.partyId), 'task:updated', toNotification(task));
}

export function notifyProofApproved(task: ITask, captainId: string, commissionPaise: number): void {
  emitToCaptain(captainId, 'task:approved', {
    ...toCaptainNotification(task, commissionPaise),
    message: 'Proof approved',
  });
  emitToParty(String(task.partyId), 'task:updated', toNotification(task));
}

/**
 * Party rejected the captain's proof. The task is not back in the pool yet —
 * it stays with this captain, collateral locked, pending admin's review.
 */
export function notifyProofRejected(task: ITask, captainId: string, reason: string): void {
  emitToCaptain(captainId, 'task:rejected', {
    ...toCaptainNotification(task),
    reason,
    message: 'Proof rejected — sent to admin for review',
  });
  emitToParty(String(task.partyId), 'task:updated', toNotification(task));
  emitToAdmins('admin:task-rejected', { ...toNotification(task), reason });
}

export function notifyTaskExpired(task: ITask, captainId: string | null): void {
  if (captainId) {
    emitToCaptain(captainId, 'task:expired', { ...toCaptainNotification(task), message: 'Task expired' });
  }
  emitToParty(String(task.partyId), 'task:updated', toNotification(task));
}

export function notifyLimitUpdated(captainId: string, availableLimitPaise: number): void {
  emitToCaptain(captainId, 'captain:limit-updated', {
    availableLimit: paiseToRupees(availableLimitPaise),
    message: 'Limit updated',
  });
}

export function notifyConfigUpdated(changedKeys: string[]): void {
  emitToAdmins('admin:config-updated', { changedKeys, message: 'Configuration updated' });
}

/** So the admin dashboard's "captains online" tile updates live rather than on its next poll. */
export function notifyPresenceChanged(captainId: string, online: boolean): void {
  emitToAdmins('admin:captain-presence-changed', { captainId, online });
}

/**
 * Party or captain asked to cancel a task the captain is actively holding —
 * whichever side did NOT ask reviews it. Admin is not told at this stage; it
 * has no role until (if) the review is disputed.
 */
export function notifyCancelRequested(task: ITask): void {
  const payload = (audience: 'CAPTAIN' | 'OTHER') => ({
    taskId: String(task._id),
    taskCode: codeFor(task, audience),
    initiatedBy: task.cancelInitiatedBy ?? null,
    reason: task.cancelReason ?? null,
    message: 'A cancellation was requested for a task you hold — please review it',
  });
  if (task.cancelInitiatedBy === 'PARTY' && task.captainId) {
    emitToCaptain(String(task.captainId), 'task:cancel-requested', payload('CAPTAIN'));
  } else if (task.cancelInitiatedBy === 'CAPTAIN') {
    emitToParty(String(task.partyId), 'task:cancel-requested', payload('OTHER'));
  }
}

/**
 * The reviewer approved (final cancel) or rejected (now disputed, admin
 * decides) a cancellation review. Both sides have a stake in the outcome —
 * whoever asked, and whoever reviewed — so both are told; admin is told only
 * once it is actually disputed.
 */
export function notifyCancelReviewed(task: ITask, decision: 'APPROVED' | 'REJECTED'): void {
  const base = (audience: 'CAPTAIN' | 'OTHER') => ({
    taskId: String(task._id),
    taskCode: codeFor(task, audience),
    status: task.status,
    reason: task.cancelReviewDecisionReason ?? null,
  });
  const requesterMessage = decision === 'APPROVED' ? 'Your cancellation request was approved' : 'Your cancellation request was disputed';
  const reviewerMessage = decision === 'APPROVED' ? 'You approved the cancellation' : 'You disputed the cancellation — escalated to admin';

  const requesterIsCaptain = task.cancelInitiatedBy === 'CAPTAIN';
  if (requesterIsCaptain && task.captainId) {
    emitToCaptain(String(task.captainId), 'task:cancel-reviewed', { ...base('CAPTAIN'), message: requesterMessage });
    emitToParty(String(task.partyId), 'task:cancel-reviewed', { ...base('OTHER'), message: reviewerMessage });
  } else {
    emitToParty(String(task.partyId), 'task:cancel-reviewed', { ...base('OTHER'), message: requesterMessage });
    if (task.captainId) {
      emitToCaptain(String(task.captainId), 'task:cancel-reviewed', { ...base('CAPTAIN'), message: reviewerMessage });
    }
  }

  if (decision === 'REJECTED') {
    emitToAdmins('admin:task-cancel-disputed', { ...base('OTHER'), message: 'A cancellation was disputed — needs your review' });
  }
}

/** Admin's final call on a disputed cancellation — either approved as-is (task resumes) or reassigned to the pool. */
export function notifyCancelDisputeResolved(task: ITask, decision: 'APPROVE' | 'REASSIGN'): void {
  const payload = (audience: 'CAPTAIN' | 'OTHER') => ({
    taskId: String(task._id),
    taskCode: codeFor(task, audience),
    status: task.status,
    message: decision === 'APPROVE' ? 'Admin resolved the dispute — the task resumes as before' : 'Admin resolved the dispute by returning the task to the pool',
  });
  emitToParty(String(task.partyId), 'task:cancel-reviewed', payload('OTHER'));
  if (task.captainId) {
    emitToCaptain(String(task.captainId), 'task:cancel-reviewed', payload('CAPTAIN'));
  }
}

/**
 * Admin's final call on a rejected proof — either overruled (task completed,
 * captain still credited) or reassigned to the pool (captain released). The
 * captain is passed explicitly since a REASSIGN decision has already cleared
 * `task.captainId` by the time this fires.
 */
export function notifyRejectionResolved(task: ITask, captainId: string, decision: 'APPROVE' | 'REASSIGN'): void {
  const payload = (audience: 'CAPTAIN' | 'OTHER') => ({
    taskId: String(task._id),
    taskCode: codeFor(task, audience),
    status: task.status,
    message: decision === 'APPROVE' ? 'Admin overruled the rejection — the task is complete' : 'Admin resolved the rejection by returning the task to the pool',
  });
  emitToParty(String(task.partyId), 'task:updated', payload('OTHER'));
  emitToCaptain(captainId, 'task:updated', payload('CAPTAIN'));
}

/**
 * Admin cashing out platform commission — the same parent/portion pattern as
 * a captain's Pay In, mirrored event-for-event. See adminWithdrawal.service.ts.
 */
export function notifyPlatformWithdrawalRequested(portions: IAdminWithdrawalPortion[]): void {
  for (const portion of portions) {
    emitToParty(String(portion.partyId), 'admin-withdrawal:available', {
      withdrawalId: String(portion._id),
      amount: paiseToRupees(portion.amountPaise),
      message: 'Admin has a new withdrawal request directed at you',
    });
  }
}

export function notifyPlatformPaymentSubmitted(portion: IAdminWithdrawalPortion): void {
  emitToAdmins('admin:platform-withdrawal-payment-submitted', {
    withdrawalId: String(portion._id),
    amount: paiseToRupees(portion.amountPaise),
    message: 'A party says they paid your withdrawal — please verify',
  });
}

export function notifyPlatformWithdrawalFulfilled(portion: IAdminWithdrawalPortion): void {
  emitToParty(String(portion.partyId), 'withdrawal:fulfilled', {
    withdrawalId: String(portion._id),
    amount: paiseToRupees(portion.amountPaise),
    message: 'Admin confirmed receipt',
  });
}

export function notifyPlatformWithdrawalDisputed(portion: IAdminWithdrawalPortion): void {
  emitToParty(String(portion.partyId), 'withdrawal:disputed', {
    withdrawalId: String(portion._id),
    amount: paiseToRupees(portion.amountPaise),
    reason: portion.disputeReason ?? null,
    message: 'Admin disputed this payment',
  });
}

/**
 * A party topping up its DMC balance — real security money the party sends
 * directly to the platform, so admin (not a shared pool) has to confirm
 * receipt before the request's proof is trusted.
 */
export function notifyPartyTopUpRequested(request: IPartyTopUpRequest): void {
  emitToAdmins('admin:party-topup-requested', {
    topUpId: String(request._id),
    amount: paiseToRupees(request.amountPaise),
    message: 'A party submitted a DMC top-up — please verify',
  });
}

/**
 * A captain posted security money and is waiting on admin to confirm it — the
 * mirror of a party top-up, and admin is the only one who can act on it.
 */
export function notifyCollateralDepositRequested(request: IDmcPurchase): void {
  emitToAdmins('admin:collateral-deposit-requested', {
    depositId: String(request._id),
    amount: paiseToRupees(request.amountPaise),
    message: 'A captain posted security money — please verify',
  });
}

/**
 * A captain has asked to buy capacity.
 *
 * Announced to admin because it is money waiting on a decision, and anything
 * waiting on admin has to reach the one screen admin actually watches.
 */
export function notifyLimitPurchaseRequested(request: ICaptainLimitPurchase): void {
  emitToAdmins('admin:limit-purchase-requested', {
    purchaseId: String(request._id),
    amount: paiseToRupees(request.amountPaise),
    message: 'A captain paid to raise their limit — please verify',
  });
}

export function notifyLimitPurchaseDecided(
  request: ICaptainLimitPurchase,
  decision: 'APPROVED' | 'REJECTED',
): void {
  emitToCaptain(String(request.captainId), 'limit-purchase:decided', {
    purchaseId: String(request._id),
    amount: paiseToRupees(request.amountPaise),
    status: request.status,
    reason: request.rejectionReason ?? null,
    message:
      decision === 'APPROVED'
        ? 'Your capacity purchase was confirmed'
        : 'Your capacity purchase was not confirmed',
  });
}

export function notifyCollateralDepositDecided(request: IDmcPurchase, decision: 'APPROVED' | 'REJECTED'): void {
  emitToCaptain(String(request.captainId), 'collateral-deposit:decided', {
    depositId: String(request._id),
    amount: paiseToRupees(request.amountPaise),
    status: request.status,
    reason: request.rejectionReason ?? null,
    message:
      decision === 'APPROVED'
        ? 'Your security deposit was confirmed — part is held as security and the rest is yours to trade with'
        : 'Your security deposit was rejected',
  });
}

/**
 * A captain wants real rupees for their DMC. This is a decision that lands on
 * admin and holds the captain's money until it is made, so it goes where every
 * such decision goes — the admin review queue — and not only onto the captain's
 * own profile page where nobody would find it.
 */
export function notifyRedemptionRequested(request: IDmcRedemption): void {
  emitToAdmins('admin:redemption-requested', {
    redemptionId: String(request._id),
    captainId: String(request.captainId),
    amount: paiseToRupees(request.amountPaise),
    message: 'A captain asked to cash out DMC — please pay and confirm',
  });
}

export function notifyRedemptionDecided(request: IDmcRedemption, decision: 'PAID' | 'REJECTED'): void {
  emitToCaptain(String(request.captainId), 'redemption:decided', {
    redemptionId: String(request._id),
    amount: paiseToRupees(request.amountPaise),
    status: request.status,
    reference: request.paymentReference ?? null,
    reason: request.rejectionReason ?? null,
    message:
      decision === 'PAID'
        ? 'Your cash-out was paid — check your account for the transfer'
        : 'Your cash-out was rejected and the DMC is back in your balance',
  });
}

/** A captain moved commission into working capital. Only they need to know. */
export function notifyWalletConverted(captainId: string, amountPaise: number, dmcBalancePaise: number): void {
  emitToCaptain(captainId, 'wallet:converted', {
    amount: paiseToRupees(amountPaise),
    dmcBalance: paiseToRupees(dmcBalancePaise),
    message: 'Commission moved into your working capital',
  });
}

/**
 * An API payout has settled.
 *
 * The party's server is told by callback, which is the channel that matters —
 * but a person may also be watching the dashboard, and a payout that quietly
 * finishes without the screen moving looks stuck. Both, then: the callback for
 * their systems and this for their eyes.
 *
 * The customer is not notified here and cannot be: they are the party's user,
 * not ours, and we hold no way to reach them. They see it on the tracking page
 * against the reference the party gave them, and the party tells them however
 * the party normally does.
 */
export function notifyPayoutSettled(task: ITask): void {
  emitToParty(String(task.partyId), 'payout:settled', {
    taskId: String(task._id),
    reference: task.externalRef,
    amount: paiseToRupees(task.amountPaise),
    settlementReference: task.providerReference ?? null,
    message: 'A payout has been sent to your customer',
  });
  emitToParty(String(task.partyId), 'task:updated', toNotification(task));
}

export function notifyPartyTopUpDecided(request: IPartyTopUpRequest, decision: 'APPROVED' | 'REJECTED'): void {
  emitToParty(String(request.partyId), 'party-topup:decided', {
    topUpId: String(request._id),
    amount: paiseToRupees(request.amountPaise),
    status: request.status,
    reason: request.rejectionReason ?? null,
    message: decision === 'APPROVED' ? 'Your DMC top-up was confirmed' : 'Your DMC top-up was rejected',
  });
}

/**
 * The party's customer needs to confirm this payout, and the clock is running.
 *
 * Sent to the party, never to the customer — OTDMS has no account for them and
 * no channel to them. The party relays it through whatever they already use,
 * and sends the answer back. The deadline travels with the message because a
 * request to go and ask somebody is useless without saying by when.
 */
export function notifyConfirmationRequired(task: ITask, deadline: Date): void {
  emitToParty(String(task.partyId), 'payout:confirmation-required', {
    ...toNotification(task),
    confirmationDeadline: deadline.toISOString(),
    providerReference: task.providerReference ?? null,
    message: 'Ask your customer whether the payment arrived',
  });
  emitToAdmins('admin:payout-confirmation-required', toNotification(task));
}
