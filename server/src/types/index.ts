/**
 * Shared domain types. This file is the single source of truth for the
 * role set, task states, and transition table. Nothing may widen these.
 */

export const ROLES = ['ADMIN', 'PARTY', 'CAPTAIN'] as const;
export type Role = (typeof ROLES)[number];

export const TASK_STATES = [
  'CREATED',
  'ASSIGNED',
  'IN_PROGRESS',
  'PROOF_SUBMITTED',
  'AUDIT_PENDING',
  'COMPLETED',
  'REJECTED',
  'REASSIGNED',
  'EXPIRED',
  'CANCEL_REVIEW',
  'CANCEL_DISPUTED',
  'CANCELLED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * Authoritative transition table, exactly as specified. Any transition not
 * listed here is illegal and rejected server-side.
 *
 * Admin never acts as a first-line reviewer anywhere — only party and
 * captain audit each other (party audits the captain's proof; whichever of
 * party/captain did NOT ask for a cancellation reviews that request). Admin
 * steps in only when that review is REJECTED/disputed, as the last-resort
 * arbiter, and even then has exactly two moves: leave the task as it is
 * (REJECTED -> COMPLETED, or CANCEL_DISPUTED back to its pre-dispute state),
 * or roll the current captain all the way back and put the task back in the
 * open pool (-> REASSIGNED). A cancellation approved with no dispute at all
 * still goes straight to CANCELLED — only a genuine disagreement reaches
 * admin. Cancelling a task nobody has claimed yet (CREATED/REASSIGNED) is
 * immediate, since no captain has anything at stake.
 */
export * from './transaction';

export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  CREATED: ['ASSIGNED', 'CANCELLED'],
  // EXPIRED is reachable from here too: the completion clock starts at the
  // claim, so a task sat on and never started runs out just the same.
  ASSIGNED: ['IN_PROGRESS', 'CANCEL_REVIEW', 'EXPIRED'],
  // Once a captain has started work, the task can no longer be cancelled by
  // anyone (party, captain, or admin resolving a dispute) — only completed
  // or expired. This is the single, authoritative gate: every cancellation
  // request (from any role) routes through assertTransition, so removing
  // CANCEL_REVIEW here blocks the whole app at once, not just one screen.
  IN_PROGRESS: ['PROOF_SUBMITTED', 'EXPIRED'],
  PROOF_SUBMITTED: ['AUDIT_PENDING'],
  AUDIT_PENDING: ['COMPLETED', 'REJECTED'],
  COMPLETED: [],
  // A rejection sits here, captain's collateral still locked, until admin
  // either overrules it (-> COMPLETED) or reassigns the task (-> REASSIGNED).
  REJECTED: ['REASSIGNED', 'COMPLETED'],
  // A reassigned task re-enters the claimable pool.
  REASSIGNED: ['ASSIGNED', 'CANCELLED'],
  // Not a dead end: the captain who held it records why, which rejects (and
  // so reassigns) it back into the pool for another captain. Self-reported,
  // so it skips the admin gate that a party/captain dispute goes through.
  EXPIRED: ['REJECTED'],
  CANCEL_REVIEW: ['CANCELLED', 'CANCEL_DISPUTED'],
  CANCEL_DISPUTED: ['ASSIGNED', 'IN_PROGRESS', 'REASSIGNED'],
  CANCELLED: [],
});

/** States in which a task is claimable by an eligible captain. */
export const CLAIMABLE_STATES: readonly TaskState[] = ['CREATED', 'REASSIGNED'];

/**
 * States in which the captain still has money committed to the task.
 *
 * Claiming a pay-out takes the amount out of their DMC — they are undertaking
 * to send that much real money — and it comes back at completion alongside the
 * reimbursement, or on its own if the task ends any other way. These are the
 * states in between.
 */
export const DMC_HELD_STATES: readonly TaskState[] = [
  'ASSIGNED',
  'IN_PROGRESS',
  'PROOF_SUBMITTED',
  'AUDIT_PENDING',
  'REJECTED',
  'CANCEL_REVIEW',
  'CANCEL_DISPUTED',
];

/** Terminal states: no further transitions. */
export const TERMINAL_STATES: readonly TaskState[] = ['COMPLETED', 'CANCELLED'];

/**
 * How a party's beneficiary is fictionally paid out. Exactly one of these is
 * attached to a task, chosen by the party when they create it — never a real
 * payment rail, only enough structure to describe which simulated channel a
 * captain's mock payout would have used.
 */
export const PAYOUT_METHOD_TYPES = ['BANK', 'UPI', 'USDT'] as const;
export type PayoutMethodType = (typeof PAYOUT_METHOD_TYPES)[number];


export const PAYOUT_RESULTS = ['SUCCESS', 'FAILED', 'PENDING'] as const;
export type PayoutResult = (typeof PAYOUT_RESULTS)[number];

export const RECON_RESULTS = ['MATCHED', 'DISCREPANCY', 'UNMATCHED_STATEMENT_ENTRY', 'UNMATCHED_SYSTEM_TASK'] as const;
export type ReconResult = (typeof RECON_RESULTS)[number];

