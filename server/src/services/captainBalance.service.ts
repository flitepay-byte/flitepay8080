/**
 * The two doors between a captain's three balances and the world outside.
 *
 * A captain holds money in two places:
 *
 *   collateralBalancePaise  security, locked, never spendable
 *   dmcBalancePaise         everything else — spent on pay-ins, earned on
 *                           pay-outs, and where commission lands
 *
 * There used to be a third, a separate wallet that commission arrived in and
 * had to be converted out of before it was any use. It is gone. The conversion
 * was a step with no decision in it — nobody ever chose to leave earnings
 * stranded where they could not be traded with — and every screen had to
 * explain the difference between two numbers that behaved identically.
 *
 * So only one thing leaves: turning DMC back into rupees. That is a request
 * admin fulfils, because a real bank transfer has to happen — the same
 * handshake as money coming in, run backwards.
 */
import mongoose, { Types } from 'mongoose';
import { Captain, WalletEntry, DmcRedemption, type IWalletEntry, type IDmcRedemption } from '../models';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { recordAudit } from './audit.service';
import { supportsTransactions } from '../config/db';
import { payCommissionFromPool, collectIntoPool } from './platformAccount.service';
import type { Role } from '../types';

export interface ActorContext {
  userId: string;
  role: Role;
  ip?: string;
}

export interface PayoutDestination {
  method: 'UPI' | 'BANK';
  upiId?: string;
  accountName?: string;
  accountNumber?: string;
  ifsc?: string;
}

function assertWholePaise(amountPaise: number, what: string): void {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, `${what} must be a whole number of paise greater than zero`);
  }
}

/**
 * Pay a captain the commission they earned on a pay-in or a pay-out.
 *
 * The money comes out of the pool the party's own commission funded, and
 * lands in the captain's spendable DMC. It is a *transfer*, never a credit out of nowhere:
 * commission that minted its own DMC would be the platform paying with money
 * nobody put in, and the books would stop adding up the first time it happened.
 *
 * Returns false when the pool cannot cover it. The transaction that earned the
 * commission still stands — real money has already moved between a customer
 * and a captain, and unwinding that because the platform's float ran dry would
 * be far worse than owing the captain their fee.
 */
export async function payCommissionToCaptain(
  captainId: Types.ObjectId | string,
  amountPaise: number,
  session?: mongoose.ClientSession,
  sourceReference?: string,
): Promise<boolean> {
  if (amountPaise === 0) return true;
  assertWholePaise(amountPaise, 'Commission amount');

  // Drained first, so a pool that cannot cover it pays nothing at all rather
  // than crediting a captain and going looking for the money afterwards.
  const funded = await payCommissionFromPool(amountPaise, session);
  if (!funded) return false;

  try {
    const credited = await Captain.findByIdAndUpdate(
      captainId,
      // The running total rises with the balance. It is what lets the captain's
      // capacity be computed without counting profit as capital.
      { $inc: { dmcBalancePaise: amountPaise, commissionEarnedTotalPaise: amountPaise } },
      session ? { new: true, session } : { new: true },
    );
    if (!credited) throw AppError.notFound('Captain not found', ErrorCodes.CAPTAIN_NOT_FOUND);

    // Written from the balance the credit actually produced, so the ledger and
    // the balance can never tell different stories about what was earned. The
    // ledger stays even though the separate wallet has gone: a running balance
    // with no history behind it is one nobody can check or argue with.
    await WalletEntry.create(
      [{
        captainId: credited._id,
        kind: 'COMMISSION_EARNED',
        amountPaise,
        walletBalanceAfterPaise: credited.dmcBalancePaise,
        sourceReference: sourceReference ?? null,
      }],
      session ? { session } : {},
    );
  } catch (err) {
    // Put it back. Without a transaction this is the only thing standing
    // between a failed credit and DMC that simply vanished from the pool.
    // A reversal, not funding — admin did not just pay for this twice.
    if (!session) await collectIntoPool(amountPaise);
    throw err;
  }

  return true;
}

// ---------------------------------------------------------------------------
// DMC back to rupees
// ---------------------------------------------------------------------------

