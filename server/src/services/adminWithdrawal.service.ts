import mongoose, { Types } from 'mongoose';
import {
  Party,
  AdminWithdrawalRequest,
  AdminWithdrawalPortion,
  type IAdminWithdrawalRequest,
  type IAdminWithdrawalPortion,
} from '../models';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { recordAudit } from './audit.service';
import { supportsTransactions } from '../config/db';
import { consumeAllocationsFifo, releaseAllocations, groupSlicesByParty, type ConsumedSlice } from './dmcAllocation.service';
import { debitPlatformCommission, PLATFORM_OWNER_ID } from './platformAccount.service';
import type { Role } from '../types';

/**
 * Admin cashing out its earned platform commission — the same parent/portion
 * pattern as a captain's Pay In (see withdrawal.service.ts): admin requests
 * only a total, the backend FIFO-consumes admin's DMCAllocation rows and
 * splits the total into one portion per source party, and each party
 * settles only its own portion.
 */

export interface ActorContext {
  userId: string;
  role: Role;
  ip?: string;
}

export interface PaymentProofInput {
  providerReference: string;
  notes?: string;
  receipt?: { url: string; fileName: string; mimeType: string };
}

async function createPortions(
  withdrawalRequestId: Types.ObjectId,
  slices: ConsumedSlice[],
  session?: mongoose.ClientSession,
): Promise<IAdminWithdrawalPortion[]> {
  const groups = groupSlicesByParty(slices);
  const docs = [...groups.entries()].map(([partyId, partySlices]) => ({
    withdrawalRequestId,
    partyId: new Types.ObjectId(partyId),
    amountPaise: partySlices.reduce((sum, s) => sum + s.amountPaise, 0),
    allocations: partySlices.map((s) => ({
      allocationId: s.allocationId,
      amountPaise: s.amountPaise,
      customerId: s.customerId,
      taskId: s.taskId,
      taskCode: s.taskCode,
      customerName: s.customerName,
    })),
    status: 'PENDING' as const,
  }));
  return AdminWithdrawalPortion.create(docs, session ? { session } : {}) as unknown as Promise<IAdminWithdrawalPortion[]>;
}

export async function requestPlatformWithdrawal(
  amountPaise: number,
  actor: ActorContext,
): Promise<{ request: IAdminWithdrawalRequest; portions: IAdminWithdrawalPortion[] }> {
  const existingActive = await AdminWithdrawalRequest.exists({ status: 'PENDING' });
  if (existingActive) {
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_REQUEST_PENDING, 'A withdrawal request is already in progress');
  }

  const useTransaction = await supportsTransactions();
  let request: IAdminWithdrawalRequest | undefined;
  let portions: IAdminWithdrawalPortion[] = [];

  const apply = async (session?: mongoose.ClientSession): Promise<void> => {
    const slices = await consumeAllocationsFifo('ADMIN', PLATFORM_OWNER_ID, amountPaise, session);
    const docs = await AdminWithdrawalRequest.create([{ amountPaise, status: 'PENDING' }], session ? { session } : {});
    const created = docs[0];
    if (!created) throw AppError.internal('Withdrawal request creation returned no document');
    request = created;
    portions = await createPortions(created._id, slices, session);
  };

  if (useTransaction) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => apply(session));
    } finally {
      await session.endSession();
    }
  } else {
    let slices: ConsumedSlice[] = [];
    try {
      slices = await consumeAllocationsFifo('ADMIN', PLATFORM_OWNER_ID, amountPaise);
      const docs = await AdminWithdrawalRequest.create([{ amountPaise, status: 'PENDING' }]);
      const created = docs[0];
      if (!created) throw AppError.internal('Withdrawal request creation returned no document');
      request = created;
      portions = await createPortions(created._id, slices, undefined);
    } catch (err) {
      if (slices.length > 0 && !request) await releaseAllocations(slices);
      throw err;
    }
  }
  if (!request) throw AppError.internal('Withdrawal request was not created');

  await recordAudit({
    action: 'PLATFORM_WITHDRAWAL_REQUESTED',
    targetCollection: 'AdminWithdrawalRequest',
    targetId: request._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { amountPaise, partyCount: portions.length },
  });

  return { request, portions };
}

