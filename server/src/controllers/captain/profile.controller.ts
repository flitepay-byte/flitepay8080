import type { Request, Response } from 'express';
import { asyncHandler, ok, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { Task, Captain, Commission, WalletEntry, Transaction } from '../../models';
import { getConfig } from '../../services/systemConfig.service';
import { captainRateFor } from '../../services/commission.service';
import * as collateral from '../../services/collateral.service';
import { notifyPresenceChanged } from '../../services/notification.service';
import { recordAudit } from '../../services/audit.service';
import { toCaptainDto } from '../../utils/serializers';
import { paiseToRupees } from '../../utils/money';
import { istDayBounds } from '../../utils/dates';
import { captainContext } from './context';
const ACTIVE_STATES = ['ASSIGNED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'AUDIT_PENDING'];

const DECIDED_STATES = ['COMPLETED', 'REJECTED'];

/**
 * The captain's commission ledger — both directions, in one list.
 *
 * Read from the wallet entries rather than from the Commission collection,
 * which was the bug this replaced. A Commission row is written only for a
 * pay-out task, so a captain who spent the week taking pay-ins opened this
 * screen and saw an empty ledger beside a wallet that had visibly grown.
 *
 * A wallet entry is the record of commission actually *reaching* the captain,
 * and `payCommissionToCaptain` writes one for a settled pay-in and a completed
 * pay-out alike. So it is the one source that has both, and it reports what was
 * paid rather than what was owed — a fee the pool could not cover leaves no
 * entry, and the total here stays honest about it.
 *
 * The entry itself carries only the commission and a reference. What the
 * payment was worth, and which way it went, live on the thing the reference
 * names — so one page's worth are looked up and joined. A page at a time keeps
 * that to two small queries however long the history gets.
 */
export const earnings = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const query = req.query as unknown as { page: number; limit: number; direction?: 'PAY_IN' | 'PAY_OUT' };
  const skip = (query.page - 1) * query.limit;

  // Which side of the business a fee came from is not stored on the entry —
  // it is a property of the thing the reference names. Filtering by resolving
  // those would mean reading the whole history to page it, so the reference
  // itself is matched instead: a pay-in cites a transaction code and a pay-out
  // cites a task code, and each of those is built in exactly one place
  // (transaction.service.ts and utils/ids.ts). `commissionLedger.test.ts` pins
  // both prefixes so a change to either format fails loudly here rather than
  // quietly emptying this filter.
  const match = {
    captainId,
    kind: 'COMMISSION_EARNED' as const,
    ...(query.direction
      ? { sourceReference: query.direction === 'PAY_IN' ? /^PIN-/ : /^TASK-/ }
      : {}),
  };

  const [entries, total, aggregate] = await Promise.all([
    WalletEntry.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(query.limit).lean(),
    WalletEntry.countDocuments(match),
    WalletEntry.aggregate<{ _id: null; totalPaise: number; count: number }>([
      { $match: match },
      { $group: { _id: null, totalPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
    ]),
  ]);

  // Sorted by createdAt *and* _id: two commissions earned in the same
  // millisecond would otherwise have no defined order between them, and a page
  // boundary falling between them could repeat one row and drop another.
  const references = entries.map((e) => e.sourceReference).filter((r): r is string => Boolean(r));
  const [payIns, payOuts] = await Promise.all([
    references.length
      ? Transaction.find({ transactionCode: { $in: references } })
          .select('transactionCode amountPaise commissionRate')
          .lean()
      : [],
    references.length
      ? Task.find({ taskCode: { $in: references } })
          .select('taskCode amountPaise captainCommissionRate')
          .lean()
      : [],
  ]);
  const payInByCode = new Map(payIns.map((t) => [t.transactionCode, t]));
  const payOutByCode = new Map(payOuts.map((t) => [t.taskCode, t]));

  const items = entries.map((entry) => {
    const reference = entry.sourceReference ?? null;
    const payIn = reference ? payInByCode.get(reference) : undefined;
    const payOut = reference ? payOutByCode.get(reference) : undefined;
    return {
      id: String(entry._id),
      /**
       * Null when the reference names something that no longer exists. Shown
       * as such rather than guessed at: the commission is real either way, and
       * inventing a direction for it would be worse than saying nothing.
       */
      direction: payIn ? 'PAY_IN' : payOut ? 'PAY_OUT' : null,
      reference,
      amount: payIn || payOut ? paiseToRupees((payIn ?? payOut)!.amountPaise) : null,
      /**
       * The rate this row was actually priced at, read off the row rather than
       * recomputed from today's settings.
       *
       * It has to be per row now. A captain's rate is their own and admin can
       * change it, so two entries a week apart can honestly carry different
       * rates — and a ledger that showed one current figure over all of them
       * would be telling the captain their older work was mispaid.
       */
      rate: payIn ? payIn.commissionRate : payOut ? (payOut.captainCommissionRate ?? null) : null,
      commission: paiseToRupees(entry.amountPaise),
      earnedAt: entry.createdAt.toISOString(),
    };
  });

  const summary = aggregate[0];
  return ok(res, {
    ...paginate(items, query.page, query.limit, total),
    totalEarned: paiseToRupees(summary?.totalPaise ?? 0),
    entryCount: summary?.count ?? 0,
  });
});

/**
 * Server-computed dashboard summary for the Home screen â€” everything the
 * client needs in one round trip, mirroring the admin dashboard's shape
 * rather than having the client fetch raw lists and aggregate them itself.
 */
export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const day = istDayBounds();

  const [statusCounts, valueAgg, todayCommissionAgg, totalCommissionAgg] = await Promise.all([
    Task.aggregate<{ _id: string; count: number }>([
      { $match: { captainId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Task.aggregate<{ _id: null; totalPaise: number; count: number }>([
      { $match: { captainId } },
      { $group: { _id: null, totalPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
    ]),
    Commission.aggregate<{ _id: null; totalPaise: number }>([
      { $match: { captainId, earnedAt: { $gte: day.start, $lt: day.end } } },
      { $group: { _id: null, totalPaise: { $sum: '$commissionPaise' } } },
    ]),
    Commission.aggregate<{ _id: null; totalPaise: number }>([
      { $match: { captainId } },
      { $group: { _id: null, totalPaise: { $sum: '$commissionPaise' } } },
    ]),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusCounts) byStatus[row._id] = row.count;

  const activeCount = ACTIVE_STATES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
  const completedCount = byStatus['COMPLETED'] ?? 0;
  const decidedCount = DECIDED_STATES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
  const conversionRate = decidedCount > 0 ? Math.round((completedCount / decidedCount) * 100) : 0;

  const totals = valueAgg[0];

  return ok(res, {
    activeCount,
    completedCount,
    conversionRate,
    totalTransactions: totals?.count ?? 0,
    totalClaimedValue: paiseToRupees(totals?.totalPaise ?? 0),
    todaysEarnings: paiseToRupees(todayCommissionAgg[0]?.totalPaise ?? 0),
    totalEarned: paiseToRupees(totalCommissionAgg[0]?.totalPaise ?? 0),
  });
});

export const profile = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const captain = await Captain.findById(captainId);
  if (!captain) throw AppError.notFound('Captain profile not found');

  const throughput = await collateral.getCaptainThroughput(captainId);
  const config = await getConfig();

  return ok(res, {
    ...toCaptainDto(captain),
    usage: {
      dailyUsed: paiseToRupees(throughput.dailyPaise),
      dailyLimit: paiseToRupees(captain.dailyLimitPaise ?? config.captainDailyLimitPaise),
      monthlyUsed: paiseToRupees(throughput.monthlyPaise),
      monthlyLimit: paiseToRupees(captain.monthlyLimitPaise ?? config.captainMonthlyLimitPaise),
    },
    /**
     * The terms the captain is working under. These are admin's settings, but
     * they decide what a captain earns and what happens to money they post, so
     * a captain who cannot see them is being asked to send real money without
     * being told what it buys.
     */
    terms: {
      collateralLockPercentage: config.collateralLockPercentage,
      // Only what *they* are paid. What the party is charged is between the
      // party and the platform, and showing a captain the margin on their own
      // work would be handing them a negotiating position they were never
      // given a seat for.
      //
      // Their own agreed rate where admin has set one, resolved through the
      // same function the money goes through — a captain on 2% who was shown
      // the 1% default would think every payment had underpaid them.
      payInCommissionPercentage: captainRateFor('PAY_IN', config, captain),
      payOutCommissionPercentage: captainRateFor('PAY_OUT', config, captain),
    },
  });
});

export const setPresence = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const { online } = req.body as { online: boolean };

  await Captain.updateOne({ _id: captainId }, { $set: { isOnline: online, lastSeenAt: new Date() } });
  await recordAudit({
    action: 'CAPTAIN_STATUS_CHANGED',
    targetCollection: 'Captain',
    targetId: captainId,
    userId: actor.userId,
    role: 'CAPTAIN',
    ip: actor.ip,
    newState: { isOnline: online },
  });
  notifyPresenceChanged(String(captainId), online);

  return ok(res, { online }, online ? 'You are now online' : 'You are now offline');
});
