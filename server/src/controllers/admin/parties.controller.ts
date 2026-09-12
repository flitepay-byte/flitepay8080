/**
 * ADMIN — PARTIES
 *
 * The party list and profile, party creation, and the per-party terms: task
 * clocks, daily limit and the commission that party is charged.
 */
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, created, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { Task, Party, User, hashPassword, nextSequence } from '../../models';
import { getConfig } from '../../services/systemConfig.service';
import { partyRateFor } from '../../services/commission.service';
import { recordAudit } from '../../services/audit.service';
import { toPartyDto } from '../../utils/serializers';
import { formatPartyCode } from '../../utils/ids';
import { env } from '../../config/env';
import { sumMovedValuePaise } from '../../utils/taskValue';
import { adminActor } from './actor';
/**
 * Every active party's effective commission rate, both directions.
 *
 * Exists so admin can be told what a captain's rate will really mean before
 * they save it. A captain's rate is not per party — there is one figure that
 * applies to whoever's work they take — so "6% is higher than the party's 5%"
 * is not a thing that can be checked at save time against "the" party. What
 * can be checked is how many parties, and which, charge less than that.
 *
 * Rates are resolved here rather than sent raw, because a party sitting on the
 * default still has an effective rate and the caller is asking what will
 * happen, not what was typed.
 */
export const partyCommissionRates = asyncHandler(async (_req: Request, res: Response) => {
  const [config, parties] = await Promise.all([
    getConfig(),
    Party.find({ status: 'ACTIVE' })
      .select('companyName partyCode payInPartyCommissionPercentage payOutPartyCommissionPercentage')
      .sort({ companyName: 1 })
      .lean(),
  ]);

  return ok(res, {
    defaults: {
      payIn: config.payInPartyCommissionPercentage,
      payOut: config.payOutPartyCommissionPercentage,
    },
    parties: parties.map((party) => ({
      id: String(party._id),
      companyName: party.companyName,
      partyCode: party.partyCode,
      payIn: partyRateFor('PAY_IN', config, party),
      payOut: partyRateFor('PAY_OUT', config, party),
      /** True when this rate is the party's own rather than the default. */
      ownPayIn: party.payInPartyCommissionPercentage != null,
      ownPayOut: party.payOutPartyCommissionPercentage != null,
    })),
  });
});

/** Parties, with task-count/value stats for the admin management view. */
export const listParties = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as { page: number; limit: number };
  const skip = (query.page - 1) * query.limit;

  const [items, total] = await Promise.all([
    Party.find().sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    Party.countDocuments(),
  ]);

  const stats = await Task.aggregate<{ _id: Types.ObjectId; count: number; totalPaise: number }>([
    { $match: { partyId: { $in: items.map((p) => p._id) } } },
    { $group: { _id: '$partyId', count: { $sum: 1 }, totalPaise: sumMovedValuePaise } },
  ]);
  const statsByParty = new Map(stats.map((s) => [String(s._id), { count: s.count, totalPaise: s.totalPaise }]));

  return ok(
    res,
    paginate(
      items.map((p) => toPartyDto(p, statsByParty.get(String(p._id)))),
      query.page,
      query.limit,
      total,
    ),
  );
});

/** Full profile view for one party, plus its most recent tasks. */
export const partyDetail = asyncHandler(async (req: Request, res: Response) => {
  const partyId = req.params['partyId'] as string;
  const party = await Party.findById(partyId);
  if (!party) throw AppError.notFound('Party not found');

  const statsAgg = await Task.aggregate<{ _id: null; count: number; totalPaise: number }>([
    { $match: { partyId: party._id } },
    { $group: { _id: null, count: { $sum: 1 }, totalPaise: sumMovedValuePaise } },
  ]);

  return ok(
    res,
    toPartyDto(party, statsAgg[0] ? { count: statsAgg[0].count, totalPaise: statsAgg[0].totalPaise } : undefined),
  );
});

/**
 * Onboard a new demo party: creates its login (role PARTY) and profile
 * together. The account is seeded with the same default demo password used
 * everywhere else in this simulation, so it is immediately usable.
 */
