import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * Server-side session record. Holding this alongside the JWT means logout and
 * admin-forced revocation take effect immediately, which a stateless token
 * alone cannot provide.
 */
export interface ISession extends Document {
  _id: Types.ObjectId;
  sessionId: string;
  userId: Types.ObjectId;
  refreshTokenHash: string;
  ip?: string;
  userAgent?: string;
  revokedAt?: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

const sessionSchema = new Schema<ISession>(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    refreshTokenHash: { type: String, required: true, select: false },
    ip: { type: String },
    userAgent: { type: String, maxlength: 300 },
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1, revokedAt: 1 });

export const Session = model<ISession>('Session', sessionSchema);
