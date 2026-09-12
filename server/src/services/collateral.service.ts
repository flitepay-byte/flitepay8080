import type { ClientSession, Types } from 'mongoose';
import { Captain, Task } from '../models';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { formatPaise } from '../utils/money';
import { istDayBounds, istMonthBounds } from '../utils/dates';
import { DMC_HELD_STATES } from '../types';

/**
 * CAPTAIN COLLATERAL
 * ------------------
 *   availableLimit = collateralBalance - lockedAmount
 *
 * availableLimit is always derived, never stored, so it cannot drift.
 * All amounts are integer paise.
 */

export interface CollateralView {
  collateralBalancePaise: number;
  lockedAmountPaise: number;
  /** Admin's override for the ceiling, or null when the collateral is the ceiling. */
  creditLimitPaise: number | null;
  availableLimitPaise: number;
}

/**
 * What the captain may still take on.
 *
 * The ceiling is normally their posted collateral, but admin can set a credit
 * limit that stands in for it — see Captain.ts. Passing `null` (or nothing)
 * keeps the collateral as the ceiling, which is where every captain starts.
 */
export function computeAvailableLimit(
  collateralBalancePaise: number,
  lockedAmountPaise: number,
  creditLimitPaise?: number | null,
): number {
  return (creditLimitPaise ?? collateralBalancePaise) - lockedAmountPaise;
}

/** Pure predicate, unit-testable without a database. */
export function canAfford(view: CollateralView, amountPaise: number): boolean {
  return amountPaise <= view.availableLimitPaise;
}

export async function getCollateral(captainId: Types.ObjectId | string): Promise<CollateralView> {
  const captain = await Captain.findById(captainId)
    .select('collateralBalancePaise lockedAmountPaise creditLimitPaise')
    .lean();
  if (!captain) throw AppError.notFound('Captain profile not found');

  return {
    collateralBalancePaise: captain.collateralBalancePaise,
    lockedAmountPaise: captain.lockedAmountPaise,
    creditLimitPaise: captain.creditLimitPaise ?? null,
    availableLimitPaise: computeAvailableLimit(
      captain.collateralBalancePaise,
      captain.lockedAmountPaise,
      captain.creditLimitPaise,
    ),
  };
}

/**
 * The task limit, as a condition Mongo evaluates at write time.
 *
 *   lockedAmount + amount <= creditLimit ?? collateralBalance
 *
 * Written once and shared, because there are now two doors into the limit —
 * claiming a pay-out and taking a pay-in — and a ceiling enforced two ways is
 * a ceiling that will eventually be enforced two different ways.
 *
 * It has to live in the query filter rather than in application code: Mongo
 * evaluates it against the document as it exists at write time, so two
 * concurrent claims cannot both pass. A read-then-write in Node would be a
 * classic time-of-check/time-of-use race.
 */
export function fitsUnderTaskLimit(amountPaise: number): Record<string, unknown> {
  return {
    $expr: {
      $lte: [
        { $add: ['$lockedAmountPaise', amountPaise] },
        { $ifNull: ['$creditLimitPaise', '$collateralBalancePaise'] },
      ],
    },
  };
}

/**
 * Atomically lock headroom against a claim. Returns false when the captain has
 * no room left under their limit.
 */
export async function lockCollateral(
  captainId: Types.ObjectId,
  amountPaise: number,
  session?: ClientSession,
): Promise<boolean> {
  const result = await Captain.updateOne(
    { _id: captainId, status: 'ACTIVE', ...fitsUnderTaskLimit(amountPaise) },
    { $inc: { lockedAmountPaise: amountPaise } },
    session ? { session } : {},
  );

  return result.modifiedCount === 1;
}

/**
 * Release a hold. Clamped at zero via $max so an accounting bug can never
 * drive lockedAmount negative.
 */
export async function releaseCollateral(
  captainId: Types.ObjectId,
  amountPaise: number,
  session?: ClientSession,
): Promise<void> {
  await Captain.updateOne(
    { _id: captainId },
    [
      {
        $set: {
          lockedAmountPaise: {
            $max: [0, { $subtract: ['$lockedAmountPaise', amountPaise] }],
          },
        },
      },
    ],
    session ? { session } : {},
  );
}

export function insufficientLimitError(availablePaise: number, requiredPaise: number): AppError {
  return AppError.unprocessable(
    ErrorCodes.INSUFFICIENT_AVAILABLE_LIMIT,
    `This task requires ${formatPaise(requiredPaise)} but your available limit is ${formatPaise(availablePaise)}`,
    {
      availableLimitPaise: availablePaise,
      requiredPaise,
      shortfallPaise: requiredPaise - availablePaise,
    },
  );
}

/**
 * Recompute lockedAmount from the tasks that actually hold collateral.
 * Used by the reconciliation tooling to detect and correct drift, which is the
 * kind of bug that silently corrupts a ledger if never checked.
 */
export async function recomputeLockedAmount(captainId: Types.ObjectId): Promise<{
  storedPaise: number;
  computedPaise: number;
  drifted: boolean;
}> {
  const [captain, aggregate] = await Promise.all([
    Captain.findById(captainId).select('lockedAmountPaise').lean(),
    Task.aggregate<{ total: number }>([
      { $match: { captainId, status: { $in: [...DMC_HELD_STATES] } } },
      { $group: { _id: null, total: { $sum: '$amountPaise' } } },
    ]),
  ]);

  if (!captain) throw AppError.notFound('Captain profile not found');
  const computed = aggregate[0]?.total ?? 0;

  return {
    storedPaise: captain.lockedAmountPaise,
    computedPaise: computed,
    drifted: captain.lockedAmountPaise !== computed,
  };
}

/**
 * Sum of task value a captain currently has outstanding, claimed within the
 * IST day/month. Only states that still hold collateral count — the same set
 * as DMC_HELD_STATES — so completing, rejecting, cancelling, or
 * losing a task to expiry frees the captain's daily/monthly room back up
 * rather than permanently consuming it for the rest of the period.
 */
export async function getCaptainThroughput(captainId: Types.ObjectId): Promise<{
  dailyPaise: number;
  monthlyPaise: number;
}> {
  const day = istDayBounds();
  const month = istMonthBounds();

  const rows = await Task.aggregate<{ _id: string; total: number }>([
    {
      $match: {
        captainId,
        claimedAt: { $gte: month.start, $lt: month.end },
        status: { $in: [...DMC_HELD_STATES] },
      },
    },
    {
      $facet: {
        daily: [
          { $match: { claimedAt: { $gte: day.start, $lt: day.end } } },
          { $group: { _id: null, total: { $sum: '$amountPaise' } } },
        ],
        monthly: [{ $group: { _id: null, total: { $sum: '$amountPaise' } } }],
      },
    },
    {
      $project: {
        daily: { $ifNull: [{ $arrayElemAt: ['$daily.total', 0] }, 0] },
        monthly: { $ifNull: [{ $arrayElemAt: ['$monthly.total', 0] }, 0] },
      },
    },
  ]);

  const result = rows[0] as unknown as { daily: number; monthly: number } | undefined;
  return { dailyPaise: result?.daily ?? 0, monthlyPaise: result?.monthly ?? 0 };
}
