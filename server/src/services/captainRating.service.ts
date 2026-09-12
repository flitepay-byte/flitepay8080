import { Types } from 'mongoose';
import { Captain, type ICaptain } from '../models';

/**
 * CAPTAIN RATING
 * ==============
 * One 0–5 number summarising how dependable a captain has been, plus the
 * badges derived from the same counters. This is the only place the formula
 * lives; routing (taskRouting.service.ts) and the UI both read the stored
 * `rating` rather than recomputing it.
 *
 * The shape of the formula:
 *
 *   1. Every finished engagement is scored 0..1 — a completion is worth 1, and
 *      each way of letting someone down is worth progressively less. They are
 *      weighted by how much they actually cost the platform, not counted
 *      equally: a rejection that admin went on to uphold means the work was
 *      genuinely bad and both the party and admin had to spend time on it, so
 *      it scores zero and carries extra weight. A missed offer only cost the
 *      routing a few minutes, so it barely dents the score.
 *
 *   2. That average is pulled toward a neutral prior (PRIOR_RATING) with the
 *      strength of PRIOR_WEIGHT engagements. Without this a captain who
 *      completed their first and only task would outrank someone with 200
 *      completions and two bad days, which is both unfair and a bad routing
 *      signal. Ratings converge on the true rate as volume grows.
 *
 *   3. A small punctuality adjustment on top, so that finishing comfortably
 *      inside the window is worth slightly more than scraping in late.
 */

/** Where a captain with no history sits: mid-table, neither favoured nor buried. */
const PRIOR_RATING = 3.5;
/** How many engagements of evidence it takes to outweigh the prior. */
const PRIOR_WEIGHT = 5;

/** Quality of each outcome, 0 (worst) to 1 (best). */
const OUTCOME_QUALITY = {
  completed: 1,
  /** Late, but the work did land. */
  expired: 0.15,
  /** The party was not satisfied, though admin did not confirm fault. */
  rejected: 0.2,
  /** Party rejected AND admin upheld it — the work was genuinely bad. */
  upheldRejection: 0,
  /** Never answered the offer. Cheap to absorb, so barely penalised. */
  missedOffer: 0.5,
} as const;

/** How much each outcome counts toward the average. */
const OUTCOME_WEIGHT = {
  completed: 1,
  expired: 1.5,
  rejected: 1.5,
  upheldRejection: 3,
  missedOffer: 0.4,
} as const;

export interface RatingInputs {
  totalTasksCompleted: number;
  totalTasksOnTime: number;
  totalTasksExpired: number;
  totalProofsRejected: number;
  totalRejectionsUpheldByAdmin: number;
  totalOffersMissed: number;
}

/**
 * Share of finished work that ended well — the plain, unsmoothed number, shown
 * to admin as "success rate" and used as its own routing signal.
 */
export function computeSuccessRate(inputs: RatingInputs): number {
  const finished =
    inputs.totalTasksCompleted +
    inputs.totalTasksExpired +
    inputs.totalProofsRejected +
    inputs.totalRejectionsUpheldByAdmin;
  if (finished === 0) return 0;
  return inputs.totalTasksCompleted / finished;
}

/** Share of completions that landed inside the allowed window. */
export function computeOnTimeRate(inputs: RatingInputs): number {
  if (inputs.totalTasksCompleted === 0) return 0;
  return Math.min(1, inputs.totalTasksOnTime / inputs.totalTasksCompleted);
}

export function computeRating(inputs: RatingInputs): number {
  // A rejection admin upheld is already counted in totalProofsRejected, so the
  // plain-rejection bucket is the remainder — otherwise the worst outcome
  // would be charged twice.
  const upheld = Math.min(inputs.totalRejectionsUpheldByAdmin, inputs.totalProofsRejected);
  const plainRejections = inputs.totalProofsRejected - upheld;

  const buckets: Array<[keyof typeof OUTCOME_QUALITY, number]> = [
    ['completed', inputs.totalTasksCompleted],
    ['expired', inputs.totalTasksExpired],
    ['rejected', plainRejections],
    ['upheldRejection', upheld],
    ['missedOffer', inputs.totalOffersMissed],
  ];

  let weightedQuality = 0;
  let totalWeight = 0;
  for (const [outcome, count] of buckets) {
    if (count <= 0) continue;
    const weight = OUTCOME_WEIGHT[outcome] * count;
    weightedQuality += OUTCOME_QUALITY[outcome] * weight;
    totalWeight += weight;
  }

  // Smooth toward the prior: with no evidence this returns exactly PRIOR_RATING.
  const observedOutOfFive = totalWeight === 0 ? 0 : (weightedQuality / totalWeight) * 5;
  const smoothed =
    (observedOutOfFive * totalWeight + PRIOR_RATING * PRIOR_WEIGHT) / (totalWeight + PRIOR_WEIGHT);

  // Punctuality nudge, worth at most a quarter point either way, and only once
  // there are completions to judge it on.
  const punctuality = inputs.totalTasksCompleted > 0 ? (computeOnTimeRate(inputs) - 0.5) * 0.5 : 0;

  return Math.round(Math.min(5, Math.max(0, smoothed + punctuality)) * 100) / 100;
}

