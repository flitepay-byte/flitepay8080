/**
 * BUYING MORE ROOM TO WORK WITH
 *
 * A captain can post more security, which is split half into collateral and
 * half into spendable DMC. This is the other thing they can do: pay for
 * capacity directly. The whole approved amount becomes DMC, the approved
 * ceiling rises by the same figure, and the collateral is untouched — no new
 * security was posted, so none is recorded.
 *
 * Both halves have to move together or the purchase does nothing. Current
 * Limit is `min(approved ceiling, available DMC − retained commission)`, so
 * raising only the ceiling leaves a captain whose capital binds exactly where
 * they were, and raising only the balance leaves one whose ceiling binds
 * exactly where they were. The pair is the feature.
 *
 * The cap is the collateral the captain already holds. Capacity bought against
 * nothing would be capacity with no security behind it.
 *
 * Nothing moves before admin approves. A request carries a reference and a
 * receipt, and those are a claim that money was sent — admin checks them
 * against the bank and only then decides. That is the same two-sided handshake
 * every real-money inflow here uses, and the reason a pending or rejected
 * request changes no balance at all.
 */
import { Types } from 'mongoose';
import { Captain, CaptainLimitPurchase, type ICaptainLimitPurchase } from '../models';
import { AppError } from '../utils/AppError';
import { openPayment } from './usdtDeposit.service';
import { ErrorCodes } from '../utils/errorCodes';
import { recordAudit } from './audit.service';

interface ActorContext {
  userId: string;
  role: 'ADMIN' | 'PARTY' | 'CAPTAIN';
  ip?: string;
}

export interface LimitPurchaseProofInput {
  providerReference: string;
  notes?: string;
  receipt?: { url: string; fileName: string; mimeType: string };
}

/** What a captain may currently buy, and what they already hold. */
export interface LimitPurchaseAllowance {
  collateralPaise: number;
  maxPurchasePaise: number;
  hasPending: boolean;
}

/**
 * How much room this captain may buy right now.
 *
 * Read by the captain's own screen so the ceiling on the form is the same
 * figure the request will be judged against, rather than a number the client
 * worked out for itself.
 */
export async function limitPurchaseAllowance(
  captainId: Types.ObjectId | string,
): Promise<LimitPurchaseAllowance> {
  const captain = await Captain.findById(captainId).select('collateralBalancePaise').lean();
  if (!captain) throw AppError.notFound('Captain not found', ErrorCodes.CAPTAIN_NOT_FOUND);
  // Undecided, whether or not it has been submitted. Counting only submitted
  // ones would let a captain open several drafts and then mark them all paid,
  // which is the one-at-a-time rule gone.
  const hasPending = Boolean(await CaptainLimitPurchase.exists({ captainId, status: { $in: ['AWAITING_PAYMENT', 'PENDING'] } }));
  return {
    collateralPaise: captain.collateralBalancePaise,
    maxPurchasePaise: captain.collateralBalancePaise,
    hasPending,
  };
}

/**
 * A captain asks to buy capacity. Nothing is credited here.
 */
export async function requestLimitPurchase(
  captainId: Types.ObjectId,
  amountPaise: number,
  actor: ActorContext,
): Promise<ICaptainLimitPurchase> {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Amount must be greater than zero');
  }

  const captain = await Captain.findById(captainId).select('collateralBalancePaise status').lean();
  if (!captain) throw AppError.notFound('Captain not found', ErrorCodes.CAPTAIN_NOT_FOUND);
  if (captain.status !== 'ACTIVE') {
    throw AppError.forbidden('Your account is suspended and cannot buy more capacity');
  }

  /**
   * Capped at the security already posted. Checked here against the captain's
   * present collateral, and the figure it was checked against is written onto
   * the request — so an approval days later is judged on the cap that applied
   * when the money was actually sent.
   */
  if (amountPaise > captain.collateralBalancePaise) {
    throw AppError.unprocessable(
      ErrorCodes.VALIDATION_ERROR,
      'You can buy at most as much capacity as the security you have posted',
      {
        maxPurchasePaise: captain.collateralBalancePaise,
        requestedPaise: amountPaise,
      },
    );
  }

  /**
   * One at a time, for the same reason a party may hold only one open top-up:
   * two open requests leave admin deciding on the same money twice with no way
   * to tell which payment each one refers to.
   */
  if (await CaptainLimitPurchase.exists({ captainId, status: { $in: ['AWAITING_PAYMENT', 'PENDING'] } })) {
    throw AppError.conflict(
      ErrorCodes.WITHDRAWAL_REQUEST_PENDING,
      'You already have a capacity purchase waiting for admin review',
    );
  }

  // Same quote-and-assign as a security deposit, at the captain rate.
  const payment = await openPayment('CAPTAIN', amountPaise);

  const request = await CaptainLimitPurchase.create({
    ...payment,
    captainId,
    amountPaise,
    collateralAtRequestPaise: captain.collateralBalancePaise,
    // A draft until the captain reports the transfer.
    status: 'AWAITING_PAYMENT',
  });

  await recordAudit({
    action: 'CAPTAIN_LIMIT_PURCHASE_REQUESTED',
    targetCollection: 'CaptainLimitPurchase',
    targetId: request._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { status: 'AWAITING_PAYMENT', amountPaise },
    metadata: { captainId: String(captainId) },
  });

  return request;
}

/**
 * Admin confirms the money arrived. Only now does anything move.
 */
