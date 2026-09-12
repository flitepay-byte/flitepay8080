import { Types } from 'mongoose';
import { Captain, DmcPurchase, type IDmcPurchase } from '../models';
import { AppError } from '../utils/AppError';
import { openPayment } from './usdtDeposit.service';
import { ErrorCodes } from '../utils/errorCodes';
import { randomToken } from '../utils/ids';
import { percentOfPaise } from '../utils/money';
import { recordAudit } from './audit.service';
import { getConfig } from './systemConfig.service';
import type { Role } from '../types';

export interface ActorContext {
  userId: string;
  role: Role;
  ip?: string;
}

export interface DepositProofInput {
  providerReference: string;
  notes?: string;
  receipt?: { url: string; fileName: string; mimeType: string };
}

function generateSimulatedPaymentRef(): string {
  return `DEMO-PAY-${randomToken(8).toUpperCase()}`;
}

/**
 * COLLATERAL DEPOSIT — a captain posting more security money.
 *
 * The captain sends the money to the platform and tells us what they sent;
 * admin confirms it arrived. Nothing is credited here, because a captain who
 * could raise their own collateral on their own say-so would be able to claim
 * work backed by money nobody has seen. This is the same handshake a party
 * top-up goes through: the side that receives the money is the side that
 * confirms it.
 *
 * The whole amount becomes collateral once confirmed. A captain's spendable
 * balance is only ever earned by completing tasks, never deposited.
 */
/**
 * Open a security-deposit request.
 *
 * Takes no proof: the captain is quoted a USDT amount and an address, pays, and
 * only then reports the transaction reference through `markDepositPaid`. That
 * ordering is the real one — nobody has a reference before they have paid.
 */
export async function requestDeposit(
  captainId: Types.ObjectId,
  amountPaise: number,
  actor: ActorContext,
): Promise<IDmcPurchase> {
  if (amountPaise <= 0) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Amount must be greater than zero');
  }

  const captain = await Captain.findById(captainId).select('_id').lean();
  if (!captain) throw AppError.notFound('Captain profile not found');

  // The quote and the address, decided once and kept with the request. A later
  // rate change or a retired address cannot alter what this captain was told to
  // pay. Nothing here watches the chain and nothing is credited.
  const payment = await openPayment('CAPTAIN', amountPaise);

  const request = await DmcPurchase.create({
    captainId,
    amountPaise,
    securityPaise: amountPaise,
    balancePaise: 0,
    ...payment,
    simulatedPaymentRef: generateSimulatedPaymentRef(),
    // A draft until the captain reports the transfer. See DmcPurchase.ts.
    status: 'AWAITING_PAYMENT',
  });

  await recordAudit({
    action: 'DMC_PURCHASED',
    targetCollection: 'DmcPurchase',
    targetId: request._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { amountPaise, status: 'AWAITING_PAYMENT' },
    metadata: { proofReference: request.proofReference },
  });

  return request;
}

/** Admin confirms the money arrived — only now does the collateral move. */
export async function approveDeposit(requestId: string, actor: ActorContext): Promise<IDmcPurchase> {
  if (!Types.ObjectId.isValid(requestId)) {
    throw AppError.notFound('Deposit request not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);
  }

  // A deposit is not one thing arriving, it is two. Part is held as security
  // the captain cannot spend, and part becomes working capital they can use
  // immediately — at the default split, ₹20,000 posted is ₹10,000 locked and
  // ₹10,000 to trade with.
  //
  // The remainder is computed by subtraction rather than by a second
  // percentage, so the two halves always add back to exactly what was posted.
  // Rounding each independently would leave a paise on the floor of every
  // deposit, and a ledger that loses a paise per deposit is a ledger that
  // stops reconciling.
  //
  // Worked out before the claim so the split can be written *by* the claim.
  // Reading settings moves no money, and the amount it is applied to cannot
  // change after the request was made.
  const pending = await DmcPurchase.findById(requestId).lean();
  if (!pending) {
    throw AppError.notFound('Deposit request not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);
  }
  const config = await getConfig();
  const lockedPaise = percentOfPaise(pending.securityPaise, config.collateralLockPercentage);
  const usablePaise = pending.securityPaise - lockedPaise;

  // Claimed before the money moves, so two admins confirming at once credit
  // the captain once — the same ordering the withdrawal handshake uses. The
  // split rides along in the claim, so an approved row always says how it was
  // divided even if the percentage is changed a minute later.
  const request = await DmcPurchase.findOneAndUpdate(
    { _id: requestId, status: 'PENDING' },
    {
      $set: {
        status: 'APPROVED',
        decidedBy: new Types.ObjectId(actor.userId),
        decidedAt: new Date(),
        collateralCreditedPaise: lockedPaise,
        dmcCreditedPaise: usablePaise,
      },
    },
    { new: true },
  );
  if (!request) {
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This deposit is no longer pending');
  }

  // Credited from what the claim actually wrote, never from the numbers above,
  // so the balances and the row can never tell different stories.
  await Captain.findByIdAndUpdate(request.captainId, {
    $inc: {
      collateralBalancePaise: request.collateralCreditedPaise ?? 0,
      dmcBalancePaise: request.dmcCreditedPaise ?? 0,
    },
  });

  await recordAudit({
    action: 'DMC_PURCHASED',
    targetCollection: 'Captain',
    targetId: request.captainId,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    // Both halves recorded, because "we credited ₹20,000" would no longer be
    // true of either balance on its own.
    newState: {
      status: 'APPROVED',
      depositPaise: request.securityPaise,
      collateralCreditedPaise: lockedPaise,
      dmcCreditedPaise: usablePaise,
      lockPercentage: config.collateralLockPercentage,
    },
    metadata: { requestId: String(request._id), proofReference: request.proofReference },
  });

  return request;
}

/** Admin says the claimed payment never arrived. Nothing financial happens. */
export async function rejectDeposit(
  requestId: string,
  reason: string,
  actor: ActorContext,
): Promise<IDmcPurchase> {
  if (!reason || reason.trim().length < 5) {
    throw AppError.badRequest(ErrorCodes.REJECTION_REASON_REQUIRED, 'A reason of at least 5 characters is required');
  }
  if (!Types.ObjectId.isValid(requestId)) {
    throw AppError.notFound('Deposit request not found', ErrorCodes.WITHDRAWAL_NOT_FOUND);
  }

  const request = await DmcPurchase.findOneAndUpdate(
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
    throw AppError.conflict(ErrorCodes.WITHDRAWAL_ALREADY_DECIDED, 'This deposit is no longer pending');
  }

  await recordAudit({
    action: 'DMC_PURCHASED',
    targetCollection: 'DmcPurchase',
    targetId: request._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { status: 'REJECTED', reason: reason.trim() },
  });

  return request;
}

/**
 * The captain says they have paid, and gives the reference for it.
 *
 * Credits nothing. All this does is attach the evidence an administrator needs,
 * and record that there is now something to check — the request stays PENDING
 * and every balance stays exactly where it was.
 */
export async function markDepositPaid(
  requestId: string,
  captainId: Types.ObjectId,
  proof: DepositProofInput,
  actor: ActorContext,
): Promise<IDmcPurchase> {
  const updated = await DmcPurchase.findOneAndUpdate(
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
    throw AppError.notFound('No pending deposit request to mark as paid', ErrorCodes.NOT_FOUND);
  }

  await recordAudit({
    action: 'DMC_PURCHASED',
    targetCollection: 'DmcPurchase',
    targetId: updated._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    metadata: { markedPaid: true, reference: updated.proofReference },
  });

  return updated;
}
