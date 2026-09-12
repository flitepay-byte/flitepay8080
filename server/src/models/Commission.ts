import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * IMMUTABLE COMMISSION LEDGER
 * ---------------------------
 * A row is written once, when a task reaches the configured successful state.
 * It snapshots the rate that was in force at that moment, so a later change to
 * SystemConfig can never retroactively alter historical earnings.
 * Update and delete are blocked at the schema level, not merely by convention.
 */
export interface ICommission extends Document {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  captainId: Types.ObjectId;
  partyId: Types.ObjectId;

  taskAmountPaise: number;
  commissionPaise: number;

  /** Snapshot of the configuration used, for auditability. */
  /** The captain's rate this task was priced at, snapshotted at completion. */
  percentageRate: number;
  tierSnapshot?: unknown;
  configVersion: number;

  entryType: 'CREDIT';
  earnedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const commissionSchema = new Schema<ICommission>(
  {
    // One credit per task, enforced by the database, not by application logic.
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true, unique: true },
    captainId: { type: Schema.Types.ObjectId, ref: 'Captain', required: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },

    taskAmountPaise: { type: Number, required: true, min: 0 },
    commissionPaise: { type: Number, required: true, min: 0 },

    percentageRate: { type: Number, required: true, default: 0, min: 0 },
    tierSnapshot: { type: Schema.Types.Mixed, default: null },
    configVersion: { type: Number, required: true },

    entryType: { type: String, enum: ['CREDIT'], default: 'CREDIT' },
    earnedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

commissionSchema.index({ captainId: 1, earnedAt: -1 });
commissionSchema.index({ partyId: 1, earnedAt: -1 });
commissionSchema.index({ earnedAt: -1 });

const IMMUTABLE_MESSAGE =
  'Commission ledger entries are immutable. Post a correcting entry instead of modifying history.';

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'] as const) {
  commissionSchema.pre(op, function (next) {
    next(new Error(IMMUTABLE_MESSAGE));
  });
}
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  commissionSchema.pre(op, function (next) {
    next(new Error(IMMUTABLE_MESSAGE));
  });
}
commissionSchema.pre('save', function (next) {
  if (!this.isNew) {
    next(new Error(IMMUTABLE_MESSAGE));
    return;
  }
  next();
});

export const Commission = model<ICommission>('Commission', commissionSchema);
