import { SystemConfig, SystemConfigVersion, type ISystemConfig } from '../models';
import { getRedis } from '../config/redis';
import { logger } from '../config/logger';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import type { Types } from 'mongoose';
import { recordAudit } from './audit.service';

const CACHE_KEY = 'systemconfig:global';
/** 5-minute TTL, per the performance requirement. */
const CACHE_TTL_SECONDS = 300;

export type ConfigPatch = Partial<
  Pick<
    ISystemConfig,
    | 'payInPartyCommissionPercentage'
    | 'payInCaptainCommissionPercentage'
    | 'payOutPartyCommissionPercentage'
    | 'payOutCaptainCommissionPercentage'
    | 'collateralLockPercentage'
    | 'captainDailyLimitPaise'
    | 'captainMonthlyLimitPaise'
    | 'partyDailyLimitPaise'
    | 'partyMonthlyLimitPaise'
    | 'minimumTaskAmountPaise'
    | 'maximumTaskAmountPaise'
    | 'taskAcceptanceMinutes'
    | 'taskCompletionMinutes'
    | 'taskMaxAgeMinutes'
    | 'taskExpiryAckMinutes'
    | 'customerConfirmationMinutes'
    | 'otpExpiryMinutes'
    | 'otpResendCooldownSeconds'
    | 'otpMaxAttempts'
    | 'maxFailedLoginAttempts'
    | 'accountLockMinutes'
    | 'proofMaxFileSizeMB'
    | 'proofAllowedMimeTypes'
  >
>;

/** Plain snapshot of config, safe to cache and to pass into pure functions. */
export type ConfigSnapshot = Omit<ISystemConfig, keyof import('mongoose').Document | '$locals' | '$op'> & {
  _id: string;
};

export async function ensureSystemConfig(): Promise<ISystemConfig> {
  const existing = await SystemConfig.findOne({ key: 'GLOBAL' });
  if (existing) {
    // A database that predates version history has a config but nothing kept
    // of the versions before it. Those are gone for good — they were
    // overwritten while nothing was recording them — but the version it is on
    // now is still here to copy, so the history starts from something real
    // rather than from whenever somebody next edits the settings.
    await recordConfigVersion(existing, null, null);
    return existing;
  }
  logger.info('Bootstrapping default SystemConfig');
  /**
   * Two callers can reach this at the same moment on a cold start — `getConfig`
   * falls through to here whenever the cache is empty, and nothing serialises
   * them. Both would find nothing, both would insert, and the unique index on
   * `key` would fail one of them with a duplicate-key error that has nothing to
   * do with the request that triggered it.
   *
   * So the loser of that race re-reads instead of throwing: the document it was
   * about to create now exists, which is the outcome it wanted.
   */
  let created;
  try {
    created = await SystemConfig.create({
    key: 'GLOBAL',
    /**
     * Placeholder addresses, so the payment flow works the moment the system
     * starts. They are obviously not real, which is the point: an administrator
     * replaces them in Settings with addresses from their own wallet, and the
     * names make it plain that nothing should be sent to these.
     */
    usdtDepositAddresses: [
      { address: 'DEMO_ADDRESS_1', label: 'Demo address 1', active: true, addedAt: new Date() },
      { address: 'DEMO_ADDRESS_2', label: 'Demo address 2', active: true, addedAt: new Date() },
      { address: 'DEMO_ADDRESS_3', label: 'Demo address 3', active: true, addedAt: new Date() },
      ],
    });
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
      const raced = await SystemConfig.findOne({ key: 'GLOBAL' });
      if (raced) return raced;
    }
    throw err;
  }
  await recordConfigVersion(created, null, null);
  return created;
}

/**
 * Copy this version of the config into the version history.
 *
 * Idempotent through the unique index on `version`: called twice for the same
 * version, the second write loses and that is treated as success. It has to be
 * — this runs on every boot as well as on every change, and checking first
 * would race with itself the moment two workers start together.
 *
 * A failure is logged and swallowed on purpose. The settings change has already
 * been saved and is the thing the operator asked for; failing it afterwards
 * because the *record* of it could not be written would undo real work to
 * protect a copy of it. A gap then shows up honestly as a version with no
 * snapshot, which is a true statement, rather than as a snapshot that is wrong.
 */
async function recordConfigVersion(
  config: ISystemConfig,
  changes: Record<string, { from: unknown; to: unknown }> | null,
  updatedBy: Types.ObjectId | null,
): Promise<void> {
  const snapshot = config.toObject() as Record<string, unknown>;
  delete snapshot['_id'];
  delete snapshot['__v'];

  try {
    await SystemConfigVersion.create({ version: config.version, snapshot, changes, updatedBy });
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) return;
    logger.error({ err, version: config.version }, 'Could not record settings version');
  }
}

/**
 * How long a cache operation may take before this gives up and uses Mongo.
 *
 * Almost every request reads config, so this is the single hottest Redis call
 * in the system — and the one where a slow answer is worth least. With Redis
 * unreachable, ioredis queues the command and drains it through its retry
 * budget: a read measured at roughly two seconds, which turned a Redis outage
 * into an effective service outage while the fallback below reported itself as
 * working perfectly.
 */
const CACHE_TIMEOUT_MS = 50;