function normaliseDestination(destination: PayoutDestination): Partial<IDmcRedemption> {
  if (destination.method === 'UPI') {
    const upiId = destination.upiId?.trim();
    if (!upiId) throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'A UPI ID is required to be paid by UPI');
    return { payoutMethod: 'UPI', payoutUpiId: upiId };
  }
  const accountName = destination.accountName?.trim();
  const accountNumber = destination.accountNumber?.trim();
  const ifsc = destination.ifsc?.trim();
  if (!accountName || !accountNumber || !ifsc) {
    throw AppError.badRequest(
      ErrorCodes.VALIDATION_ERROR,
      'Account name, account number and IFSC are all required for a bank transfer',
    );
  }
  return { payoutMethod: 'BANK', payoutAccountName: accountName, payoutAccountNumber: accountNumber, payoutIfsc: ifsc };
}

/**
 * Ask for DMC to be paid back out as rupees.
 *
 * The DMC is held out of the captain's balance here rather than when admin
 * pays, so it cannot be spent while the request waits. See DmcRedemption.ts
 * for why that matters.
 */
export async function requestRedemption(
  captainId: Types.ObjectId | string,
  amountPaise: number,
  destination: PayoutDestination,
  actor: ActorContext,
): Promise<IDmcRedemption> {
  assertWholePaise(amountPaise, 'Redemption amount');
  const payoutFields = normaliseDestination(destination);

  // Whether the balance has actually moved, tracked rather than inferred from
  // the error. Refunding on the strength of "something went wrong" would credit
  // DMC that was never debited the moment the *debit itself* is what failed.
  let debited = false;
  /**
   * How much retained fee this withdrawal ate. Hoisted so the compensating
   * refund below puts back exactly what was taken rather than guessing at it.
   */
  let commissionConsumedPaise = 0;

  const hold = async (session?: mongoose.ClientSession): Promise<IDmcRedemption> => {
    /**
     * The balance and the retained-fee counter move together, in one write.
     *
     * A withdrawal spends the captain's own earnings before it touches their
     * working capital, so the counter falls by the withdrawal — floored at
     * zero, since nobody can spend more fee than they have retained. Without
     * this the counter only ever rose, and Current Limit went on subtracting
     * fee the captain had already taken home: withdraw 1,000 against 2,461
     * holding 361 of fee and capacity fell to 1,100 when 1,461 was there.
     *
     * Written as an aggregation pipeline so the cap is evaluated against the
     * stored document. A read-then-write would let a commission credit landing
     * in between be overwritten, and would race a task claim reading the same
     * balance.
     *
     * The pre-image is returned on purpose: it is the document the pipeline
     * ran against, so the fee it consumed is exactly
     * `min(amount, its commissionEarnedTotalPaise)` — no second read, and
     * nothing a concurrent write could have moved underneath.
     */
    const before = await Captain.findOneAndUpdate(
      { _id: captainId, dmcBalancePaise: { $gte: amountPaise } },
      [
        {
          $set: {
            dmcBalancePaise: { $subtract: ['$dmcBalancePaise', amountPaise] },
            commissionEarnedTotalPaise: {
              $max: [0, { $subtract: [{ $ifNull: ['$commissionEarnedTotalPaise', 0] }, amountPaise] }],
            },
          },
        },
      ],
      session ? { session } : {},
    );
    if (!before) {
      const exists = await Captain.exists({ _id: captainId });
      if (!exists) throw AppError.notFound('Captain not found', ErrorCodes.CAPTAIN_NOT_FOUND);
      throw AppError.badRequest(ErrorCodes.INSUFFICIENT_DMC_BALANCE, 'DMC balance is not enough for this redemption');
    }
    debited = true;
    commissionConsumedPaise = Math.min(amountPaise, before.commissionEarnedTotalPaise ?? 0);
    const docs = await DmcRedemption.create(
      [{ captainId: before._id, amountPaise, commissionConsumedPaise, status: 'PENDING', ...payoutFields }],
      session ? { session } : {},
    );
    const created = docs[0];
    if (!created) throw AppError.internal('Redemption request creation returned no document');
    return created;
  };

  let request: IDmcRedemption | undefined;
  const useTransaction = await supportsTransactions();

  if (useTransaction) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Reset per attempt: withTransaction retries the callback on transient
        // errors, and a rolled-back debit did not happen.
        debited = false;
        request = await hold(session);
      });
    } finally {
      await session.endSession();
    }
  } else {
    // Without a transaction the hold has to come first: a held balance with no
    // request behind it is money the captain temporarily cannot reach, whereas
    // a request with nothing held behind it is money admin would pay out twice.
    // Compensate if the row cannot be written.
    try {
      request = await hold(undefined);
    } catch (err) {
      if (debited && !request) {
        // Both halves of the hold come back, or the counter is left wrong.
        await Captain.findByIdAndUpdate(captainId, {
          $inc: { dmcBalancePaise: amountPaise, commissionEarnedTotalPaise: commissionConsumedPaise },
        });
      }
      throw err;
    }
  }

  if (!request) throw AppError.internal('Redemption request was not created');

  await recordAudit({
    action: 'REDEMPTION_REQUESTED',
    targetCollection: 'DmcRedemption',
    targetId: request._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { status: 'PENDING', amountPaise, payoutMethod: request.payoutMethod },
    metadata: { captainId: String(request.captainId) },
  });

  return request;
}

