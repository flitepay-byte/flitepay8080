import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * How far a withdrawal has got, as a whole.
 *
 * A request is split into one portion per source party, so the parent's status
 * is a summary of its children: PENDING while any is unresolved, FULFILLED
 * once they all settle. Deliberately coarser than a portion's own status —
 * whether one party has paid yet is the portion's business, not the request's.
 */
export const REQUEST_STATUSES = ['PENDING', 'FULFILLED', 'CANCELLED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * Admin cashing out its earned platform commission (see PlatformAccount and
 * DMCAllocation.ts). Same parent/portion split as a captain's Pay In: this
 * is just the total requested and its overall status; the real settlement
 * detail (which party, proof, confirm/dispute) lives on AdminWithdrawalPortion.
 */
export interface IAdminWithdrawalRequest extends Document {
  _id: Types.ObjectId;
  amountPaise: number;
  status: RequestStatus;
  cancelledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const adminWithdrawalRequestSchema = new Schema<IAdminWithdrawalRequest>(
  {
    amountPaise: {
      type: Number,
      required: true,
      min: [1, 'Withdrawal amount must be greater than zero'],
      validate: {
        validator: Number.isInteger,
        message: 'amountPaise must be an integer (paise)',
      },
    },
    status: { type: String, enum: REQUEST_STATUSES, required: true, default: 'PENDING', index: true },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

export const AdminWithdrawalRequest = model<IAdminWithdrawalRequest>('AdminWithdrawalRequest', adminWithdrawalRequestSchema);
