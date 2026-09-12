/**
 * ADMIN — COMMISSION AND PAYMENT SUMMARIES
 *
 * What the two rails moved and what the platform kept. The platform's share is
 * always the remainder — what a party was charged, less what the captain was
 * paid — and never a percentage of its own.
 */
import type { Request, Response } from 'express';
import { asyncHandler, ok, paginate } from '../../utils/http';
import { Task, Commission, Transaction } from '../../models';
import { toCommissionDto } from '../../utils/serializers';
import { paiseToRupees } from '../../utils/money';
import { istDayBounds, istMonthBounds } from '../../utils/dates';
export const commissions = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as { page: number; limit: number };
  const skip = (query.page - 1) * query.limit;
  const [items, total, agg] = await Promise.all([
    Commission.find().sort({ earnedAt: -1 }).skip(skip).limit(query.limit),
    Commission.countDocuments(),
    Commission.aggregate<{ _id: null; totalPaise: number }>([
      { $group: { _id: null, totalPaise: { $sum: '$commissionPaise' } } },
    ]),
  ]);

  return ok(res, {
    ...paginate(items.map(toCommissionDto), query.page, query.limit, total),
    totalCommission: paiseToRupees(agg[0]?.totalPaise ?? 0),
  });
});

/**
 * What has actually moved through the two rails, and when.
 *
 * "Total" here means money that reached the other end — a settled pay-in, a
 * completed pay-out — and nothing else. Counting created payments instead
 * would fold in the ones that expired, were cancelled, or are still in flight,
 * and the number would answer "what did people attempt" while being read as
 * "what did we handle". A payment that never completed moved nothing.
 *
 * The buckets are measured by when the money moved, not when the payment was
 * raised. A pay-in created last night and settled this morning is this
 * morning's money — that is the day it landed, and the day admin will be asked
 * about it.
 *
 * Days are IST days, because that is the working day of everybody using this.
 * "Last 7 days" is seven calendar days ending today, today included — so it
 * always contains "Today" rather than running alongside it.
 *
 * The two rails are counted from two different collections on purpose. A
 * pay-in is a Transaction; a pay-out is a Task and has been since the direction
 * was removed from the transaction engine. Nothing here revives the old
 * PAY_OUT transaction — it reads the tasks that replaced it.
 */
export const paymentsSummary = asyncHandler(async (_req: Request, res: Response) => {
  const day = istDayBounds();
  const month = istMonthBounds();
  // Six days back from the start of today, so the window is seven whole IST
  // days and its last one is the day in progress.
  const weekStart = new Date(day.start.getTime() - 6 * 24 * 60 * 60_000);

  interface Bucket {
    count: number;
    amount: number;
  }

  /** One rail, four windows. `field` is when that rail records the money landing. */
  async function railTotals(
    model: typeof Transaction | typeof Task,
    match: Record<string, unknown>,
    field: 'settledAt' | 'completedAt',
  ): Promise<{ total: Bucket; today: Bucket; last7Days: Bucket; thisMonth: Bucket }> {
    const windowed = async (from?: Date, to?: Date): Promise<Bucket> => {
      const [row] = await model.aggregate<{ count: number; totalPaise: number }>([
        {
          $match: {
            ...match,
            ...(from ? { [field]: { $gte: from, $lt: to ?? day.end } } : {}),
          },
        },
        { $group: { _id: null, count: { $sum: 1 }, totalPaise: { $sum: '$amountPaise' } } },
      ]);
      return { count: row?.count ?? 0, amount: paiseToRupees(row?.totalPaise ?? 0) };
    };

    const [total, today, last7Days, thisMonth] = await Promise.all([
      windowed(),
      windowed(day.start, day.end),
      windowed(weekStart, day.end),
      windowed(month.start, month.end),
    ]);
    return { total, today, last7Days, thisMonth };
  }

  const [payIn, payOut] = await Promise.all([
    // Settled is the pay-in rail's terminal success: the customer paid and the
    // party has been credited.
    railTotals(Transaction, { direction: 'PAY_IN', status: 'SETTLED' }, 'settledAt'),
    // Completed is the pay-out rail's: the captain sent the money and the
    // party approved the proof.
    railTotals(Task, { status: 'COMPLETED' }, 'completedAt'),
  ]);

  return ok(res, {
    payIn,
    payOut,
    /** Stated so the screen can say what it is showing rather than imply it. */
    basis: {
      payIn: 'Settled pay-ins, by the time they settled',
      payOut: 'Completed pay-outs, by the time they completed',
      timezone: 'IST',
    },
  });
});

