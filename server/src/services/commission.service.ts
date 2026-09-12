import type { ClientSession, Types } from 'mongoose';
import { Commission } from '../models';
import { percentOfPaise } from '../utils/money';
import { isDuplicateKey } from '../utils/mongoErrors';

/**
 * COMMISSION ENGINE
 * -----------------
 * Pure functions of (amount, config). No rate is hard-coded anywhere; every
 * value is read from SystemConfig, so changing commission is a settings edit
 * rather than a deploy.
 *
 * There used to be two independent schemes here — a captain rate and a
 * platform rate, each of which could be a flat amount or a percentage, and
 * each of which a party could be given its own override for. Six settings, and
 * no screen could answer "what does this payment cost" without evaluating all
 * of them. What replaced it is below: two percentages per direction, and the
 * platform's cut is the difference.
 */

/**
 * What a task's captain commission was priced at.
 *
 * Read off the task row rather than recomputed, so the ledger names the rate
 * the task was actually priced at even if the setting changed since.
 */
export interface CommissionComputation {
  commissionPaise: number;
  percentageRate: number;
  configVersion: number;
}

export interface CreditInput {
  taskId: Types.ObjectId;
  captainId: Types.ObjectId;
  partyId: Types.ObjectId;
  taskAmountPaise: number;
  computation: CommissionComputation;
  session?: ClientSession;
}

/**
 * Write the immutable ledger entry. The unique index on taskId is what
 * actually prevents double payment: a concurrent duplicate raises E11000
 * rather than silently crediting twice.
 */
export async function creditCommission(input: CreditInput): Promise<{ created: boolean; commissionPaise: number }> {
  const doc = {
    taskId: input.taskId,
    captainId: input.captainId,
    partyId: input.partyId,
    taskAmountPaise: input.taskAmountPaise,
    commissionPaise: input.computation.commissionPaise,
    percentageRate: input.computation.percentageRate,
    configVersion: input.computation.configVersion,
    entryType: 'CREDIT' as const,
    earnedAt: new Date(),
  };

  try {
    await Commission.create(input.session ? [doc] : [doc], input.session ? { session: input.session } : {});
    return { created: true, commissionPaise: input.computation.commissionPaise };
  } catch (err) {
    if (isDuplicateKey(err)) {
      // Already credited: idempotent success, never a second payment.
      return { created: false, commissionPaise: input.computation.commissionPaise };
    }
    throw err;
  }
}


/** Which side of a payment a captain is being paid for. */
export type PaymentDirection = 'PAY_IN' | 'PAY_OUT';


export interface DirectionalCommission {
  /** Charged to the party, on top of the amount. Goes to the pool. */
  partyPaise: number;
  /** Paid to the captain, out of that pool. */
  captainPaise: number;
  /** What nobody took. The platform's, and never computed separately. */
  platformPaise: number;
  partyRate: number;
  /**
   * The rate the captain was actually paid at.
   *
   * The same as the agreed rate below unless the cap bit, in which case it is
   * the party's rate — because a capped captain is paid exactly the party's
   * charge, and that charge is the party's rate applied to the same amount.
   *
   * This is the figure the ledger shows. Showing the agreed rate there instead
   * put "6%" beside an amount that was five percent of the payment, which any
   * captain reads as having been underpaid. It reveals nothing they could not
   * already work out: the ledger shows them the amount and the commission, so
   * the division was always theirs to do.
   */
  captainRate: number;
  /**
   * What admin agreed with this captain, before any cap.
   *
   * Kept alongside so a dispute can be answered from the row: the agreement
   * was real, and the reason a smaller number was paid is that the party this
   * particular work came from is charged less than the captain is promised.
   */
  captainRateAgreed: number;
  /** True when the agreed rate could not be honoured in full. */
  capped: boolean;
  configVersion: number;
}

/** The four default rates, as SystemConfig stores them. */
export interface RateConfig {
  payInPartyCommissionPercentage: number;
  payInCaptainCommissionPercentage: number;
  payOutPartyCommissionPercentage: number;
  payOutCaptainCommissionPercentage: number;
  version: number;
}

/**
 * The per-account rates, as the party and captain rows store them.
 *
 * Deliberately two separate shapes rather than one: a party has no captain
 * rate to give and a captain has no party rate to give, and a single shape
 * carrying both fields would make it possible — and eventually likely — to
 * read one account's half off the other's profile.
 */
export interface PartyRates {
  payInPartyCommissionPercentage?: number | null;
  payOutPartyCommissionPercentage?: number | null;
}

export interface CaptainRates {
  payInCaptainCommissionPercentage?: number | null;
  payOutCaptainCommissionPercentage?: number | null;
}

/**
 * What this party is charged on this direction.
 *
 * Their own rate where they have one, the default otherwise. Null and zero
 * are different answers: null means "nobody decided for this party, use the
 * default", zero means "this party is charged nothing" — so the check is
 * against null, never against falsiness. A `?? ` on a rate of 0 would
 * silently bill a party that had been promised free service.
 */
