/**
 * THE PARTY API — what a party's own server calls.
 *
 * Everything here is authenticated by signature, not by session: the caller is
 * a server, there is no browser and no logged-in person. See
 * apiKey.service.ts for the scheme.
 *
 * Two things shape every response below.
 *
 * **A party sees its own payments and nothing else.** Every lookup is scoped
 * by the party the signature resolved to, in the query filter itself rather
 * than by checking afterwards — so there is no path, including a guessed id,
 * that returns another party's transaction.
 *
 * **A party never learns who the captain is.** They are buying settlement, not
 * a relationship with a particular person, and the captain's identity is not
 * theirs to have. The serialiser here is deliberately separate from the
 * dashboard's for that reason: it is easier to keep a field out of a small
 * purpose-built shape than to remember to strip it from a large shared one.
 */
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, created, clientIp } from '../utils/http';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { Party, Transaction, Task, type ITransaction, type ITask } from '../models';
import {
  createPayIn,
  assignCaptain,
  openToCustomer,
  dispute as raiseDispute,
} from '../services/transaction.service';
import { createTask } from '../services/task.service';
import { disputePayoutTask } from '../services/payoutDispute.service';
import { issueQrForTransaction } from '../services/upiGateway.service';
import { deliverCallback } from '../services/callback.service';
import { applyCustomerConfirmation } from '../services/customerConfirmation.service';
import { paiseToRupees } from '../utils/money';

interface ApiCaller {
  partyId: Types.ObjectId;
  keyId: string;
  callbackUrl: string | null;
  actor: { userId: string; role: 'PARTY'; ip: string };
}

function caller(req: Request): ApiCaller {
  if (!req.apiCaller) throw AppError.unauthorized('API credentials required', ErrorCodes.UNAUTHENTICATED);
  return {
    partyId: new Types.ObjectId(req.apiCaller.partyId),
    keyId: req.apiCaller.keyId,
    callbackUrl: req.apiCaller.callbackUrl,
    // Acting on the party's behalf, identified by the key rather than a user —
    // audit rows say which key moved the money, which is what a party needs to
    // know when they are trying to work out which of their systems did it.
    actor: { userId: req.apiCaller.partyId, role: 'PARTY', ip: clientIp(req) },
  };
}

/**
 * What a party is told about their own transaction.
 *
 * No captain, no internal ids, no routing state — a party asked us to settle a
 * payment and what they need back is whether it settled.
 */
function toApiDto(transaction: ITransaction): Record<string, unknown> {
  return {
    id: transaction.transactionCode,
    reference: transaction.partyReference,
    direction: transaction.direction,
    status: transaction.status,
    amount: paiseToRupees(transaction.amountPaise),
    settlementReference: transaction.settlementReference ?? null,
    /** Only a pay-in has something for the customer to scan. */
    qr: transaction.gatewayQrPayload
      ? { payload: transaction.gatewayQrPayload, expiresAt: transaction.expiresAt.toISOString() }
      : null,
    failureReason: transaction.failureReason ?? null,
    createdAt: transaction.createdAt.toISOString(),
    settledAt: transaction.settledAt?.toISOString() ?? null,
  };
}

/**
 * Take a payment from the party's customer.
 *
 * The response carries the QR the customer scans. Routing a captain and
 * issuing the QR happen inline rather than in the background, because a
 * checkout page has nothing to show the customer until they exist.
 */
export const payIn = asyncHandler(async (req: Request, res: Response) => {
  const api = caller(req);
  // `amount` has already been converted to paise by the validator, which is
  // where every rupee figure in this codebase crosses over. Converting again
  // here would multiply every payment by a hundred.
  const body = req.body as { reference: string; amount: number; callbackUrl?: string };

  const { transaction, created: isNew } = await createPayIn(
    api.partyId,
    {
      partyReference: body.reference,
      amountPaise: body.amount,
      callbackUrl: body.callbackUrl ?? api.callbackUrl ?? undefined,
      createdByKeyId: api.keyId,
    },
    api.actor,
  );

  // A repeat of a call we already handled returns what we already did, without
  // routing a second captain or issuing a second QR.
  if (!isNew) return ok(res, toApiDto(transaction), 'This reference was already accepted');

  const assignment = await assignCaptain(transaction._id);
  if (!assignment.captainId) {
    // Honest rather than optimistic: a party that is told "accepted" and never
    // gets a QR has no idea whether to retry, and a customer is waiting.
    throw AppError.unprocessable(
      ErrorCodes.NO_CAPTAIN_AVAILABLE,
      assignment.stalled
        ? 'No captain can accept payments at the moment'
        : 'No captain is available right now — try again shortly',
    );
  }

  const qr = await issueQrForTransaction(assignment.transaction);
  const open = await openToCustomer(transaction._id, {
    gatewayOrderId: qr.gatewayOrderId,
    gatewayQrPayload: qr.payload,
  });

  return created(res, toApiDto(open), 'Show this QR to your customer');
});

