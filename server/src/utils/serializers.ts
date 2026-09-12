import type { Types } from 'mongoose';
import { paiseToRupees, usdtMicrosToAmount } from './money';
import { captainGuidanceFor, type RejectionCategory } from './rejectionCategories';
import type { TaskState } from '../types';
import { computeBadges, computeSuccessRate, computeOnTimeRate } from '../services/captainRating.service';
import { computeAvailableLimit } from '../services/collateral.service';
import { currentLimitPaise } from '../services/captainCapacity.service';
import type {
  ITask,
  ICaptain,
  IParty,
  IProof,
  ICommission,
  ITaskPayoutMethod,
  IDmcPurchase,
  ICaptainLimitPurchase,
  IAdminWithdrawalRequest,
  IAdminWithdrawalPortion,
  IPlatformAccount,
  IPartyTopUpRequest,
  IWalletEntry,
  IDmcRedemption,
  ITransaction,
} from '../models';

/**
 * SERIALISERS
 * -----------
 * The single boundary where internal paise become rupees and where
 * role-specific field stripping happens. Customer-facing output is built by a
 * dedicated function that starts from an empty object and adds only what is
 * permitted, rather than starting from the document and deleting fields — the
 * allow-list cannot leak a field added later.
 */

export interface PayoutMethodDto {
  type: 'BANK' | 'UPI' | 'USDT';
  bankName: string | null;
  accountNumber: string | null;
  ifscCode: string | null;
  accountHolderName: string | null;
  upiId: string | null;
  screenshotUrl: string | null;
  screenshotFileName: string | null;
  screenshotMimeType: string | null;
  walletAddress: string | null;
}

export interface TaskDto {
  id: string;
  taskCode: string;
  customerId: string | null;
  customerName: string;
  identifier: string;
  payoutMethod: PayoutMethodDto | null;
  amount: number;
  externalRef: string;
  /** The opaque code a captain is shown for this task. Admin needs both to trace one. */
  captainTaskCode: string | null;
  status: string;
  captainId: string | null;
  partyId: string;
  claimedAt: string | null;
  startedAt: string | null;
  proofSubmittedAt: string | null;
  completedAt: string | null;
  /** Deadline for the holding captain to finish. Drives the completion countdown. */
  expiresAt: string | null;
  /** Deadline for the offered captain to accept, while still unclaimed. */
  offerExpiresAt: string | null;
  /** While EXPIRED: how long the captain has to acknowledge before it is reclaimed. */
  expiryAckDeadline: string | null;
  /**
   * The windows this task is running on, in minutes, settled from its party
   * when it was created — see taskClocks.service.ts.
   *
   * Sent alongside the absolute deadlines above rather than instead of them: a
   * countdown needs the instant, but "you have 15 minutes" is what a captain
   * looking at a fresh offer actually wants to know, and only the party can
   * answer it.
   *
   * Null on rows written before tasks carried their own windows. Left null
   * rather than filled in from today's settings, which would be a guess: the
   * deadlines above are the truth for those tasks either way, and this
   * serializer has no config to resolve against without becoming async.
   */
  acceptanceMinutes: number | null;
  completionMinutes: number | null;
  maxAgeMinutes: number | null;
  expiryAckMinutes: number | null;
  rejectionReason: string | null;
  rejectionCategory: RejectionCategory | null;
  reassignmentCount: number;
  /**
   * The reference for the payment the captain reported making. Supplied by
   * them with their proof — this system moves no money and issues no
   * references of its own.
   */
  providerReference: string | null;
  /** The captain's commission — locked in at creation. See Task.ts. */
  commission: number | null;
  /** The platform's commission — locked in at creation. See Task.ts. */
  adminCommission: number | null;
  /**
   * The whole fee the party was charged: the two halves above, added.
   *
   * Added in paise here rather than left to the caller, because adding the two
   * rupee figures is float arithmetic — 94.5 + 37.8 is 132.30000000000001 —
   * and this codebase keeps money integral for exactly that reason. The pay-in
   * DTO carries the same field under the same name.
   */
  partyCharge: number;
  createdAt: string;
  updatedAt: string;
  /** Set only while a cancellation is in review/dispute, or for the historical record after. */
  cancelInitiatedBy: 'PARTY' | 'CAPTAIN' | null;
  cancelReason: string | null;
  cancelReviewDecision: 'APPROVED' | 'REJECTED' | null;
  cancelReviewDecisionReason: string | null;
  adminCancelResolution: 'APPROVED' | 'REASSIGNED' | null;
  /** Set only while a rejected proof is pending admin review, or for the historical record after. */
  adminRejectionResolution: 'APPROVED' | 'REASSIGNED' | null;
}

function toPayoutMethodDto(pm: ITaskPayoutMethod | null | undefined): PayoutMethodDto | null {
  if (!pm) return null;
  return {
    type: pm.type,
    bankName: pm.bankName ?? null,
    accountNumber: pm.accountNumber ?? null,
    ifscCode: pm.ifscCode ?? null,
    accountHolderName: pm.accountHolderName ?? null,
    upiId: pm.upiId ?? null,
    screenshotUrl: pm.screenshotUrl ?? null,
    screenshotFileName: pm.screenshotFileName ?? null,
    screenshotMimeType: pm.screenshotMimeType ?? null,
    walletAddress: pm.walletAddress ?? null,
  };
}