export const AUDIT_ACTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'OTP_ISSUED',
  'OTP_VERIFIED',
  'OTP_FAILED',
  'LOGOUT',
  'TOKEN_REFRESHED',
  'ACCOUNT_LOCKED',
  'ACCOUNT_UNLOCKED',
  'TASK_CREATED',
  'TASK_BULK_IMPORTED',
  'TASK_CLAIMED',
  'TASK_CLAIM_REJECTED',
  'TASK_STARTED',
  'TASK_PAYOUT_EXECUTED',
  'TASK_PROOF_SUBMITTED',
  'TASK_APPROVED',
  'TASK_REJECTED',
  'TASK_REJECTION_RESOLVED',
  'TASK_REASSIGNED',
  'TASK_EXPIRED',
  'TASK_CANCEL_REQUESTED',
  'TASK_CANCEL_APPROVED',
  'TASK_CANCEL_DISPUTED',
  'TASK_CANCEL_DISPUTE_RESOLVED',
  'TASK_CANCELLED',
  'COLLATERAL_LOCKED',
  'COLLATERAL_RELEASED',
  // Historical only. Admin used to be able to move a captain's collateral
  // directly; it is their own security money, posted and withdrawn by them,
  // so that route is gone. Kept here so existing audit records still read.
  'COLLATERAL_ADJUSTED',
  'COMMISSION_CREATED',
  'CONFIG_UPDATED',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_STATUS_CHANGED',
  'RECONCILIATION_RUN',
  'CAPTAIN_STATUS_CHANGED',
  'PARTY_LIMITS_UPDATED',
  'CAPTAIN_PROFILE_UPDATED',
  /** A captain applied to join, through the public registration form. */
  'CAPTAIN_REGISTRATION_SUBMITTED',
  /** They entered the code mailed to them, so the address is theirs. */
  'CAPTAIN_REGISTRATION_EMAIL_VERIFIED',
  'CAPTAIN_REGISTRATION_APPROVED',
  'CAPTAIN_REGISTRATION_REJECTED',
  /** A password was reset by email code rather than changed while signed in. */
  'PASSWORD_RESET',
  /** Proof arrived; the party has been asked to get their customer's answer. */
  'TASK_CONFIRMATION_REQUESTED',
  /** The party relayed their customer's answer, either way. */
  'TASK_CUSTOMER_CONFIRMED',
  'TASK_CUSTOMER_DISPUTED',
  /** Nobody came back in time, so the payout approved itself. */
  'TASK_AUTO_APPROVED',
  'WITHDRAWAL_REQUESTED',
  'WITHDRAWAL_PAYMENT_SUBMITTED',
  'WITHDRAWAL_FULFILLED',
  'WITHDRAWAL_DISPUTED',
  'WITHDRAWAL_DISPUTE_RESOLVED',
  'WITHDRAWAL_CANCELLED',
  'DMC_PURCHASED',
  /** A captain bought more room to work with; admin confirmed the money. */
  'CAPTAIN_LIMIT_PURCHASE_REQUESTED',
  'CAPTAIN_LIMIT_PURCHASE_APPROVED',
  'CAPTAIN_LIMIT_PURCHASE_REJECTED',
  'PARTY_DMC_GRANTED',
  'PARTY_DMC_PURCHASED',
  'PARTY_DMC_DEBITED',
  'PARTY_DMC_CREDITED',
  'PARTY_DMC_REFUNDED',
  'PLATFORM_COMMISSION_CREDITED',
  'PLATFORM_COMMISSION_REVERSED',
  'PLATFORM_WITHDRAWAL_REQUESTED',
  'PLATFORM_WITHDRAWAL_PAYMENT_SUBMITTED',
  'PLATFORM_WITHDRAWAL_FULFILLED',
  'PLATFORM_WITHDRAWAL_DISPUTED',
  'PLATFORM_WITHDRAWAL_DISPUTE_RESOLVED',
  'PLATFORM_WITHDRAWAL_CANCELLED',
  'PLATFORM_POOL_FUNDED',
  'PAYIN_CREATED',
  'PAYOUT_CREATED',
  'TRANSACTION_SETTLED',
  'TRANSACTION_DISPUTED',
  'TRANSACTION_DISPUTE_RESOLVED',
  'API_KEY_ISSUED',
  'API_KEY_REVOKED',
  'CALLBACK_DELIVERED',
  'CALLBACK_FAILED',
  'WALLET_CONVERTED',
  'REDEMPTION_REQUESTED',
  'REDEMPTION_PAID',
  'REDEMPTION_REJECTED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Authenticated principal attached to the request by auth middleware. */
export interface AuthUser {
  userId: string;
  role: Role;
  email: string;
  sessionId: string;
  partyId?: string;
  captainId?: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiFailure {
  success: false;
  message: string;
  errorCode: string;
  details?: Record<string, unknown>;
}
