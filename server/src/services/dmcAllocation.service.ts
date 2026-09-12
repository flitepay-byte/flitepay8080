import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { DMCAllocation, type AllocationOwnerType, type IDMCAllocation } from '../models';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';

/**
 * DMC ALLOCATION — the source-of-truth ledger behind a captain's or admin's
 * total balance. One row per earning event (a task's completion for a
 * captain, a task's creation for admin's commission), never per individual
 * DMC. The owner (captain/admin) only ever sees their aggregate total; this
 * is what lets a withdrawal still be traced back to the exact party,
 * customer, and task it came from — for admin's full visibility and each
 * party's own portion — without ever exposing that breakdown to the owner.
 */

export interface CreateAllocationInput {
  ownerType: AllocationOwnerType;
  ownerId: Types.ObjectId;
  sourcePartyId: Types.ObjectId;
  customerId?: Types.ObjectId | null;
  taskId: Types.ObjectId;
  taskCode: string;
  customerName: string;
  amountPaise: number;
  sourceTransactionId: string;
}

export async function createAllocation(input: CreateAllocationInput, session?: ClientSession): Promise<IDMCAllocation> {
  const docs = await DMCAllocation.create(
    [
      {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        sourcePartyId: input.sourcePartyId,
        customerId: input.customerId ?? null,
        taskId: input.taskId,
        taskCode: input.taskCode,
        customerName: input.customerName,
        amountPaise: input.amountPaise,
        availableAmountPaise: input.amountPaise,
        usedAmountPaise: 0,
        status: 'AVAILABLE',
        sourceTransactionId: input.sourceTransactionId,
      },
    ],
    session ? { session } : {},
  );
  const doc = docs[0];
  if (!doc) throw AppError.internal('Allocation creation returned no document');
  return doc;
}

export interface ConsumedSlice {
  allocationId: Types.ObjectId;
  amountPaise: number;
  sourcePartyId: Types.ObjectId;
  customerId: Types.ObjectId | null;
  taskId: Types.ObjectId;
  taskCode: string;
  customerName: string;
}

/**
 * FIFO-consumes an owner's oldest still-available allocations to cover a
 * requested total, immediately marking the drawn amount as used (this is
 * the "reserve" step — a withdrawal request holds these slices from the
 * moment it's created, exactly like a captain's collateral lock, so two
 * concurrent requests can never double-spend the same DMC). Returns the
 * individual slices consumed, each tagged with its source party — grouping
 * those into per-party withdrawal portions is the caller's job.
 *
 * Throws if the owner's available total can't cover the request; nothing is
 * partially consumed on failure.
 */
export async function consumeAllocationsFifo(
  ownerType: AllocationOwnerType,
  ownerId: Types.ObjectId,
  amountPaise: number,
  session?: ClientSession,
): Promise<ConsumedSlice[]> {
  const candidates = await DMCAllocation.find({ ownerType, ownerId, status: { $ne: 'SETTLED' } })
    .sort({ createdAt: 1 })
    .session(session ?? null);

  const totalAvailable = candidates.reduce((sum, a) => sum + a.availableAmountPaise, 0);
  if (totalAvailable < amountPaise) {
    throw AppError.unprocessable(
      ErrorCodes.INSUFFICIENT_AVAILABLE_BALANCE,
      `Not enough DMC available (have ${totalAvailable}, need ${amountPaise})`,
      { availablePaise: totalAvailable, requestedPaise: amountPaise },
    );
  }

  const slices: ConsumedSlice[] = [];
  let remaining = amountPaise;

  for (const allocation of candidates) {
    if (remaining <= 0) break;
    if (allocation.availableAmountPaise <= 0) continue;

    const draw = Math.min(remaining, allocation.availableAmountPaise);
    const updated = await DMCAllocation.findOneAndUpdate(
      { _id: allocation._id, availableAmountPaise: { $gte: draw } },
      { $inc: { availableAmountPaise: -draw, usedAmountPaise: draw } },
      session ? { session, new: true } : { new: true },
    );
    if (!updated) {
      // Lost a race with another consumer — abort; the caller's transaction
      // (or the compensating release on the non-transactional path) undoes
      // any slices already drawn in this call.
      throw AppError.conflict(ErrorCodes.CONFLICT, 'DMC allocation changed concurrently — please retry');
    }
    updated.status = updated.availableAmountPaise === 0 ? 'SETTLED' : 'PARTIALLY_USED';
    await updated.save(session ? { session } : {});

    slices.push({
      allocationId: allocation._id,
      amountPaise: draw,
      sourcePartyId: allocation.sourcePartyId,
      customerId: allocation.customerId ?? null,
      taskId: allocation.taskId,
      taskCode: allocation.taskCode,
      customerName: allocation.customerName,
    });
    remaining -= draw;
  }

  return slices;
}

/** Reverses a consume — used when a withdrawal is cancelled before any portion is paid. */
export async function releaseAllocations(slices: ConsumedSlice[], session?: ClientSession): Promise<void> {
  for (const slice of slices) {
    const updated = await DMCAllocation.findOneAndUpdate(
      { _id: slice.allocationId },
      { $inc: { availableAmountPaise: slice.amountPaise, usedAmountPaise: -slice.amountPaise } },
      session ? { session, new: true } : { new: true },
    );
    if (!updated) continue;
    updated.status = updated.usedAmountPaise === 0 ? 'AVAILABLE' : 'PARTIALLY_USED';
    await updated.save(session ? { session } : {});
  }
}

/**
 * Voids the allocation an event created, when that event turns out to have
 * never happened after all (a cancelled task's admin commission — see
 * refundPartyForCancelledTask in workflow.service.ts). Only succeeds while the
 * allocation is still fully untouched (status AVAILABLE): if a withdrawal has
 * already drawn against it, that DMC has already left this event's hands and
 * unwinding it would mean unwinding an unrelated withdrawal too, which is out
 * of scope here — same as the aggregate PlatformAccount reversal beside it,
 * this covers the common case, not every possible race. The row is kept, never
 * deleted, so the ledger's history stays complete.
 */
/** Groups consumed slices by source party — one withdrawal portion per distinct party. */
export function groupSlicesByParty(slices: ConsumedSlice[]): Map<string, ConsumedSlice[]> {
  const groups = new Map<string, ConsumedSlice[]>();
  for (const slice of slices) {
    const key = String(slice.sourcePartyId);
    const existing = groups.get(key);
    if (existing) existing.push(slice);
    else groups.set(key, [slice]);
  }
  return groups;
}