export function toTaskDto(task: ITask): TaskDto {
  return {
    id: String(task._id),
    taskCode: task.taskCode,
    customerId: task.customerId ? String(task.customerId) : null,
    customerName: task.customerName,
    identifier: task.identifier,
    payoutMethod: toPayoutMethodDto(task.payoutMethod),
    amount: paiseToRupees(task.amountPaise),
    externalRef: task.externalRef,
    captainTaskCode: task.captainTaskCode ?? null,
    status: task.status,
    captainId: task.captainId ? String(task.captainId) : null,
    partyId: String(task.partyId),
    claimedAt: task.claimedAt?.toISOString() ?? null,
    startedAt: task.startedAt?.toISOString() ?? null,
    proofSubmittedAt: task.proofSubmittedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    expiresAt: task.expiresAt?.toISOString() ?? null,
    offerExpiresAt: task.offerExpiresAt?.toISOString() ?? null,
    expiryAckDeadline: task.expiryAckDeadline?.toISOString() ?? null,
    acceptanceMinutes: task.acceptanceMinutes ?? null,
    completionMinutes: task.completionMinutes ?? null,
    maxAgeMinutes: task.maxAgeMinutes ?? null,
    expiryAckMinutes: task.expiryAckMinutes ?? null,
    rejectionReason: task.rejectionReason ?? null,
    rejectionCategory: task.rejectionCategory ?? null,
    reassignmentCount: task.reassignmentCount,
    providerReference: task.providerReference ?? null,
    commission: task.commissionPaise != null ? paiseToRupees(task.commissionPaise) : null,
    adminCommission: task.adminCommissionPaise != null ? paiseToRupees(task.adminCommissionPaise) : null,
    partyCharge: paiseToRupees((task.commissionPaise ?? 0) + (task.adminCommissionPaise ?? 0)),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    cancelInitiatedBy: task.cancelInitiatedBy ?? null,
    cancelReason: task.cancelReason ?? null,
    cancelReviewDecision: task.cancelReviewDecision ?? null,
    cancelReviewDecisionReason: task.cancelReviewDecisionReason ?? null,
    adminCancelResolution: task.adminCancelResolution ?? null,
    adminRejectionResolution: task.adminRejectionResolution ?? null,
  };
}

/** Task card shown to a captain browsing the queue, before claiming. */
export function toQueueCardDto(task: ITask, estimatedCommissionPaise: number): Record<string, unknown> {
  return {
    id: String(task._id),
    taskCode: task.captainTaskCode ?? task.taskCode,
    customerName: task.customerName,
    identifier: task.identifier,
    amount: paiseToRupees(task.amountPaise),
    commission: paiseToRupees(estimatedCommissionPaise),
    status: 'AVAILABLE',
    createdAt: task.createdAt.toISOString(),
    /** Deadline to accept — what the client counts down against. Null once the task is open to everyone. */
    offerExpiresAt: task.offerExpiresAt?.toISOString() ?? null,
    /** True when routing was exhausted and any eligible captain may claim this. */
    openToPool: Boolean(task.openPoolAt),
    /** How many captains have already been through this one. */
    reassignmentCount: task.reassignmentCount,
    /**
     * What went wrong last time, stated as instruction. A captain deciding
     * whether to accept deserves to know a previous attempt failed and why,
     * without being handed the party's complaint about another captain.
     */
    rejectionGuidance: captainGuidanceFor(task.rejectionCategory),
  };
}

/** How a captain's turn on a task ended, once the task moved on without them. */
export type CaptainReleaseOutcome = 'REJECTED' | 'EXPIRED' | 'CANCELLED';

interface CaptainRelease {
  outcome: CaptainReleaseOutcome;
  at: string | null;
}

/**
 * Whether this captain used to hold the task, and how their turn ended.
 *
 * A reassigned task keeps no field saying "CAP-001 was rejected off this" —
 * `previousCaptainIds` records only that they were involved. The state history
 * does know, because every event carries the captain who held the task at the
 * time (see Task.ts), so the answer is read back out of their own events.
 *
 * Both release paths end the same way, at REASSIGNED, so that is not the
 * interesting part. What separates them is what came just before: a party
 * rejecting the proof, or the clock running out. EXPIRED is checked first
 * because the expiry path passes through REJECTED on its way out, and telling
 * a captain their work was rejected when they simply ran out of time would be
 * both wrong and unfair.
 *
 * Returns null when the captain still holds the task, or never held it.
 */
function releaseFor(task: ITask, viewerCaptainId?: Types.ObjectId | string | null): CaptainRelease | null {
  if (!viewerCaptainId) return null;
  const viewer = String(viewerCaptainId);
  if (task.captainId && String(task.captainId) === viewer) return null;
  if (!(task.previousCaptainIds ?? []).some((id) => String(id) === viewer)) return null;

  const theirs = (task.stateHistory ?? []).filter((e) => e.captainId && String(e.captainId) === viewer);
  const sawState = (state: TaskState): boolean => theirs.some((e) => e.to === state);

  const outcome: CaptainReleaseOutcome = sawState('EXPIRED')
    ? 'EXPIRED'
    : sawState('CANCELLED')
      ? 'CANCELLED'
      : 'REJECTED';

  const last = theirs[theirs.length - 1];
  return { outcome, at: last?.at ? last.at.toISOString() : null };
}