export const createParty = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { companyName, contactEmail } = req.body as { companyName: string; contactEmail: string };

  const existing = await User.findOne({ email: contactEmail }).lean();
  if (existing) {
    throw AppError.conflict(ErrorCodes.CONFLICT, 'A user with this email already exists', { field: 'contactEmail' });
  }

  const sequence = await nextSequence('party');
  const passwordHash = await hashPassword(env.SEED_DEFAULT_PASSWORD);

  const user = await User.create({
    email: contactEmail,
    passwordHash,
    name: companyName,
    role: 'PARTY',
    status: 'ACTIVE',
  });

  // Every new party starts funded — a task-creation balance credited on
  // registration, the same way a captain funds theirs by buying DMC.
  const config = await getConfig();
  const party = await Party.create({
    userId: user._id,
    partyCode: formatPartyCode(sequence),
    companyName,
    contactEmail,
    dmcBalancePaise: config.partyRegistrationDmcPaise,
  });

  await recordAudit({
    action: 'USER_CREATED',
    targetCollection: 'Party',
    targetId: party._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    newState: { partyCode: party.partyCode, companyName, contactEmail },
  });
  await recordAudit({
    action: 'PARTY_DMC_GRANTED',
    targetCollection: 'Party',
    targetId: party._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    newState: { amountPaise: config.partyRegistrationDmcPaise },
  });

  return created(
    res,
    { ...toPartyDto(party), defaultPassword: env.SEED_DEFAULT_PASSWORD },
    'Party onboarded',
  );
});

/** Per-party overrides of the daily/monthly throughput ceilings; null inherits from SystemConfig. */
export const updatePartyLimits = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const partyId = req.params['partyId'] as string;
  const {
    dailyLimit, monthlyLimit,
    payInPartyCommissionPercentage, payOutPartyCommissionPercentage,
    acceptanceMinutes, completionMinutes, maxAgeMinutes, expiryAckMinutes,
  } = req.body as {
    dailyLimit?: number | null;
    monthlyLimit?: number | null;
    payInPartyCommissionPercentage?: number | null;
    payOutPartyCommissionPercentage?: number | null;
    acceptanceMinutes?: number | null;
    completionMinutes?: number | null;
    maxAgeMinutes?: number | null;
    expiryAckMinutes?: number | null;
  };

  const party = await Party.findById(partyId);
  if (!party) throw AppError.notFound('Party not found');

  const before = {
    dailyLimitPaise: party.dailyLimitPaise,
    monthlyLimitPaise: party.monthlyLimitPaise,
    payInPartyCommissionPercentage: party.payInPartyCommissionPercentage ?? null,
    payOutPartyCommissionPercentage: party.payOutPartyCommissionPercentage ?? null,
    acceptanceMinutes: party.acceptanceMinutes ?? null,
    completionMinutes: party.completionMinutes ?? null,
    maxAgeMinutes: party.maxAgeMinutes ?? null,
    expiryAckMinutes: party.expiryAckMinutes ?? null,
  };
  if (dailyLimit !== undefined) party.dailyLimitPaise = dailyLimit;
  if (monthlyLimit !== undefined) party.monthlyLimitPaise = monthlyLimit;
  // What this party is charged. Only ever their own charge — the captain's
  // share is set on the captain, and this endpoint has no way to touch it.
  if (payInPartyCommissionPercentage !== undefined) {
    party.payInPartyCommissionPercentage = payInPartyCommissionPercentage;
  }
  if (payOutPartyCommissionPercentage !== undefined) {
    party.payOutPartyCommissionPercentage = payOutPartyCommissionPercentage;
  }
  /**
   * The clocks their tasks will run on. Only tasks created after this; work
   * already in flight keeps the windows it was created with, which is the
   * whole reason those are copied onto the task rather than read back here.
   */
  if (acceptanceMinutes !== undefined) party.acceptanceMinutes = acceptanceMinutes;
  if (completionMinutes !== undefined) party.completionMinutes = completionMinutes;
  if (maxAgeMinutes !== undefined) party.maxAgeMinutes = maxAgeMinutes;
  if (expiryAckMinutes !== undefined) party.expiryAckMinutes = expiryAckMinutes;

  await party.save();

  await recordAudit({
    action: 'PARTY_LIMITS_UPDATED',
    targetCollection: 'Party',
    targetId: party._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    oldState: before,
    newState: {
      dailyLimitPaise: party.dailyLimitPaise,
      monthlyLimitPaise: party.monthlyLimitPaise,
      payInPartyCommissionPercentage: party.payInPartyCommissionPercentage ?? null,
      payOutPartyCommissionPercentage: party.payOutPartyCommissionPercentage ?? null,
      acceptanceMinutes: party.acceptanceMinutes ?? null,
      completionMinutes: party.completionMinutes ?? null,
      maxAgeMinutes: party.maxAgeMinutes ?? null,
      expiryAckMinutes: party.expiryAckMinutes ?? null,
    },
  });

  return ok(res, toPartyDto(party), 'Party limits updated');
});
