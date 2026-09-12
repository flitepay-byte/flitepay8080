import { Types } from 'mongoose';
import { Task, Captain, TaskOffer, type ITask, type ICaptain } from '../models';
import { getConfig } from './systemConfig.service';
import { clocksOf } from './taskClocks.service';
import { computeSuccessRate } from './captainRating.service';
import { currentLimitPaise } from './captainCapacity.service';
import { notifyTaskOffered, notifyTaskOpenedToPool, notifyRoutingStalled } from './notification.service';
import { addMinutes } from '../utils/dates';
import { logger } from '../config/logger';
import { CLAIMABLE_STATES } from '../types';

/**
 * TASK ROUTING — WHO GETS OFFERED WHAT
 * ====================================
 * A task is not broadcast to every captain. It is offered to exactly one
 * captain at a time — the best fit still eligible — who has their acceptance
 * window to take it. If they let it lapse, the offer passes to the next best,
 * and so on. Once everyone eligible has had a turn the task falls back to the
 * open pool, where any eligible captain may claim it, until the global
 * max-age deadline expires it outright (see taskExpiry.job.ts).
 *
 * "Best fit" is deliberately more than just rating. A five-star captain who is
 * already sitting on four unfinished tasks is a worse choice than a four-star
 * captain with none: the point is the task actually getting done, not
 * rewarding a leaderboard. So the score blends how well a captain performs
 * with how much room they have to take the work on right now.
 */

/** Weights sum to 1. Rating and success rate dominate; the rest break ties sensibly. */
const WEIGHTS = {
  /** Overall dependability, as summarised by the stored rating. */
  rating: 0.35,
  /** Share of finished work that ended well — a sharper signal than rating alone. */
  successRate: 0.25,
  /** How much unfinished work they are already carrying. */
  availability: 0.25,
  /** How quickly they answer offers — a fast captain keeps the task moving. */
  responsiveness: 0.1,
  /** Collateral headroom beyond this task, so we do not park a captain at their ceiling. */
  headroom: 0.05,
} as const;

/** Workload at which a captain scores zero on availability. */
const SATURATION_TASKS = 5;
/** Response time at which a captain scores zero on responsiveness. */
const SLOW_RESPONSE_SECONDS = 300;

export interface CaptainWorkload {
  /** Claimed but not yet started. */
  pending: number;
  /** Started, proof not yet submitted. */
  inProgress: number;
  /** Submitted, waiting on the party's audit — still the captain's open work. */
  awaitingAudit: number;
}

export interface ScoredCaptain {
  captain: ICaptain;
  score: number;
  workload: CaptainWorkload;
}

/** Open work per captain, in one aggregation rather than a query per captain. */
export async function getWorkloads(captainIds: Types.ObjectId[]): Promise<Map<string, CaptainWorkload>> {
  const rows = await Task.aggregate<{ _id: { captainId: Types.ObjectId; status: string }; count: number }>([
    { $match: { captainId: { $in: captainIds }, status: { $in: ['ASSIGNED', 'IN_PROGRESS', 'AUDIT_PENDING'] } } },
    { $group: { _id: { captainId: '$captainId', status: '$status' }, count: { $sum: 1 } } },
  ]);

  const map = new Map<string, CaptainWorkload>();
  for (const id of captainIds) map.set(String(id), { pending: 0, inProgress: 0, awaitingAudit: 0 });

  for (const row of rows) {
    const entry = map.get(String(row._id.captainId));
    if (!entry) continue;
    if (row._id.status === 'ASSIGNED') entry.pending = row.count;
    else if (row._id.status === 'IN_PROGRESS') entry.inProgress = row.count;
    else entry.awaitingAudit = row.count;
  }
  return map;
}

/**
 * 0..1 fit for this captain taking this task right now. Every input is
 * normalised to 0..1 first so the weights above are directly comparable.
 */
