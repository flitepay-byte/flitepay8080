/**
 * ADMIN — SETTINGS AND THEIR HISTORY
 *
 * Reading and writing SystemConfig, plus the immutable snapshots kept beside
 * it. Every save writes a full version, so what the platform was configured to
 * do on any past day can be read back rather than inferred.
 */
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, paginate, created } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { User, SystemConfigVersion } from '../../models';
import { getConfig, updateConfig, type ConfigPatch, addDepositAddress, setDepositAddressActive } from '../../services/systemConfig.service';
import { recordAudit } from '../../services/audit.service';
import { notifyConfigUpdated } from '../../services/notification.service';
import { toConfigDto } from '../../utils/serializers';
import { rupeesToPaise } from '../../utils/money';
import { adminActor } from './actor';
import { listDepositAddresses } from '../../services/usdtDeposit.service';
export const getSettings = asyncHandler(async (_req: Request, res: Response) => {
  const config = await getConfig();
  return ok(res, toConfigDto(config as unknown as Record<string, unknown>));
});

/**
 * Every settings version, newest first, with what each one changed.
 *
 * The list carries the diff rather than the whole snapshot: a reader scanning
 * for "when did commission move" wants the one line that moved, and sending
 * thirty unchanged fields per row to find it would bury the answer. The full
 * state is one request away, below.
 */
export const settingsVersions = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as { page: number; limit: number };
  const skip = (query.page - 1) * query.limit;

  const [items, total, current] = await Promise.all([
    SystemConfigVersion.find()
      .select('version changes updatedBy createdAt')
      .sort({ version: -1 })
      .skip(skip)
      .limit(query.limit)
      .lean(),
    SystemConfigVersion.countDocuments(),
    getConfig(),
  ]);

  const actorIds = items.map((v) => v.updatedBy).filter((id): id is Types.ObjectId => id != null);
  const actors = actorIds.length
    ? await User.find({ _id: { $in: actorIds } }).select('name email').lean()
    : [];
  const nameById = new Map(actors.map((u) => [String(u._id), u.name || u.email]));

  return ok(res, {
    ...paginate(
      items.map((v) => ({
        version: v.version,
        /**
         * Which fields moved, and to what. Empty on the earliest version kept:
         * it was copied as a starting point, not as the result of an edit.
         */
        changes: v.changes ?? {},
        changedCount: Object.keys(v.changes ?? {}).length,
        /** Null where the system wrote it itself rather than an admin saving. */
        changedBy: v.updatedBy ? (nameById.get(String(v.updatedBy)) ?? null) : null,
        at: v.createdAt.toISOString(),
        /** The one in force now — nothing after it to compare against. */
        isCurrent: v.version === current.version,
      })),
      query.page,
      query.limit,
      total,
    ),
    currentVersion: current.version,
  });
});

/** One version in full, exactly as the settings stood at the time. */
export const settingsVersionDetail = asyncHandler(async (req: Request, res: Response) => {
  const version = Number(req.params['version']);
  const record = await SystemConfigVersion.findOne({ version }).lean();
  if (!record) throw AppError.notFound('That settings version was not recorded');

  const actor = record.updatedBy
    ? await User.findById(record.updatedBy).select('name email').lean()
    : null;

  return ok(res, {
    version: record.version,
    // Through the same serializer the live settings screen uses, so paise read
    // as rupees and an old version is legible in the same units as today's.
    settings: toConfigDto(record.snapshot),
    changes: record.changes ?? {},
    changedBy: actor ? (actor.name || actor.email) : null,
    at: record.createdAt.toISOString(),
  });
});

/**
 * Settings are supplied in rupees and stored in paise. The mapping is explicit
 * rather than automatic so a new field cannot be silently misinterpreted.
 */
export const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const body = req.body as Record<string, unknown>;

  const patch: ConfigPatch = {};
  const direct = [
    'payInPartyCommissionPercentage',
    'payInCaptainCommissionPercentage',
    'payOutPartyCommissionPercentage',
    'payOutCaptainCommissionPercentage',
    'collateralLockPercentage',
    'taskAcceptanceMinutes',
    'taskCompletionMinutes',
    'taskMaxAgeMinutes',
    'taskExpiryAckMinutes',
    'otpExpiryMinutes',
    'otpResendCooldownSeconds',
    'otpMaxAttempts',
    'maxFailedLoginAttempts',
    'accountLockMinutes',
    'proofMaxFileSizeMB',
  ] as const;
  for (const key of direct) {
    if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
  }

  /**
   * The two conversion rates, converted at the edge like every other money
   * figure: 9.59 DMC per USDT is stored as 959.
   *
   * Handled one at a time and never together, so sending one cannot disturb the
   * other — the independence the setting promises is enforced here as well as
   * documented.
   */
  if (body['captainDmcPerUsdt'] !== undefined) {
    (patch as Record<string, unknown>)['captainDmcPaisePerUsdt'] = rupeesToPaise(
      body['captainDmcPerUsdt'] as number,
    );
  }
  if (body['partyDmcPerUsdt'] !== undefined) {
    (patch as Record<string, unknown>)['partyDmcPaisePerUsdt'] = rupeesToPaise(
      body['partyDmcPerUsdt'] as number,
    );
  }

  const rupeeToPaiseFields: Record<string, string> = {
    captainDailyLimit: 'captainDailyLimitPaise',
    captainMonthlyLimit: 'captainMonthlyLimitPaise',
    partyDailyLimit: 'partyDailyLimitPaise',
    partyMonthlyLimit: 'partyMonthlyLimitPaise',
    minimumTaskAmount: 'minimumTaskAmountPaise',
    maximumTaskAmount: 'maximumTaskAmountPaise',
  };
  for (const [input, stored] of Object.entries(rupeeToPaiseFields)) {
    // The validator has already converted these to paise.
    if (body[input] !== undefined) (patch as Record<string, unknown>)[stored] = body[input];
  }

  const { config, changes } = await updateConfig(patch, new Types.ObjectId(actor.userId));

  if (Object.keys(changes).length > 0) {
    await recordAudit({
      action: 'CONFIG_UPDATED',
      targetCollection: 'SystemConfig',
      targetId: config._id,
      userId: actor.userId,
      role: 'ADMIN',
      ip: actor.ip,
      oldState: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.from])),
      newState: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])),
      metadata: { version: config.version },
    });
    notifyConfigUpdated(Object.keys(changes));
  }

  return ok(
    res,
    { config: toConfigDto(config.toObject() as Record<string, unknown>), changes },
    Object.keys(changes).length > 0 ? 'Settings updated' : 'No changes were made',
  );
});

/** The USDT addresses an administrator manages, retired ones included. */
export const listUsdtAddresses = asyncHandler(async (_req: Request, res: Response) => {
  return ok(res, { addresses: await listDepositAddresses() });
});

export const addUsdtAddress = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { address, label } = req.body as { address: string; label?: string };
  const config = await addDepositAddress(address, label, actor);
  return created(res, { addresses: config.usdtDepositAddresses }, 'Address added');
});

/**
 * Retire or reinstate an address.
 *
 * Retiring stops it being handed to new requests and changes nothing about the
 * ones already assigned to it — their payment is still expected there.
 */
export const setUsdtAddressActive = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { active } = req.body as { active: boolean };
  const config = await setDepositAddressActive(
    decodeURIComponent(req.params['address'] as string),
    active,
    actor,
  );
  return ok(
    res,
    { addresses: config.usdtDepositAddresses },
    active ? 'Address is back in use' : 'Address retired — existing requests are unaffected',
  );
});
