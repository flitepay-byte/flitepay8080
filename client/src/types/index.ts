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

/** Mirrors the server's frozen transition table; used by the state rail. */
export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  CREATED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCEL_REVIEW'],
  IN_PROGRESS: ['PROOF_SUBMITTED', 'EXPIRED', 'CANCEL_REVIEW'],
  PROOF_SUBMITTED: ['AUDIT_PENDING'],
  AUDIT_PENDING: ['COMPLETED', 'REJECTED'],
  COMPLETED: [],
  REJECTED: ['REASSIGNED', 'COMPLETED'],
  REASSIGNED: ['ASSIGNED', 'CANCELLED'],
  EXPIRED: [],
  CANCEL_REVIEW: ['CANCELLED', 'CANCEL_DISPUTED'],
  CANCEL_DISPUTED: ['ASSIGNED', 'IN_PROGRESS', 'REASSIGNED'],
  CANCELLED: [],
};

export type Role = 'ADMIN' | 'PARTY' | 'CAPTAIN';

export const PAYOUT_METHOD_TYPES = ['BANK', 'UPI', 'USDT'] as const;
export type PayoutMethodType = (typeof PAYOUT_METHOD_TYPES)[number];

/**
 * Why a party rejected a proof. The party picks one of these alongside their
 * free-text explanation; the category is what a later captain is shown,
 * because the free text is about a different captain's work.
 */
export const REJECTION_CATEGORIES = [
  { value: 'NOT_RECEIVED', label: 'The money never reached the customer' },
  { value: 'WRONG_DESTINATION', label: 'Sent to the wrong account or UPI id' },
  { value: 'WRONG_AMOUNT', label: 'The amount was wrong' },
  { value: 'PROOF_MISMATCH', label: 'The proof or reference did not match' },
  { value: 'OTHER', label: 'Something else' },
] as const;
export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number]['value'];

/** How the party's beneficiary is fictionally paid — visible to party, captain, and admin alike. */
export interface PayoutMethod {
  type: PayoutMethodType;
  /** Which bank the account sits with, e.g. "SBI" or "HDFC Bank". */
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

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status?: string;
  partyId?: string;
  captainId?: string;
  lastLoginAt?: string | null;
}

export interface Task {
  id: string;
  taskCode: string;
  customerId: string | null;
  customerName: string;
  identifier: string;
  payoutMethod: PayoutMethod | null;
  amount: number;
  /** Absent in captain-facing responses — the party's tracking reference is need-to-know for party/admin only. */
  externalRef?: string;
  /**
   * The opaque code a captain is shown. On captain-facing responses the server
   * puts this value into `taskCode` itself, so this field is populated only for
   * party and admin — who need both to trace a code a captain reads out.
   */
  captainTaskCode?: string | null;
  status: TaskState;
  captainId: string | null;
  partyId: string;
  claimedAt: string | null;
  startedAt: string | null;
  proofSubmittedAt: string | null;
  completedAt: string | null;
  /** Deadline for the holding captain to finish — drives the completion countdown. */
  expiresAt: string | null;
  /** Deadline for the offered captain to accept, while the task is still unclaimed. */
  offerExpiresAt: string | null;
  /** While EXPIRED: how long the captain has to acknowledge before the system reclaims it. */
  expiryAckDeadline: string | null;
  /**
   * The party's own words. Admin and the party always see it; a captain sees
   * it only when the rejection was about their own work — the server sends
   * null to anyone who inherited the task afterwards.
   */
  rejectionReason: string | null;
  rejectionCategory: RejectionCategory | null;
  /**
   * Captain-side only: the fixed, blameless instruction derived from the
   * category, shown in place of the party's text to a captain who did not do
   * the rejected work.
   */
  rejectionGuidance?: string | null;
  /**
   * Captain-side only: true when this captain used to hold the task and no
   * longer does. The row is frozen at the moment they lost it — its status is
   * their own outcome, not whatever is happening to the task now.
   */
  releasedFromYou?: boolean;
  releasedAt?: string | null;
  reassignmentCount: number;
  /** The payment reference the captain reported — a UTR, a UPI reference. */
  providerReference: string | null;
  /** The captain's commission — locked in at task creation. */
  commission: number | null;
  /** The platform's commission — locked in at task creation. */
  adminCommission: number | null;
  /** Both halves added, as one integral figure — see the server serializer. */
  partyCharge: number;
  createdAt: string;
  updatedAt: string;
  /** Set only while a cancellation is in review/dispute, or for the historical record after. Purely a label — never a behaviour switch. */
  cancelInitiatedBy: 'PARTY' | 'CAPTAIN' | null;
  cancelReason: string | null;
  /** Whichever side did NOT request the cancellation reviews it — this is their decision. */
  cancelReviewDecision: 'APPROVED' | 'REJECTED' | null;
  cancelReviewDecisionReason: string | null;
  /** Admin's last-resort call on a disputed cancellation. */
  adminCancelResolution: 'APPROVED' | 'REASSIGNED' | null;
  /** Admin's last-resort call on a party-rejected proof. */
  adminRejectionResolution: 'APPROVED' | 'REASSIGNED' | null;
}

