import mongoose, { Types, type ClientSession } from 'mongoose';
import { Task, Captain, Party, Customer, nextSequence, type ITask, type ITaskPayoutMethod } from '../models';
import { formatTaskCode, generateTrackingRef, deriveTaskIdentifier } from '../utils/ids';
import { addMinutes } from '../utils/dates';
import { formatPaise } from '../utils/money';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { getConfig } from './systemConfig.service';
import { commissionFor, captainRateFor, repriceCaptainShare } from './commission.service';
import { currentLimitPaise, withinCurrentLimit } from './captainCapacity.service';
import { markOfferAccepted, withdrawOpenOffers, offerToNextCaptain } from './taskRouting.service';
import { clocksFor, clocksOf } from './taskClocks.service';
import { recordOutcome } from './captainRating.service';
import { recordAudit } from './audit.service';
import { assertTransition, isClaimable } from './taskStateMachine';
import * as collateral from './collateral.service';
import { withLock, lockKeys } from './lock.service';
import { supportsTransactions } from '../config/db';
import { istDayBounds, istMonthBounds } from '../utils/dates';
import { CLAIMABLE_STATES, type Role, type TaskState } from '../types';
import { logger } from '../config/logger';

export interface CreateTaskInput {
  partyId: Types.ObjectId;
  createdBy: Types.ObjectId;
  customerName: string;
  /**
   * Bulk import supplies its own destination handle directly, since it has
   * no structured payout method to derive one from. Left unset, it is
   * computed from `payoutMethod`.
   */
  identifier?: string;
  /** Not collected by bulk import — CSV rows have no structured payout method. */
  payoutMethod?: ITaskPayoutMethod;
  amountPaise: number;
  /**
   * Bulk import still lets a party supply their own reference for
   * reconciliation against their source file. Left unset, one is generated —
   * this is the path for the "New task" form, where the reference is purely
   * a system-issued tracking code the party relays to their customer.
   */
  externalRef?: string;
  batchId?: Types.ObjectId | null;
  /**
   * Where this came from. Decides the money rules and whether the proof
   * auto-approves — see Task.ts, which explains why the two differ.
   */
  origin?: 'DASHBOARD' | 'API';
  /** API payouts only: where to tell the party the outcome. */
  callbackUrl?: string | null;
  /** The API key this came in on, so a retried callback returns to it. */
  createdByKeyId?: string | null;
}

export interface ActorContext {
  userId: string;
  role: Role;
  ip?: string;
}

/** Validate an amount against the configured task bounds. */
export async function assertAmountWithinBounds(amountPaise: number): Promise<void> {
  const config = await getConfig();
  if (amountPaise < config.minimumTaskAmountPaise) {
    throw AppError.unprocessable(
      ErrorCodes.AMOUNT_BELOW_MINIMUM,
      `Minimum task amount is ${formatPaise(config.minimumTaskAmountPaise)}`,
      { minimumPaise: config.minimumTaskAmountPaise },
    );
  }
  if (amountPaise > config.maximumTaskAmountPaise) {
    throw AppError.unprocessable(
      ErrorCodes.AMOUNT_ABOVE_MAXIMUM,
      `Maximum task amount is ${formatPaise(config.maximumTaskAmountPaise)}`,
      { maximumPaise: config.maximumTaskAmountPaise },
    );
  }
}