export function scoreCaptain(captain: ICaptain, amountPaise: number, workload: CaptainWorkload): number {
  const rating = Math.min(1, Math.max(0, captain.rating / 5));

  // A captain with no completions has no success rate to speak of; scoring
  // them 0 would freeze new captains out permanently, so they inherit their
  // (prior-smoothed) rating as a stand-in until they have a record.
  const finished =
    captain.totalTasksCompleted + captain.totalTasksExpired + captain.totalProofsRejected;
  const successRate = finished === 0 ? rating : computeSuccessRate(captain);

  const openWork = workload.pending + workload.inProgress + workload.awaitingAudit;
  const availability = Math.max(0, 1 - openWork / SATURATION_TASKS);

  const meanAccept =
    captain.totalOffersAccepted > 0 ? captain.totalAcceptSeconds / captain.totalOffersAccepted : null;
  // Unproven captains sit mid-scale rather than at either extreme.
  const responsiveness = meanAccept === null ? 0.5 : Math.max(0, 1 - meanAccept / SLOW_RESPONSE_SECONDS);

  // Room left over after this task, measured the same way eligibility measures
  // it. Only ranking — an ineligible captain never reaches here — but a second
  // formula for one idea is how the first two came apart.
  const available = currentLimitPaise(captain);
  const headroom = amountPaise > 0 ? Math.min(1, Math.max(0, (available - amountPaise) / amountPaise)) : 1;

  const score =
    rating * WEIGHTS.rating +
    successRate * WEIGHTS.successRate +
    availability * WEIGHTS.availability +
    responsiveness * WEIGHTS.responsiveness +
    headroom * WEIGHTS.headroom;

  return Math.round(score * 10000) / 10000;
}

export interface RoutingCandidates {
  /** Eligible captains who have not yet had a turn on this task, best fit first. */
  ranked: ScoredCaptain[];
  /**
   * How many captains could take this task at all, counting those who have
   * already had a turn. Zero means nobody can do it right now for reasons that
   * may pass — everyone offline, or short on collateral — which is a very
   * different situation from having tried everybody. See offerToNextCaptain.
   */
  eligibleCount: number;
  /**
   * How many ACTIVE captains have not been permanently rejected off this task,
   * whether or not they are online or funded. Zero means the task can never be
   * placed again — every captain in the system has had it and been rejected —
   * which no amount of waiting will fix.
   */
  placeableCount: number;
  /**
   * Exactly who may take this task right now — online, funded, and not
   * permanently excluded from it. The open-pool announcement goes to these
   * captains individually rather than to every connected captain, so nobody is
   * alerted to work they are barred from.
   */
  eligibleCaptainIds: string[];
}
/**
 * Every captain who could legitimately take this task, best fit first.
 *
 * Excludes anyone offline, suspended, short on collateral, already offered
 * this task, or previously rejected off it. Throughput limits are checked at
 * claim time by task.service.ts rather than here: they need a per-captain
 * aggregation each, and routing only proposes — the claim is what enforces.
 */
export async function rankEligibleCaptains(task: ITask): Promise<RoutingCandidates> {
  // Being rejected off a task is permanent; having had a turn is not the same
  // thing, so the two exclusions are kept apart — the second is what tells us
  // whether routing is genuinely exhausted or merely waiting for someone.
  const rejectedOff = task.previousCaptainIds ?? [];
  const alreadyOffered = new Set((task.offeredCaptainIds ?? []).map(String));

  const candidates = await Captain.find({
    status: 'ACTIVE',
    isOnline: true,
    _id: { $nin: rejectedOff },
  });

  // Everyone who could *ever* take this task, ignoring whether they happen to
  // be online or funded right now. When this is zero the task can never be
  // placed again, however long it waits — which is a different situation from
  // "nobody is available at this moment", and the only one worth telling
  // admin about.
  const placeableCount = await Captain.countDocuments({
    status: 'ACTIVE',
    _id: { $nin: rejectedOff },
  });

  const affordable = candidates.filter(
    /**
     * Current Limit, the same figure the claim guard enforces and the same
     * one the captain is shown — see captainCapacity.service.ts.
     *
     * This used to ask for collateral headroom instead, which is the ceiling
     * and nothing else. A captain holding nothing but earned commission has a
     * full ceiling and no capacity, so they were offered work they could not
     * take: the queue advertised a payout the claim then refused. Three places
     * asked this question and only one of them had been brought to the shared
     * rule; this is the second.
     */
    (c) => task.amountPaise <= currentLimitPaise(c),
  );
  const untried = affordable.filter((c) => !alreadyOffered.has(String(c._id)));
  const eligibleCaptainIds = affordable.map((c) => String(c._id));
  if (untried.length === 0) return { ranked: [], eligibleCount: affordable.length, placeableCount, eligibleCaptainIds };

  const workloads = await getWorkloads(untried.map((c) => c._id));

  const ranked = untried
    .map((captain) => {
      const workload = workloads.get(String(captain._id)) ?? { pending: 0, inProgress: 0, awaitingAudit: 0 };
      return { captain, workload, score: scoreCaptain(captain, task.amountPaise, workload) };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Genuinely equal captains — two new ones, say — must not resolve to
      // whichever registered first, or that account wins every tie forever.
      // Longest since their last offer goes first, which rotates the work.
      const aLast = a.captain.lastOfferedAt?.getTime() ?? 0;
      const bLast = b.captain.lastOfferedAt?.getTime() ?? 0;
      return aLast - bLast;
    });

  return { ranked, eligibleCount: affordable.length, placeableCount, eligibleCaptainIds };
}

