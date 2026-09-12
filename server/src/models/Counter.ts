import { Schema, model, type Document } from 'mongoose';

/**
 * Atomic sequence source for human-readable codes (TASK-2026-000125).
 * findOneAndUpdate with $inc is atomic at the document level, so concurrent
 * task creation cannot produce a duplicate code.
 */
export interface ICounter extends Document<string> {
  _id: string;
  sequence: number;
}

const counterSchema = new Schema<ICounter>({
  _id: { type: String, required: true },
  sequence: { type: Number, required: true, default: 0 },
});

export const Counter = model<ICounter>('Counter', counterSchema);

export async function nextSequence(key: string): Promise<number> {
  const doc = await Counter.findByIdAndUpdate(
    key,
    { $inc: { sequence: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return doc?.sequence ?? 1;
}
