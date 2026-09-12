import { Schema, model, type Document, type Types } from 'mongoose';

export const ALLOCATION_OWNER_TYPES = ['PARTY', 'CAPTAIN', 'ADMIN'] as const;
export type AllocationOwnerType = (typeof ALLOCATION_OWNER_TYPES)[number];

/** VOID: the task this allocation was earned from was cancelled before the allocation was ever drawn against — kept for history, never consumable. */
export const ALLOCATION_STATUSES = ['AVAILABLE', 'PARTIALLY_USED', 'SETTLED', 'VOID'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

/**
 * DMC ALLOCATION — one row per earning event (never per individual DMC).
 * This is the source-of-truth ledger behind a captain's or admin's total
 * balance: it permanently preserves which party, customer, and task a chunk
 * of DMC came from, so a withdrawal can be traced back to its origin even
 * though the owner (captain/admin) only ever sees their total.
 *
 * `usedAmountPaise` covers BOTH a portion currently reserved against an
 * in-flight withdrawal and one already settled — the two are told apart by
 * looking at the withdrawal portion(s) referencing this allocation, not by a
 * separate field here, so this stays exactly the shape a reader expects:
 * amount / availableAmount / usedAmount / status.
 */
export interface IDMCAllocation extends Document {
  _id: Types.ObjectId;
  ownerType: AllocationOwnerType;
  ownerId: Types.ObjectId;
  sourcePartyId: Types.ObjectId;
  customerId?: Types.ObjectId | null;
  taskId: Types.ObjectId;
  /**
   * Denormalized from the task at the moment this allocation is created —
   * same reasoning as Task.commissionPaise being locked in at creation: the
   * owner's withdrawal portions must keep showing the exact task/customer
   * this DMC traced back to even if the Task or Customer record is later
   * edited, and a party viewing its own portion needs this without a join.
   */
  taskCode: string;
  customerName: string;
  amountPaise: number;
  availableAmountPaise: number;
  usedAmountPaise: number;
  status: AllocationStatus;
  /** What created this allocation — a task's creation (admin's cut) or completion (captain's earnings). */
  sourceTransactionId: string;
  createdAt: Date;
  updatedAt: Date;
}

const dmcAllocationSchema = new Schema<IDMCAllocation>(
  {
    ownerType: { type: String, enum: ALLOCATION_OWNER_TYPES, required: true },
    ownerId: { type: Schema.Types.ObjectId, required: true },
    sourcePartyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    taskCode: { type: String, required: true, trim: true },
    customerName: { type: String, required: true, trim: true },
    amountPaise: {
      type: Number,
      required: true,
      min: [1, 'Allocation amount must be greater than zero'],
      validate: { validator: Number.isInteger, message: 'amountPaise must be an integer (paise)' },
    },
    availableAmountPaise: { type: Number, required: true, min: 0 },
    usedAmountPaise: { type: Number, required: true, default: 0, min: 0 },
    status: { type: String, enum: ALLOCATION_STATUSES, required: true, default: 'AVAILABLE' },
    sourceTransactionId: { type: String, required: true, trim: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

// FIFO consumption: oldest still-available allocation for an owner first.
dmcAllocationSchema.index({ ownerType: 1, ownerId: 1, status: 1, createdAt: 1 });
// A party's own view: which of its tasks contributed to allocations.
dmcAllocationSchema.index({ sourcePartyId: 1, createdAt: -1 });
dmcAllocationSchema.index({ taskId: 1 });

export const DMCAllocation = model<IDMCAllocation>('DMCAllocation', dmcAllocationSchema);
