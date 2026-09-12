import { Schema, model, type Document, type Types } from 'mongoose';

export interface IProof extends Document {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  captainId: Types.ObjectId;
  /** Fictional reference echoed from MockPayoutProvider. */
  providerReference: string;
  notes?: string;
  receiptFileName?: string | null;
  /** Cloudinary secure URL and public ID; the file itself is not stored locally. */
  receiptUrl?: string | null;
  receiptPublicId?: string | null;
  receiptMimeType?: string | null;
  receiptSizeBytes?: number | null;
  submittedAt: Date;
  /**
   * Set when the task this proof belonged to went back to the pool — a
   * rejection admin upheld, or a cancellation dispute admin reassigned.
   *
   * A task can legitimately be worked by more than one captain over its life,
   * so proof is not one-per-task: the previous captain's submission is kept
   * for the record and marked superseded, leaving the next captain free to
   * submit their own. Exactly one proof per task is ever live.
   */
  supersededAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const proofSchema = new Schema<IProof>(
  {
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    captainId: { type: Schema.Types.ObjectId, ref: 'Captain', required: true },
    providerReference: { type: String, required: true, trim: true, maxlength: 64 },
    notes: { type: String, maxlength: 500 },
    receiptFileName: { type: String, default: null },
    receiptUrl: { type: String, default: null },
    receiptPublicId: { type: String, default: null },
    receiptMimeType: { type: String, default: null },
    receiptSizeBytes: { type: Number, default: null, min: 0 },
    submittedAt: { type: Date, default: Date.now },
    supersededAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// "The proof for this task right now" — the query every audit view runs.
proofSchema.index({ taskId: 1, supersededAt: 1, submittedAt: -1 });

// At most one LIVE proof per task, enforced by the database rather than by
// whoever remembers to check. A task can accumulate several proofs over its
// life — each reassignment supersedes the last — so the uniqueness has to be
// partial, covering only the rows that have not been superseded.
proofSchema.index(
  { taskId: 1 },
  { unique: true, partialFilterExpression: { supersededAt: null } },
);
proofSchema.index({ captainId: 1, submittedAt: -1 });
proofSchema.index({ providerReference: 1 });

export const Proof = model<IProof>('Proof', proofSchema);

/**
 * The proof that currently stands for a task — the one an auditor should be
 * looking at. Superseded submissions from earlier captains stay in the
 * collection for the record but are never what a task "has".
 */
export function findLiveProof(taskId: Types.ObjectId) {
  return Proof.findOne({ taskId, supersededAt: null }).sort({ submittedAt: -1 });
}

/** Retires whatever proof a task currently has, when it goes back to the pool. */
export async function supersedeProofFor(taskId: Types.ObjectId): Promise<void> {
  await Proof.updateMany({ taskId, supersededAt: null }, { $set: { supersededAt: new Date() } });
}