/**
 * Task view for a party's own tasks.
 *
 * A party never learns which captain is working its task — that is the mirror
 * of the captain never learning which party the work came from. The rule used
 * to live at the call sites, with each party handler destructuring `captainId`
 * out of the response by hand; the task list forgot, which is exactly how a
 * rule spread across nine places fails. It lives here now, once.
 */
export function toPartyTaskDto(task: ITask): Omit<TaskDto, 'captainId'> {
  const { captainId: _captainId, ...rest } = toTaskDto(task);
  return rest;
}

/**
 * Task view for a captain's own claimed/active/history tasks. The party's
 * tracking reference is need-to-know for the party and admin only — a
 * captain never sees it, so they cannot hand it to the customer themselves.
 *
 * The party's rejection text is withheld the same way, from everyone except
 * the captain it was written about. A captain who inherits a rejected task
 * gets `rejectionGuidance` instead: the same problem stated as instruction,
 * drawn from a fixed list, naming nobody. Passing no viewer is the safe
 * reading — the text is withheld.
 */
export function toCaptainTaskDto(
  task: ITask,
  viewerCaptainId?: Types.ObjectId | string | null,
): Record<string, unknown> {
  // captainTaskCode is dropped as a separate field: it is what `taskCode`
  // below already carries for this audience, and two names for one value is
  // just another thing to get wrong.
  const { externalRef: _externalRef, captainTaskCode: _captainTaskCode, rejectionReason, ...rest } = toTaskDto(task);

  const wasRejectedForViewer =
    Boolean(viewerCaptainId) &&
    Boolean(task.rejectedCaptainId) &&
    String(task.rejectedCaptainId) === String(viewerCaptainId);

  const release = releaseFor(task, viewerCaptainId);

  if (release) {
    return {
      ...rest,
      taskCode: task.captainTaskCode ?? rest.taskCode,
      // Everything below describes the task as it stands NOW, under whoever
      // holds it next. None of it is this captain's to see: the live status
      // would tell them a stranger finished their task, and `captainId` would
      // name that stranger outright. Their row is frozen at the moment they
      // lost it.
      status: release.outcome,
      captainId: null,
      claimedAt: null,
      startedAt: null,
      proofSubmittedAt: null,
      completedAt: null,
      expiresAt: null,
      offerExpiresAt: null,
      expiryAckDeadline: null,
      providerReference: null,
      payoutResult: null,
      commission: null,
      adminRejectionResolution: null,
      cancelInitiatedBy: null,
      cancelReason: null,
      cancelReviewDecision: null,
      cancelReviewDecisionReason: null,
      adminCancelResolution: null,
      // Their own rejection text still belongs to them — it was written about
      // their work, and it is the whole explanation of why the row says what
      // it says.
      rejectionReason: wasRejectedForViewer ? rejectionReason : null,
      rejectionGuidance: null,
      releasedFromYou: true,
      releasedAt: release.at,
    };
  }

  return {
    ...rest,
    // The opaque code, under the same key: `taskCode` on a party or admin
    // payload names the party in plain text (TASK-PARTY-003-...), which is the
    // one thing a captain is never told. See generateCaptainTaskCode.
    taskCode: task.captainTaskCode ?? rest.taskCode,
    rejectionReason: wasRejectedForViewer ? rejectionReason : null,
    // Only worth saying to a captain who did not cause it.
    rejectionGuidance: wasRejectedForViewer ? null : captainGuidanceFor(task.rejectionCategory),
    releasedFromYou: false,
    releasedAt: null,
  };
}

export const CUSTOMER_TIMELINE_STEPS = [
  { key: 'CREATED', label: 'Created' },
  { key: 'ASSIGNED', label: 'Assigned' },
  { key: 'IN_PROGRESS', label: 'In Progress' },
  { key: 'PROOF_SUBMITTED', label: 'Proof Submitted' },
  { key: 'AUDIT_PENDING', label: 'Verification' },
  { key: 'COMPLETED', label: 'Completed' },
] as const;

export interface CustomerTrackingDto {
  reference: string;
  amount: number;
  status: string;
  statusLabel: string;
  timeline: Array<{ key: string; label: string; complete: boolean; at: string | null }>;
  lastUpdated: string;
  /** When the money should arrive. Null once it has, or once it cannot. */
  expectedBy: string | null;
  /** Past that time and still unpaid. */
  isLate: boolean;
  /** The money has gone out. The reference is deliberately not exposed. */
  paid: boolean;
}

const CUSTOMER_STATUS_LABELS: Record<string, string> = {
  CREATED: 'Created',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In Progress',
  PROOF_SUBMITTED: 'Proof Submitted',
  AUDIT_PENDING: 'Under Verification',
  COMPLETED: 'Completed',
  REJECTED: 'Under Review',
  // A reassignment is an internal operational detail; the beneficiary is
  // shown a neutral in-progress state rather than the churn behind it.
  REASSIGNED: 'In Progress',
  EXPIRED: 'Delayed',
  CANCELLED: 'Cancelled',
};

/**
 * PUBLIC customer view. Built by allow-list.
 *
 * Deliberately absent: captain identity, commission, collateral, admin notes,
 * audit information, internal task id, party id, provider reference, and the
 * reassignment count.
 */
