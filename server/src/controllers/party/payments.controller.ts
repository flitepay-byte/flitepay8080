import type { Request, Response } from 'express';
import { asyncHandler, ok, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { dispute as raisePartyDispute } from '../../services/transaction.service';
import { ErrorCodes } from '../../utils/errorCodes';
import { Task, Party, Transaction } from '../../models';
import { paiseToRupees } from '../../utils/money';
import { sumMovedValuePaise } from '../../utils/taskValue';
import { sumSettledPayInValuePaise } from '../../utils/payInValue';
import { partyContext } from './context';
/** Dashboard metrics for the party's own tasks. */
export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  const { partyId } = partyContext(req);

  const [counts, totals, payIns, party] = await Promise.all([
    Task.aggregate<{ _id: string; count: number }>([
      { $match: { partyId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Task.aggregate<{ _id: null; totalPaise: number; completedPaise: number }>([
      { $match: { partyId } },
      {
        $group: {
          _id: null,
          // Cancelled tasks are refunded, so their amount never moved.
          totalPaise: sumMovedValuePaise,
          completedPaise: {
            $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, '$amountPaise', 0] },
          },
        },
      },
    ]),
    /**
     * The other direction. Money a party's customers paid in is money that
     * moved through them just as much as money they sent out, and counting
     * only one side made "total value moved" answer a narrower question than
     * its label asked.
     *
     * A separate collection, so nothing here can be counted twice: a pay-in is
     * a Transaction and a pay-out is a Task, and the pay-out rail was removed
     * from the transaction engine — the direction filter is belt and braces,
     * and says plainly which half this is.
     */
    Transaction.aggregate<{ _id: null; totalPaise: number }>([
      { $match: { partyId, direction: 'PAY_IN' } },
      { $group: { _id: null, totalPaise: sumSettledPayInValuePaise } },
    ]),
    Party.findById(partyId).select('dmcBalancePaise').lean(),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of counts) byStatus[row._id] = row.count;
  const totalsRow = totals[0];

  return ok(res, {
    byStatus,
    /**
     * Tasks, as the label says, and as the three tiles beside it count. The
     * pay-in side has its own screens; folding it in here would make a count
     * of tasks stop being one.
     */
    totalTasks: Object.values(byStatus).reduce((a, b) => a + b, 0),
    /** Both directions: what this party has actually moved, either way. */
    totalValue: paiseToRupees((totalsRow?.totalPaise ?? 0) + (payIns[0]?.totalPaise ?? 0)),
    /**
     * Completed pay-out tasks only, unchanged. It sits with the task tiles and
     * answers "how much of my own work finished" — a different question from
     * the headline above, and one a pay-in has no part in.
     */
    completedValue: paiseToRupees(totalsRow?.completedPaise ?? 0),
    dmcBalance: paiseToRupees(party?.dmcBalancePaise ?? 0),
  });
});

/**
 * The party's own transactions, as the dashboard shows them.
 *
 * Separate from the API's view because the two audiences differ: a developer
 * integrating wants the reference they sent, while somebody watching the
 * dashboard wants to see what is stuck. Neither is shown the captain.
 */
export const listTransactions = asyncHandler(async (req: Request, res: Response) => {
  const { partyId } = partyContext(req);
  const query = req.query as unknown as { page: number; limit: number; direction?: string; status?: string };

  const filter: Record<string, unknown> = { partyId };
  if (query.direction) filter['direction'] = query.direction;
  if (query.status) filter['status'] = query.status;

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    Transaction.countDocuments(filter),
  ]);

  return ok(
    res,
    paginate(
      items.map((t) => ({
        id: t.transactionCode,
        reference: t.partyReference,
        direction: t.direction,
        status: t.status,
        amount: paiseToRupees(t.amountPaise),
        settlementReference: t.settlementReference ?? null,
        failureReason: t.failureReason ?? null,
        createdAt: t.createdAt.toISOString(),
        settledAt: t.settledAt?.toISOString() ?? null,
      })),
      query.page,
      query.limit,
      total,
    ),
  );
});

/** The dashboard's way of raising the same dispute the API can raise. */
export const disputeTransaction = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  // Keyed on the party's own reference, exactly as the API is. A party that
  // came through the dashboard and a party that came through the API are the
  // same party, and they should not have to hold two different ids for one
  // payment depending on which door they used.
  const reference = req.params['reference'] as string;
  const { reason } = req.body as { reason: string };

  const owned = await Transaction.findOne({ partyId, partyReference: reference }).select('_id').lean();
  if (!owned) throw AppError.notFound('Transaction not found', ErrorCodes.TRANSACTION_NOT_FOUND);

  const disputed = await raisePartyDispute(owned._id, reason, actor);
  return ok(
    res,
    { id: disputed.transactionCode, reference: disputed.partyReference, status: disputed.status },
    'Raised with the platform — the money stays held until they decide',
  );
});
