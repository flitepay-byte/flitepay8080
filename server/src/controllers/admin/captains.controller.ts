/**
 * ADMIN — CAPTAINS
 *
 * The captain list and profile, the fields admin may set on a captain
 * (approved limit, per-captain commission), and the collateral integrity
 * check that compares stored locked funds against what the open work implies.
 */
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { Captain } from '../../models';
import { recordAudit } from '../../services/audit.service';
import * as collateral from '../../services/collateral.service';
import { notifyLimitUpdated } from '../../services/notification.service';
import { toCaptainDto } from '../../utils/serializers';
import { paiseToRupees, rupeesToPaise } from '../../utils/money';
import { adminActor } from './actor';
/** Full profile view for one captain. Their tasks are fetched separately via GET /admin/tasks?captainId=. */
export const captainDetail = asyncHandler(async (req: Request, res: Response) => {
  const captainId = req.params['captainId'] as string;
  const captain = await Captain.findById(captainId);
  if (!captain) throw AppError.notFound('Captain not found');

  return ok(res, toCaptainDto(captain));
});

export const listCaptains = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as { page: number; limit: number };
  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    Captain.find().sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    Captain.countDocuments(),
  ]);
  return ok(res, paginate(items.map(toCaptainDto), query.page, query.limit, total));
});

/**
 * Adjust simulated collateral. This changes the exposure ceiling only; it is
 * not a payment and moves no funds.
 */

/** Editable profile fields: display name and per-captain limit overrides. */
export const updateCaptainProfile = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const captainId = req.params['captainId'] as string;
  const {
    displayName, dailyLimit, monthlyLimit, creditLimit, creditLimitAdd,
    payInCaptainCommissionPercentage, payOutCaptainCommissionPercentage,
  } = req.body as {
    displayName?: string;
    dailyLimit?: number | null;
    monthlyLimit?: number | null;
    creditLimit?: number | null;
    creditLimitAdd?: number;
    payInCaptainCommissionPercentage?: number | null;
    payOutCaptainCommissionPercentage?: number | null;
  };

  const captain = await Captain.findById(captainId);
  if (!captain) throw AppError.notFound('Captain not found');

  const before = {
    displayName: captain.displayName,
    dailyLimitPaise: captain.dailyLimitPaise,
    monthlyLimitPaise: captain.monthlyLimitPaise,
    creditLimitPaise: captain.creditLimitPaise ?? null,
    collateralBalancePaise: captain.collateralBalancePaise,
    payInCaptainCommissionPercentage: captain.payInCaptainCommissionPercentage ?? null,
    payOutCaptainCommissionPercentage: captain.payOutCaptainCommissionPercentage ?? null,
  };
  if (displayName !== undefined) captain.displayName = displayName;
  if (dailyLimit !== undefined) captain.dailyLimitPaise = dailyLimit;
  if (monthlyLimit !== undefined) captain.monthlyLimitPaise = monthlyLimit;
  // Changes the ceiling only. The collateral is the captain's own money and is
  // deliberately not touched here — see Captain.ts.
  if (creditLimit !== undefined) captain.creditLimitPaise = creditLimit === null ? null : rupeesToPaise(creditLimit);
  // What this captain is paid. Only ever their own share — what the party is
  // charged is set on the party, and this endpoint cannot reach it.
  if (payInCaptainCommissionPercentage !== undefined) {
    captain.payInCaptainCommissionPercentage = payInCaptainCommissionPercentage;
  }
  if (payOutCaptainCommissionPercentage !== undefined) {
    captain.payOutCaptainCommissionPercentage = payOutCaptainCommissionPercentage;
  }
  await captain.save();

  /**
   * Raising the ceiling by an amount, which is the shape the decision
   * actually has: admin grants a captain another 2,000 of room.
   *
   * Done as one conditional write against the stored value rather than
   * read-add-save, and done after the save above so nothing here can be
   * undone by it. Two admins granting at the same moment both land; the
   * read-modify-write this replaces would have kept only the later one and
   * lost the other grant without a trace.
   *
   * The base is the collateral when no override is set yet, so the first
   * grant adds to what the captain has actually posted rather than starting
   * again from zero and cutting them down.
   */
  let raised: typeof captain | null = null;
  if (creditLimitAdd !== undefined) {
    const deltaPaise = rupeesToPaise(creditLimitAdd);
    const nextCeiling = {
      $add: [{ $ifNull: ['$creditLimitPaise', '$collateralBalancePaise'] }, deltaPaise],
    };
    raised = await Captain.findOneAndUpdate(
      { _id: captain._id, $expr: { $gte: [nextCeiling, 0] } },
      [{ $set: { creditLimitPaise: nextCeiling } }],
      { new: true },
    );
    if (!raised) {
      throw AppError.badRequest(
        ErrorCodes.VALIDATION_ERROR,
        'That would take the approved limit below zero.',
      );
    }
  }
  const updated = raised ?? captain;

  await recordAudit({
    action: 'CAPTAIN_PROFILE_UPDATED',
    targetCollection: 'Captain',
    targetId: captain._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    oldState: before,
    newState: {
      displayName: updated.displayName,
      dailyLimitPaise: updated.dailyLimitPaise,
      monthlyLimitPaise: updated.monthlyLimitPaise,
      creditLimitPaise: updated.creditLimitPaise ?? null,
      payInCaptainCommissionPercentage: updated.payInCaptainCommissionPercentage ?? null,
      payOutCaptainCommissionPercentage: updated.payOutCaptainCommissionPercentage ?? null,
      // Recorded unchanged on purpose: the audit trail should show plainly
      // that a limit decision moved no money.
      collateralBalancePaise: updated.collateralBalancePaise,
    },
  });

  // A ceiling change moves no money, but it does change what the captain can
  // take on — so their limit display has to follow it immediately.
  if (creditLimit !== undefined || creditLimitAdd !== undefined) {
    const view = await collateral.getCollateral(captain._id);
    notifyLimitUpdated(String(captain._id), view.availableLimitPaise);
  }

  return ok(res, toCaptainDto(updated), 'Captain profile updated');
});

/** Detect drift between stored lockedAmount and the tasks that justify it. */
export const collateralIntegrity = asyncHandler(async (req: Request, res: Response) => {
  const captainId = new Types.ObjectId(req.params['captainId'] as string);
  const result = await collateral.recomputeLockedAmount(captainId);
  return ok(res, {
    storedLocked: paiseToRupees(result.storedPaise),
    computedLocked: paiseToRupees(result.computedPaise),
    drifted: result.drifted,
    differencePaise: result.storedPaise - result.computedPaise,
  });
});
