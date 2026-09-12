import { Schema, model, type Document, type Types } from 'mongoose';
import { TASK_STATES, PAYOUT_METHOD_TYPES, type TaskState, type PayoutMethodType } from '../types';
import { REJECTION_CATEGORY_KEYS, type RejectionCategory } from '../utils/rejectionCategories';
import { generateCaptainTaskCode } from '../utils/ids';

export interface ITaskStateEvent {
  from: TaskState | null;
  to: TaskState;
  actorUserId?: Types.ObjectId | null;
  actorRole?: string;
  reason?: string;
  /**
   * Which captain held the task at this point in its life — stamped by the
   * hook below, so it cannot be forgotten at any of the many places a
   * transition is written. Null where nobody held it (before the first claim,
   * and after a reassignment).
   *
   * Without this the history cannot answer "who had it when", which is the
   * whole question once a task has passed through more than one captain. It
   * is surfaced to admin only.
   */
  captainId?: Types.ObjectId | null;
  at: Date;
}

/**
 * How the party says their beneficiary should be fictionally paid — exactly
 * one of BANK / UPI / USDT per task. Visible to the party, the assigned
 * captain, and admin alike (unlike `externalRef`, which is party/admin only);
 * a captain needs it to know what a real payout would have targeted.
 */
export interface ITaskPayoutMethod {
  type: PayoutMethodType;
  /** Which bank the account sits with, e.g. "SBI" or "HDFC Bank" — free text, since any bank may be named. */
  bankName?: string | null;
  accountNumber?: string | null;
  ifscCode?: string | null;
  accountHolderName?: string | null;
  upiId?: string | null;
  /** Optional screenshot of the UPI destination (QR/app), uploaded to Cloudinary. */
  screenshotUrl?: string | null;
  screenshotFileName?: string | null;
  screenshotMimeType?: string | null;
  walletAddress?: string | null;
}

export interface ITask extends Document {
  _id: Types.ObjectId;
  taskCode: string;
  partyId: Types.ObjectId;
  batchId?: Types.ObjectId | null;

  /** Live relationship to the Customer record; see models/Customer.ts. */
  customerId?: Types.ObjectId | null;
  /** Fictional beneficiary. Seeded demo data only. Snapshot — see Customer.ts. */
  /**
   * WHERE THIS TASK CAME FROM, AND WHY IT MATTERS.
   *
   * `DASHBOARD` is a party creating work by hand. The party is billed the
   * amount plus both commissions, the captain is credited into their
   * withdrawable earnings, and a person at the party audits the proof before
   * anything settles.
   *
   * `API` is a payout a party's own site asked for. The rules are different in
   * three ways, and each difference is deliberate:
   *
   *   The party is billed *exactly* the amount. ₹100 sent is ₹100 billed —
   *   the captain's fee comes out of the platform's funded pool instead, so
   *   the number the party sees and the number their customer receives are the
   *   same number.
   *
   *   The captain is credited into working DMC rather than withdrawable
   *   earnings, because in this model that capital is what lets them take the
   *   next pay-in. Money that could only be withdrawn would strand them.
   *
   *   The proof auto-approves. There is no person at the party — it is a
   *   server — so waiting for an audit would leave every payout hanging.
   *   The party can dispute it afterwards instead.
   *
   * Stored rather than inferred: a task created under one rule must keep that
   * rule for its whole life, even if the flows change around it.
   */
  origin: 'DASHBOARD' | 'API';
  /** API tasks only: where to tell the party the outcome. */
  /**
   * The API key whose call created this, kept so a retried callback goes back to
   * the same key and the same callback URL.
   *
   * Null for anything not created through the partner API — a task a party
   * raised from its dashboard has no key behind it and nothing to call back to.
   *
   * Without this a retry had to pick any of the party's live keys, which for a
   * party running staging and production side by side meant a production retry
   * could be delivered to the staging endpoint.
   */
  createdByKeyId?: string | null;
  callbackUrl?: string | null;
  callbackDeliveredAt?: Date | null;
  callbackAttempts: number;

