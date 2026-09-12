import type { Request, Response } from 'express';
import { asyncHandler, ok, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { Transaction } from '../../models';
import {
  confirmMovement,
  settle as settleTransaction,
  dispute as disputeTransactionState,
  declineAsCaptain,
} from '../../services/transaction.service';
import { toCaptainTransactionDto } from '../../utils/serializers';
import { captainContext } from './context';

/**
 * Every pay-in this captain has received, newest first.
 *
 * A pay-in is a customer paying the captain in real rupees; the captain gives
 * up the matching DMC and the party is credited. This is the captain's own
 * record of those — all of them, whatever state they reached, because a
 * payment that expired unpaid or is still being argued over is exactly what a
 * captain opens their history to find.
 *
 * Scoped to this captain by the query itself. The party behind the payment is
 * never included: a captain must not learn whose money they handled, and the
 * serializer for their view is an allow-list rather than a redaction.
 */
export const payInHistory = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const query = req.query as unknown as { page: number; limit: number; status?: string };

  const filter: Record<string, unknown> = { captainId, direction: 'PAY_IN' };
  if (query.status) filter['status'] = query.status;

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    // By creation and then by id: two pay-ins opened in the same millisecond
    // would otherwise have no order between them, and a page boundary falling
    // between the two could repeat one row and drop the other.
    Transaction.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(query.limit),
    Transaction.countDocuments(filter),
  ]);

  return ok(res, paginate(items.map(toCaptainTransactionDto), query.page, query.limit, total));
});

/**
 * What the captain is currently on the hook for.
 *
 * A pay-in is money they are waiting to receive from a customer, against DMC
 * already taken from their capital. A pay-out is a transfer they have to
 * actually make. Both are shown with the counterparty stripped: the captain
 * never learns which party the money belongs to, only what to do.
 */
export const myTransactions = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const query = req.query as unknown as { page: number; limit: number; status?: string };

  const filter: Record<string, unknown> = { captainId };
  filter['status'] = query.status
    ? query.status
    : { $in: ['ASSIGNED', 'AWAITING_CUSTOMER', 'CONFIRMED', 'DISPUTED'] };

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    Transaction.countDocuments(filter),
  ]);

  return ok(res, paginate(items.map(toCaptainTransactionDto), query.page, query.limit, total));
});

/**
 * The captain says they have made the transfer.
 *
 * Their word alone does not settle it in the sense of being unchallengeable —
 * the party can dispute it — but it does move the money, because the captain
 * is the one who actually sent the rupees and there is nobody else who can
 * report it. The reference they give is what any later dispute is argued over,
 * which is why it is required rather than optional.
 */
export const confirmTransfer = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const transactionId = req.params['transactionId'] as string;
  const { reference } = req.body as { reference: string };

  // Scoped to this captain in the filter, so one captain cannot confirm
  // another's transfer by guessing an id.
  const owned = await Transaction.exists({ _id: transactionId, captainId, direction: 'PAY_OUT' });
  if (!owned) throw AppError.notFound('Transaction not found', ErrorCodes.TRANSACTION_NOT_FOUND);

  const confirmed = await confirmMovement(transactionId, reference, actor);
  const settled = confirmed.status === 'SETTLED' ? confirmed : await settleTransaction(confirmed._id, actor);

  return ok(res, toCaptainTransactionDto(settled), 'Transfer recorded — the payout is settled');
});

/** The captain says the customer's money never arrived on a pay-in. */
export const disputeTransaction = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const transactionId = req.params['transactionId'] as string;
  const { reason } = req.body as { reason: string };

  const owned = await Transaction.exists({ _id: transactionId, captainId });
  if (!owned) throw AppError.notFound('Transaction not found', ErrorCodes.TRANSACTION_NOT_FOUND);

  const disputed = await disputeTransactionState(transactionId, reason, actor);
  return ok(res, toCaptainTransactionDto(disputed), 'Raised with admin — the DMC stays held until they decide');
});

/** The captain hands back a pay-in they cannot take. */
export const declineTransaction = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const transactionId = req.params['transactionId'] as string;
  const { reason } = req.body as { reason: string };

  const released = await declineAsCaptain(transactionId, captainId, reason, actor);
  return ok(res, toCaptainTransactionDto(released), 'Handed back — it will go to another captain');
});