/** Party-side throughput ceilings, evaluated over IST day/month windows. */
export async function assertPartyLimits(partyId: Types.ObjectId, addingPaise: number): Promise<void> {
  const config = await getConfig();
  const party = await Party.findById(partyId).select('dailyLimitPaise monthlyLimitPaise').lean();
  const dailyCap = party?.dailyLimitPaise ?? config.partyDailyLimitPaise;
  const monthlyCap = party?.monthlyLimitPaise ?? config.partyMonthlyLimitPaise;

  const day = istDayBounds();
  const month = istMonthBounds();

  const rows = await Task.aggregate<{ daily: number; monthly: number }>([
    {
      $match: {
        partyId,
        createdAt: { $gte: month.start, $lt: month.end },
        status: { $ne: 'CANCELLED' },
      },
    },
    {
      $facet: {
        daily: [
          { $match: { createdAt: { $gte: day.start, $lt: day.end } } },
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

  const used = rows[0] ?? { daily: 0, monthly: 0 };

  if (used.daily + addingPaise > dailyCap) {
    throw AppError.unprocessable(
      ErrorCodes.PARTY_DAILY_LIMIT_EXCEEDED,
      `This would exceed the daily limit of ${formatPaise(dailyCap)}`,
      { usedPaise: used.daily, limitPaise: dailyCap, requestedPaise: addingPaise },
    );
  }
  if (used.monthly + addingPaise > monthlyCap) {
    throw AppError.unprocessable(
      ErrorCodes.PARTY_MONTHLY_LIMIT_EXCEEDED,
      `This would exceed the monthly limit of ${formatPaise(monthlyCap)}`,
      { usedPaise: used.monthly, limitPaise: monthlyCap, requestedPaise: addingPaise },
    );
  }
}

/**
 * Resolves the fictional beneficiary to a Customer record, creating one on
 * first use of an identifier and reusing it on repeat use — the same
 * identifier always means the same demo customer.
 */
async function resolveCustomer(name: string, identifier: string, session?: ClientSession): Promise<Types.ObjectId> {
  const customer = await Customer.findOneAndUpdate(
    { identifier },
    { $setOnInsert: { name, identifier } },
    { upsert: true, new: true, session },
  );
  return customer._id;
}

/**
 * Atomically debits the party's DMC balance for the full task cost (amount +
 * both commissions), guarded so it can never go negative. This is the actual
 * spending-capacity check — assertPartyLimits above is a separate throughput
 * ceiling, not a balance check.
 */
async function debitPartyDmcBalance(
  partyId: Types.ObjectId,
  totalPaise: number,
  session?: ClientSession,
): Promise<void> {
  const updated = await Party.findOneAndUpdate(
    { _id: partyId, dmcBalancePaise: { $gte: totalPaise } },
    { $inc: { dmcBalancePaise: -totalPaise } },
    session ? { session } : {},
  );
  if (!updated) {
    const party = await Party.findById(partyId).select('dmcBalancePaise').session(session ?? null);
    throw AppError.unprocessable(
      ErrorCodes.INSUFFICIENT_DMC_BALANCE,
      `Not enough DMC balance to create this task (need ${formatPaise(totalPaise)})`,
      { balancePaise: party?.dmcBalancePaise ?? 0, requiredPaise: totalPaise },
    );
  }
}

export async function createTask(input: CreateTaskInput, actor: ActorContext, session?: ClientSession): Promise<ITask> {
  await assertAmountWithinBounds(input.amountPaise);
  await assertPartyLimits(input.partyId, input.amountPaise);

  const party = await Party.findById(input.partyId)
    .select(
      'partyCode payOutPartyCommissionPercentage ' +
        'acceptanceMinutes completionMinutes maxAgeMinutes expiryAckMinutes confirmationMinutes',
    )
    .session(session ?? null);
  if (!party) throw AppError.internal('Party not found for task creation');

  if (!input.identifier && !input.payoutMethod) {
    throw AppError.internal('createTask requires either identifier or payoutMethod');
  }
  const identifier = input.identifier ?? deriveTaskIdentifier(input.payoutMethod!);

  // Both commissions are computed and locked in now, at creation, since the
  // party's balance is debited for the full cost up front — whoever
  // eventually completes the task is credited these exact locked amounts,
  // not a freshly recomputed one.
  const config = await getConfig();
  /**
   * ONE RATE CHARGED, SPLIT INTO TWO RECORDED HALVES.
   *
   * The party is charged a single percentage on top of the amount. That whole
   * charge funds the pool at completion; the captain is paid their share out
   * of it, and what nobody takes is the platform's.
   *
   * It is stored as two halves because a dispute wants to see both — but they
   * are derived from one charge rather than set independently. That is the
   * point of the change: the old pair of unrelated rates could promise a
   * captain more than the party was ever billed, and the difference came from
   * nowhere.
   */
  const split = commissionFor('PAY_OUT', input.amountPaise, config, {
    // This party's own rate where admin has given them one. Their charge is
    // fixed from here: debited below, refunded in full on cancellation.
    party,
    // No captain yet — nobody has claimed this. The default stands in so the
    // pool has a split to record, and the captain who eventually takes it is
    // re-priced at their own rate when they do (see claimTask below). The
    // party's charge does not move when that happens; only its division.
    captain: null,
  });

  // Charged the same whichever door it came through. A payout is a payout, and
  // pricing it differently because a person clicked rather than a server called
  // would be a rule nobody could explain to either of them.
  const captainCommissionPaise = split.captainPaise;
  const adminCommissionPaise = split.platformPaise;
  const totalPaise = input.amountPaise + split.partyPaise;

  await debitPartyDmcBalance(input.partyId, totalPaise, session);

  const year = new Date().getFullYear();
  const sequence = await nextSequence(`task:${year}`);
  const taskCode = formatTaskCode(party.partyCode, year, sequence);
  const customerId = await resolveCustomer(input.customerName, identifier, session);

  /**
   * The deadlines this task will run by, settled here from the party that
   * created it and written onto the row below.
   *
   * Settled now rather than read back later, so nothing can move the clock
   * under work in flight — not a change to the party's windows, and not a
   * change to the settings they fall back on.
   */
  const clocks = clocksFor(config, party);

  const isAutoRef = !input.externalRef;
  let externalRef = input.externalRef ?? generateTrackingRef();

  // The party's balance was debited above, before this point. If the insert
  // below fails for good — a client-supplied reference that already exists,
  // most likely — that money must come back; otherwise the party pays for a
  // task that does not exist. A session rolls this back on its own, so the
  // compensation only applies to the standalone path.
  const refundDebit = async (): Promise<void> => {
    if (session) return;
    await Party.findByIdAndUpdate(input.partyId, { $inc: { dmcBalancePaise: totalPaise } });
  };

  // The (partyId, externalRef) pair is uniquely indexed. A collision on a
  // random 8-character code is astronomically unlikely, but is regenerated
  // and retried rather than left to surface as an opaque 500.
  let task: ITask | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const docs = await Task.create(
        [
          {
            taskCode,
            partyId: input.partyId,
            batchId: input.batchId ?? null,
            customerId,
            customerName: input.customerName,
            identifier,
            payoutMethod: input.payoutMethod ?? null,
            amountPaise: input.amountPaise,
            externalRef,
            status: 'CREATED' as TaskState,
            commissionPaise: captainCommissionPaise,
            adminCommissionPaise,
            // The rates it was priced at, so completion reads them back rather
            // than recomputing from settings that may have changed since.
            partyCommissionPaise: split.partyPaise,
            ...clocks,
            partyCommissionRate: split.partyRate,
            captainCommissionRate: split.captainRate,
            captainCommissionRateAgreed: split.captainRateAgreed,
            origin: input.origin ?? 'DASHBOARD',
            callbackUrl: input.callbackUrl ?? null,
            createdByKeyId: input.createdByKeyId ?? null,
            createdBy: input.createdBy,
            stateHistory: [
              { from: null, to: 'CREATED', actorUserId: input.createdBy, actorRole: actor.role, at: new Date() },
            ],
          },
        ],
        session ? { session } : {},
      );
      task = docs[0];
      break;
    } catch (err) {
      const isDuplicateKey = typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
      if (isDuplicateKey && isAutoRef && attempt < 4) {
        externalRef = generateTrackingRef();
        continue;
      }
      await refundDebit();
      throw err;
    }
  }
  if (!task) {
    await refundDebit();
    throw AppError.internal('Task creation returned no document');
  }


  // The party is billed the platform's cut here, along with the task amount
  // and the captain's commission — that is what reserves the money. But the
  // platform does not *earn* it yet, so nothing is credited to the platform
  // wallet and no ADMIN allocation exists to withdraw against until the task
  // is actually completed (see approveTask in workflow.service.ts).
  //
  // This used to credit at creation, which let admin withdraw commission for
  // a task that was still open. If that task was then cancelled, the party
  // was refunded money admin had already been paid, the platform wallet went
  // negative, and the ledger invented DMC out of nothing. Crediting on
  // completion makes that impossible: COMPLETED is a terminal state with no
  // transition out (see TASK_TRANSITIONS), so a credited task can never be
  // cancelled and there is never anything to reverse.

  await recordAudit({
    action: 'TASK_CREATED',
    targetCollection: 'Task',
    targetId: task._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { status: 'CREATED', amountPaise: task.amountPaise, taskCode },
    metadata: {
      taskCode,
      externalRef,
      captainCommissionPaise,
      adminCommissionPaise,
      totalDebitedPaise: totalPaise,
    },
  });
  // Hand it straight to the best-fit captain rather than broadcasting it. A
  // routing failure must not fail task creation — the party's money has
  // already moved, and the sweeper picks up any task left without an offer.
  try {
    await offerToNextCaptain(task._id);
  } catch (err) {
    logger.error({ err, taskCode }, 'Initial task routing failed; sweeper will retry');
  }

  return task;
}

/** Eligibility gate applied before any write. Frontend visibility is not security. */
async function assertCaptainEligible(captainId: Types.ObjectId, amountPaise: number): Promise<void> {
  const config = await getConfig();
  const captain = await Captain.findById(captainId)
    .select(
      'status isOnline collateralBalancePaise lockedAmountPaise creditLimitPaise ' +
        'dmcBalancePaise commissionEarnedTotalPaise dailyLimitPaise monthlyLimitPaise',
    )
    .lean();

  if (!captain) throw AppError.notFound('Captain profile not found');
  if (captain.status !== 'ACTIVE') {
    throw AppError.forbidden('Your account is suspended and cannot claim tasks');
  }
  if (!captain.isOnline) {
    throw AppError.unprocessable(ErrorCodes.CAPTAIN_OFFLINE, 'Go online before claiming tasks');
  }

  // The same rule the claim's conditional write enforces, asked early so the
  // captain gets a sentence rather than a bare refusal. It is not the
  // authority — the write is — but it must agree with it, or a captain is
  // told one thing and refused for another.
  const limit = currentLimitPaise(captain);
  if (amountPaise > limit) {
    throw collateral.insufficientLimitError(limit, amountPaise);
  }

  const throughput = await collateral.getCaptainThroughput(captainId);
  const dailyCap = captain.dailyLimitPaise ?? config.captainDailyLimitPaise;
  const monthlyCap = captain.monthlyLimitPaise ?? config.captainMonthlyLimitPaise;

  if (throughput.dailyPaise + amountPaise > dailyCap) {
    throw AppError.unprocessable(
      ErrorCodes.CAPTAIN_DAILY_LIMIT_EXCEEDED,
      `This would exceed your daily limit of ${formatPaise(dailyCap)}`,
      { usedPaise: throughput.dailyPaise, limitPaise: dailyCap },
    );
  }
  if (throughput.monthlyPaise + amountPaise > monthlyCap) {
    throw AppError.unprocessable(
      ErrorCodes.CAPTAIN_MONTHLY_LIMIT_EXCEEDED,
      `This would exceed your monthly limit of ${formatPaise(monthlyCap)}`,
      { usedPaise: throughput.monthlyPaise, limitPaise: monthlyCap },
    );
  }
}

/**
 * Atomic task claim: filter-based compare-and-swap.
 *
 * The filter requires the task to still be unclaimed AND in a claimable state.
 * Mongo applies this atomically at the document level, so of N concurrent
 * claims exactly one can match; the rest see modifiedCount 0 and are told
 * TASK_ALREADY_CLAIMED. This — not the Redis lock — is what makes the
 * operation correct.
 */
async function compareAndSwapClaim(
  taskId: Types.ObjectId,
  captainId: Types.ObjectId,
  expiryMinutes: number,
  actor: ActorContext,
  session?: ClientSession,
  /**
   * This captain's share of the charge the party already paid, written in the
   * same conditional update that takes the task. Separating them would leave a
   * window in which the task is theirs but is still priced for whoever the
   * default assumed — and a crash inside that window would leave it there.
   */
  pricing?: { commissionPaise: number; adminCommissionPaise: number; captainCommissionRate: number },
): Promise<ITask | null> {
  const now = new Date();
  return Task.findOneAndUpdate(
    {
      _id: taskId,
      status: { $in: [...CLAIMABLE_STATES] },
      captainId: null,
    },
    {
      $set: {
        status: 'ASSIGNED' as TaskState,
        captainId,
        claimedAt: now,
        expiresAt: addMinutes(now, expiryMinutes),
        // The offer is settled the moment it is taken; the acceptance
        // countdown stops here and the completion one above starts.
        offeredCaptainId: null,
        offeredAt: null,
        offerExpiresAt: null,
        ...(pricing ?? {}),
      },
      $push: {
        stateHistory: {
          from: 'CREATED' as TaskState,
          to: 'ASSIGNED' as TaskState,
          actorUserId: new Types.ObjectId(actor.userId),
          actorRole: actor.role,
          // Written through findOneAndUpdate, which bypasses the save hook
          // that stamps this everywhere else — so it is set explicitly here.
          captainId,
          at: now,
        },
      },
    },
    { new: true, ...(session ? { session } : {}) },
  );
}

export interface ClaimResult {
  task: ITask;
  collateral: collateral.CollateralView;
}


/**
 * Take the hold for a pay-out the captain is about to claim.
 *
 * One rule, in one conditional write: the amount must be within their Current
 * Limit — the ceiling their security backs, and their own capital, whichever
 * binds. Evaluated by the server against the stored document at write time, so
 * two claims arriving together cannot both pass on the same "before" figure.
 *
 * This used to ask two looser questions instead — "do they hold this much DMC"
 * and "is it within the ceiling" — and neither subtracted commission the
 * captain had already earned. That subtraction is the whole difference between
 * the ceiling and Current Limit, so a captain could take work their own
 * dashboard had told them was beyond them. See captainCapacity.service.ts,
 * which now states the rule once for both the screen and this guard.
 *
 * Returns false when it does not fit, which the caller turns into a refusal
 * rather than a half-applied claim.
 */
async function holdForPayout(captainId: Types.ObjectId, amountPaise: number, session?: mongoose.ClientSession): Promise<boolean> {
  const held = await Captain.findOneAndUpdate(
    {
      _id: captainId,
      status: 'ACTIVE',
      ...withinCurrentLimit(amountPaise),
    },
    { $inc: { dmcBalancePaise: -amountPaise } },
    session ? { session } : {},
  );
  return held != null;
}

/**
 * Give a hold back, for a pay-out that ends without the money being sent.
 *
 * Cancelled, expired, reassigned — whatever the route, the captain never sent
 * anything, so the DMC they committed is theirs again. Completion does not go
 * through here: it returns the hold *and* the reimbursement together, which is
 * a different sum and lives with the rest of the completion payment.
 */
export async function releasePayoutHold(
  captainId: Types.ObjectId,
  amountPaise: number,
  session?: mongoose.ClientSession,
): Promise<void> {
  if (amountPaise <= 0) return;
  await Captain.updateOne(
    { _id: captainId },
    { $inc: { dmcBalancePaise: amountPaise } },
    session ? { session } : {},
  );
}

async function assertFitsTaskLimit(captainId: Types.ObjectId, amountPaise: number): Promise<void> {
  const view = await collateral.getCollateral(captainId);
  const ceiling = view.creditLimitPaise ?? view.collateralBalancePaise;
  if (amountPaise > ceiling) {
    throw collateral.insufficientLimitError(ceiling, amountPaise);
  }
}

/**
 * CLAIM A TASK — the contended path.
 *
 * Three layers of protection, outermost to innermost:
 *   1. Redis lock  — cheap serialisation, avoids wasted database work.
 *   2. Transaction — when a replica set is available, collateral lock and task
 *                    assignment commit or roll back together.
 *   3. Atomic CAS  — the actual correctness guarantee, and the fallback when
 *                    transactions are unavailable, with explicit compensation.
 *
 * Guarantees: no duplicate assignment, no duplicate lock, no negative balance,
 * no inconsistent task state.
 */
export async function claimTask(
  taskIdRaw: string,
  captainId: Types.ObjectId,
  actor: ActorContext,
): Promise<ClaimResult> {
  if (!Types.ObjectId.isValid(taskIdRaw)) {
    throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  }
  const taskId = new Types.ObjectId(taskIdRaw);

  return withLock(lockKeys.task(taskIdRaw), 5000, async () => {
    const task = await Task.findById(taskId).lean();
    if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

    // Fail fast with a precise message before doing any write.
    if (task.captainId) {
      throw AppError.conflict(ErrorCodes.TASK_ALREADY_CLAIMED, 'This task has already been claimed');
    }
    if (!isClaimable(task.status)) {
      throw AppError.conflict(
        ErrorCodes.TASK_NOT_CLAIMABLE,
        `A task in state ${task.status} cannot be claimed`,
        { status: task.status },
      );
    }

    // A task is offered to one captain at a time (see taskRouting.service.ts),
    // and that offer has a deadline. Both halves are enforced here.
    //
    // The deadline especially: the sweeper that retires a lapsed offer only
    // runs once a minute, so checking only *who* holds the offer would leave
    // an expired one claimable for up to a minute after the captain's own
    // countdown had visibly reached zero.
    const openToEveryone = Boolean(task.openPoolAt);
    const offerIsMine =
      task.offeredCaptainId != null && String(task.offeredCaptainId) === String(captainId);
    const offerStillOpen =
      task.offerExpiresAt != null && task.offerExpiresAt.getTime() > Date.now();

    // Being rejected off a task excludes a captain from it permanently. The
    // queue already hides it from them, but that is a filter on a list, not a
    // rule: once the task falls into the open pool, `openToEveryone` alone
    // would let them take it straight back — from a stale card, a
    // notification, or the API. The exclusion has to be enforced where the
    // claim actually happens.
    if ((task.previousCaptainIds ?? []).some((id) => String(id) === String(captainId))) {
      throw AppError.conflict(
        ErrorCodes.TASK_NOT_CLAIMABLE,
        'This task was rejected while you held it, so it cannot be claimed by you again',
      );
    }

    if (!openToEveryone && !(offerIsMine && offerStillOpen)) {
      const reason = offerIsMine
        ? 'Your window to accept this task has passed'
        : task.offeredCaptainId == null
          ? 'This task has not been offered to you'
          : 'This task is currently offered to another captain';
      throw AppError.conflict(ErrorCodes.TASK_NOT_CLAIMABLE, reason);
    }

    await assertCaptainEligible(captainId, task.amountPaise);


    /**
     * Price this captain's half of a charge the party has already paid.
     *
     * The pool is what the party was billed at creation, read back off the row
     * rather than recomputed: their charge is settled and must not move, or a
     * cancellation would refund a different number than it collected. What
     * moves is the division of it — this captain's own rate decides their
     * share, and the remainder stays the platform's.
     */
    const [config, captain] = await Promise.all([
      getConfig(),
      Captain.findById(captainId).select('payOutCaptainCommissionPercentage').lean(),
    ]);

    // The task's own deadline, set from its party when it was created. It is
    // not the captain's to vary: the party made a promise to a customer on
    // this window, and whoever picks the work up is held to that promise.
    const { completionMinutes } = clocksOf(task, config);
    const poolPaise = (task.commissionPaise ?? 0) + (task.adminCommissionPaise ?? 0);
    const priced = repriceCaptainShare(
      poolPaise,
      task.amountPaise,
      // Their own rate first; failing that, the default this task was priced
      // under at creation. The agreed rate, not the paid one: a row that was
      // capped last time must not have the cap read back as the agreement.
      captainRateFor('PAY_OUT', config, captain, task.captainCommissionRateAgreed),
      task.partyCommissionRate ?? 0,
    );
    const pricing = {
      commissionPaise: priced.captainPaise,
      adminCommissionPaise: priced.platformPaise,
      captainCommissionRate: priced.captainRate,
      captainCommissionRateAgreed: priced.captainRateAgreed,
    };

    const useTransaction = await supportsTransactions();
    let claimed: ITask | null = null;

    if (useTransaction) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const held = await holdForPayout(captainId, task.amountPaise, session);
          if (!held) {
            await assertFitsTaskLimit(captainId, task.amountPaise);
            throw collateral.insufficientLimitError(
              (await collateral.getCollateral(captainId)).availableLimitPaise,
              task.amountPaise,
            );
          }
          claimed = await compareAndSwapClaim(taskId, captainId, completionMinutes, actor, session, pricing);
          if (!claimed) {
            // Aborts the transaction, which also rolls back the hold.
            throw AppError.conflict(ErrorCodes.TASK_ALREADY_CLAIMED, 'This task has already been claimed');
          }
        });
      } finally {
        await session.endSession();
      }
    } else {
      // Hold first, then claim, and give the hold back if the claim loses the
      // race — the same compensating shape the collateral lock used to have.
      const held = await holdForPayout(captainId, task.amountPaise);
      if (!held) {
        await assertFitsTaskLimit(captainId, task.amountPaise);
        throw collateral.insufficientLimitError(
          (await collateral.getCollateral(captainId)).availableLimitPaise,
          task.amountPaise,
        );
      }

      try {
        claimed = await compareAndSwapClaim(taskId, captainId, completionMinutes, actor, undefined, pricing);
      } catch (err) {
        await releasePayoutHold(captainId, task.amountPaise);
        throw err;
      }

      if (!claimed) {
        await releasePayoutHold(captainId, task.amountPaise);
        await recordAudit({
          action: 'TASK_CLAIM_REJECTED',
          targetCollection: 'Task',
          targetId: taskId,
          userId: actor.userId,
          role: actor.role,
          ip: actor.ip,
          metadata: { reason: 'ALREADY_CLAIMED', taskCode: task.taskCode },
        });
        throw AppError.conflict(ErrorCodes.TASK_ALREADY_CLAIMED, 'This task has already been claimed');
      }
    }

    const claimedTask = claimed as ITask | null;
    if (!claimedTask) throw AppError.conflict(ErrorCodes.TASK_ALREADY_CLAIMED, 'This task has already been claimed');

    // Close out the routing side: bank how fast this captain answered (it
    // feeds their responsiveness score) and retire any other live offer.
    const responseSeconds = await markOfferAccepted(taskId, captainId);
    if (responseSeconds !== null) {
      await recordOutcome(captainId, { totalOffersAccepted: 1, totalAcceptSeconds: responseSeconds });
    }
    await withdrawOpenOffers(taskId, captainId);

    await recordAudit({
      action: 'TASK_CLAIMED',
      targetCollection: 'Task',
      targetId: taskId,
      userId: actor.userId,
      role: actor.role,
      ip: actor.ip,
      oldState: { status: task.status, captainId: null },
      newState: { status: 'ASSIGNED', captainId: String(captainId) },
      metadata: { taskCode: task.taskCode, amountPaise: task.amountPaise },
    });
    await recordAudit({
      action: 'COLLATERAL_LOCKED',
      targetCollection: 'Captain',
      targetId: captainId,
      userId: actor.userId,
      role: actor.role,
      metadata: { taskId: String(taskId), amountPaise: task.amountPaise },
    });

    const view = await collateral.getCollateral(captainId);
    logger.info(
      { taskCode: claimedTask.taskCode, captainId: String(captainId) },
      'Task claimed',
    );

    return { task: claimedTask, collateral: view };
  });
}

/**
 * Generic guarded transition. Every state change outside the claim path goes
 * through here so the transition table and the audit log stay authoritative.
 */
export async function transitionTask(
  taskId: Types.ObjectId,
  to: TaskState,
  actor: ActorContext,
  options: { reason?: string; extra?: Record<string, unknown>; session?: ClientSession } = {},
): Promise<ITask> {
  const task = await Task.findById(taskId);
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  const from = task.status;
  assertTransition(from, to);

  task.status = to;
  task.stateHistory.push({
    from,
    to,
    actorUserId: new Types.ObjectId(actor.userId),
    actorRole: actor.role,
    reason: options.reason,
    at: new Date(),
  });
  Object.assign(task, options.extra ?? {});
  await task.save(options.session ? { session: options.session } : {});

  return task;
}