export interface QueueCard {
  id: string;
  taskCode: string;
  customerName: string;
  identifier: string;
  amount: number;
  commission: number;
  status: string;
  createdAt: string;
  /** Deadline to accept this exclusive offer. Null once the task is open to everyone. */
  offerExpiresAt: string | null;
  /** True when routing ran out of captains and any eligible captain may claim it. */
  openToPool: boolean;
  /** How many captains have already been through this task. 0 for a fresh one. */
  reassignmentCount: number;
  /** What went wrong on the last attempt, as instruction — never the party's own words. */
  rejectionGuidance: string | null;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface StateEvent {
  from: TaskState | null;
  to: TaskState;
  role: string | null;
  reason: string | null;
  at: string;
}

export const BADGE_CODES = ['TOP_RATED', 'ON_TIME', 'RELIABLE', 'FAST_RESPONDER', 'VETERAN', 'NEW'] as const;
export type BadgeCode = (typeof BADGE_CODES)[number];

/** Derived from a captain's counters, never stored — so it can never drift out of step with them. */
export interface CaptainBadge {
  code: BadgeCode;
  label: string;
  description: string;
}

export interface CaptainProfile {
  id: string;
  userId?: string;
  captainCode: string;
  displayName: string;
  collateralBalance: number;
  /**
   * Admin's ceiling on live work, standing in for the collateral. Null means
   * the collateral itself is the ceiling, which is where every captain starts.
   */
  creditLimit?: number | null;
  lockedAmount: number;
  /**
   * The ceiling: how much live work this captain may hold at once. Fixed —
   * it moves only when their security or admin's override moves.
   */
  taskLimit: number;
  /**
   * How much more work the captain can take on right now: the task limit and
   * their DMC, whichever binds first.
   */
  canTakeNow: number;
  /** The collateral headroom on its own — what the claim guard enforces. */
  availableLimit: number;
  /** Working capital: what the captain can actually transact with. */
  dmcBalance: number;
  /** Admin's settings, as they affect this captain — see the server's captain profile endpoint. */
  terms?: {
    collateralLockPercentage: number;
    payInCommission: { mode: 'PERCENTAGE' | 'FLAT'; percentage: number; flat: number };
    payOutCommission: { mode: 'PERCENTAGE' | 'FLAT'; percentage: number; flat: number };
  };
  isOnline: boolean;
  status: string;
  totalTasksCompleted: number;
  /** Performance — see the server's captainRating.service.ts, which owns both the score and the badges. */
  rating: number;
  successRate: number;
  onTimeRate: number;
  badges: CaptainBadge[];
  totalTasksOnTime: number;
  totalTasksExpired: number;
  totalProofsRejected: number;
  totalRejectionsUpheldByAdmin: number;
  totalOffersMissed: number;
  meanAcceptSeconds: number | null;
  /** Null means "inherit the system default". Admin sets these per captain. */
  acceptanceWindowMinutes: number | null;
  completionWindowMinutes: number | null;
  dailyLimitOverride?: number | null;
  monthlyLimitOverride?: number | null;
  usage?: {
    dailyUsed: number;
    dailyLimit: number;
    monthlyUsed: number;
    monthlyLimit: number;
  };
}

export interface PartyProfile {
  id: string;
  userId?: string;
  partyCode: string;
  companyName: string;
  contactEmail: string;
  status: string;
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  /** DMC spending capacity for creating tasks — debited at task creation, credited back on a captain's Pay In settlement. */
  dmcBalance: number;
  taskCount?: number;
  taskValue?: number;
  createdAt?: string;
}

/** Simulated DMC purchase — see server dmcPurchase.service.ts. No real payment gateway is involved. */
/** `AWAITING_PAYMENT` is a draft the payer has not submitted yet — see the
 * server's status enums. An administrator never sees one. */
export const DEPOSIT_STATUSES = ['AWAITING_PAYMENT', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

/**
 * A captain's security-money deposit. It raises their collateral, but only
 * once admin confirms the money arrived — the same handshake a party top-up
 * goes through, and for the same reason.
 */
export type LimitPurchaseStatus = 'AWAITING_PAYMENT' | 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * A captain buying capacity outright.
 *
 * Not a security deposit: `credited` lands wholly on their DMC and their
 * approved ceiling, and no collateral is posted. Null until admin approves,
 * because a pending request has moved nothing.
 */
export interface LimitPurchaseDto {
  id: string;
  captainId: string;
  amount: number;
  /** The cap the request was judged against when it was made. */
  collateralAtRequest: number;
  credited: number | null;
  status: LimitPurchaseStatus;
  proof: {
    reference: string | null;
    notes: string | null;
    receiptUrl: string | null;
    receiptFileName: string | null;
    receiptMimeType: string | null;
  };
  /**
   * The payment as it was quoted when the request was opened — address, network,
   * rate and USDT amount, all frozen at that moment so a later settings change
   * cannot alter what somebody was already told to pay.
   */
  payment: {
    address: string | null;
    network: string | null;
    dmcPerUsdt: number | null;
    usdtAmount: number | null;
    markedPaidAt: string | null;
  };
  rejectionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** Admin's view only. */
  captainDisplayName?: string | null;
  captainCode?: string | null;
  captainCollateral?: number;
  currentLimitBefore?: number;
  currentLimitAfter?: number;
}

/** What a captain may buy right now, served rather than computed on screen. */
export interface LimitPurchaseOptionsDto {
  collateral: number;
  maxPurchase: number;
  hasPending: boolean;
}

export interface DmcPurchaseDto {
  id: string;
  captainId: string;
  amount: number;
  security: number;
  balance: number;
  simulatedPaymentRef: string;
  status: DepositStatus;
  /** How the security was split. Null until admin decides. */
  collateralCredited: number | null;
  dmcCredited: number | null;
  proof: {
    reference: string | null;
    notes: string | null;
    receiptUrl: string | null;
    receiptFileName: string | null;
    receiptMimeType: string | null;
  };
  /**
   * The payment as it was quoted when the request was opened — address, network,
   * rate and USDT amount, all frozen at that moment so a later settings change
   * cannot alter what somebody was already told to pay.
   */
  payment: {
    address: string | null;
    network: string | null;
    dmcPerUsdt: number | null;
    usdtAmount: number | null;
    markedPaidAt: string | null;
  };
  rejectionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** Admin-side lists name the depositing captain; their own view already knows. */
  captainDisplayName?: string | null;
  captainCode?: string | null;
  captainCollateral?: number;
}

/** A withdrawal PARENT's overall status — derived from whether every one of its portions has settled. */
export const REQUEST_STATUSES = ['PENDING', 'FULFILLED', 'CANCELLED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** One party-slice (PORTION) of a withdrawal's own status. */
export const WITHDRAWAL_STATUSES = ['PENDING', 'PARTY_PAID', 'FULFILLED', 'DISPUTED', 'CANCELLED'] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

/**
 * "Pay In" — a captain's request to cash out earned DMC; see server
 * WithdrawalRequest. The captain requests only a total; which party(s) that
 * DMC actually came from is backend-only (see DMCAllocation.ts) and never
 * shown here — this parent record only ever holds the total and its overall
 * status, so this shape is identical and safe for every viewer including the
 * captain. The real settlement detail lives on WithdrawalPortionDto below.
 */
export interface WithdrawalRequestDto {
  id: string;
  captainId: string;
  amount: number;
  captainUpiId: string;
  status: RequestStatus;
  createdAt: string;
  cancelledAt: string | null;
}

export interface WithdrawalPortionProofDto {
  reference: string;
  notes: string | null;
  receiptUrl: string | null;
  receiptFileName: string | null;
  receiptMimeType: string | null;
}

/** Never sent to a captain — this is exactly the source trace a captain must never see. */
export interface WithdrawalPortionAllocationDto {
  allocationId: string;
  amount: number;
  customerId: string | null;
  customerName: string;
  taskId: string;
  taskCode: string;
}

/**
 * One party's slice of a captain's withdrawal — full detail, for admin and
 * for the targeted party's own view of its own portion. Settlement is a
 * two-sided handshake: the party pays and submits proof (-> PARTY_PAID), and
 * the *captain* verifies it, confirming (-> FULFILLED, that slice moves) or
 * disputing (-> DISPUTED) — a dispute on one portion never blocks another.
 */
export interface WithdrawalPortionDto {
  id: string;
  withdrawalRequestId: string;
  captainId: string;
  partyId: string;
  /** Where this portion's payment must be sent. */
  captainUpiId: string;
  amount: number;
  allocations: WithdrawalPortionAllocationDto[];
  status: WithdrawalStatus;
  proof: WithdrawalPortionProofDto | null;
  disputeReason: string | null;
  /** Set only when admin resolved a dispute by sending this back for the party to pay again. */
  returnedToPartyAt: string | null;
  /** The captain's original complaint, kept so the second request makes sense. */
  returnedReason: string | null;
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  disputedAt: string | null;
}

/** Admin's oversight view of a captain's Pay In portion — same full detail as WithdrawalPortionDto, plus display names resolved from the raw ids for the list. */
export interface AdminCaptainWithdrawalPortionDto extends WithdrawalPortionDto {
  captainDisplayName: string | null;
  captainCode: string | null;
  partyCompanyName: string | null;
  partyCode: string | null;
}

/** The captain's own view of one portion — total, proof, and status only. Never who paid it or what it was for. */
export interface CaptainWithdrawalPortionDto {
  id: string;
  withdrawalRequestId: string;
  amount: number;
  status: WithdrawalStatus;
  proof: WithdrawalPortionProofDto | null;
  disputeReason: string | null;
  /** Set only when admin resolved a dispute by sending this back for the party to pay again. */
  returnedToPartyAt: string | null;
  /** The captain's original complaint, kept so the second request makes sense. */
  returnedReason: string | null;
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  disputedAt: string | null;
}

export const TOPUP_STATUSES = ['AWAITING_PAYMENT', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type TopUpStatus = (typeof TOPUP_STATUSES)[number];

/**
 * A party topping up its DMC balance beyond the registration grant. Real
 * security money the party sends directly to admin — not a self-service
 * purchase — so it sits pending until admin confirms actually receiving it.
 */
export interface PartyTopUpRequestDto {
  id: string;
  partyId: string;
  amount: number;
  status: TopUpStatus;
  proof: {
    reference: string | null;
    notes: string | null;
    receiptUrl: string | null;
    receiptFileName: string | null;
    receiptMimeType: string | null;
  };
  rejectionReason: string | null;
  /** Admin-side lists name the paying party; the party's own view already knows. */
  partyCompanyName?: string | null;
  partyCode?: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** Admin cashing out earned platform commission — same parent/portion pattern as a captain's Pay In, minus the captain-specific fields. */
export interface AdminWithdrawalRequestDto {
  id: string;
  amount: number;
  status: RequestStatus;
  createdAt: string;
  cancelledAt: string | null;
}

/** Admin's own withdrawal portion — same full detail as WithdrawalPortionDto, minus the captain-specific field. */
export interface AdminWithdrawalPortionDto {
  id: string;
  withdrawalRequestId: string;
  partyId: string;
  amount: number;
  allocations: WithdrawalPortionAllocationDto[];
  status: WithdrawalStatus;
  proof: WithdrawalPortionProofDto | null;
  disputeReason: string | null;
  /** Set only when admin resolved a dispute by sending this back for the party to pay again. */
  returnedToPartyAt: string | null;
  /** The captain's original complaint, kept so the second request makes sense. */
  returnedReason: string | null;
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  disputedAt: string | null;
}

export interface PlatformAccountDto {
  /** The same figure as poolBalance, under the name the cash-out screen uses. */
  commissionBalance: number;
  /**
   * The platform's one balance: admin's funding plus every party's commission,
   * less every captain's share. What is left in it is what the platform made.
   */
  poolBalance: number;
  /** Real money admin put in out of their own pocket. */
  poolFundedTotal: number;
  /** Commission charged to parties — the platform's income. */
  poolCollected: number;
  /** Commission paid to captains — its cost. */
  poolPaidOut: number;
  /** Income less cost. Negative means the network is being subsidised. */
  poolNet: number;
}

export interface TrackingResult {
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
  /** The money has gone out. The bank reference is deliberately not exposed. */
  paid: boolean;
}

export interface ApiError {
  message: string;
  errorCode: string;
  details?: Record<string, unknown>;
}

/** One movement in or out of a captain's commission wallet. */
export interface WalletEntryDto {
  id: string;
  kind: 'COMMISSION_EARNED' | 'CONVERTED_TO_CAPITAL';
  amount: number;
  walletBalanceAfter: number;
  /** Only a conversion touches working capital, so only a conversion sets this. */
  dmcBalanceAfter: number | null;
  sourceReference: string | null;
  createdAt: string;
}

export type RedemptionStatus = 'PENDING' | 'PAID' | 'REJECTED';

/** A captain asking to be paid real rupees for DMC. */
export interface RedemptionDto {
  id: string;
  amount: number;
  status: RedemptionStatus;
  payoutMethod: 'UPI' | 'BANK';
  payoutUpiId: string | null;
  payoutAccountName: string | null;
  payoutAccountNumber: string | null;
  payoutIfsc: string | null;
  paymentReference: string | null;
  paymentNotes: string | null;
  rejectionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** Admin-side lists name the captain; their own view already knows. */
  captainId?: string;
  captainCode?: string | null;
  captainName?: string | null;
}

export type TransactionDirection = 'PAY_IN' | 'PAY_OUT';
export type TransactionState =
  | 'CREATED' | 'ASSIGNED' | 'AWAITING_CUSTOMER' | 'CONFIRMED'
  | 'SETTLED' | 'EXPIRED' | 'CANCELLED' | 'DISPUTED';

/** A payment as its captain sees it — never naming the party it belongs to. */
export interface CaptainTransactionDto {
  id: string;
  code: string;
  direction: TransactionDirection;
  status: TransactionState;
  amount: number;
  commission: number;
  beneficiary: {
    name: string | null;
    upiId: string | null;
    accountNumber: string | null;
    ifsc: string | null;
  } | null;
  qrPayload: string | null;
  settlementReference: string | null;
  expiresAt: string;
  createdAt: string;
  settledAt: string | null;
}

/** A payment as admin sees it — the only view naming both counterparties. */
export interface AdminTransactionDto {
  id: string;
  code: string;
  direction: TransactionDirection;
  status: TransactionState;
  amount: number;
  commission: number;
  /**
   * The whole fee the party was charged, and what the platform keeps of it —
   * the charge less the captain's share, never its own percentage.
   */
  partyCharge: number;
  platformCommission: number;
  /** False means the pool could not cover it — the captain is owed, unpaid. */
  commissionPaid: boolean;
  partyId: string;
  partyName: string | null;
  partyCode: string | null;
  captainId: string | null;
  captainName: string | null;
  captainCode: string | null;
  partyReference: string;
  settlementReference: string | null;
  disputeReason: string | null;
  failureReason: string | null;
  callbackDelivered: boolean;
  callbackAttempts: number;
  createdAt: string;
  settledAt: string | null;
}

/** An API key as the party's dashboard lists it — never including the secret. */
export interface ApiKeyDto {
  keyId: string;
  label: string;
  status: 'ACTIVE' | 'REVOKED';
  callbackUrl: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** The one and only time the secret is ever returned. */
export interface IssuedApiKeyDto {
  keyId: string;
  secret: string;
  label: string;
  callbackUrl: string | null;
  createdAt: string;
}

/** A payment as its party sees it — never naming the captain who settled it. */
export interface PartyTransactionDto {
  id: string;
  reference: string;
  direction: TransactionDirection;
  status: TransactionState;
  amount: number;
  settlementReference: string | null;
  failureReason: string | null;
  createdAt: string;
  settledAt: string | null;
}

/** One captain commission entry, with the rate that actually applied to it. */
export interface CommissionDto {
  id: string;
  taskId: string;
  taskAmount: number;
  commission: number;
  mode: 'FLAT' | 'PERCENTAGE';
  percentageRate: number;
  flatAmount: number | null;
  /** Which settings version priced it — so a mid-month rate change is legible. */
  configVersion: number;
  earnedAt: string;
}

/**
 * A captain's application to join, as the admin screens see it.
 *
 * Carries no money of any kind, because registration involves none: an approved
 * captain begins at zero and posts security afterwards.
 */
export type RegistrationStatus = 'PENDING_EMAIL' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

export interface CaptainRegistrationDto {
  id: string;
  name: string;
  fullName: string;
  mobile: string;
  email: string;
  upiId: string;
  status: RegistrationStatus;
  emailVerifiedAt: string | null;
  rejectionReason: string | null;
  captainCode: string | null;
  createdCaptainId: string | null;
  createdAt: string;
  decidedAt: string | null;
}
