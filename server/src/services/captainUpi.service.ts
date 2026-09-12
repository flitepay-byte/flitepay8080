/**
 * A CAPTAIN'S MERCHANT UPI IDS
 * ----------------------------
 * A captain may hold several merchant accounts, but only one of them is where
 * money is sent. This owns that list and the rule that exactly one entry is
 * active.
 *
 * **The rule is enforced by the write, not by the caller.** Activating an id is
 * a single aggregation-pipeline update that rewrites every entry in the array —
 * setting `active` true on the one being chosen and false on all the others in
 * the same operation. There is no window in which two are active and no
 * sequence of calls that can leave two active, because "deactivate the old one"
 * is not a separate step anybody could skip or have fail halfway.
 *
 * Only merchant UPI IDs are permitted. Nothing about a UPI string says whether
 * the account behind it is a merchant account, so that cannot be validated here
 * — the screens state the requirement plainly and an administrator checks it
 * when they pay. Pretending a regular expression could enforce it would be worse
 * than saying so.
 */
import { Types } from 'mongoose';
import { Captain, type ICaptain } from '../models';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { recordAudit } from './audit.service';
import type { Role } from '../types';

/** The sentence every screen shows, kept in one place so they cannot disagree. */
export const MERCHANT_UPI_NOTICE = 'Only Merchant UPI ID is allowed.';

/** How many a captain may keep. Generous, but not unbounded. */
export const MAX_MERCHANT_UPI_IDS = 10;

export interface MerchantUpi {
  upiId: string;
  label: string | null;
  active: boolean;
  addedAt: Date;
}

export interface ActorContext {
  userId: string;
  role: Role;
  ip?: string;
}

function toDto(entry: ICaptain['merchantUpiIds'][number]): MerchantUpi {
  return {
    upiId: entry.upiId,
    label: entry.label ?? null,
    active: entry.active,
    addedAt: entry.addedAt,
  };
}

export async function listMerchantUpiIds(captainId: Types.ObjectId | string): Promise<MerchantUpi[]> {
  const captain = await Captain.findById(captainId).select('merchantUpiIds').lean();
  if (!captain) throw AppError.notFound('Captain profile not found', ErrorCodes.CAPTAIN_NOT_FOUND);
  return (captain.merchantUpiIds ?? []).map(toDto);
}

/**
 * The one money is sent to.
 *
 * Returns null rather than throwing, so callers can decide what an absence
 * means: for a withdrawal it is a refusal with a sentence the captain can act
 * on, and for a profile screen it is simply nothing to show yet.
 */
export async function activeMerchantUpi(
  captainId: Types.ObjectId | string,
): Promise<MerchantUpi | null> {
  const list = await listMerchantUpiIds(captainId);
  return list.find((u) => u.active) ?? null;
}

/**
 * Add one.
 *
 * The first id a captain adds becomes active, because a list of payout accounts
 * where none is chosen is a captain who cannot be paid and has no way of knowing
 * why. Every later one is added inactive — switching where money goes should be
 * a deliberate act, not a side effect of adding an account.
 */