export function toCustomerTrackingDto(task: ITask, expectedBy?: Date | null): CustomerTrackingDto {
  const reachedAt = new Map<string, string>();
  for (const event of task.stateHistory) {
    if (!reachedAt.has(event.to)) reachedAt.set(event.to, event.at.toISOString());
  }

  const orderIndex = CUSTOMER_TIMELINE_STEPS.findIndex((s) => s.key === task.status);

  const timeline = CUSTOMER_TIMELINE_STEPS.map((step, index) => {
    const at = reachedAt.get(step.key) ?? null;
    const complete = at !== null || (orderIndex >= 0 && index < orderIndex);
    return { key: step.key, label: step.label, complete, at };
  });

  const settled = task.status === 'COMPLETED';
  const failed = task.status === 'CANCELLED' || task.status === 'EXPIRED';
  const late = expectedBy != null && !settled && !failed && expectedBy.getTime() < Date.now();

  return {
    reference: task.externalRef,
    amount: paiseToRupees(task.amountPaise),
    status: task.status,
    statusLabel: CUSTOMER_STATUS_LABELS[task.status] ?? 'In Progress',
    timeline,
    lastUpdated: task.updatedAt.toISOString(),

    /**
     * When the money should be with them.
     *
     * Somebody waiting on a payment wants one thing answered — when? — and
     * "In Progress" does not answer it. Without a time they refresh, worry,
     * and eventually chase the seller over something that was never late.
     *
     * Null once it is settled or has fallen through: there is nothing left to
     * expect, and a stale countdown beside "Paid" reads as a second payment
     * still coming.
     */
    expectedBy: settled || failed ? null : expectedBy?.toISOString() ?? null,
    /** Past that time and still not paid — said plainly rather than left to be worked out. */
    isLate: late,

    /**
     * The payment reference is deliberately NOT here.
     *
     * It is excluded by the same rule that keeps the captain and the party out
     * of this view, and there is a second reason on top: on a simulated task
     * the reference is fictional, so showing it would hand somebody a number
     * that looks like a bank reference and is not one.
     *
     * The customer does not need it. The credit appears on their own statement
     * either way, and `paid` below tells them to expect it.
     */
    paid: settled,
  };
}

export function toCaptainDto(captain: ICaptain): Record<string, unknown> {
  // The ceiling is admin's credit limit where one is set, the posted
  // collateral otherwise — computed in one place so this cannot drift from
  // what the claim guard actually enforces.
  const available = computeAvailableLimit(
    captain.collateralBalancePaise,
    captain.lockedAmountPaise,
    captain.creditLimitPaise,
  );
  return {
    id: String(captain._id),
    userId: String(captain.userId),
    captainCode: captain.captainCode,
    displayName: captain.displayName,
    collateralBalance: paiseToRupees(captain.collateralBalancePaise),
    lockedAmount: paiseToRupees(captain.lockedAmountPaise),
    /**
     * Admin's override for the ceiling, or null when the collateral is the
     * ceiling. Kept alongside the collateral rather than replacing it, so
     * both screens can show that a limit change moved no money.
     */
    creditLimit: captain.creditLimitPaise == null ? null : paiseToRupees(captain.creditLimitPaise),
    /**
     * What this captain is paid, per direction; null means the system default.
     * Never what a party is charged — a captain's row does not carry that, and
     * showing them the margin on their own work would hand them a negotiating
     * position they were never given a seat for.
     */
    payInCommissionPercentage: captain.payInCaptainCommissionPercentage ?? null,
    payOutCommissionPercentage: captain.payOutCaptainCommissionPercentage ?? null,
    /**
     * The ceiling itself: what this captain may hold in live work at once.
     *
     * Sent beside the remainder below because they are different questions and
     * the screens kept answering the second one under the first one's name. A
     * captain with 10,000 of security saw "Task limit 550" and reasonably
     * concluded their security had been spent on the work they were holding.
     * It had not, and it never is.
     */
    taskLimit: paiseToRupees(captain.creditLimitPaise ?? captain.collateralBalancePaise),
    /**
     * How much more work the captain can actually take on right now.
     *
     * It follows the same movements as the balance — a pay-in takes it, a
     * pay-out holds it and repays it — with two differences, and both are the
     * reason it exists as a separate figure at all.
     *
     * It never exceeds the task limit, because that is what admin approved and
     * what the security backs. And commission does not raise it: a captain who
     * has earned fees holds more DMC than they started with, and is still not
     * allowed to carry more work. Capacity is capital; profit is not capital.
     *
     * So a captain can quite correctly see 8,050 of DMC and be told they may
     * take on 8,000 — the 50 is theirs, but it is earnings, not headroom.
     */
    canTakeNow: paiseToRupees(currentLimitPaise(captain)),
    /** The collateral headroom on its own — what the claim guard enforces. */
    availableLimit: paiseToRupees(available),
    /**
     * The captain's DMC — capital, earnings and commission, all one number.
     * Separate only from the collateral above, which is security posted
     * against the work and cannot be spent on it.
     */
    dmcBalance: paiseToRupees(captain.dmcBalancePaise),
    isOnline: captain.isOnline,
    status: captain.status,
    /** Performance — see captainRating.service.ts, which owns both the rating and the badges. */
    rating: captain.rating,
    successRate: Math.round(computeSuccessRate(captain) * 1000) / 1000,
    onTimeRate: Math.round(computeOnTimeRate(captain) * 1000) / 1000,
    badges: computeBadges(captain),
    totalTasksOnTime: captain.totalTasksOnTime,
    totalTasksExpired: captain.totalTasksExpired,
    totalProofsRejected: captain.totalProofsRejected,
    totalRejectionsUpheldByAdmin: captain.totalRejectionsUpheldByAdmin,
    totalOffersMissed: captain.totalOffersMissed,
    meanAcceptSeconds:
      captain.totalOffersAccepted > 0
        ? Math.round(captain.totalAcceptSeconds / captain.totalOffersAccepted)
        : null,
    /** Null means "inherit the system default" — admin sets these per captain. */
    totalTasksCompleted: captain.totalTasksCompleted,
    lastSeenAt: captain.lastSeenAt?.toISOString() ?? null,
    dailyLimitOverride: captain.dailyLimitPaise != null ? paiseToRupees(captain.dailyLimitPaise) : null,
    monthlyLimitOverride: captain.monthlyLimitPaise != null ? paiseToRupees(captain.monthlyLimitPaise) : null,
  };
}