export function partyRateFor(
  direction: PaymentDirection,
  config: RateConfig,
  party?: PartyRates | null,
): number {
  const own =
    direction === 'PAY_IN'
      ? party?.payInPartyCommissionPercentage
      : party?.payOutPartyCommissionPercentage;
  if (own != null) return own;
  return direction === 'PAY_IN'
    ? config.payInPartyCommissionPercentage
    : config.payOutPartyCommissionPercentage;
}

/**
 * What this captain is paid on this direction. Same rule as the party's, with
 * one addition that only their side needs.
 *
 * `lockedDefault` is the default that was in force when the work was priced,
 * recorded on the row at creation. It exists because a captain's share is
 * priced later than the party's — at the claim, since that is when there is a
 * captain — and in the gap between the two, admin may have changed the
 * setting. Without this, a settings change would reach back and re-price work
 * somebody had already been quoted for.
 *
 * The captain's own agreed rate still wins over both. That is not a settings
 * change reaching backwards; it is the agreement that was always theirs being
 * applied the moment we learn the work is theirs.
 */
export function captainRateFor(
  direction: PaymentDirection,
  config: RateConfig,
  captain?: CaptainRates | null,
  lockedDefault?: number | null,
): number {
  const own =
    direction === 'PAY_IN'
      ? captain?.payInCaptainCommissionPercentage
      : captain?.payOutCaptainCommissionPercentage;
  if (own != null) return own;
  if (lockedDefault != null) return lockedDefault;
  return direction === 'PAY_IN'
    ? config.payInCaptainCommissionPercentage
    : config.payOutCaptainCommissionPercentage;
}

/**
 * What a payment costs and what it pays, for one direction.
 *
 * Each side's rate is that account's own where admin has set one, and the
 * system default otherwise — resolved above, in one place, so the two screens
 * that display a rate and the code that charges it cannot disagree.
 *
 * The captain's share is capped at what the party was charged. Without that
 * cap a misconfigured pair — say 2% charged and 5% paid — would promise the
 * captain money the pool never received, and the shortfall would have to come
 * from somewhere the books do not model. Capping it turns a bad setting into a
 * visibly smaller fee rather than into DMC appearing from nowhere. It matters
 * more now than it did: with per-account rates the mismatched pair is not a
 * misconfiguration of one global setting but an ordinary consequence of a
 * cheap party being served by a well-paid captain.
 */
export function commissionFor(
  direction: PaymentDirection,
  amountPaise: number,
  config: RateConfig,
  accounts?: { party?: PartyRates | null; captain?: CaptainRates | null },
): DirectionalCommission {
  const partyRate = partyRateFor(direction, config, accounts?.party);
  const agreedRate = captainRateFor(direction, config, accounts?.captain);

  const partyPaise = percentOfPaise(amountPaise, partyRate);
  const uncapped = percentOfPaise(amountPaise, agreedRate);
  const captainPaise = Math.min(uncapped, partyPaise);
  const capped = captainPaise < uncapped;

  return {
    partyPaise,
    captainPaise,
    // By subtraction, never by its own percentage — so the three always add up
    // and no paise can be lost or invented between them.
    platformPaise: partyPaise - captainPaise,
    partyRate,
    // What was paid, and what was promised. They differ only when the cap bit,
    // and then the paid rate is the party's, because the captain took the
    // whole of the party's charge.
    captainRate: capped ? partyRate : agreedRate,
    captainRateAgreed: agreedRate,
    capped,
    configVersion: config.version,
  };
}

/**
 * Re-price the captain's half once we know which captain took the work.
 *
 * The party's charge is settled at creation — they are debited for it there
 * and refunded it if the work is cancelled — so it is fixed here and passed in
 * as the pool. Only the split of that pool moves: this captain's own rate
 * decides their share, and whatever they do not take stays the platform's.
 *
 * Which is why the captain's rate cannot be resolved at creation like the
 * party's: at creation there is no captain. Pricing their share then, and
 * leaving it, meant every captain earned the default rate no matter what admin
 * had agreed with them.
 */
export function repriceCaptainShare(
  poolPaise: number,
  amountPaise: number,
  agreedRate: number,
  /**
   * The rate the party was charged, off the row. Needed only to name the rate
   * a capped captain was actually paid at — a capped captain takes the whole
   * charge, so the rate they were paid at is the party's.
   */
  partyRate: number,
): {
  captainPaise: number;
  platformPaise: number;
  captainRate: number;
  captainRateAgreed: number;
  capped: boolean;
} {
  const uncapped = percentOfPaise(amountPaise, agreedRate);
  const captainPaise = Math.min(uncapped, poolPaise);
  const capped = captainPaise < uncapped;
  return {
    captainPaise,
    // Still by subtraction, so re-pricing can move the split but never the
    // total: the party is refunded exactly what they were charged.
    platformPaise: poolPaise - captainPaise,
    captainRate: capped ? partyRate : agreedRate,
    captainRateAgreed: agreedRate,
    capped,
  };
}