/**
 * What the platform itself earned, per direction and per window.
 *
 * The platform's cut is what nobody else took: the party's charge less the
 * captain's share. It is never its own percentage, so this reads it the same
 * way the engine computes it — by subtraction — rather than re-deriving it
 * from a rate and risking a second answer.
 *
 * Counted only where the money actually landed: a settled pay-in and a
 * completed pay-out. Work in flight has been billed to the party but nothing
 * has been earned by anyone yet, and counting it here would overstate what the
 * platform holds.
 */
export const commissionsSummary = asyncHandler(async (_req: Request, res: Response) => {
  const day = istDayBounds();
  const month = istMonthBounds();
  const weekStart = new Date(day.start.getTime() - 6 * 24 * 60 * 60_000);

  interface Bucket {
    count: number;
    amount: number;
  }

  /**
   * One rail, four windows, summing whatever expression names the platform's
   * share on that rail — `adminCommissionPaise` on a task, and the subtraction
   * on a transaction, which has no such field of its own.
   */
  async function railTotals(
    model: typeof Transaction | typeof Task,
    match: Record<string, unknown>,
    field: 'settledAt' | 'completedAt',
    sumExpr: unknown,
  ): Promise<{ total: Bucket; today: Bucket; last7Days: Bucket; thisMonth: Bucket }> {
    const windowed = async (from?: Date, to?: Date): Promise<Bucket> => {
      const [row] = await model.aggregate<{ count: number; totalPaise: number }>([
        { $match: { ...match, ...(from ? { [field]: { $gte: from, $lt: to ?? day.end } } : {}) } },
        { $group: { _id: null, count: { $sum: 1 }, totalPaise: { $sum: sumExpr } } },
      ]);
      return { count: row?.count ?? 0, amount: paiseToRupees(row?.totalPaise ?? 0) };
    };

    const [total, today, last7Days, thisMonth] = await Promise.all([
      windowed(),
      windowed(day.start, day.end),
      windowed(weekStart, day.end),
      windowed(month.start, month.end),
    ]);
    return { total, today, last7Days, thisMonth };
  }

  const [payIn, payOut] = await Promise.all([
    railTotals(
      Transaction,
      { direction: 'PAY_IN', status: 'SETTLED' },
      'settledAt',
      // No stored field for it: a transaction records what the party was
      // charged and what the captain took, and the platform is the difference.
      { $subtract: ['$partyCommissionPaise', '$commissionPaise'] },
    ),
    railTotals(
      Task,
      { status: 'COMPLETED' },
      'completedAt',
      { $ifNull: ['$adminCommissionPaise', 0] },
    ),
  ]);

  return ok(res, {
    payIn,
    payOut,
    combined: {
      total: {
        count: payIn.total.count + payOut.total.count,
        amount: payIn.total.amount + payOut.total.amount,
      },
      today: {
        count: payIn.today.count + payOut.today.count,
        amount: payIn.today.amount + payOut.today.amount,
      },
      last7Days: {
        count: payIn.last7Days.count + payOut.last7Days.count,
        amount: payIn.last7Days.amount + payOut.last7Days.amount,
      },
      thisMonth: {
        count: payIn.thisMonth.count + payOut.thisMonth.count,
        amount: payIn.thisMonth.amount + payOut.thisMonth.amount,
      },
    },
    /** Stated so the screen can say what it counts rather than imply it. */
    basis: {
      payIn: 'Settled pay-ins, by the time they settled',
      payOut: 'Completed pay-outs, by the time they completed',
      rule: "The party's charge less the captain's share",
      timezone: 'IST',
    },
  });
});