export function toPartyDto(party: IParty, taskStats?: { count: number; totalPaise: number }): Record<string, unknown> {
  return {
    id: String(party._id),
    userId: String(party.userId),
    partyCode: party.partyCode,
    companyName: party.companyName,
    contactEmail: party.contactEmail,
    status: party.status,
    dailyLimit: party.dailyLimitPaise != null ? paiseToRupees(party.dailyLimitPaise) : null,
    monthlyLimit: party.monthlyLimitPaise != null ? paiseToRupees(party.monthlyLimitPaise) : null,
    /**
     * What this party is charged, per direction. Null means they are on the
     * system default — sent as null rather than resolved to the default here,
     * because a screen offering to change it has to be able to say which of
     * the two a number is, and a resolved figure cannot.
     */
    payInCommissionPercentage: party.payInPartyCommissionPercentage ?? null,
    payOutCommissionPercentage: party.payOutPartyCommissionPercentage ?? null,
    /**
     * The deadlines this party's tasks run on; null means the system default.
     * Sent unresolved for the same reason as the rates above — a screen
     * offering to change one has to be able to say which of the two it is.
     */
    acceptanceMinutes: party.acceptanceMinutes ?? null,
    completionMinutes: party.completionMinutes ?? null,
    maxAgeMinutes: party.maxAgeMinutes ?? null,
    expiryAckMinutes: party.expiryAckMinutes ?? null,
    /** DMC spending capacity for creating tasks — see Party.ts. */
    dmcBalance: paiseToRupees(party.dmcBalancePaise),
    taskCount: taskStats?.count ?? 0,
    taskValue: paiseToRupees(taskStats?.totalPaise ?? 0),
    createdAt: party.createdAt.toISOString(),
  };
}

export function toProofDto(proof: IProof): Record<string, unknown> {
  return {
    id: String(proof._id),
    taskId: String(proof.taskId),
    captainId: String(proof.captainId),
    providerReference: proof.providerReference,
    notes: proof.notes ?? null,
    receipt: proof.receiptUrl
      ? {
          fileName: proof.receiptFileName,
          url: proof.receiptUrl,
          mimeType: proof.receiptMimeType,
          sizeBytes: proof.receiptSizeBytes,
        }
      : null,
    submittedAt: proof.submittedAt.toISOString(),
  };
}

/** Admin cashing out platform commission — see AdminWithdrawalRequest.ts. Same shape as toWithdrawalDto, minus the captain-specific field. */
export function toAdminWithdrawalDto(request: IAdminWithdrawalRequest): Record<string, unknown> {
  return {
    id: String(request._id),
    amount: paiseToRupees(request.amountPaise),
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    cancelledAt: request.cancelledAt?.toISOString() ?? null,
  };
}

function portionProofDto(portion: {
  proofReference?: string | null;
  proofNotes?: string | null;
  proofReceiptUrl?: string | null;
  proofReceiptFileName?: string | null;
  proofReceiptMimeType?: string | null;
}): Record<string, unknown> | null {
  if (!portion.proofReference) return null;
  return {
    reference: portion.proofReference,
    notes: portion.proofNotes ?? null,
    receiptUrl: portion.proofReceiptUrl ?? null,
    receiptFileName: portion.proofReceiptFileName ?? null,
    receiptMimeType: portion.proofReceiptMimeType ?? null,
  };
}

/** Admin's own withdrawal portion — same full detail as toWithdrawalPortionDto, minus the captain-specific field. */
export function toAdminWithdrawalPortionDto(portion: IAdminWithdrawalPortion): Record<string, unknown> {
  return {
    id: String(portion._id),
    withdrawalRequestId: String(portion.withdrawalRequestId),
    partyId: String(portion.partyId),
    amount: paiseToRupees(portion.amountPaise),
    allocations: portion.allocations.map((a) => ({
      allocationId: String(a.allocationId),
      amount: paiseToRupees(a.amountPaise),
      customerId: a.customerId ? String(a.customerId) : null,
      customerName: a.customerName,
      taskId: String(a.taskId),
      taskCode: a.taskCode,
    })),
    status: portion.status,
    proof: portionProofDto(portion),
    disputeReason: portion.disputeReason ?? null,
    /** Set only when admin sent this back for the party to pay a second time. */
    returnedToPartyAt: portion.returnedToPartyAt?.toISOString() ?? null,
    returnedReason: portion.returnedReason ?? null,
    createdAt: portion.createdAt.toISOString(),
    paidAt: portion.paidAt?.toISOString() ?? null,
    fulfilledAt: portion.fulfilledAt?.toISOString() ?? null,
    disputedAt: portion.disputedAt?.toISOString() ?? null,
  };
}