  /**
   * A party objecting to an API payout after it auto-approved.
   *
   * Recorded beside the task rather than as a state of it. The task is
   * COMPLETED and must stay COMPLETED — what is being raised is an objection
   * to a finished payment, not a new stage of the payment. Reversing money
   * from here on one side's word is exactly the "credit early, compensate
   * later" pattern the rest of this system avoids, so the objection waits for
   * a person instead.
   */
  payoutDisputedAt?: Date | null;
  payoutDisputeReason?: string | null;
  payoutDisputedBy?: Types.ObjectId | null;
  payoutDisputeResolvedAt?: Date | null;
  payoutDisputeDecision?: 'UPHELD' | 'REJECTED' | null;
  payoutDisputeResolution?: string | null;

  customerName: string;
  /** Fictional destination handle, e.g. DEMO-UPI-001. Never a real VPA. Derived from payoutMethod for single-created tasks; supplied directly by CSV bulk import. */
  identifier: string;
  /** Absent only for older bulk-imported tasks created before this field existed. */
  payoutMethod?: ITaskPayoutMethod | null;
  amountPaise: number;
  externalRef: string;
  /**
   * The task's identifier as a captain sees it. Opaque on purpose: `taskCode`
   * spells out the owning party, which a captain must never learn.
   */
  captainTaskCode: string;

  status: TaskState;
  captainId?: Types.ObjectId | null;

  claimedAt?: Date | null;
  startedAt?: Date | null;
  proofSubmittedAt?: Date | null;
  auditedAt?: Date | null;
  auditedBy?: Types.ObjectId | null;
  completedAt?: Date | null;
  rejectionReason?: string | null;
  /** The fixed category behind the rejection; drives what a later captain is told. */
  rejectionCategory?: RejectionCategory | null;
  /**
   * The captain whose proof was rejected. Kept so that captain can still read
   * the party's own words about their work, while a captain who picks the task
   * up afterwards cannot.
   */
  rejectedCaptainId?: Types.ObjectId | null;
  /** Increments each time the task is rejected and returned to the pool. */
  reassignmentCount: number;
  previousCaptainIds: Types.ObjectId[];

  /** Deadline for the claiming captain to submit proof. */
  expiresAt?: Date | null;

  /**
   * EXCLUSIVE OFFER ROUTING — see taskRouting.service.ts. An unclaimed task is
   * offered to exactly one captain at a time, best-fit first; only they can
   * see or claim it until their window lapses. Once every eligible captain has
   * had a turn the task falls back to the open pool (`openPoolAt` set), where
   * anyone eligible may claim it, until the global max-age expiry catches it.
   */
  offeredCaptainId?: Types.ObjectId | null;
  offeredAt?: Date | null;
  /** When the current exclusive offer lapses — the captain's acceptance countdown. */
  offerExpiresAt?: Date | null;
  /** Everyone already offered this task, so routing never loops back to them. */
  offeredCaptainIds: Types.ObjectId[];
  /** Set once routing is exhausted and the task is claimable by any eligible captain. */
  openPoolAt?: Date | null;
  /**
   * Set when every captain who could ever take this task has already been
   * rejected off it, so routing can never place it again however long it
   * waits. Distinct from a temporary drought (everyone offline or short on
   * collateral), which resolves itself and is deliberately left unmarked.
   * Its only effect is to surface the task in admin's review queue — the task
   * is not closed, and clears the moment a captain becomes available.
   */
  routingStalledAt?: Date | null;

  /**
   * While EXPIRED: how long the captain who let it lapse has to acknowledge
   * and explain before the system reclaims the task and routes it onward. See
   * reclaimUnacknowledgedExpiredTasks in workflow.service.ts.
   */
  expiryAckDeadline?: Date | null;

  /** Populated by the simulated provider; never a real bank UTR. */
  providerReference?: string | null;

