import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * What a code was issued to do.
 *
 * A code is only valid for the thing it was sent for. Without this the three
 * flows would share one pool of codes, and a code mailed to prove somebody owns
 * an address during registration would also complete a password reset or a
 * sign-in — which is the whole value of the second factor given away. So every
 * challenge carries its purpose and verification demands a match.
 */
export const OTP_PURPOSES = ['LOGIN', 'CAPTAIN_REGISTRATION', 'PASSWORD_RESET'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/**
 * Short-lived OTP challenge. The code itself is stored only as a SHA-256 hash;
 * a database dump therefore does not permit replaying an in-flight challenge.
 */
export interface IOtpToken extends Document {
  _id: Types.ObjectId;
  /**
   * Null for a registration, where no account exists yet. Present for a sign-in
   * and for a password reset, both of which act on an existing user.
   */
  userId?: Types.ObjectId | null;
  /**
   * Where the code was sent.
   *
   * Stored rather than accepted from the client on resend. It used to be a
   * request field, which meant whoever held a challenge id could name the
   * address the next code went to — the server always knew the right one and
   * asked anyway. The destination of a code is now decided once, when the
   * challenge is created, and never again.
   */
  email: string;
  purpose: OtpPurpose;
  /** Opaque handle returned to the client to correlate step 1 with step 2. */
  challengeId: string;
  otpHash: string;
  attempts: number;
  maxAttempts: number;
  consumedAt?: Date | null;
  lastSentAt: Date;
  expiresAt: Date;
  ip?: string;
  createdAt: Date;
}

const otpTokenSchema = new Schema<IOtpToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    email: { type: String, required: true, lowercase: true, trim: true },
    purpose: { type: String, enum: OTP_PURPOSES, required: true, default: 'LOGIN' },
    challengeId: { type: String, required: true, unique: true },
    otpHash: { type: String, required: true, select: false },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 5, min: 1 },
    consumedAt: { type: Date, default: null },
    lastSentAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    ip: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// TTL index: Mongo reaps expired challenges automatically.
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpTokenSchema.index({ userId: 1, createdAt: -1 });
otpTokenSchema.index({ email: 1, purpose: 1, createdAt: -1 });

export const OtpToken = model<IOtpToken>('OtpToken', otpTokenSchema);