/** Resolves to null rather than waiting past the deadline. */
async function withDeadline<T>(operation: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CACHE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // The losing promise still settles on its own; make sure a rejection from
    // it is observed so it cannot surface as an unhandled rejection.
    void operation.catch(() => undefined);
  }
}

/**
 * Read-through cache. On any Redis failure — or any Redis slowness — we fall
 * back to Mongo rather than failing or stalling the request: configuration
 * must never be a single point of failure, and a cache that answers slowly is
 * worse than no cache at all.
 */
export async function getConfig(): Promise<ConfigSnapshot> {
  try {
    const cached = await withDeadline(getRedis().get(CACHE_KEY));
    if (cached) return JSON.parse(cached) as ConfigSnapshot;
  } catch (err) {
    logger.warn({ err }, 'SystemConfig cache read failed; falling back to database');
  }

  const doc = await ensureSystemConfig();
  const snapshot = doc.toObject({ virtuals: false }) as unknown as ConfigSnapshot;

  // Deliberately not awaited: the caller already has the answer, and making
  // them wait on a cache write — especially a slow or failing one — buys
  // nothing. Refreshing the cache is best-effort by definition.
  void getRedis()
    .set(CACHE_KEY, JSON.stringify(snapshot), 'EX', CACHE_TTL_SECONDS)
    .catch((err: unknown) => logger.warn({ err }, 'SystemConfig cache write failed'));

  return snapshot;
}

export async function invalidateConfigCache(): Promise<void> {
  try {
    await getRedis().del(CACHE_KEY);
  } catch (err) {
    logger.warn({ err }, 'SystemConfig cache invalidation failed');
  }
}

/**
 * Apply a patch, bump the version, and return both old and new values so the
 * caller can write an AuditLog containing the exact diff.
 */
export async function updateConfig(
  patch: ConfigPatch,
  adminUserId: Types.ObjectId,
): Promise<{ config: ISystemConfig; changes: Record<string, { from: unknown; to: unknown }> }> {
  const doc = await ensureSystemConfig();

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = doc.get(key) as unknown;
    const isEqual = JSON.stringify(current) === JSON.stringify(value);
    if (isEqual) continue;
    changes[key] = { from: current, to: value };
    doc.set(key, value);
  }

  if (Object.keys(changes).length === 0) {
    // Nothing to write, but still drop the cache. Invalidation elsewhere is
    // best-effort and swallows its failures, so a cached snapshot can be stale
    // while the database is right — and saving the settings again is the
    // obvious remedy to reach for. Returning early without clearing the cache
    // is what made that remedy provably useless.
    await invalidateConfigCache();
    return { config: doc, changes };
  }

  doc.version += 1;
  doc.updatedBy = adminUserId;

  try {
    await doc.save();
    // After the save, never before: a version recorded for a change that then
    // failed validation would name a state that never existed.
    await recordConfigVersion(doc, changes, adminUserId);
  } catch (err) {
    throw AppError.badRequest(
      ErrorCodes.CONFIG_INVALID_VALUE,
      err instanceof Error ? err.message : 'Invalid configuration value',
    );
  }

  await invalidateConfigCache();
  return { config: doc, changes };
}

/**
 * THE USDT ADDRESS BOOK
 *
 * Held in settings rather than the environment so an administrator can add or
 * retire an address without a deployment. Retiring sets `active` to false and
 * never deletes: requests already assigned to an address still have to name it,
 * and a row pointing at an address nobody can look up is a payment nobody can
 * trace.
 */
export async function addDepositAddress(
  address: string,
  label: string | undefined,
  actor: { userId: string; ip?: string },
): Promise<ISystemConfig> {
  const config = await getConfig();
  const existing = (config.usdtDepositAddresses ?? []).find((a) => a.address === address);
  if (existing) {
    throw AppError.conflict(ErrorCodes.CONFLICT, 'That address is already in the list', {
      field: 'address',
    });
  }

  const updated = await SystemConfig.findOneAndUpdate(
    { key: 'GLOBAL' },
    {
      $push: { usdtDepositAddresses: { address, label: label ?? null, active: true, addedAt: new Date() } },
      $inc: { version: 1 },
      $set: { updatedBy: actor.userId },
    },
    { new: true },
  );
  if (!updated) throw AppError.internal('System configuration is missing');

  await invalidateConfigCache();
  await recordAudit({
    action: 'CONFIG_UPDATED',
    targetCollection: 'SystemConfig',
    targetId: updated._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    newState: { addedDepositAddress: address },
  });
  return updated;
}

/** Retire or reinstate an address. Existing requests are untouched either way. */
export async function setDepositAddressActive(
  address: string,
  active: boolean,
  actor: { userId: string; ip?: string },
): Promise<ISystemConfig> {
  const updated = await SystemConfig.findOneAndUpdate(
    { key: 'GLOBAL', 'usdtDepositAddresses.address': address },
    {
      $set: { 'usdtDepositAddresses.$.active': active, updatedBy: actor.userId },
      $inc: { version: 1 },
    },
    { new: true },
  );
  if (!updated) throw AppError.notFound('That address is not in the list', ErrorCodes.NOT_FOUND);

  await invalidateConfigCache();
  await recordAudit({
    action: 'CONFIG_UPDATED',
    targetCollection: 'SystemConfig',
    targetId: updated._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    newState: { depositAddress: address, active },
  });
  return updated;
}