export async function cancelPlatformWithdrawal(withdrawalId: string, actor: ActorContext): Promise<IAdminWithdrawalRequest> {
  if (!Types.ObjectId.isValid(withdrawalId)) {
    throw AppError.notFound('Withdrawal request not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);
  }
  const existing = await AdminWithdrawalRequest.findById(withdrawalId).lean();
  if (!existing) throw AppError.notFound('Withdrawal request not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);
  if (existing.status !== 'PENDING') {
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This request is no longer pending');
  }

  const portions = await AdminWithdrawalPortion.find({ withdrawalRequestId: existing._id }).lean();
  const anyPaid = portions.some((p) => p.status !== 'PENDING');
  if (anyPaid) {
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'A party has already paid part of this request — it can no longer be cancelled outright');
  }

  const slices: ConsumedSlice[] = portions.flatMap((p) =>
    p.allocations.map((a) => ({
      allocationId: a.allocationId,
      amountPaise: a.amountPaise,
      sourcePartyId: p.partyId,
      customerId: a.customerId ?? null,
      taskId: a.taskId,
      taskCode: a.taskCode,
      customerName: a.customerName,
    })),
  );
  await releaseAllocations(slices);

  await AdminWithdrawalPortion.updateMany({ withdrawalRequestId: existing._id }, { $set: { status: 'CANCELLED' } });
  const request = await AdminWithdrawalRequest.findOneAndUpdate(
    { _id: withdrawalId, status: 'PENDING' },
    { $set: { status: 'CANCELLED', cancelledAt: new Date() } },
    { new: true },
  );
  if (!request) {
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This request is no longer pending');
  }

  await recordAudit({
    action: 'PLATFORM_WITHDRAWAL_CANCELLED',
    targetCollection: 'AdminWithdrawalRequest',
    targetId: request._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
  });

  return request;
}

export async function submitPlatformPortionPaymentProof(
  portionId: string,
  partyId: Types.ObjectId,
  proof: PaymentProofInput,
  actor: ActorContext,
): Promise<IAdminWithdrawalPortion> {
  if (!Types.ObjectId.isValid(portionId)) {
    throw AppError.notFound('Withdrawal not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);
  }

  const updated = await AdminWithdrawalPortion.findOneAndUpdate(
    { _id: portionId, partyId, status: 'PENDING' },
    {
      $set: {
        status: 'PARTY_PAID',
        proofReference: proof.providerReference,
        proofNotes: proof.notes ?? null,
        proofReceiptUrl: proof.receipt?.url ?? null,
        proofReceiptFileName: proof.receipt?.fileName ?? null,
        proofReceiptMimeType: proof.receipt?.mimeType ?? null,
        paidAt: new Date(),
      },
    },
    { new: true },
  );
  if (!updated) {
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This request is no longer pending, or is not directed at you');
  }

  await recordAudit({
    action: 'PLATFORM_WITHDRAWAL_PAYMENT_SUBMITTED',
    targetCollection: 'AdminWithdrawalPortion',
    targetId: updated._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { providerReference: proof.providerReference },
  });

  return updated;
}

async function refreshRequestStatus(withdrawalRequestId: Types.ObjectId): Promise<void> {
  const portions = await AdminWithdrawalPortion.find({ withdrawalRequestId }).select('status').lean();
  if (portions.length > 0 && portions.every((p) => p.status === 'FULFILLED')) {
    await AdminWithdrawalRequest.updateOne({ _id: withdrawalRequestId, status: 'PENDING' }, { $set: { status: 'FULFILLED' } });
  }
}

/** Admin verifies one portion's proof and confirms receipt — only now does that slice actually move. */
export async function confirmPlatformPortionReceipt(portionId: string, actor: ActorContext): Promise<IAdminWithdrawalPortion> {
  if (!Types.ObjectId.isValid(portionId)) {
    throw AppError.notFound('Withdrawal not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);
  }
  const pending = await AdminWithdrawalPortion.findById(portionId).lean();
  if (!pending) throw AppError.notFound('Withdrawal not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);
  if (pending.status !== 'PARTY_PAID') {
    throw AppError.conflict(
      ErrorCodes.WITHDRAWAL_ALREADY_DECIDED,
      `This portion is not awaiting confirmation (currently ${pending.status.toLowerCase()})`,
    );
  }

  const useTransaction = await supportsTransactions();
  let result: IAdminWithdrawalPortion | undefined;

  const applyConfirm = async (session?: mongoose.ClientSession): Promise<void> => {
    // Claim the portion before moving anything — see withdrawal.service.ts for
    // why the order matters: a concurrent dispute flips the same field, and the
    // standalone path has no transaction to undo a half-applied settlement.
    const confirmed = await AdminWithdrawalPortion.findOneAndUpdate(
      { _id: portionId, status: 'PARTY_PAID' },
      { $set: { status: 'FULFILLED', fulfilledAt: new Date() } },
      { new: true, ...(session ? { session } : {}) },
    );
    if (!confirmed) {
      throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This portion is no longer awaiting confirmation');
    }

    await debitPlatformCommission(pending.amountPaise, session);

    await Party.findByIdAndUpdate(
      pending.partyId,
      { $inc: { dmcBalancePaise: pending.amountPaise } },
      session ? { session } : {},
    );

    result = confirmed;
  };

  if (useTransaction) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => applyConfirm(session));
    } finally {
      await session.endSession();
    }
  } else {
    await applyConfirm();
  }
  if (!result) throw AppError.internal('Withdrawal confirmation returned no document');

  await refreshRequestStatus(pending.withdrawalRequestId);

  await recordAudit({
    action: 'PLATFORM_WITHDRAWAL_FULFILLED',
    targetCollection: 'AdminWithdrawalPortion',
    targetId: pending._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { amountPaise: pending.amountPaise },
  });

  return result;
}

/**
 * Resolving a dispute on admin's own withdrawal — the same two outcomes, and
 * the same deadlock being closed, as resolvePortionDispute in
 * withdrawal.service.ts: without it the portion sits in DISPUTED, the parent
 * request never leaves PENDING, and no further platform withdrawal can be
 * requested at all.
 */
export async function resolvePlatformPortionDispute(
  portionId: string,
  decision: 'SETTLE' | 'RETRY',
  actor: ActorContext,
): Promise<IAdminWithdrawalPortion> {
  if (!Types.ObjectId.isValid(portionId)) {
    throw AppError.notFound('Withdrawal not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);
  }
  const disputed = await AdminWithdrawalPortion.findOne({ _id: portionId, status: 'DISPUTED' }).lean();
  if (!disputed) {
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This portion is not under dispute');
  }

  if (decision === 'RETRY') {
    const reopened = await AdminWithdrawalPortion.findOneAndUpdate(
      { _id: portionId, status: 'DISPUTED' },
      {
        $set: {
          status: 'PENDING',
          proofReference: null,
          proofNotes: null,
          proofReceiptUrl: null,
          proofReceiptFileName: null,
          proofReceiptMimeType: null,
          disputeReason: null,
          paidAt: null,
          disputedAt: null,
          // Kept so the party can be told why they are being asked again,
          // rather than the portion silently reappearing as if it were new.
          returnedToPartyAt: new Date(),
          returnedReason: disputed.disputeReason ?? null,
        },
      },
      { new: true },
    );
    if (!reopened) {
      throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This portion is no longer under dispute');
    }

    await recordAudit({
      action: 'PLATFORM_WITHDRAWAL_DISPUTE_RESOLVED',
      targetCollection: 'AdminWithdrawalPortion',
      targetId: reopened._id,
      userId: actor.userId,
      role: actor.role,
      ip: actor.ip,
      newState: { decision, status: 'PENDING' },
    });
    return reopened;
  }

  const useTransaction = await supportsTransactions();
  let result: IAdminWithdrawalPortion | undefined;

  const applySettle = async (session?: mongoose.ClientSession): Promise<void> => {
    // Claim first, money second — same ordering as applyConfirm above.
    const settled = await AdminWithdrawalPortion.findOneAndUpdate(
      { _id: portionId, status: 'DISPUTED' },
      { $set: { status: 'FULFILLED', fulfilledAt: new Date() } },
      { new: true, ...(session ? { session } : {}) },
    );
    if (!settled) {
      throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This portion is no longer under dispute');
    }

    await debitPlatformCommission(disputed.amountPaise, session);
    await Party.findByIdAndUpdate(
      disputed.partyId,
      { $inc: { dmcBalancePaise: disputed.amountPaise } },
      session ? { session } : {},
    );

    result = settled;
  };

  if (useTransaction) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => applySettle(session));
    } finally {
      await session.endSession();
    }
  } else {
    await applySettle();
  }
  if (!result) throw AppError.internal('Dispute resolution returned no document');

  await refreshRequestStatus(disputed.withdrawalRequestId);

  await recordAudit({
    action: 'PLATFORM_WITHDRAWAL_DISPUTE_RESOLVED',
    targetCollection: 'AdminWithdrawalPortion',
    targetId: result._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { decision, status: 'FULFILLED', amountPaise: disputed.amountPaise },
  });

  return result;
}

/** Admin says the party's claimed payment for this portion never arrived. Nothing financial happens. */
export async function disputePlatformPortionReceipt(
  portionId: string,
  reason: string,
  actor: ActorContext,
): Promise<IAdminWithdrawalPortion> {
  if (!reason || reason.trim().length < 5) {
    throw AppError.badRequest(ErrorCodes.REJECTION_REASON_REQUIRED, 'A reason of at least 5 characters is required');
  }
  if (!Types.ObjectId.isValid(portionId)) {
    throw AppError.notFound('Withdrawal not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);
  }

  const updated = await AdminWithdrawalPortion.findOneAndUpdate(
    { _id: portionId, status: 'PARTY_PAID' },
    { $set: { status: 'DISPUTED', disputeReason: reason.trim(), disputedAt: new Date() } },
    { new: true },
  );
  if (!updated) {
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This portion is not awaiting confirmation');
  }

  await recordAudit({
    action: 'PLATFORM_WITHDRAWAL_DISPUTED',
    targetCollection: 'AdminWithdrawalPortion',
    targetId: updated._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { reason: reason.trim() },
  });

  return updated;
}