  /**
   * The captain's commission — computed and locked in at task creation (not
   * completion), since the party's DMC balance is debited for the full
   * amount (task amount + captain commission + admin commission) up front.
   * Credited to whichever captain completes the task, whether or not that's
   * the one it was first assigned to.
   */
  /**
   * THE RATES THIS TASK WAS PRICED AT.
   *
   * Stored rather than recomputed at completion, because a rate change between
   * the two would otherwise rewrite what somebody was already promised — and
   * because a dispute months later has to be answerable from the row itself,
   * not from whatever the settings happen to say today.
   *
   * `partyCommissionPaise` is the whole charge; the captain's share and the
   * platform's remainder below add back to it exactly.
   */
  partyCommissionPaise?: number | null;
  /**
   * The deadlines this task runs on, resolved from its party when it was
   * created and written here.
   *
   * Stored rather than looked up each time, so a settings or party change
   * cannot move the clock under work already in flight: a captain who accepted
   * a job with fifteen minutes on it keeps fifteen minutes. Null on rows
   * written before tasks carried their own clocks, which fall back to the
   * settings default — see taskClocks.service.ts.
   */
  acceptanceMinutes?: number | null;
  completionMinutes?: number | null;
  maxAgeMinutes?: number | null;
  expiryAckMinutes?: number | null;
  confirmationMinutes?: number | null;
  /**
   * When the party's window to relay their customer's answer runs out.
   *
   * Set when proof is submitted, cleared when the answer arrives or the sweep
   * approves it. Its presence is what marks a task as waiting on the customer,
   * and clearing it is what stops the sweep considering it twice.
   */
  confirmationDeadline?: Date | null;
  /** When the party was told to go and ask. Part of the confirmation trail. */
  confirmationRequestedAt?: Date | null;
  partyCommissionRate?: number | null;
  /** The rate the captain was actually paid at — see commission.service.ts. */
  captainCommissionRate?: number | null;
  /**
   * What admin had agreed with the captain, before the cap.
   *
   * Equal to the paid rate above on almost every row. It differs when this
   * party is charged less than the captain is promised, and then this is the
   * only record that the shortfall was a cap rather than a mistake — which is
   * exactly what a captain querying their pay will want answered.
   */
  captainCommissionRateAgreed?: number | null;
  commissionPaise?: number | null;
  /** The platform's commission — locked in and credited to PlatformAccount at task creation. */
  adminCommissionPaise?: number | null;

  /**
   * Cancellation review — set only while status is CANCEL_REVIEW or
   * CANCEL_DISPUTED (or after, for the historical record). Whoever did NOT
   * request the cancellation reviews it — never admin. Purely informational:
   * never a behaviour switch.
   */
  cancelInitiatedBy?: 'PARTY' | 'CAPTAIN' | null;
  cancelInitiatedByUserId?: Types.ObjectId | null;
  cancelReason?: string | null;
  /** ASSIGNED or IN_PROGRESS — where to send the task back if admin's resolution keeps it as-is. */
  preCancelStatus?: TaskState | null;
  /** The reviewer's (whoever didn't request the cancellation) decision. */
  cancelReviewDecision?: 'APPROVED' | 'REJECTED' | null;
  cancelReviewDecisionReason?: string | null;
  /** Admin's last-resort call on a disputed cancellation: keep as-is, or roll back and reassign. */
  adminCancelResolution?: 'APPROVED' | 'REASSIGNED' | null;
  /** Admin's last-resort call on a party-rejected proof: overrule and complete, or roll back and reassign. */
  adminRejectionResolution?: 'APPROVED' | 'REASSIGNED' | null;

