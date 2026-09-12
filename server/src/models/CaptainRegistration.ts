import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * A CAPTAIN'S APPLICATION TO JOIN
 * -------------------------------
 * Held here, in its own collection, rather than as a half-made `User` waiting to
 * be switched on.
 *
 * The reason is that an account which exists but may not be used has to be
 * excluded by hand from every query that ever looks at users or captains — the
 * routing scan, the admin lists, the reconciliation sweeps — and the day one of
 * them forgets is the day an unapproved captain is offered real work. Keeping the
 * application separate means a captain either exists or does not, and nothing
 * downstream needs to know this collection is here at all.
 *
 * It is also the shape the rest of this system already uses for anything waiting
 * on an administrator: a deposit, a top-up, a withdrawal and a capacity purchase
 * are all a document with PENDING, APPROVED and REJECTED, and all of them surface
 * in the admin review queue from that status. An application is one more of those.
 *
 * Nothing here is a balance and nothing here is money. On approval this becomes a
 * `User` plus a `Captain` with every figure at zero, and the captain funds
 * themselves afterwards through the ordinary security-deposit handshake.
 */
export const REGISTRATION_STATUSES = [
  /** Submitted; the email address has not been confirmed yet. */
  'PENDING_EMAIL',
  /** Email confirmed. This is the state an administrator sees and decides on. */
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export interface ICaptainRegistration extends Document {
  _id: Types.ObjectId;
  /** What the captain is called on screen, and what becomes `Captain.displayName`. */
  name: string;
  /** Their legal name, and what becomes `User.name`. Admin-facing only. */
  fullName: string;
  /**
   * A contact number and nothing more.
   *
   * Explicitly not an identity factor: no code is ever sent here and it plays no
   * part in signing in. Every verification in this system goes to email.
   */
  mobile: string;
  email: string;
  /** Where this captain is paid. Captured here at the applicant's own request. */
  upiId: string;
  /**
   * Already hashed, with the same cost as a real account's, because a pending
   * application is a credential store like any other and a rejected one may sit
   * here for a long time.
   */
  passwordHash: string;

  status: RegistrationStatus;
  /** The OTP challenge currently outstanding against this application. */
  challengeId?: string | null;
  emailVerifiedAt?: Date | null;

  rejectionReason?: string | null;
  decidedBy?: Types.ObjectId | null;
  decidedAt?: Date | null;

  /** Set on approval, so an approved application points at what it produced. */
  createdUserId?: Types.ObjectId | null;
  createdCaptainId?: Types.ObjectId | null;
  captainCode?: string | null;

  /** Where the application came from, for an administrator judging it. */
  ip?: string | null;

  createdAt: Date;
  updatedAt: Date;
}

const captainRegistrationSchema = new Schema<ICaptainRegistration>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    fullName: { type: String, required: true, trim: true, maxlength: 160 },
    mobile: { type: String, required: true, trim: true, maxlength: 20 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    upiId: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    passwordHash: { type: String, required: true, select: false },

    status: { type: String, enum: REGISTRATION_STATUSES, required: true, default: 'PENDING_EMAIL', index: true },
    challengeId: { type: String, default: null, index: true },
    emailVerifiedAt: { type: Date, default: null },

    rejectionReason: { type: String, default: null, trim: true, maxlength: 500 },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },

    createdUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdCaptainId: { type: Schema.Types.ObjectId, ref: 'Captain', default: null },
    captainCode: { type: String, default: null, uppercase: true, trim: true },

    ip: { type: String, default: null },
  },
  { timestamps: true },
);

/**
 * One live application per address, and only while it is live.
 *
 * A partial index rather than a plain unique one, because a rejected applicant
 * must be able to apply again. Were it unconditional, a single rejection would
 * bar that address forever and the only remedy would be an administrator
 * deleting rows by hand.
 */
captainRegistrationSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['PENDING_EMAIL', 'PENDING_APPROVAL'] } },
  },
);

// The admin queue reads the oldest undecided applications first.
captainRegistrationSchema.index({ status: 1, createdAt: 1 });

export const CaptainRegistration = model<ICaptainRegistration>(
  'CaptainRegistration',
  captainRegistrationSchema,
);