/**
 * The platform's position, as the four numbers that explain it.
 *
 * `poolCollected` and `poolPaidOut` are counted from the records rather than
 * derived from the balance, because the balance alone can no longer tell them
 * apart. It used to: the pool held only admin's funding, so "spent" was simply
 * what had left it. Now every party's commission flows in too, and subtracting
 * the balance from the funding understates what captains were paid — and goes
 * negative the moment the platform collects more than it put in, which reads
 * as a bug rather than as the good news it is.
 */
export function toPlatformAccountDto(
  account: IPlatformAccount,
  flows?: { collectedPaise: number; paidOutPaise: number },
): Record<string, unknown> {
  const funded = account.poolFundedTotalPaise;
  const collected = flows?.collectedPaise ?? 0;
  const paidOut = flows?.paidOutPaise ?? 0;
  return {
    commissionBalance: paiseToRupees(account.poolBalancePaise),
    /** What is left to pay captain commission out of. */
    poolBalance: paiseToRupees(account.poolBalancePaise),
    /** Real money admin put in out of their own pocket. */
    poolFundedTotal: paiseToRupees(funded),
    /** Commission charged to parties, which is the platform's actual income. */
    poolCollected: paiseToRupees(collected),
    /** Commission actually paid to captains, which is its actual cost. */
    poolPaidOut: paiseToRupees(paidOut),
    /**
     * Income less cost. Positive means the platform is making money on the
     * network rather than subsidising it, which is the one thing this screen
     * exists to answer.
     */
    poolNet: paiseToRupees(collected - paidOut),
  };
}

/** Simulated DMC purchase — see dmcPurchase.service.ts. No real payment gateway is involved. */
/**
 * A captain's security-money deposit, pending admin's confirmation that it
 * arrived. Nothing is credited until then — see dmcPurchase.service.ts.
 */
/**
 * A capacity purchase, as either side sees it.
 *
 * `credited` stays null until admin approves, which is the whole point: a
 * pending request has moved nothing and no screen may imply otherwise.
 */
export function toLimitPurchaseDto(purchase: ICaptainLimitPurchase): Record<string, unknown> {
  return {
    id: String(purchase._id),
    captainId: String(purchase.captainId),
    amount: paiseToRupees(purchase.amountPaise),
    /** The cap this request was judged against when it was made. */
    collateralAtRequest: paiseToRupees(purchase.collateralAtRequestPaise),
    credited: purchase.creditedPaise == null ? null : paiseToRupees(purchase.creditedPaise),
    status: purchase.status,
    proof: {
      reference: purchase.proofReference ?? null,
      notes: purchase.proofNotes ?? null,
      receiptUrl: purchase.proofReceiptUrl ?? null,
      receiptFileName: purchase.proofReceiptFileName ?? null,
      receiptMimeType: purchase.proofReceiptMimeType ?? null,
    },
    /**
     * THE PAYMENT AS IT WAS QUOTED, read straight off the row.
     *
     * Rate and amount come from the snapshot rather than from settings, so a
     * later change to the conversion rate cannot alter what an already-open
     * request says somebody owes.
     *
     * The QR image is not here: it is generated on demand by the route that
     * shows it, so a list of fifty requests does not carry fifty base64 images.
     */
    payment: {
      address: purchase.depositAddress ?? null,
      network: purchase.depositNetwork ?? null,
      dmcPerUsdt: purchase.dmcPaisePerUsdt == null ? null : paiseToRupees(purchase.dmcPaisePerUsdt),
      usdtAmount:
        purchase.usdtAmountMicros == null ? null : usdtMicrosToAmount(purchase.usdtAmountMicros),
      markedPaidAt: purchase.markedPaidAt?.toISOString() ?? null,
    },
    rejectionReason: purchase.rejectionReason ?? null,
    createdAt: purchase.createdAt.toISOString(),
    decidedAt: purchase.decidedAt?.toISOString() ?? null,
  };
}