/**
 * Admin has sent the rupees. The held DMC is destroyed rather than returned:
 * the money it stood for has left the platform, so leaving the DMC anywhere at
 * all would be counting the same value twice.
 *
 * Claimed before anything else, so two admins pressing pay at the same moment
 * cannot both record a payment against one request.
 */
export async function markRedemptionPaid(
  requestId: string,
  payment: { reference: string; notes?: string },
  actor: ActorContext,
): Promise<IDmcRedemption> {
  if (!Types.ObjectId.isValid(requestId)) {
    throw AppError.notFound('Redemption request not found', ErrorCodes.REDEMPTION_NOT_FOUND);
  }
  const reference = payment.reference?.trim();
  if (!reference) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'A payment reference is required');
  }

  const request = await DmcRedemption.findOneAndUpdate(
    { _id: requestId, status: 'PENDING' },
    {
      $set: {
        status: 'PAID',
        paymentReference: reference,
        paymentNotes: payment.notes?.trim() ?? null,
        decidedBy: new Types.ObjectId(actor.userId),
        decidedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!request) {
    throw AppError.conflict(ErrorCodes.REDEMPTION_ALREADY_DECIDED, 'This redemption is no longer pending');
  }

  // Nothing to move: the DMC was taken out of the balance when the request was
  // made and is simply not given back. That the burn is a non-event is the
  // reason this path cannot get the accounting wrong.
  await recordAudit({
    action: 'REDEMPTION_PAID',
    targetCollection: 'DmcRedemption',
    targetId: request._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { status: 'PAID', amountPaise: request.amountPaise, paymentReference: reference },
    metadata: { captainId: String(request.captainId) },
  });

  return request;
}

/** Admin could not or would not pay. Every paise held goes back. */
export async function rejectRedemption(
  requestId: string,
  reason: string,
  actor: ActorContext,
): Promise<IDmcRedemption> {
  if (!Types.ObjectId.isValid(requestId)) {
    throw AppError.notFound('Redemption request not found', ErrorCodes.REDEMPTION_NOT_FOUND);
  }
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'A reason is required to reject a redemption');
  }

  // Claimed before the refund, so a losing concurrent rejection refunds nothing.
  const request = await DmcRedemption.findOneAndUpdate(
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
    throw AppError.conflict(ErrorCodes.REDEMPTION_ALREADY_DECIDED, 'This redemption is no longer pending');
  }

  // The fee returns to the counter with the money, so Current Limit goes back
  // to what it was before the request rather than to a figure that counts
  // withdrawn profit as capital.
  await Captain.findByIdAndUpdate(request.captainId, {
    $inc: {
      dmcBalancePaise: request.amountPaise,
      commissionEarnedTotalPaise: request.commissionConsumedPaise ?? 0,
    },
  });

  await recordAudit({
    action: 'REDEMPTION_REJECTED',
    targetCollection: 'DmcRedemption',
    targetId: request._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { status: 'REJECTED', amountPaise: request.amountPaise, rejectionReason: trimmed },
    metadata: { captainId: String(request.captainId) },
  });

  return request;
}

/** The captain's wallet history: what they earned and what they converted. */
export async function listWalletEntries(captainId: Types.ObjectId | string): Promise<IWalletEntry[]> {
  return WalletEntry.find({ captainId }).sort({ createdAt: -1 }).lean() as unknown as Promise<IWalletEntry[]>;
}

/** Everything a captain has asked for, newest first. */
export async function listRedemptionsForCaptain(captainId: Types.ObjectId | string): Promise<IDmcRedemption[]> {
  return DmcRedemption.find({ captainId }).sort({ createdAt: -1 }).lean() as unknown as Promise<IDmcRedemption[]>;
}

/** Everything still waiting on admin, oldest first — a queue, not a list. */
export async function listPendingRedemptions(): Promise<IDmcRedemption[]> {
  return DmcRedemption.find({ status: 'PENDING' }).sort({ createdAt: 1 }).lean() as unknown as Promise<IDmcRedemption[]>;
}