/**
 * Send money to the party's customer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TASK AND NOT A GATEWAY CALL
 * ---------------------------------------------------------------------------
 *
 * A pay-in can be automated because the captain has a *merchant* account: the
 * gateway can mint a dynamic QR against it and the customer scans. A payout
 * has no equivalent. The person receiving the money has an ordinary personal
 * account, and there is no QR, no merchant handle and nothing to automate
 * against — somebody has to actually make the transfer.
 *
 * So a payout becomes a task: it is routed to an online captain, their
 * collateral is held against it, they make the transfer by hand and submit the
 * reference. That machinery already exists and already handles the parts that
 * are easy to get wrong — routing, expiry, collateral, disputes.
 *
 * What differs from a dashboard task is only the money and the audit, both
 * covered in Task.ts: the party is billed exactly the amount, the captain is
 * reimbursed into working DMC with their fee from the platform pool, and the
 * proof approves itself because there is no person at the party to audit it.
 */
export const payOut = asyncHandler(async (req: Request, res: Response) => {
  const api = caller(req);
  const body = req.body as {
    reference: string;
    amount: number;
    callbackUrl?: string;
    beneficiary: { name?: string; upiId?: string; accountNumber?: string; ifsc?: string };
  };

  // The party's own reference is the task's external reference, and that is
  // unique per party — so the same call twice resolves to the one payout
  // rather than sending the customer's money again.
  const existing = await Task.findOne({ partyId: api.partyId, externalRef: body.reference });
  if (existing) return ok(res, toPayoutDto(existing), 'This reference was already accepted');

  const beneficiary = body.beneficiary;
  const payoutMethod = beneficiary.upiId?.trim()
    ? { type: 'UPI' as const, upiId: beneficiary.upiId.trim() }
    : {
        type: 'BANK' as const,
        accountNumber: beneficiary.accountNumber?.trim() ?? '',
        ifsc: beneficiary.ifsc?.trim().toUpperCase() ?? '',
      };

  try {
    const task = await createTask(
      {
        partyId: api.partyId,
        createdBy: api.partyId,
        customerName: beneficiary.name?.trim() || 'Customer',
        payoutMethod,
        amountPaise: body.amount,
        externalRef: body.reference,
        origin: 'API',
        callbackUrl: body.callbackUrl ?? api.callbackUrl ?? null,
        createdByKeyId: api.keyId,
      },
      api.actor,
    );
    return created(res, toPayoutDto(task), 'Payout accepted — a captain will make the transfer');
  } catch (err) {
    // Two identical calls raced past the lookup above. The unique reference
    // decided which one is real; the loser returns the winner's payout, which
    // is exactly what idempotency means.
    const winner = await Task.findOne({ partyId: api.partyId, externalRef: body.reference });
    if (winner) return ok(res, toPayoutDto(winner), 'This reference was already accepted');
    throw err;
  }
});

/**
 * A payout as the party sees it.
 *
 * Shaped like a transaction on purpose — a party integrating against us should
 * not have to learn that one direction is a "transaction" and the other a
 * "task". That is our internal distinction, not theirs.
 */
function toPayoutDto(task: ITask): Record<string, unknown> {
  const settled = task.status === 'COMPLETED';
  return {
    id: task.taskCode,
    reference: task.externalRef,
    direction: 'PAY_OUT',
    status: PAYOUT_STATUS[task.status] ?? task.status,
    amount: paiseToRupees(task.amountPaise),
    settlementReference: task.providerReference ?? null,
    qr: null,
    failureReason: task.rejectionReason ?? task.cancelReason ?? null,
    createdAt: task.createdAt.toISOString(),
    settledAt: settled ? task.completedAt?.toISOString() ?? null : null,
  };
}

/**
 * Task states, worded as a payment. A party asked us to send money; they do
 * not need to know that it is carried by something we call a task, nor which
 * of its nine internal states it is sitting in.
 */
