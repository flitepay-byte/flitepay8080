import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * A full copy of SystemConfig as it stood at one version.
 *
 * SystemConfig is a single document that is edited in place, so every save
 * overwrites the values it replaces. The version counter on it went up but the
 * settings it counted were gone: "priced under v2" named a state nobody could
 * look at any more. The audit log recorded each change as a diff, which
 * answers "what moved" but never "what was everything else at the time" —
 * and reconstructing that meant replaying every diff backwards by hand.
 *
 * So each version is copied here whole, when it is made. The cost is one small
 * document per settings change, which is a price worth paying to be able to
 * answer a dispute about what a task was priced under.
 *
 * Rows are immutable and cannot be deleted: a version is a record of a state
 * that really existed, and editing it would make every commission row that
 * cites it a lie. The hooks below enforce that rather than trusting nobody to
 * try — the same treatment the wallet ledger gets, for the same reason.
 */
export interface ISystemConfigVersion extends Document {
  _id: Types.ObjectId;
  /** The version this is a copy of. Unique, so a snapshot cannot be written twice. */
  version: number;
  /**
   * Every field of the config as it stood, exactly as stored — paise still in
   * paise, no rounding, no field dropped. Kept as a loose object on purpose:
   * a snapshot must survive a later change to the config's shape, and a typed
   * copy would quietly stop recording whatever field was added after it.
   */
  snapshot: Record<string, unknown>;
  /**
   * Which fields this version changed, and from what. Null on the first
   * version, which changed nothing because there was nothing before it.
   */
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  /** Who saved it. Null for the version the system bootstrapped itself with. */
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
}

const systemConfigVersionSchema = new Schema<ISystemConfigVersion>(
  {
    version: { type: Number, required: true, unique: true, min: 1 },
    snapshot: { type: Schema.Types.Mixed, required: true },
    changes: { type: Schema.Types.Mixed, default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

systemConfigVersionSchema.index({ version: -1 });

const IMMUTABLE = 'Settings versions are a record of what was, and cannot be modified or removed.';
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany'] as const) {
  systemConfigVersionSchema.pre(op, function reject() {
    throw new Error(IMMUTABLE);
  });
}

export const SystemConfigVersion = model<ISystemConfigVersion>(
  'SystemConfigVersion',
  systemConfigVersionSchema,
);