export interface OfferResult {
  /** The captain the task is now offered to, or null if nobody was eligible. */
  captainId: Types.ObjectId | null;
  offerExpiresAt: Date | null;
  /** True when routing ran out of captains and the task fell back to the open pool. */
  openedToPool: boolean;
}

/**
 * How long the captain this task is offered to has to answer.
 *
 * The task's window, from the party that created it — not the captain's. A
 * captain used to be able to carry their own, which meant the same task
 * offered to two captains had two different countdowns and the party's promise
 * to their customer depended on who it happened to reach.
 */
export async function acceptanceMinutesFor(task: ITask): Promise<number> {
  const config = await getConfig();
  return clocksOf(task, config).acceptanceMinutes;
}

/**
 * Hands the task to the next-best eligible captain, or opens it to the pool if
 * there is nobody left to try.
 *
 * The write is a compare-and-swap on the task still being unclaimed and still
 * offered to whoever we last saw, so two sweeps racing cannot both hand the
 * same task out.
 */
/**
 * Records that a task has run out of captains for good.
 *
 * Written once and only once: the guard on routingStalledAt means the sweeper,
 * which retries this task on every pass, cannot re-stamp the timestamp or
 * re-announce it. Admin should see "stuck since 09:14", not a notification
 * every thirty seconds.
 */
async function markRoutingStalled(task: ITask): Promise<void> {
  const marked = await Task.findOneAndUpdate(
    { _id: task._id, routingStalledAt: null },
    { $set: { routingStalledAt: new Date() } },
    { new: true },
  );
  if (!marked) return;

  notifyRoutingStalled(marked);
  logger.warn(
    { taskCode: marked.taskCode, rejectedOff: (marked.previousCaptainIds ?? []).length },
    'Task has no captain left who has not been rejected off it; raised to admin',
  );
}

/** Clears the mark as soon as the task can be routed again. */
async function clearRoutingStalled(taskId: Types.ObjectId): Promise<void> {
  await Task.updateOne({ _id: taskId, routingStalledAt: { $ne: null } }, { $set: { routingStalledAt: null } });
}