  stateHistory: ITaskStateEvent[];
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const stateEventSchema = new Schema<ITaskStateEvent>(
  {
    from: { type: String, enum: [...TASK_STATES, null], default: null },
    to: { type: String, enum: TASK_STATES, required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String },
    reason: { type: String, maxlength: 500 },
    // Deliberately no default: `undefined` is what marks an event as not yet
    // stamped, which is how the pre-save hook tells a new event from one
    // loaded back out of the database.
    captainId: { type: Schema.Types.ObjectId, ref: 'Captain' },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const payoutMethodSchema = new Schema<ITaskPayoutMethod>(
  {
    type: { type: String, enum: PAYOUT_METHOD_TYPES, required: true },
    bankName: { type: String, default: null, trim: true },
    accountNumber: { type: String, default: null, trim: true },
    ifscCode: { type: String, default: null, trim: true, uppercase: true },
    accountHolderName: { type: String, default: null, trim: true },
    upiId: { type: String, default: null, trim: true, lowercase: true },
    screenshotUrl: { type: String, default: null },
    screenshotFileName: { type: String, default: null },
    screenshotMimeType: { type: String, default: null },
    walletAddress: { type: String, default: null, trim: true },
  },
  { _id: false },
);

const taskSchema = new Schema<ITask>(
  {
    taskCode: { type: String, required: true, unique: true, uppercase: true, trim: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    batchId: { type: Schema.Types.ObjectId, ref: 'ImportBatch', default: null },

    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    origin: { type: String, enum: ['DASHBOARD', 'API'], required: true, default: 'DASHBOARD', index: true },
    createdByKeyId: { type: String, default: null, index: true },
    callbackUrl: { type: String, default: null, maxlength: 500 },
    callbackDeliveredAt: { type: Date, default: null },
    callbackAttempts: { type: Number, required: true, default: 0, min: 0 },

    payoutDisputedAt: { type: Date, default: null, index: true },
    payoutDisputeReason: { type: String, default: null, maxlength: 500 },
    payoutDisputedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    payoutDisputeResolvedAt: { type: Date, default: null },
    payoutDisputeDecision: { type: String, enum: ['UPHELD', 'REJECTED', null], default: null },
    payoutDisputeResolution: { type: String, default: null, maxlength: 500 },

    customerName: { type: String, required: true, trim: true, maxlength: 160 },
    identifier: { type: String, required: true, trim: true, maxlength: 120 },
    payoutMethod: { type: payoutMethodSchema, default: null },
    amountPaise: {
      type: Number,
      required: true,
      min: [1, 'Task amount must be greater than zero'],
      validate: {
        validator: Number.isInteger,
        message: 'amountPaise must be an integer (paise), not a fractional rupee value',
      },
    },
    externalRef: { type: String, required: true, trim: true, maxlength: 120 },
    // Defaulted rather than assigned at the call site: every task needs one,
    // and a task that reaches the database without it would fall back to
    // showing captains the party-scoped code. Mongoose evaluates this per
    // document, so a retry after a collision gets a fresh value.
    captainTaskCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      default: generateCaptainTaskCode,
    },

    status: { type: String, enum: TASK_STATES, required: true, default: 'CREATED' },
    captainId: { type: Schema.Types.ObjectId, ref: 'Captain', default: null },

    claimedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    proofSubmittedAt: { type: Date, default: null },
    auditedAt: { type: Date, default: null },
    auditedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    completedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null, maxlength: 500 },
    rejectionCategory: { type: String, enum: REJECTION_CATEGORY_KEYS, default: null },
    rejectedCaptainId: { type: Schema.Types.ObjectId, ref: 'Captain', default: null },
    reassignmentCount: { type: Number, default: 0, min: 0 },
    previousCaptainIds: [{ type: Schema.Types.ObjectId, ref: 'Captain' }],

    expiresAt: { type: Date, default: null },

    offeredCaptainId: { type: Schema.Types.ObjectId, ref: 'Captain', default: null },
    offeredAt: { type: Date, default: null },
    offerExpiresAt: { type: Date, default: null },
    offeredCaptainIds: [{ type: Schema.Types.ObjectId, ref: 'Captain' }],
    openPoolAt: { type: Date, default: null },
    routingStalledAt: { type: Date, default: null },
    expiryAckDeadline: { type: Date, default: null },

    providerReference: { type: String, default: null, trim: true },

    partyCommissionPaise: { type: Number, default: null, min: 0 },
    acceptanceMinutes: { type: Number, default: null, min: 1, max: 1440 },
    completionMinutes: { type: Number, default: null, min: 1, max: 1440 },
    maxAgeMinutes: { type: Number, default: null, min: 1, max: 10080 },
    expiryAckMinutes: { type: Number, default: null, min: 1, max: 1440 },
    confirmationMinutes: { type: Number, default: null, min: 1, max: 1440 },
    confirmationDeadline: { type: Date, default: null },
    confirmationRequestedAt: { type: Date, default: null },
    partyCommissionRate: { type: Number, default: null, min: 0 },
    captainCommissionRate: { type: Number, default: null, min: 0 },
    captainCommissionRateAgreed: { type: Number, default: null, min: 0 },
    commissionPaise: { type: Number, default: null, min: 0 },
    adminCommissionPaise: { type: Number, default: null, min: 0 },

    cancelInitiatedBy: { type: String, enum: ['PARTY', 'CAPTAIN', null], default: null },
    cancelInitiatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: null, maxlength: 500 },
    preCancelStatus: { type: String, enum: [...TASK_STATES, null], default: null },
    cancelReviewDecision: { type: String, enum: ['APPROVED', 'REJECTED', null], default: null },
    cancelReviewDecisionReason: { type: String, default: null, maxlength: 500 },
    adminCancelResolution: { type: String, enum: ['APPROVED', 'REASSIGNED', null], default: null },
    adminRejectionResolution: { type: String, enum: ['APPROVED', 'REASSIGNED', null], default: null },

    stateHistory: { type: [stateEventSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: true,
    // Mongoose bumps __v and asserts it on save(); combined with the
    // compare-and-swap claim this makes lost updates detectable.
    optimisticConcurrency: true,
  },
);

// --- Indexes required by the specification ---
/**
 * Stamps the holding captain onto any state event that has not been stamped
 * yet. A transition is written from well over a dozen places; asking each of
 * them to remember this would guarantee that one eventually forgets, and a
 * history with holes in it is worse than none. Events already saved come back
 * with the field set (an id or an explicit null) and are left alone.
 *
 * The two transitions that clear `captainId` before pushing their event —
 * a reassignment, and an expired task being returned to the pool — set it
 * themselves, since by this point the task no longer knows who was rolled off.
 */
taskSchema.pre('save', function (next) {
  for (const event of this.stateHistory) {
    if (event.captainId === undefined) event.captainId = this.captainId ?? null;
  }
  next();
});

taskSchema.index({ status: 1, amountPaise: 1 });
taskSchema.index({ captainId: 1, status: 1 });
// Reference/UTR lookup: drives customer tracking and reconciliation matching.
taskSchema.index({ externalRef: 1 });
taskSchema.index({ providerReference: 1 }, { sparse: true });

// --- Additional indexes justified by actual query paths ---
// Party dashboard: "my tasks, newest first", optionally filtered by status.
taskSchema.index({ partyId: 1, status: 1, createdAt: -1 });
// Captain queue: claimable tasks ordered by age (fair FIFO surfacing).
taskSchema.index({ status: 1, createdAt: 1 });
// Expiry sweeper: find in-flight tasks past their deadline.
taskSchema.index({ status: 1, expiresAt: 1 }, { sparse: true });
// Captain queue: the task currently offered to me, plus the offer sweeper's
// hunt for lapsed offers. See taskRouting.service.ts.
taskSchema.index({ offeredCaptainId: 1, status: 1 }, { sparse: true });
taskSchema.index({ status: 1, offerExpiresAt: 1 }, { sparse: true });
// Reclaim sweeper: expired tasks whose captain never explained themselves.
taskSchema.index({ status: 1, expiryAckDeadline: 1 }, { sparse: true });
// The sweep that auto-approves a payout nobody came back on.
taskSchema.index({ status: 1, confirmationDeadline: 1 }, { sparse: true });
// Admin audit desk: oldest pending audit first.
taskSchema.index({ status: 1, proofSubmittedAt: 1 }, { sparse: true });
// Bulk import drill-down.
taskSchema.index({ batchId: 1 }, { sparse: true });
// A customer's task history.
taskSchema.index({ customerId: 1, createdAt: -1 }, { sparse: true });
// Per-party duplicate detection on external reference.
taskSchema.index({ partyId: 1, externalRef: 1 }, { unique: true });

export const Task = model<ITask>('Task', taskSchema);