export const BADGE_CODES = ['TOP_RATED', 'ON_TIME', 'RELIABLE', 'FAST_RESPONDER', 'VETERAN', 'NEW'] as const;
export type BadgeCode = (typeof BADGE_CODES)[number];

export interface Badge {
  code: BadgeCode;
  label: string;
  description: string;
}

/**
 * Badges are derived, never stored: they are a reading of the counters, so
 * they can never drift out of step with them. Each one needs enough history
 * behind it to mean something — a single on-time task is not a track record.
 */
export function computeBadges(captain: Pick<
  ICaptain,
  | 'rating'
  | 'totalTasksCompleted'
  | 'totalTasksOnTime'
  | 'totalTasksExpired'
  | 'totalProofsRejected'
  | 'totalRejectionsUpheldByAdmin'
  | 'totalOffersMissed'
  | 'totalOffersAccepted'
  | 'totalAcceptSeconds'
>): Badge[] {
  const badges: Badge[] = [];
  const successRate = computeSuccessRate(captain);
  const onTimeRate = computeOnTimeRate(captain);
  const meanAcceptSeconds =
    captain.totalOffersAccepted > 0 ? captain.totalAcceptSeconds / captain.totalOffersAccepted : null;

  if (captain.totalTasksCompleted < 5) {
    badges.push({ code: 'NEW', label: 'New', description: 'Fewer than 5 completed tasks so far' });
  }
  if (captain.totalTasksCompleted >= 10 && captain.rating >= 4.5) {
    badges.push({ code: 'TOP_RATED', label: 'Top rated', description: 'Rated 4.5 or better across 10+ tasks' });
  }
  if (captain.totalTasksCompleted >= 10 && onTimeRate >= 0.9) {
    badges.push({ code: 'ON_TIME', label: 'On time', description: '9 in 10 tasks finished inside the deadline' });
  }
  if (captain.totalTasksCompleted >= 20 && successRate >= 0.95) {
    badges.push({ code: 'RELIABLE', label: 'Reliable', description: '95%+ success rate across 20+ tasks' });
  }
  if (captain.totalOffersAccepted >= 10 && meanAcceptSeconds !== null && meanAcceptSeconds <= 60) {
    badges.push({ code: 'FAST_RESPONDER', label: 'Fast responder', description: 'Accepts offers in under a minute on average' });
  }
  if (captain.totalTasksCompleted >= 100) {
    badges.push({ code: 'VETERAN', label: 'Veteran', description: '100+ tasks completed' });
  }
  return badges;
}

/**
 * Applies counter deltas and rewrites the rating from the resulting totals in
 * one round trip. Counters are `$inc`-ed rather than read-modify-written so
 * two outcomes landing at once cannot lose one another; the rating is then
 * recomputed from whatever the totals actually became.
 */
export async function recordOutcome(
  captainId: Types.ObjectId,
  deltas: Partial<Record<keyof RatingInputs | 'totalOffersAccepted' | 'totalAcceptSeconds', number>>,
): Promise<void> {
  const inc: Record<string, number> = {};
  for (const [field, value] of Object.entries(deltas)) {
    if (value) inc[field] = value;
  }
  const updated = Object.keys(inc).length
    ? await Captain.findByIdAndUpdate(captainId, { $inc: inc }, { new: true })
    : await Captain.findById(captainId);
  if (!updated) return;

  const rating = computeRating(updated);
  if (rating !== updated.rating) {
    await Captain.updateOne({ _id: captainId }, { $set: { rating } });
  }
}