export async function offerToNextCaptain(taskId: Types.ObjectId): Promise<OfferResult> {
  const task = await Task.findById(taskId);
  if (!task) return { captainId: null, offerExpiresAt: null, openedToPool: false };
  if (task.captainId || !CLAIMABLE_STATES.includes(task.status)) {
    return { captainId: null, offerExpiresAt: null, openedToPool: false };
  }

  // Already open to everyone: leave it that way. Pulling a task back into an
  // exclusive offer because one new captain appeared would mean captains who
  // can currently see it suddenly cannot, which is worse than letting it race.
  if (task.openPoolAt) return { captainId: null, offerExpiresAt: null, openedToPool: true };

  const { ranked, eligibleCount, placeableCount, eligibleCaptainIds } = await rankEligibleCaptains(task);
  const best = ranked[0];

  if (!best) {
    // Nobody untried left — but that has three very different causes, and only
    // one of them means routing is actually finished.
    if (eligibleCount === 0) {
      if (placeableCount === 0) {
        // Dead end: every captain in the system has held this task and been
        // rejected off it, so no amount of waiting will produce another. The
        // sweeper will keep retrying and keep failing, silently, while the
        // party's DMC stays committed — so mark it and let it surface in
        // admin's review queue instead of stalling unnoticed.
        //
        // The task is NOT closed. It stays claimable, and the mark is cleared
        // the moment a captain becomes available (a new one is onboarded, or
        // an existing one is un-excluded), at which point routing resumes on
        // its own.
        await markRoutingStalled(task);
        return { captainId: null, offerExpiresAt: null, openedToPool: false };
      }

      // A drought: captains exist who could take this, but right now they are
      // all offline or short on collateral. That passes. Leave the task
      // unrouted so the sweeper can offer it properly once someone becomes
      // available — throwing it open to a pool that is empty anyway would only
      // void the exclusivity for whoever eventually turns up.
      await clearRoutingStalled(task._id);
      return { captainId: null, offerExpiresAt: null, openedToPool: false };
    }

    // Genuine exhaustion: everyone who could take this has had their turn.
    const opened = await Task.findOneAndUpdate(
      { _id: taskId, captainId: null, status: { $in: [...CLAIMABLE_STATES] }, openPoolAt: null },
      { $set: { offeredCaptainId: null, offeredAt: null, offerExpiresAt: null, openPoolAt: new Date() } },
      { new: true },
    );
    // The guard on openPoolAt above means this only matches once, so the
    // announcement cannot repeat on later sweeps.
    if (opened) {
      notifyTaskOpenedToPool(opened, opened.commissionPaise ?? 0, eligibleCaptainIds);
      logger.info({ taskCode: opened.taskCode }, 'Task routing exhausted; opened to all eligible captains');
    }
    return { captainId: null, offerExpiresAt: null, openedToPool: Boolean(opened) };
  }

  const now = new Date();
  const expiresAt = addMinutes(now, await acceptanceMinutesFor(task));
  const previousOfferee = task.offeredCaptainId ?? null;

  const updated = await Task.findOneAndUpdate(
    {
      _id: taskId,
      captainId: null,
      status: { $in: [...CLAIMABLE_STATES] },
      offeredCaptainId: previousOfferee,
    },
    {
      $set: { offeredCaptainId: best.captain._id, offeredAt: now, offerExpiresAt: expiresAt },
      $addToSet: { offeredCaptainIds: best.captain._id },
    },
    { new: true },
  );
  // Lost the race to another sweep — leave their offer alone.
  if (!updated) return { captainId: null, offerExpiresAt: null, openedToPool: false };
  // It routed, so it is no longer stuck.
  await clearRoutingStalled(taskId);

  const sequence = (updated.offeredCaptainIds ?? []).length;
  await TaskOffer.create({
    taskId,
    captainId: best.captain._id,
    status: 'OFFERED',
    score: best.score,
    sequence,
    offeredAt: now,
    expiresAt,
  });

  // Stamps the captain's turn in the rotation, so the next tie between equally
  // scored captains goes to whoever has been waiting longer.
  await Captain.updateOne({ _id: best.captain._id }, { $set: { lastOfferedAt: now } });

  notifyTaskOffered(updated, String(best.captain._id), updated.commissionPaise ?? 0, expiresAt);

  logger.info(
    { taskCode: updated.taskCode, captainCode: best.captain.captainCode, score: best.score, sequence },
    'Task offered to captain',
  );

  return { captainId: best.captain._id, offerExpiresAt: expiresAt, openedToPool: false };
}

/**
 * Marks the offer a captain just accepted, and returns how long they took —
 * the input to their responsiveness score.
 */
export async function markOfferAccepted(taskId: Types.ObjectId, captainId: Types.ObjectId): Promise<number | null> {
  const now = new Date();
  const offer = await TaskOffer.findOneAndUpdate(
    { taskId, captainId, status: 'OFFERED' },
    { $set: { status: 'ACCEPTED', respondedAt: now } },
    { new: true },
  );
  if (!offer) return null;

  const seconds = Math.max(0, Math.round((now.getTime() - offer.offeredAt.getTime()) / 1000));
  await TaskOffer.updateOne({ _id: offer._id }, { $set: { responseSeconds: seconds } });
  return seconds;
}

