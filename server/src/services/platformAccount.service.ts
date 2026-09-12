import { Types, type ClientSession } from 'mongoose';
import { PlatformAccount, type IPlatformAccount } from '../models';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { recordAudit } from './audit.service';
import type { Role } from '../types';

/**
 * Admin's commission is a single platform-wide pool, not tied to any one
 * admin user — there is no per-admin "Admin" profile document the way there
 * is Party/Captain. This fixed, well-known id is what DMCAllocation rows use
 * as `ownerId` when `ownerType: 'ADMIN'`, so every admin commission
 * allocation resolves to the same owner regardless of which admin user acts.
 */
export const PLATFORM_OWNER_ID = new Types.ObjectId('000000000000000000000001');

/** The platform's single commission wallet — created lazily on first use, like SystemConfig. */
export async function getPlatformAccount(session?: ClientSession): Promise<IPlatformAccount> {
  const existing = await PlatformAccount.findOne({ key: 'GLOBAL' }).session(session ?? null);
  if (existing) return existing;

  const created = await PlatformAccount.findOneAndUpdate(
    { key: 'GLOBAL' },
    { $setOnInsert: { key: 'GLOBAL', poolBalancePaise: 0 } },
    { upsert: true, new: true, session },
  );
  return created;
}

/**
 * Admin cashes out, so the pool gives up what they are taking.
 *
 * The pool is the platform's balance, so this is where an admin withdrawal
 * draws from — there is nowhere else it could. Guarded against going negative
 * in the query itself, like every other balance here.
 *
 * Note the consequence, because it is a real operational one rather than an
 * accident: admin can withdraw the pool down far enough that captain
 * commissions stop being payable. That is the honest behaviour — the money is
 * genuinely gone once it is taken — and it is why the pool balance is the
 * number the dashboard puts in front of admin.
 */
export async function debitPlatformCommission(amountPaise: number, session?: ClientSession): Promise<void> {
  const updated = await PlatformAccount.findOneAndUpdate(
    { key: 'GLOBAL', poolBalancePaise: { $gte: amountPaise } },
    { $inc: { poolBalancePaise: -amountPaise } },
    { session },
  );
  if (!updated) {
    throw AppError.unprocessable(ErrorCodes.INSUFFICIENT_PLATFORM_BALANCE, 'Not enough platform balance for this withdrawal');
  }
}

/**
 * Money moving into the pool from somewhere already inside the system.
 *
 * A party's commission, or a captain's fee being put back after a credit
 * failed. It raises the balance and nothing else — deliberately not
 * `poolFundedTotalPaise`, which counts only what admin paid for out of their
 * own pocket. Conflating the two made that figure grow every time a party was
 * charged, so the one number telling admin what running the platform costs
 * them read as though they had funded money they never did.
 */
export async function collectIntoPool(amountPaise: number, session?: ClientSession): Promise<void> {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Pool credit must be a positive whole number of paise');
  }
  await PlatformAccount.findOneAndUpdate(
    { key: 'GLOBAL' },
    { $inc: { poolBalancePaise: amountPaise }, $setOnInsert: { key: 'GLOBAL' } },
    { upsert: true, session },
  );
}

/**
 * Admin puts real money in and mints DMC into the pool.
 *
 * This is where DMC enters the system for commission purposes, and it is
 * deliberately an explicit admin act rather than something that happens
 * automatically when a commission is owed. If commission could mint its own
 * funding there would be no ceiling on it and no moment at which anyone had to
 * look at the cost; making admin fund the pool first means the platform's
 * spend is always a decision someone made, and always visible as a balance
 * going down.
 *
 * Use `collectIntoPool` for money that is merely moving in from elsewhere in
 * the system — commission collected from a party is not new money.
 */
export async function fundPlatformPool(amountPaise: number, session?: ClientSession): Promise<void> {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Funding amount must be a positive whole number of paise');
  }
  await PlatformAccount.findOneAndUpdate(
    { key: 'GLOBAL' },
    {
      $inc: { poolBalancePaise: amountPaise, poolFundedTotalPaise: amountPaise },
      $setOnInsert: { key: 'GLOBAL' },
    },
    { upsert: true, session },
  );
}

/**
 * Pay a captain's commission out of the pool.
 *
 * Guarded against overdrawing in the query itself, the same way the captain's
 * own balances are: a commission the platform cannot fund is refused rather
 * than driven negative. The caller decides what that means — the sensible
 * reading is that the transaction still stands and the commission is owed but
 * unpaid, because the party and the captain have already moved real money and
 * unwinding that would be worse than a platform IOU.
 */
export async function payCommissionFromPool(amountPaise: number, session?: ClientSession): Promise<boolean> {
  if (amountPaise <= 0) return true;
  const updated = await PlatformAccount.findOneAndUpdate(
    { key: 'GLOBAL', poolBalancePaise: { $gte: amountPaise } },
    { $inc: { poolBalancePaise: -amountPaise } },
    { session },
  );
  return updated != null;
}

/**
 * Admin puts real money behind the commission the platform promises.
 *
 * Wrapped rather than folded into `fundPlatformPool` because this is the door
 * real rupees come in through and it needs a name on it: who funded, how much,
 * and against what reference. The unaudited version stays for internal callers
 * that are compensating a failed payment rather than adding new money.
 */
export async function fundCommissionPool(
  amountPaise: number,
  actor: { userId: string; role: Role; ip?: string },
  reference?: string,
): Promise<IPlatformAccount> {
  await fundPlatformPool(amountPaise);
  const account = await getPlatformAccount();

  await recordAudit({
    action: 'PLATFORM_POOL_FUNDED',
    targetCollection: 'PlatformAccount',
    targetId: account._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: {
      amountPaise,
      poolBalancePaise: account.poolBalancePaise,
      poolFundedTotalPaise: account.poolFundedTotalPaise,
    },
    metadata: reference ? { reference } : {},
  });

  return account;
}
