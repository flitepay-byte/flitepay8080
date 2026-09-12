import { Schema, model, type Document, type Types } from 'mongoose';
import { AUDIT_ACTIONS, ROLES, type AuditAction, type Role } from '../types';

export interface IAuditLog extends Document {
  _id: Types.ObjectId;
  userId?: Types.ObjectId | null;
  role?: Role | null;
  ip?: string;
  userAgent?: string;
  action: AuditAction;
  targetCollection: string;
  targetId?: string | null;
  oldState?: unknown;
  newState?: unknown;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    role: { type: String, enum: [...ROLES, null], default: null },
    ip: { type: String },
    userAgent: { type: String, maxlength: 300 },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    targetCollection: { type: String, required: true },
    targetId: { type: String, default: null },
    oldState: { type: Schema.Types.Mixed, default: null },
    newState: { type: Schema.Types.Mixed, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ targetCollection: 1, targetId: 1, timestamp: -1 });

// The audit trail is append-only.
const APPEND_ONLY = 'Audit log entries are append-only and cannot be modified or removed.';
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany'] as const) {
  auditLogSchema.pre(op, function (next) {
    next(new Error(APPEND_ONLY));
  });
}

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema);