export async function addMerchantUpiId(
  captainId: Types.ObjectId | string,
  upiId: string,
  label: string | undefined,
  actor: ActorContext,
): Promise<MerchantUpi[]> {
  const normalised = upiId.trim().toLowerCase();

  const captain = await Captain.findById(captainId).select('merchantUpiIds');
  if (!captain) throw AppError.notFound('Captain profile not found', ErrorCodes.CAPTAIN_NOT_FOUND);

  const existing = captain.merchantUpiIds ?? [];
  if (existing.some((u) => u.upiId === normalised)) {
    throw AppError.conflict(ErrorCodes.CONFLICT, 'That UPI ID is already on your profile', {
      field: 'upiId',
    });
  }
  if (existing.length >= MAX_MERCHANT_UPI_IDS) {
    throw AppError.badRequest(
      ErrorCodes.VALIDATION_ERROR,
      `You can keep at most ${MAX_MERCHANT_UPI_IDS} UPI IDs. Remove one before adding another.`,
    );
  }

  const isFirst = existing.length === 0;
  const updated = await Captain.findByIdAndUpdate(
    captainId,
    {
      $push: {
        merchantUpiIds: {
          upiId: normalised,
          label: label?.trim() || null,
          active: isFirst,
          addedAt: new Date(),
        },
      },
    },
    { new: true, select: 'merchantUpiIds' },
  );
  if (!updated) throw AppError.notFound('Captain profile not found', ErrorCodes.CAPTAIN_NOT_FOUND);

  await recordAudit({
    action: 'CAPTAIN_PROFILE_UPDATED',
    targetCollection: 'Captain',
    targetId: captainId,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { addedMerchantUpi: normalised, active: isFirst },
  });

  return (updated.merchantUpiIds ?? []).map(toDto);
}

/**
 * Make one active, and by the same act make every other one inactive.
 *
 * A single pipeline update rewrites the whole array: each entry's `active`
 * becomes the answer to "is this the one being chosen?". That is what makes the
 * one-active rule structural — there is no separate deactivate step to fail, no
 * ordering to get wrong, and two of these racing still leave exactly one active
 * rather than two.
 */
export async function activateMerchantUpiId(
  captainId: Types.ObjectId | string,
  upiId: string,
  actor: ActorContext,
): Promise<MerchantUpi[]> {
  const normalised = upiId.trim().toLowerCase();

  const captain = await Captain.findById(captainId).select('merchantUpiIds').lean();
  if (!captain) throw AppError.notFound('Captain profile not found', ErrorCodes.CAPTAIN_NOT_FOUND);
  if (!(captain.merchantUpiIds ?? []).some((u) => u.upiId === normalised)) {
    throw AppError.notFound('That UPI ID is not on your profile', ErrorCodes.NOT_FOUND);
  }

  const updated = await Captain.findByIdAndUpdate(
    captainId,
    [
      {
        $set: {
          merchantUpiIds: {
            $map: {
              input: '$merchantUpiIds',
              as: 'u',
              in: {
                $mergeObjects: ['$$u', { active: { $eq: ['$$u.upiId', normalised] } }],
              },
            },
          },
        },
      },
    ],
    { new: true, select: 'merchantUpiIds' },
  );
  if (!updated) throw AppError.notFound('Captain profile not found', ErrorCodes.CAPTAIN_NOT_FOUND);

  await recordAudit({
    action: 'CAPTAIN_PROFILE_UPDATED',
    targetCollection: 'Captain',
    targetId: captainId,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { activeMerchantUpi: normalised },
  });

  return (updated.merchantUpiIds ?? []).map(toDto);
}

/**
 * Turn one off without turning another on.
 *
 * Leaves the captain with nothing active, which is a legitimate state — they
 * may be between merchant accounts — and withdrawals refuse until they choose
 * one. Refusing to pay is the right failure here; guessing at a replacement and
 * sending money somewhere they did not choose is not.
 */
export async function deactivateMerchantUpiId(
  captainId: Types.ObjectId | string,
  upiId: string,
  actor: ActorContext,
): Promise<MerchantUpi[]> {
  const normalised = upiId.trim().toLowerCase();

  const updated = await Captain.findOneAndUpdate(
    { _id: captainId, 'merchantUpiIds.upiId': normalised },
    { $set: { 'merchantUpiIds.$.active': false } },
    { new: true, select: 'merchantUpiIds' },
  );
  if (!updated) throw AppError.notFound('That UPI ID is not on your profile', ErrorCodes.NOT_FOUND);

  await recordAudit({
    action: 'CAPTAIN_PROFILE_UPDATED',
    targetCollection: 'Captain',
    targetId: captainId,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { deactivatedMerchantUpi: normalised },
  });

  return (updated.merchantUpiIds ?? []).map(toDto);
}