const PAYOUT_STATUS: Record<string, string> = {
  CREATED: 'CREATED',
  REASSIGNED: 'CREATED',
  ASSIGNED: 'ASSIGNED',
  IN_PROGRESS: 'AWAITING_CUSTOMER',
  PROOF_SUBMITTED: 'CONFIRMED',
  AUDIT_PENDING: 'CONFIRMED',
  COMPLETED: 'SETTLED',
  REJECTED: 'DISPUTED',
  CANCEL_REVIEW: 'DISPUTED',
  CANCEL_DISPUTED: 'DISPUTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
};

/**
 * A page of the party's own payments, both directions.
 *
 * Pay-ins and pay-outs live in different collections here — one is carried by
 * a transaction and the other by a task, for the reasons in payOut above — but
 * that is our business and not the party's. They asked us to move money twice
 * and expect two rows, so both are read and merged into one ordered page.
 *
 * Cursored on creation time rather than page numbers, because rows are being
 * added while a party pages through them and an offset would skip or repeat
 * whatever crossed the boundary.
 */
export const listTransactions = asyncHandler(async (req: Request, res: Response) => {
  const api = caller(req);
  const query = req.query as unknown as {
    limit?: number; direction?: string; status?: string; before?: string;
  };
  const limit = Math.min(query.limit ?? 50, 100);

  let cursor: Date | undefined;
  if (query.before) {
    const parsed = new Date(query.before);
    if (Number.isNaN(parsed.getTime())) {
      throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, '`before` must be an ISO timestamp');
    }
    cursor = parsed;
  }

  const wantsPayIn = query.direction !== 'PAY_OUT';
  const wantsPayOut = query.direction !== 'PAY_IN';

  // One more than asked for from each side, so the merged page can tell
  // whether anything is left without counting either collection.
  const [payIns, payOuts] = await Promise.all([
    wantsPayIn
      ? Transaction.find({
          partyId: api.partyId,
          direction: 'PAY_IN',
          ...(query.status ? { status: query.status } : {}),
          ...(cursor ? { createdAt: { $lt: cursor } } : {}),
        })
          .sort({ createdAt: -1 })
          .limit(limit + 1)
      : Promise.resolve([]),
    wantsPayOut
      ? Task.find({
          partyId: api.partyId,
          origin: 'API',
          ...(cursor ? { createdAt: { $lt: cursor } } : {}),
        })
          .sort({ createdAt: -1 })
          .limit(limit + 1)
      : Promise.resolve([]),
  ]);

  const merged = [
    ...payIns.map((t) => ({ at: t.createdAt, dto: toApiDto(t) })),
    ...payOuts.map((t) => ({ at: t.createdAt, dto: toPayoutDto(t) })),
  ]
    // A status filter is applied to payouts here rather than in the query,
    // because their stored states are task states and the filter speaks the
    // payment vocabulary the party was given.
    .filter((row) => !query.status || row.dto['status'] === query.status)
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  const hasMore = merged.length > limit;
  const page = hasMore ? merged.slice(0, limit) : merged;

  return ok(res, {
    items: page.map((row) => row.dto),
    hasMore,
    /** Pass this back as `before` for the next page. */
    nextCursor: hasMore ? page[page.length - 1]?.at.toISOString() ?? null : null,
  });
});

/**
 * One payment by the party's own reference, whichever direction it was.
 *
 * The party sent us one reference and expects one answer; that it might be a
 * transaction or a task underneath is our concern. Looked up in both, scoped
 * to this party in the query itself so no reference of anyone else's can be
 * reached by guessing.
 */
export const getTransaction = asyncHandler(async (req: Request, res: Response) => {
  const api = caller(req);
  const reference = req.params['reference'] as string;

  const [payIn, payOut] = await Promise.all([
    Transaction.findOne({ partyId: api.partyId, partyReference: reference }),
    Task.findOne({ partyId: api.partyId, externalRef: reference, origin: 'API' }),
  ]);

  if (payIn) return ok(res, toApiDto(payIn));
  if (payOut) return ok(res, toPayoutDto(payOut));
  throw AppError.notFound('No payment with that reference', ErrorCodes.TRANSACTION_NOT_FOUND);
});

