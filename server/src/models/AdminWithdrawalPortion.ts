import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * Where one party's slice of a withdrawal has got to.
 *
 * Finer than the request's own status because this is the half with a
 * handshake in it. PARTY_PAID is the party's claim — they say they sent the
 * money and attach proof — and it is deliberately not the end: FULFILLED comes
 * only when the other side confirms it arrived. DISPUTED is when they say it
 * did not, and admin is the only one who can end that.
 */
export const WITHDRAWAL_STATUSES = ['PENDING', 'PARTY_PAID', 'FULFILLED', 'DISPUTED', 'CANCELLED'] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

/**
 * Which earnings a slice was drawn from.
 *
 * Denormalised at the moment the portion is created rather than joined later,
 * for the same reason a task's commission is: the party paying it must keep
 * seeing exactly what it was for even if the task or customer is edited
 * afterwards.
 */
export interface IWithdrawalPortionAllocation {
  allocationId: Types.ObjectId;
  amountPaise: number;
  customerId?: Types.ObjectId | null;
  taskId: Types.ObjectId;
  taskCode: string;
  customerName: string;
}

/**
 * One party's slice of admin's own withdrawal — the same portion-per-source-
 * party pattern as WithdrawalPortion.ts, since admin's commission also
 * accrues from many different parties' tasks.
 */
export interface IAdminWithdrawalPortion extends Document {
  _id: Types.ObjectId;
  withdrawalRequestId: Types.ObjectId;
  partyId: Types.ObjectId;
  amountPaise: number;
  allocations: IWithdrawalPortionAllocation[];
  status: WithdrawalStatus;

  proofReference?: string | null;
  proofNotes?: string | null;
  proofReceiptUrl?: string | null;
  proofReceiptFileName?: string | null;
  proofReceiptMimeType?: string | null;

  disputeReason?: string | null;

  /** Admin sent this back for the party to pay again — see WithdrawalPortion.ts. */
  returnedToPartyAt?: Date | null;
  returnedReason?: string | null;

  paidAt?: Date | null;
  fulfilledAt?: Date | null;
  disputedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const portionAllocationSchema = new Schema<IWithdrawalPortionAllocation>(
  {
    allocationId: { type: Schema.Types.ObjectId, ref: 'DMCAllocation', required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    taskCode: { type: String, required: true, trim: true },
    customerName: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const adminWithdrawalPortionSchema = new Schema<IAdminWithdrawalPortion>(
  {
    withdrawalRequestId: { type: Schema.Types.ObjectId, ref: 'AdminWithdrawalRequest', required: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    allocations: { type: [portionAllocationSchema], default: [] },
    status: { type: String, enum: WITHDRAWAL_STATUSES, required: true, default: 'PENDING' },

    proofReference: { type: String, default: null, trim: true, maxlength: 64 },
    proofNotes: { type: String, default: null, maxlength: 500 },
    proofReceiptUrl: { type: String, default: null },
    proofReceiptFileName: { type: String, default: null },
    proofReceiptMimeType: { type: String, default: null },

    disputeReason: { type: String, default: null, maxlength: 500 },
    returnedToPartyAt: { type: Date, default: null },
    returnedReason: { type: String, default: null, maxlength: 500 },

    paidAt: { type: Date, default: null },
    fulfilledAt: { type: Date, default: null },
    disputedAt: { type: Date, default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

adminWithdrawalPortionSchema.index({ withdrawalRequestId: 1 });
adminWithdrawalPortionSchema.index({ partyId: 1, status: 1, createdAt: 1 });

export const AdminWithdrawalPortion = model<IAdminWithdrawalPortion>('AdminWithdrawalPortion', adminWithdrawalPortionSchema);
