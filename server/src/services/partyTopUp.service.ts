import { Types } from 'mongoose';
import { Party, PartyTopUpRequest, type IPartyTopUpRequest } from '../models';
import { AppError } from '../utils/AppError';
import { openPayment } from './usdtDeposit.service';
import { ErrorCodes } from '../utils/errorCodes';
import { recordAudit } from './audit.service';
import type { Role } from '../types';

export interface ActorContext {
  userId: string;
  role: Role;
  ip?: string;
}

export interface TopUpProofInput {
  providerReference: string;
  notes?: string;
  receipt?: { url: string; fileName: string; mimeType: string };
}

/**
 * A party topping up its DMC balance beyond the registration grant. Unlike
 * a captain's self-service purchase, the party is sending real security
 * money to the platform's own account — so the request (with proof) sits
 * pending until admin confirms actually receiving it. Nothing moves yet.
 */
export async function requestTopUp(
  partyId: Types.ObjectId,
  amountPaise: number,
  actor: ActorContext,
): Promise<IPartyTopUpRequest> {
  if (amountPaise <= 0) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Amount must be greater than zero');
  }

  // Undecided, submitted or not — same reasoning as the captain's.
  const existingActive = await PartyTopUpRequest.exists({ partyId, status: { $in: ['AWAITING_PAYMENT', 'PENDING'] } });
  if (existingActive) {
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_REQUEST_PENDING, 'You already have a top-up request pending admin review');
  }

  // The party rate, never the captain one. See usdtDeposit.service.ts.
  const payment = await openPayment('PARTY', amountPaise);

  const request = await PartyTopUpRequest.create({
    ...payment,
    partyId,
    amountPaise,
    // A draft until the party reports the transfer.
    status: 'AWAITING_PAYMENT',
  });

  await recordAudit({
    action: 'PARTY_DMC_PURCHASED',
    targetCollection: 'PartyTopUpRequest',
    targetId: request._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { amountPaise, status: 'AWAITING_PAYMENT' },
  });

  return request;
}

/** Admin confirms the party's payment actually arrived — only now does the balance move. */
export async function approveTopUp(requestId: string, actor: ActorContext): Promise<IPartyTopUpRequest> {
  if (!Types.ObjectId.isValid(requestId)) throw AppError.notFound('Top-up request not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);

  const request = await PartyTopUpRequest.findOneAndUpdate(
    { _id: requestId, status: 'PENDING' },
    { $set: { status: 'APPROVED', decidedBy: new Types.ObjectId(actor.userId), decidedAt: new Date() } },
    { new: true },
  );
  if (!request) {
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This request is no longer pending');
  }

  await Party.findByIdAndUpdate(request.partyId, { $inc: { dmcBalancePaise: request.amountPaise } });

  await recordAudit({
    action: 'PARTY_DMC_CREDITED',
    targetCollection: 'Party',
    targetId: request.partyId,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    metadata: { requestId: String(request._id), amountPaise: request.amountPaise },
  });

  return request;
}

/** Admin says the claimed payment never arrived. Nothing financial happens. */
export async function rejectTopUp(requestId: string, reason: string, actor: ActorContext): Promise<IPartyTopUpRequest> {
  if (!reason || reason.trim().length < 5) {
    throw AppError.badRequest(ErrorCodes.REJECTION_REASON_REQUIRED, 'A reason of at least 5 characters is required');
  }
  if (!Types.ObjectId.isValid(requestId)) throw AppError.notFound('Top-up request not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);

  const request = await PartyTopUpRequest.findOneAndUpdate(
    { _id: requestId, status: 'PENDING' },
    {
      $set: {
        status: 'REJECTED',
        rejectionReason: reason.trim(),
        decidedBy: new Types.ObjectId(actor.userId),
        decidedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!request) {
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This request is no longer pending');
  }

  return request;
}

/**
 * The party says they have paid, with a reference.
 *
 * Credits nothing — the top-up stays PENDING until an administrator confirms it,
 * which is the same two-sided handshake it always was.
 */
export async function markTopUpPaid(
  requestId: string,
  partyId: Types.ObjectId,
  proof: { providerReference: string; notes?: string; receipt?: { url: string; fileName: string; mimeType: string } | null },
  _actor: ActorContext,
): Promise<IPartyTopUpRequest> {
  const updated = await PartyTopUpRequest.findOneAndUpdate(
    { _id: requestId, partyId, status: 'AWAITING_PAYMENT' },
    {
      $set: {
        proofReference: proof.providerReference.trim(),
        proofNotes: proof.notes?.trim() || null,
        proofReceiptUrl: proof.receipt?.url ?? null,
        proofReceiptFileName: proof.receipt?.fileName ?? null,
        proofReceiptMimeType: proof.receipt?.mimeType ?? null,
        markedPaidAt: new Date(),
        // This is what puts it in front of an administrator. Nothing before
        // this point is visible to them, and nothing here credits anything.
        status: 'PENDING',
      },
    },
    { new: true },
  );

  if (!updated) {
    throw AppError.notFound('No pending top-up to mark as paid', ErrorCodes.NOT_FOUND);
  }

  return updated;
}