export function toDmcPurchaseDto(purchase: IDmcPurchase): Record<string, unknown> {
  return {
    id: String(purchase._id),
    captainId: String(purchase.captainId),
    amount: paiseToRupees(purchase.amountPaise),
    security: paiseToRupees(purchase.securityPaise),
    balance: paiseToRupees(purchase.balancePaise),
    /**
     * How the security was actually divided. Null while the deposit is still
     * pending, because nothing has been decided yet — and read from the row
     * rather than recomputed, so an old deposit keeps showing the split it was
     * given even after admin changes the percentage.
     */
    collateralCredited:
      purchase.collateralCreditedPaise == null ? null : paiseToRupees(purchase.collateralCreditedPaise),
    dmcCredited: purchase.dmcCreditedPaise == null ? null : paiseToRupees(purchase.dmcCreditedPaise),
    simulatedPaymentRef: purchase.simulatedPaymentRef,
    status: purchase.status,
    proof: {
      reference: purchase.proofReference ?? null,
      notes: purchase.proofNotes ?? null,
      receiptUrl: purchase.proofReceiptUrl ?? null,
      receiptFileName: purchase.proofReceiptFileName ?? null,
      receiptMimeType: purchase.proofReceiptMimeType ?? null,
    },
    /**
     * THE PAYMENT AS IT WAS QUOTED, read straight off the row.
     *
     * Rate and amount come from the snapshot rather than from settings, so a
     * later change to the conversion rate cannot alter what an already-open
     * request says somebody owes.
     *
     * The QR image is not here: it is generated on demand by the route that
     * shows it, so a list of fifty requests does not carry fifty base64 images.
     */
    payment: {
      address: purchase.depositAddress ?? null,
      network: purchase.depositNetwork ?? null,
      dmcPerUsdt: purchase.dmcPaisePerUsdt == null ? null : paiseToRupees(purchase.dmcPaisePerUsdt),
      usdtAmount:
        purchase.usdtAmountMicros == null ? null : usdtMicrosToAmount(purchase.usdtAmountMicros),
      markedPaidAt: purchase.markedPaidAt?.toISOString() ?? null,
    },
    rejectionReason: purchase.rejectionReason ?? null,
    createdAt: purchase.createdAt.toISOString(),
    decidedAt: purchase.decidedAt?.toISOString() ?? null,
  };
}

/** A party's DMC top-up request — pending admin's confirmation. See partyTopUp.service.ts. */
export function toPartyTopUpDto(request: IPartyTopUpRequest): Record<string, unknown> {
  return {
    id: String(request._id),
    partyId: String(request.partyId),
    amount: paiseToRupees(request.amountPaise),
    status: request.status,
    /** The party rate as applied to this request, never re-read from settings. */
    payment: {
      address: request.depositAddress ?? null,
      network: request.depositNetwork ?? null,
      dmcPerUsdt: request.dmcPaisePerUsdt == null ? null : paiseToRupees(request.dmcPaisePerUsdt),
      usdtAmount:
        request.usdtAmountMicros == null ? null : usdtMicrosToAmount(request.usdtAmountMicros),
      markedPaidAt: request.markedPaidAt?.toISOString() ?? null,
    },
    proof: {
      reference: request.proofReference ?? null,
      notes: request.proofNotes ?? null,
      receiptUrl: request.proofReceiptUrl ?? null,
      receiptFileName: request.proofReceiptFileName ?? null,
      receiptMimeType: request.proofReceiptMimeType ?? null,
    },
    rejectionReason: request.rejectionReason ?? null,
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
  };
}