/** Clears any live offer once a task leaves the claimable states (claimed, cancelled, expired). */
export async function withdrawOpenOffers(taskId: Types.ObjectId, exceptCaptainId?: Types.ObjectId): Promise<void> {
  const filter: Record<string, unknown> = { taskId, status: 'OFFERED' };
  if (exceptCaptainId) filter['captainId'] = { $ne: exceptCaptainId };
  await TaskOffer.updateMany(filter, { $set: { status: 'WITHDRAWN', respondedAt: new Date() } });
}

export interface SweepResult {
  /** Offers that lapsed unanswered and were passed on. */
  lapsed: number;
  /** Unclaimed tasks that had no live offer and were given one (or opened to the pool). */
  routed: number;
}

/**
 * Moves routing forward: retires offers whose window has passed, and finds a
 * captain for any unclaimed task currently sitting without one.
 *
 * Runs on an interval rather than a timer per offer, for the same reason the
 * expiry sweep does — a restart must not be able to strand a task with a dead
 * offer nobody will ever advance.
 */
export async function sweepOffers(): Promise<SweepResult> {
  const now = new Date();
  let lapsed = 0;
  let routed = 0;

  // 1. Offers nobody answered in time.
  const expiredOffers = await Task.find({
    status: { $in: [...CLAIMABLE_STATES] },
    captainId: null,
    offeredCaptainId: { $ne: null },
    offerExpiresAt: { $lte: now },
  })
    .select('_id offeredCaptainId taskCode')
    .limit(200);

  for (const task of expiredOffers) {
    const missedBy = task.offeredCaptainId;
    try {
      const released = await Task.findOneAndUpdate(
        { _id: task._id, offeredCaptainId: missedBy, captainId: null },
        { $set: { offeredCaptainId: null, offeredAt: null, offerExpiresAt: null } },
      );
      // Someone else already advanced this one.
      if (!released) continue;

      if (missedBy) {
        await TaskOffer.updateMany(
          { taskId: task._id, captainId: missedBy, status: 'OFFERED' },
          { $set: { status: 'MISSED', respondedAt: now } },
        );
        // Deliberately imported lazily: captainRating imports nothing from
        // here, and this keeps the two services free of a require cycle.
        const { recordOutcome } = await import('./captainRating.service');
        await recordOutcome(missedBy, { totalOffersMissed: 1 });
      }

      await offerToNextCaptain(task._id);
      lapsed += 1;
    } catch (err) {
      logger.error({ err, taskId: String(task._id) }, 'Failed to advance a lapsed task offer');
    }
  }

  // 2. Unclaimed tasks with no live offer — newly created ones whose initial
  //    routing failed, and any that became eligible since (a captain came
  //    online, freed up collateral, or finished other work).
  const unrouted = await Task.find({
    status: { $in: [...CLAIMABLE_STATES] },
    captainId: null,
    offeredCaptainId: null,
  })
    .select('_id openPoolAt')
    .sort({ createdAt: 1 })
    .limit(200);

  for (const task of unrouted) {
    try {
      const result = await offerToNextCaptain(task._id);
      if (result.captainId) routed += 1;
    } catch (err) {
      logger.error({ err, taskId: String(task._id) }, 'Failed to route an unoffered task');
    }
  }

  return { lapsed, routed };
}

/**
 * Puts a task back into routing from scratch — used when it returns to the
 * pool after a rejection or a disputed cancellation. Everyone who has already
 * been offered it stays excluded, so it works its way outward rather than
 * looping back to the same captain.
 */
export async function resetRoutingForReassignment(taskId: Types.ObjectId): Promise<void> {
  await Task.updateOne(
    { _id: taskId },
    { $set: { offeredCaptainId: null, offeredAt: null, offerExpiresAt: null } },
  );
  await withdrawOpenOffers(taskId);
  await offerToNextCaptain(taskId);
}