/** What the party can currently spend on payouts. */
export const balance = asyncHandler(async (req: Request, res: Response) => {
  const api = caller(req);
  const party = await Party.findById(api.partyId).select('dmcBalancePaise companyName').lean();
  if (!party) throw AppError.notFound('Party not found', ErrorCodes.PARTY_NOT_FOUND);

  // Held money is shown separately rather than netted off, because "why is my
  // balance lower than I expect" is otherwise unanswerable from the API alone.
  //
  // Read from tasks, because that is what carries a payout — the party was
  // billed when they asked for it and the money is committed until the captain
  // finishes or it falls through.
  const held = await Task.aggregate<{ _id: null; total: number }>([
    {
      $match: {
        partyId: api.partyId,
        origin: 'API',
        status: {
          $in: [
            'CREATED', 'ASSIGNED', 'IN_PROGRESS', 'PROOF_SUBMITTED',
            'AUDIT_PENDING', 'REJECTED', 'REASSIGNED', 'CANCEL_REVIEW', 'CANCEL_DISPUTED',
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        // The whole charge, so available + held adds back to what the party
        // had. Reporting only the amount would leave the commission missing
        // from both figures and the question unanswerable.
        total: { $sum: { $add: ['$amountPaise', { $ifNull: ['$partyCommissionPaise', 0] }] } },
      },
    },
  ]);

  return ok(res, {
    available: paiseToRupees(party.dmcBalancePaise),
    heldForPayouts: paiseToRupees(held[0]?.total ?? 0),
  });
});

/**
 * The party's customer says the money never arrived.
 *
 * A dispute used to be the captain's alone, which made it one-sided in a
 * system that is two-sided everywhere else: the captain could say "nobody paid
 * me", but a party whose customer swears they paid — or who never received a
 * payout — had no way to say so at all. Now either side can stop it, and the
 * hold stays exactly where it is until admin decides.
 */
export const disputeTransaction = asyncHandler(async (req: Request, res: Response) => {
  const api = caller(req);
  const reference = req.params['reference'] as string;
  const { reason } = req.body as { reason: string };

  // Scoped in the filter, so a party cannot dispute somebody else's payment.
  const [payIn, payOut] = await Promise.all([
    Transaction.findOne({ partyId: api.partyId, partyReference: reference }),
    Task.findOne({ partyId: api.partyId, externalRef: reference, origin: 'API' }),
  ]);

  if (payIn) {
    const disputed = await raiseDispute(payIn._id, reason, api.actor);
    return ok(res, toApiDto(disputed), 'Raised with the platform — we will come back to you');
  }

  if (payOut) {
    // A payout auto-approved on the captain's word, so this is the party's
    // only chance to say the money never reached their customer. It goes to
    // admin as a dispute on the task, which is where a rejected proof already
    // goes — one queue, one decision, rather than a second parallel one.
    const disputed = await disputePayoutTask(payOut, reason, api.actor);
    return ok(res, toPayoutDto(disputed), 'Raised with the platform — we will come back to you');
  }

  throw AppError.notFound('No payment with that reference', ErrorCodes.TRANSACTION_NOT_FOUND);
});

/**
 * Ask us to try the callback again.
 *
 * Offered because a party's endpoint being down is entirely normal and the
 * alternative — polling every transaction — is worse for both sides.
 */
export const replayCallback = asyncHandler(async (req: Request, res: Response) => {
  const api = caller(req);
  const reference = req.params['reference'] as string;

  const transaction = await Transaction.findOne({ partyId: api.partyId, partyReference: reference });
  if (!transaction) throw AppError.notFound('No transaction with that reference', ErrorCodes.TRANSACTION_NOT_FOUND);
  if (!transaction.callbackUrl) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'This transaction has no callback URL');
  }

  const delivered = await deliverCallback(transaction, `transaction.${transaction.status.toLowerCase()}`, api.keyId);
  return ok(res, { delivered }, delivered ? 'Callback delivered' : 'Callback could not be delivered');
});

/**
 * The party relaying their customer's answer about a payout.
 *
 * The inbound half of `payout.confirmation_required`. A party's server calls
 * this once its customer has said whether the money arrived — OTDMS never
 * asked the customer itself and holds nothing about them, so this is the only
 * way the answer can arrive.
 *
 * Keyed by the party's own reference, like every other endpoint here, so an
 * integrator never has to store our identifiers to answer us.
 */
export const confirmPayout = asyncHandler(async (req: Request, res: Response) => {
  const api = caller(req);
  const reference = req.params['reference'] as string;
  const { received, reason } = req.body as { received: boolean; reason?: string };

  const task = await Task.findOne({ partyId: api.partyId, externalRef: reference });
  if (!task) throw AppError.notFound('No payout found for this reference', ErrorCodes.TASK_NOT_FOUND);

  const updated = await applyCustomerConfirmation({
    taskId: task._id,
    partyId: api.partyId,
    received,
    ...(reason ? { reason } : {}),
    actor: api.actor,
  });

  return ok(
    res,
    { reference, status: updated.status },
    received ? 'Payout approved' : 'Payout disputed — an administrator will review it',
  );
});