export async function approveLimitPurchase(
  requestId: string,
  actor: ActorContext,
): Promise<ICaptainLimitPurchase> {
  if (!Types.ObjectId.isValid(requestId)) {
    throw AppError.notFound('Purchase request not found', ErrorCodes.NOT_FOUND);
  }

  /**
   * Claimed before the money moves, so two admins approving at once credit the
   * captain once. The amount credited rides along in the claim, so an approved
   * row always says what it applied.
   */
  const request = await CaptainLimitPurchase.findOneAndUpdate(
    { _id: requestId, status: 'PENDING' },
    {
      $set: {
        status: 'APPROVED',
        decidedBy: new Types.ObjectId(actor.userId),
        decidedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!request) {
    throw AppError.conflict(
      ErrorCodes.WITHDRAWAL_ALREADY_DECIDED,
      'This purchase is no longer pending',
    );
  }

  /**
   * Both halves in one write.
   *
   * `creditLimitPaise` is null until admin has set a ceiling, and null means
   * "the collateral is the ceiling" — so it cannot simply be incremented. The
   * pipeline resolves the present ceiling first and adds to that, which is the
   * same shape the admin's own additive grant uses. Written as a pipeline so
   * both figures are computed from the stored document: a read-then-write here
   * would lose a concurrent commission credit or a racing security approval.
   */
  const credited = await Captain.findOneAndUpdate(
    { _id: request.captainId },
    [
      {
        $set: {
          dmcBalancePaise: { $add: ['$dmcBalancePaise', request.amountPaise] },
          creditLimitPaise: {
            $add: [
              { $ifNull: ['$creditLimitPaise', '$collateralBalancePaise'] },
              request.amountPaise,
            ],
          },
        },
      },
    ],
    { new: true },
  );
  if (!credited) {
    throw AppError.notFound('Captain not found', ErrorCodes.CAPTAIN_NOT_FOUND);
  }

  // Recorded from the claim, never from the request read above, so the row and
  // the balances can never tell different stories about what was applied.
  await CaptainLimitPurchase.updateOne(
    { _id: request._id },
    { $set: { creditedPaise: request.amountPaise } },
  );

  await recordAudit({
    action: 'CAPTAIN_LIMIT_PURCHASE_APPROVED',
    targetCollection: 'Captain',
    targetId: request.captainId,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: {
      status: 'APPROVED',
      creditedPaise: request.amountPaise,
      dmcBalancePaise: credited.dmcBalancePaise,
      creditLimitPaise: credited.creditLimitPaise ?? null,
      // Recorded unchanged on purpose: a capacity purchase posts no security.
      collateralBalancePaise: credited.collateralBalancePaise,
    },
    metadata: { requestId: String(request._id) },
  });

  request.creditedPaise = request.amountPaise;
  return request;
}

/** Admin could not find the money. Nothing moves. */
export async function rejectLimitPurchase(
  requestId: string,
  reason: string,
  actor: ActorContext,
): Promise<ICaptainLimitPurchase> {
  if (!Types.ObjectId.isValid(requestId)) {
    throw AppError.notFound('Purchase request not found', ErrorCodes.NOT_FOUND);
  }
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'A reason is required to reject a purchase');
  }

  const request = await CaptainLimitPurchase.findOneAndUpdate(
    { _id: requestId, status: 'PENDING' },
    {
      $set: {
        status: 'REJECTED',
        rejectionReason: trimmed,
        decidedBy: new Types.ObjectId(actor.userId),
        decidedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!request) {
    throw AppError.conflict(
      ErrorCodes.WITHDRAWAL_ALREADY_DECIDED,
      'This purchase is no longer pending',
    );
  }

  await recordAudit({
    action: 'CAPTAIN_LIMIT_PURCHASE_REJECTED',
    targetCollection: 'CaptainLimitPurchase',
    targetId: request._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { status: 'REJECTED', amountPaise: request.amountPaise, rejectionReason: trimmed },
    metadata: { captainId: String(request.captainId) },
  });

  return request;
}

/** A captain's own history, newest first. */
export async function listForCaptain(
  captainId: Types.ObjectId | string,
  page: number,
  limit: number,
): Promise<{ items: ICaptainLimitPurchase[]; total: number }> {
  const [items, total] = await Promise.all([
    CaptainLimitPurchase.find({ captainId })
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CaptainLimitPurchase.countDocuments({ captainId }),
  ]);
  return { items, total };
}

/** Everything waiting on an admin decision, oldest first. */
export async function listPending(
  page: number,
  limit: number,
): Promise<{ items: ICaptainLimitPurchase[]; total: number }> {
  const filter = { status: 'PENDING' as const };
  const [items, total] = await Promise.all([
    CaptainLimitPurchase.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CaptainLimitPurchase.countDocuments(filter),
  ]);
  return { items, total };
}

/**
 * The captain says they have paid for the capacity, with a reference.
 *
 * As with a security deposit: nothing is credited, the request stays PENDING,
 * and an administrator still has to confirm the money arrived.
 */
export async function markLimitPurchasePaid(
  requestId: string,
  captainId: Types.ObjectId,
  proof: LimitPurchaseProofInput,
  actor: ActorContext,
): Promise<ICaptainLimitPurchase> {
  const updated = await CaptainLimitPurchase.findOneAndUpdate(
    { _id: requestId, captainId, status: 'AWAITING_PAYMENT' },
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
    throw AppError.notFound('No pending limit purchase to mark as paid', ErrorCodes.NOT_FOUND);
  }

  await recordAudit({
    action: 'DMC_PURCHASED',
    targetCollection: 'CaptainLimitPurchase',
    targetId: updated._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    metadata: { markedPaid: true, reference: updated.proofReference },
  });

  return updated;
}
