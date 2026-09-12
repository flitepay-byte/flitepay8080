import { Schema, model, type Document, type Types } from 'mongoose';

export const OFFER_STATUSES = ['OFFERED', 'ACCEPTED', 'MISSED', 'WITHDRAWN'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/**
 * One turn in a task's routing: this captain was offered this task at this
 * moment, and either took it, let the window lapse, or had it pulled back.
 *
 * The Task itself only carries who holds the offer *right now*; this is the
 * history behind that — what the routing tried, in what order, and how fast
 * each captain answered. It is what makes a routing decision explainable after
 * the fact, and it is where response-time statistics come from.
 *
 * MISSED is the one that costs a captain: it means the task had to be handed
 * to someone else because they did not answer in time.
 */
export interface ITaskOffer extends Document {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  captainId: Types.ObjectId;
  status: OfferStatus;
  /** The fit score that won this captain the offer — see taskRouting.service.ts. */
  score: number;
  /** Which turn this was for the task: 1 for the first captain offered, 2 for the next, and so on. */
  sequence: number;
  offeredAt: Date;
  expiresAt: Date;
  respondedAt?: Date | null;
  /** Seconds from offer to acceptance; null unless accepted. */
  responseSeconds?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const taskOfferSchema = new Schema<ITaskOffer>(
  {
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    captainId: { type: Schema.Types.ObjectId, ref: 'Captain', required: true },
    status: { type: String, enum: OFFER_STATUSES, required: true, default: 'OFFERED', index: true },
    score: { type: Number, required: true, default: 0 },
    sequence: { type: Number, required: true, default: 1, min: 1 },
    offeredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    respondedAt: { type: Date, default: null },
    responseSeconds: { type: Number, default: null, min: 0 },
  },
  { timestamps: true },
);

// A task's routing history, in the order it was tried.
taskOfferSchema.index({ taskId: 1, sequence: 1 });
// A captain's own offer history, newest first.
taskOfferSchema.index({ captainId: 1, createdAt: -1 });

export const TaskOffer = model<ITaskOffer>('TaskOffer', taskOfferSchema);