/** One movement in or out of a captain's commission wallet. */
export function toWalletEntryDto(entry: IWalletEntry): Record<string, unknown> {
  return {
    id: String(entry._id),
    kind: entry.kind,
    amount: paiseToRupees(entry.amountPaise),
    walletBalanceAfter: paiseToRupees(entry.walletBalanceAfterPaise),
    dmcBalanceAfter: entry.dmcBalanceAfterPaise == null ? null : paiseToRupees(entry.dmcBalanceAfterPaise),
    sourceReference: entry.sourceReference ?? null,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * A cash-out as the captain sees it. Their own payout details are theirs to
 * see; there is no counterparty here to hide, because the platform itself is
 * the one paying.
 */
export function toRedemptionDto(request: IDmcRedemption): Record<string, unknown> {
  return {
    id: String(request._id),
    amount: paiseToRupees(request.amountPaise),
    status: request.status,
    payoutMethod: request.payoutMethod,
    payoutUpiId: request.payoutUpiId ?? null,
    payoutAccountName: request.payoutAccountName ?? null,
    payoutAccountNumber: request.payoutAccountNumber ?? null,
    payoutIfsc: request.payoutIfsc ?? null,
    paymentReference: request.paymentReference ?? null,
    paymentNotes: request.paymentNotes ?? null,
    rejectionReason: request.rejectionReason ?? null,
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
  };
}

/**
 * The same request as admin sees it: everything above plus who is asking, so
 * admin can check the name on the account against the captain before sending
 * real money.
 */
export function toAdminRedemptionDto(
  request: IDmcRedemption,
  captain?: Pick<ICaptain, 'captainCode' | 'displayName'> | null,
): Record<string, unknown> {
  return {
    ...toRedemptionDto(request),
    captainId: String(request.captainId),
    captainCode: captain?.captainCode ?? null,
    captainName: captain?.displayName ?? null,
  };
}

/**
 * A payment as its captain sees it.
 *
 * No party, ever. A captain is settling a payment, not working for a named
 * client, and letting them see which business the money belongs to would let
 * them price their service differently per party — or simply decline the ones
 * they like less. What they need is the amount, the direction, and for a
 * payout, where to send it.
 */
export function toCaptainTransactionDto(transaction: ITransaction): Record<string, unknown> {
  return {
    id: String(transaction._id),
    code: transaction.transactionCode,
    direction: transaction.direction,
    status: transaction.status,
    amount: paiseToRupees(transaction.amountPaise),
    commission: paiseToRupees(transaction.commissionPaise),
    /** Only a payout has a destination, and only its captain may see it. */
    // Payouts are tasks, so a transaction never has a beneficiary. Kept as a
    // null so the captain's screen can hold one shape for both.
    beneficiary: null,
    /** Only a pay-in has something for a customer to scan. */
    qrPayload: transaction.gatewayQrPayload ?? null,
    settlementReference: transaction.settlementReference ?? null,
    expiresAt: transaction.expiresAt.toISOString(),
    createdAt: transaction.createdAt.toISOString(),
    settledAt: transaction.settledAt?.toISOString() ?? null,
  };
}

/**
 * A payment as admin sees it: both counterparties named.
 *
 * The only view in the system that shows the party *and* the captain together.
 * That is not an oversight in the other two — it is the point of them — but
 * admin has to settle arguments between the two sides, and they cannot do that
 * while seeing only half of one.
 */
export function toAdminTransactionDto(
  transaction: ITransaction,
  party?: Pick<IParty, 'partyCode' | 'companyName'> | null,
  captain?: Pick<ICaptain, 'captainCode' | 'displayName'> | null,
): Record<string, unknown> {
  return {
    id: String(transaction._id),
    code: transaction.transactionCode,
    direction: transaction.direction,
    status: transaction.status,
    amount: paiseToRupees(transaction.amountPaise),
    commission: paiseToRupees(transaction.commissionPaise),
    /**
     * The whole fee the party was charged, and what the platform keeps of it.
     *
     * The platform's share is the remainder by subtraction, never its own
     * percentage — the same rule the engine prices by, so the three figures
     * here always add back to the charge. A pay-out carries the equivalent
     * pair on the task itself (`adminCommission`), which is why only this side
     * needed adding.
     */
    partyCharge: paiseToRupees(transaction.partyCommissionPaise),
    platformCommission: paiseToRupees(transaction.partyCommissionPaise - transaction.commissionPaise),
    /** False means the pool could not cover it — the captain is owed, unpaid. */
    commissionPaid: transaction.commissionPaid,
    partyId: String(transaction.partyId),
    partyName: party?.companyName ?? null,
    partyCode: party?.partyCode ?? null,
    captainId: transaction.captainId ? String(transaction.captainId) : null,
    captainName: captain?.displayName ?? null,
    captainCode: captain?.captainCode ?? null,
    /** The party's own id for this payment — how they will refer to it. */
    partyReference: transaction.partyReference,
    settlementReference: transaction.settlementReference ?? null,
    disputeReason: transaction.disputeReason ?? null,
    failureReason: transaction.failureReason ?? null,
    callbackDelivered: transaction.callbackDeliveredAt != null,
    callbackAttempts: transaction.callbackAttempts,
    createdAt: transaction.createdAt.toISOString(),
    settledAt: transaction.settledAt?.toISOString() ?? null,
  };
}

export function toCommissionDto(entry: ICommission): Record<string, unknown> {
  return {
    id: String(entry._id),
    taskId: String(entry.taskId),
    taskAmount: paiseToRupees(entry.taskAmountPaise),
    commission: paiseToRupees(entry.commissionPaise),
    percentageRate: entry.percentageRate,
    configVersion: entry.configVersion,
    earnedAt: entry.earnedAt.toISOString(),
  };
}

/** Config is stored in paise but presented to admins in rupees. */
export function toConfigDto(config: Record<string, unknown>): Record<string, unknown> {
  // Every paise field the settings screen can edit has to be listed here. One
  // that is missing does not simply go blank: the form falls back to zero, so
  // the screen that sets the platform's flat commission shows DMC 0 while the
  // platform is really charging something else, and anyone adjusting it is
  // working from a number that was never true.
  const paiseFields = [
    'flatCommissionPaise',
    'adminFlatCommissionPaise',
    'payInFlatCommissionPaise',
    'payOutFlatCommissionPaise',
    'captainDailyLimitPaise',
    'captainMonthlyLimitPaise',
    'partyDailyLimitPaise',
    'partyMonthlyLimitPaise',
    'minimumTaskAmountPaise',
    'maximumTaskAmountPaise',
  ];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === '_id' || key === '__v' || key === 'key') continue;
    if (paiseFields.includes(key) && typeof value === 'number') {
      out[key.replace(/Paise$/, '')] = paiseToRupees(value);
      continue;
    }
    /**
     * The two conversion rates. Named for what they mean rather than how they
     * are stored, and converted like every other money figure — 959 becomes
     * 9.59, which is what "1 USDT = 9.59 DMC" says on the screen.
     *
     * Not in `paiseFields` above because that list keys off a `Paise` suffix,
     * and these end in `PerUsdt`; handled here so the rename is explicit rather
     * than an accident of a regular expression.
     */
    if (key === 'captainDmcPaisePerUsdt' && typeof value === 'number') {
      out['captainDmcPerUsdt'] = paiseToRupees(value);
      continue;
    }
    if (key === 'partyDmcPaisePerUsdt' && typeof value === 'number') {
      out['partyDmcPerUsdt'] = paiseToRupees(value);
      continue;
    }
    if (key === 'commissionTiers' && Array.isArray(value)) {
      out[key] = value.map((tier) => {
        const t = tier as Record<string, number | null>;
        return {
          minAmount: typeof t['minAmountPaise'] === 'number' ? paiseToRupees(t['minAmountPaise']) : 0,
          maxAmount: typeof t['maxAmountPaise'] === 'number' ? paiseToRupees(t['maxAmountPaise']) : null,
          percentage: t['percentage'] ?? 0,
          flat: typeof t['flatPaise'] === 'number' ? paiseToRupees(t['flatPaise']) : 0,
        };
      });
      continue;
    }
    out[key] = value;
  }
  return out;
}
