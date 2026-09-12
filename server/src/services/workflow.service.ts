import mongoose, { Types } from 'mongoose';
import { Task, Proof, supersedeProofFor, Captain, Party, ApiKey, type ITask } from '../models';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { assertTransition } from './taskStateMachine';
import { getConfig } from './systemConfig.service';
import { clocksOf } from './taskClocks.service';
import { notifyConfirmationRequired } from './notification.service';
import { autoApproveOnTimeout } from './customerConfirmation.service';
import { recordAudit } from './audit.service';
import { creditCommission } from './commission.service';
import { collectIntoPool, PLATFORM_OWNER_ID } from './platformAccount.service';
import { payCommissionToCaptain } from './captainBalance.service';
import { deliverPayoutCallback } from './callback.service';
import { createAllocation } from './dmcAllocation.service';
import { recordOutcome } from './captainRating.service';
import { resetRoutingForReassignment, withdrawOpenOffers } from './taskRouting.service';
import { supportsTransactions } from '../config/db';
import { logger } from '../config/logger';
import { releasePayoutHold } from './task.service';
import type { ActorContext } from './task.service';
import type { TaskState } from '../types';
import type { RejectionCategory } from '../utils/rejectionCategories';

/** Load a task and assert the captain owns it. */
/**
 * Claim a task's state transition atomically, before anything is written for it.
 *
 * Every money-moving workflow here used to change the document in memory and
 * `save()` it, relying on the status having been read a moment earlier. That
 * did hold, but only as a side effect: these saves also push to `stateHistory`,
 * which makes Mongoose include the version key in the update, so a losing
 * writer failed with a VersionError. Correctness rested on an array happening
 * to be modified — change the shape of one of these writes and the guard
 * silently disappears, with a double refund on the other side of it.
 *
 * A compare-and-swap on the status says the same thing on purpose. The filter
 * is the precondition, so a loser matches nothing, moves no money, and returns
 * null for the caller to handle — a sweep skips it, a user action reports a
 * conflict. It is also the ordering the rest of this codebase already uses:
 * claim the transition first, then move the money.
 */
interface HistoryEntry {
  from: TaskState;
  to: TaskState;
  actorUserId?: Types.ObjectId;
  actorRole?: ActorContext['role'] | 'SYSTEM';
  reason?: string;
  captainId?: Types.ObjectId | null;
  at: Date;
}

async function claimTransition(
  taskId: Types.ObjectId,
  precondition: Record<string, unknown>,
  set: Record<string, unknown>,
  history: HistoryEntry[],
  options: {
    inc?: Record<string, number>;
    pushCaptainId?: Types.ObjectId | null;
    session?: mongoose.ClientSession;
  } = {},
): Promise<ITask | null> {
  const push: Record<string, unknown> = { stateHistory: { $each: history } };
  if (options.pushCaptainId) push['previousCaptainIds'] = options.pushCaptainId;

  const update: Record<string, unknown> = { $set: set, $push: push };
  if (options.inc) update['$inc'] = options.inc;

  return Task.findOneAndUpdate(
    { _id: taskId, ...precondition },
    update,
    { new: true, ...(options.session ? { session: options.session } : {}) },
  );
}

/** The task moved under us: someone else decided it first. */
function alreadyDecided(what: string): AppError {
  return AppError.conflict(
    ErrorCodes.INVALID_STATE_TRANSITION,
    `This task is no longer ${what} — someone else has already acted on it`,
  );
}

async function loadOwnedTask(taskId: string, captainId: Types.ObjectId): Promise<ITask> {
  if (!Types.ObjectId.isValid(taskId)) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  const task = await Task.findById(taskId);
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  if (!task.captainId || String(task.captainId) !== String(captainId)) {
    throw AppError.forbidden('This task is not assigned to you');
  }
  return task;
}

/** ASSIGNED -> IN_PROGRESS. */
export async function startTask(taskId: string, captainId: Types.ObjectId, actor: ActorContext): Promise<ITask> {
  const task = await loadOwnedTask(taskId, captainId);
  assertTransition(task.status, 'IN_PROGRESS');

  // No money moves here, but the transition is claimed the same way as the
  // rest so that every step of a task's life is guarded by the same visible
  // rule rather than some of them being guarded by accident.
  const started = await claimTransition(
    task._id,
    { status: 'ASSIGNED', captainId },
    { status: 'IN_PROGRESS', startedAt: new Date() },
    [
      {
        from: 'ASSIGNED',
        to: 'IN_PROGRESS',
        actorUserId: new Types.ObjectId(actor.userId),
        actorRole: actor.role,
        at: new Date(),
      },
    ],
  );
  if (!started) throw alreadyDecided('yours and waiting to be started');

  await recordAudit({
    action: 'TASK_STARTED',
    targetCollection: 'Task',
    targetId: started._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    oldState: { status: 'ASSIGNED' },
    newState: { status: 'IN_PROGRESS' },
    metadata: { taskCode: task.taskCode },
  });
  return task;
}

export interface SubmitProofInput {
  taskId: string;
  captainId: Types.ObjectId;
  /**
   * The transaction reference for the payment the captain made — a UTR, a UPI
   * reference, whatever their bank gave them. The money moves outside this
   * system, so this is the captain's report of it, not something the system
   * issued. Reconciliation against the bank statement is what checks it.
   */
  providerReference: string;
  notes?: string;
  receipt?: { originalName: string; url: string; publicId: string; mimeType: string; sizeBytes: number };
}

/**
 * IN_PROGRESS -> PROOF_SUBMITTED -> AUDIT_PENDING.
 *
 * The two transitions are applied together because AUDIT_PENDING is entered
 * automatically the moment proof lands; there is no state in which proof
 * exists but no audit is queued.
 */
export async function submitProof(input: SubmitProofInput, actor: ActorContext): Promise<ITask> {
  const task = await loadOwnedTask(input.taskId, input.captainId);

  assertTransition(task.status, 'PROOF_SUBMITTED');

  // Only a *live* proof blocks a submission. A task that went back to the
  // pool carries the previous captain's superseded proof for the record, and
  // that must not stop whoever holds it now from submitting their own.
  const existing = await Proof.findOne({ taskId: task._id, supersededAt: null }).lean();
  if (existing) {
    throw AppError.conflict(ErrorCodes.PROOF_ALREADY_SUBMITTED, 'Proof has already been submitted for this task');
  }

  const now = new Date();

  // Claim the task before writing anything. Three simultaneous submissions all
  // read IN_PROGRESS, all see no live proof, and all reach this point — so the
  // "has a proof already been submitted" check above cannot be what decides it.
  // This compare-and-swap can only succeed once, and only the winner writes a
  // proof; the losers find the task already moved on and are turned away with
  // the same conflict a late submission would get.
  const claimed = await Task.findOneAndUpdate(
    { _id: task._id, captainId: input.captainId, status: 'IN_PROGRESS' },
    {
      $set: {
        status: 'PROOF_SUBMITTED',
        proofSubmittedAt: now,
        // The transaction reference for the payment the captain actually made.
        // It is theirs to report — nothing in this system moves the money — so
        // it is recorded here rather than checked against anything. What makes
        // it trustworthy is admin reconciling it against the bank statement
        // later; see reconciliation.service.ts.
        providerReference: input.providerReference,
      },
      // Recorded by the same write that makes the change, so the history can
      // never describe a transition that did not happen — or, as it did
      // briefly, be lost because the write that carried it moved elsewhere.
      $push: {
        stateHistory: {
          from: 'IN_PROGRESS',
          to: 'PROOF_SUBMITTED',
          actorUserId: new Types.ObjectId(actor.userId),
          actorRole: actor.role,
          at: now,
        },
      },
    },
    { new: true },
  );
  if (!claimed) {
    throw AppError.conflict(ErrorCodes.PROOF_ALREADY_SUBMITTED, 'Proof has already been submitted for this task');
  }

  await Proof.create({
    taskId: task._id,
    captainId: input.captainId,
    providerReference: input.providerReference,
    notes: input.notes,
    receiptFileName: input.receipt?.originalName ?? null,
    receiptUrl: input.receipt?.url ?? null,
    receiptPublicId: input.receipt?.publicId ?? null,
    receiptMimeType: input.receipt?.mimeType ?? null,
    receiptSizeBytes: input.receipt?.sizeBytes ?? null,
    submittedAt: now,
  });

  // Immediately queue for audit — an automatic consequence of the proof
  // submission above, not a discretionary action by the captain, so it's
  // attributed to the system rather than to whoever happened to submit.
  assertTransition('PROOF_SUBMITTED', 'AUDIT_PENDING');
  // Only the caller who won the claim above can reach this line, so the swap
  // is belt and braces — but it keeps the invariant readable as one rule
  // rather than something you have to trace back through the function to see.
  const queued = await claimTransition(
    task._id,
    { status: 'PROOF_SUBMITTED' },
    { status: 'AUDIT_PENDING' },
    [
      {
        from: 'PROOF_SUBMITTED',
        to: 'AUDIT_PENDING',
        actorRole: 'SYSTEM',
        reason: 'Automatically queued for audit on proof submission',
        at: now,
      },
    ],
  );
  if (!queued) throw alreadyDecided('awaiting its audit hand-off');

  await recordAudit({
    action: 'TASK_PROOF_SUBMITTED',
    targetCollection: 'Task',
    targetId: task._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    oldState: { status: 'IN_PROGRESS' },
    newState: { status: 'AUDIT_PENDING' },
    metadata: {
      taskCode: task.taskCode,
      providerReference: input.providerReference,
      hasReceipt: Boolean(input.receipt),
    },
  });

  /**
   * ASK THE PARTY, DO NOT DECIDE.
   *
   * A payout used to approve itself the instant proof arrived, on the grounds
   * that an API party is a server with nobody present to audit. That decided
   * on the customer's behalf whether their money had turned up — the one fact
   * the platform is in no position to know.
   *
   * So instead the party is asked, and given a deadline. OTDMS never contacts
   * the customer: it has no account for them, no channel to them, and no
   * business holding their contact details. The party already knows who their
   * customer is and already has a way to reach them, so the chain runs
   * captain -> OTDMS -> party -> customer, and the answer comes back the same
   * way.
   *
   * If nothing comes back before the deadline the payout approves itself after
   * all — a captain who has already sent real money cannot be left waiting on
   * somebody who may never look. That is the sweep in taskExpiry.job.ts, and
   * it says in the audit trail that is what happened.
   */
  const config = await getConfig();
  const { confirmationMinutes } = clocksOf(task, config);
  const deadline = new Date(now.getTime() + confirmationMinutes * 60_000);

  // Written with a guard on the state and on the deadline being unset, so two
  // submissions racing cannot start two confirmation windows — and so the
  // party is never asked twice for one payout.
  const asked = await Task.findOneAndUpdate(
    { _id: task._id, status: 'AUDIT_PENDING', confirmationDeadline: null },
    { $set: { confirmationDeadline: deadline, confirmationRequestedAt: now } },
    { new: true },
  );

  if (asked) {
    await recordAudit({
      action: 'TASK_CONFIRMATION_REQUESTED',
      targetCollection: 'Task',
      targetId: task._id,
      userId: actor.userId,
      role: actor.role,
      ip: actor.ip,
      newState: { status: 'AUDIT_PENDING', confirmationDeadline: deadline.toISOString() },
      metadata: {
        taskCode: task.taskCode,
        providerReference: input.providerReference,
        confirmationMinutes,
        requestedAt: now.toISOString(),
      },
    });

    // Both channels, because a party may be a dashboard, an integration, or
    // both — and the one that is not watching must still be told.
    notifyConfirmationRequired(asked, deadline);
    if (asked.callbackUrl) {
      const key = await ApiKey.findOne({ partyId: task.partyId, status: 'ACTIVE' }).lean();
      // Not awaited and not allowed to fail the submission: the captain has
      // done their part, and a party's endpoint being down is not their
      // problem. The sweep retries what does not land.
      if (key) void deliverPayoutCallback(asked, 'payout.confirmation_required', key.keyId);
    }
  }

  return task;
}

/**
 * AUDIT_PENDING -> COMPLETED.
 *
 * Three effects must land together: the state change, the collateral release,
 * and the immutable commission credit. Under a replica set these run in one
 * transaction. Otherwise they run in an order chosen so that a mid-way failure
 * is recoverable and never over-pays: commission first (guarded by a unique
 * index on taskId), then state, then release.
 */
/**
 * Shared completion core: commission credit, collateral release, and the
 * AUDIT_PENDING/REJECTED -> COMPLETED transition. Used both by a party's own
 * approval and by admin overruling a party's rejection.
 */
async function completeTask(
  task: ITask,
  actor: ActorContext,
  fromState: Extract<TaskState, 'AUDIT_PENDING' | 'REJECTED'>,
  extraSet: Record<string, unknown> = {},
): Promise<{ task: ITask; commissionPaise: number }> {
  assertTransition(fromState, 'COMPLETED');
  if (!task.captainId) throw AppError.internal('Task has no assigned captain');
  if (task.commissionPaise == null) throw AppError.internal('Task has no commission locked in from creation');

  // The commission was already computed and locked in at task creation — the
  // party's balance was debited for it up front — so it's credited exactly
  // as-is here, never recomputed against (possibly since-changed) config.
  const config = await getConfig();
  // The amount below comes from the task, but the mode and rate recorded
  // alongside it must be the ones that actually produced it — including a
  // per-party override, or the ledger would claim a rate this party was never
  // on.
  /**
   * The commission record, taken from the task rather than recomputed.
   *
   * It used to be worked out again here from the live settings, with only the
   * amount overridden from the task — which meant the ledger could name a rate
   * this task was never priced at, the moment anybody changed the settings
   * between creation and completion. The rates are on the row for exactly this
   * reason; reading them is the whole point of having stored them.
   */
  const computation = {
    commissionPaise: task.commissionPaise ?? 0,
    percentageRate: task.captainCommissionRate ?? 0,
    configVersion: config.version,
  };

  const captainId = task.captainId;
  const now = new Date();
  const useTransaction = await supportsTransactions();
  let completed: ITask | undefined;

  /**
   * Claim the completion before anything is written.
   *
   * The caller's status check is a read, and a read cannot hold a state
   * against a concurrent writer. A party approving a proof at the same moment
   * they reject it produced exactly that: both callers saw AUDIT_PENDING, the
   * approval wrote its Commission row, and the rejection then won the status.
   * The task ended REJECTED carrying a commission for a captain who was never
   * paid — and because `taskId` is unique on Commission, the captain who
   * eventually did the work got the money while `creditCommission` silently
   * treated the stale row as "already credited" and never recorded them.
   *
   * Compare-and-swapping the status first is the same ordering the rest of
   * this codebase uses for exactly this reason: claim the transition, then
   * move the money. A loser now finds the state already gone and writes
   * nothing at all.
   */
  const claimCompletion = async (session?: mongoose.ClientSession): Promise<ITask> => {
    const claimed = await Task.findOneAndUpdate(
      { _id: task._id, status: fromState },
      {
        $set: {
          status: 'COMPLETED',
          completedAt: now,
          auditedAt: now,
          auditedBy: new Types.ObjectId(actor.userId),
          commissionPaise: computation.commissionPaise,
          ...extraSet,
        },
        $push: {
          stateHistory: {
            from: fromState,
            to: 'COMPLETED',
            actorUserId: new Types.ObjectId(actor.userId),
            actorRole: actor.role,
            at: now,
          },
        },
      },
      { new: true, ...(session ? { session } : {}) },
    );
    if (!claimed) {
      throw AppError.conflict(
        ErrorCodes.NOT_PENDING_AUDIT,
        'This task is no longer awaiting audit — someone else has already decided it',
      );
    }
    return claimed;
  };

  if (useTransaction) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        completed = await claimCompletion(session);
        await creditCommission({
          taskId: task._id,
          captainId,
          partyId: task.partyId,
          taskAmountPaise: task.amountPaise,
          computation,
          session,
        });
        await payCaptainForCompletedTask(task, captainId, session);
        // The captain's earning event, sourced back to this exact party/task
        // (see DMCAllocation.ts) — mirrors the aggregate credit just above.
        await createAllocation(
          {
            ownerType: 'CAPTAIN',
            ownerId: captainId,
            sourcePartyId: task.partyId,
            customerId: task.customerId,
            taskId: task._id,
            taskCode: task.taskCode,
            customerName: task.customerName,
            amountPaise: task.amountPaise + computation.commissionPaise,
            sourceTransactionId: task.taskCode,
          },
          session,
        );
        await createPlatformAllocation(task, session);
      });
    } finally {
      await session.endSession();
    }
  } else {
    // Claim first, then move money. The unique index on taskId still makes the
    // commission write idempotent for a retry after a partial failure, but it
    // is no longer what stands between two racing callers — the claim above is.
    completed = await claimCompletion();
    await creditCommission({
      taskId: task._id,
      captainId,
      partyId: task.partyId,
      taskAmountPaise: task.amountPaise,
      computation,
    });
    await payCaptainForCompletedTask(task, captainId);
    await createAllocation({
      ownerType: 'CAPTAIN',
      ownerId: captainId,
      sourcePartyId: task.partyId,
      customerId: task.customerId,
      taskId: task._id,
      taskCode: task.taskCode,
      customerName: task.customerName,
      amountPaise: task.amountPaise + computation.commissionPaise,
      sourceTransactionId: task.taskCode,
    });
    await createPlatformAllocation(task);
  }

  await recordAudit({
    action: 'TASK_APPROVED',
    targetCollection: 'Task',
    targetId: task._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    oldState: { status: fromState },
    newState: { status: 'COMPLETED' },
    metadata: { taskCode: task.taskCode, commissionPaise: computation.commissionPaise },
  });

  // Rating: a completion counts, and counts for more if it landed inside the
  // deadline. Judged against the task's own recorded deadline rather than the
  // current config, so changing the window later cannot rewrite history.
  const onTime = task.expiresAt == null || now.getTime() <= task.expiresAt.getTime();
  await recordOutcome(captainId, { totalTasksCompleted: 1, totalTasksOnTime: onTime ? 1 : 0 });

  await recordAudit({
    action: 'COMMISSION_CREATED',
    targetCollection: 'Commission',
    targetId: task._id,
    userId: actor.userId,
    role: actor.role,
    newState: {
      commissionPaise: computation.commissionPaise,
      configVersion: computation.configVersion,
    },
    metadata: { taskCode: task.taskCode },
  });
  await recordAudit({
    action: 'COLLATERAL_RELEASED',
    targetCollection: 'Captain',
    targetId: captainId,
    userId: actor.userId,
    role: actor.role,
    metadata: { taskId: String(task._id), amountPaise: task.amountPaise },
  });

  logger.info({ taskCode: task.taskCode, commissionPaise: computation.commissionPaise }, 'Task approved');
  // The claimed document, not the in-memory one the caller loaded — that copy
  // never received the status change now that it is applied by the swap.
  return { task: completed ?? task, commissionPaise: computation.commissionPaise };
}


/**
 * The platform's own record of what it kept on a task.
 *
 * The remainder itself lives in the pool and is never stored as a figure — it
 * is simply what nobody took. But admin's cash-out draws against allocations,
 * one per earning event naming the party it came from, exactly as a captain's
 * does. Without this row the platform's money is real but unreachable: admin
 * could see the pool and never withdraw a paise of it.
 *
 * Written at completion, next to the captain's, so both appear at the moment
 * the money is actually earned and neither can be drawn against a task that
 * might still be cancelled.
 */
async function createPlatformAllocation(task: ITask, session?: mongoose.ClientSession): Promise<void> {
  const platformPaise = task.adminCommissionPaise ?? 0;
  if (platformPaise <= 0) return;
  await createAllocation(
    {
      ownerType: 'ADMIN',
      ownerId: PLATFORM_OWNER_ID,
      sourcePartyId: task.partyId,
      customerId: task.customerId,
      taskId: task._id,
      taskCode: task.taskCode,
      customerName: task.customerName,
      amountPaise: platformPaise,
      sourceTransactionId: task.taskCode,
    },
    session,
  );
}

/** A party approving the captain's proof — the normal, undisputed path. */
export async function approveTask(taskId: string, actor: ActorContext): Promise<{ task: ITask; commissionPaise: number }> {
  if (!Types.ObjectId.isValid(taskId)) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  const task = await Task.findById(taskId);
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  if (task.status !== 'AUDIT_PENDING') {
    throw AppError.conflict(
      ErrorCodes.NOT_PENDING_AUDIT,
      `Only tasks awaiting audit can be approved (currently ${task.status})`,
      { status: task.status },
    );
  }
  return completeTask(task, actor, 'AUDIT_PENDING');
}

/**
 * Shared rollback: release the current captain's collateral, clear them from
 * the task, and return it to the open pool. Used only where the reassignment
 * itself needs gating (an admin overruling a rejected proof or a disputed
 * cancellation) — a captain's own expiry acknowledgement stays a direct,
 * un-gated reassign since there is no counterpart dispute to arbitrate.
 */
async function reassignTask(
  task: ITask,
  actor: ActorContext,
  reason: string,
  extraSet: Record<string, unknown> = {},
): Promise<ITask> {
  const from = task.status;
  const captainId = task.captainId;
  assertTransition(from, 'REASSIGNED');

  // Claimed before the collateral is released. Two admins resolving the same
  // rejection at once would otherwise both reach the release below, and a
  // captain's lock would be given back twice for one task.
  const claimed = await claimTransition(
    task._id,
    { status: from },
    {
      status: 'REASSIGNED',
      captainId: null,
      claimedAt: null,
      startedAt: null,
      proofSubmittedAt: null,
      expiresAt: null,
      providerReference: null,
      ...extraSet,
    },
    [
      {
        from,
        to: 'REASSIGNED',
        actorUserId: new Types.ObjectId(actor.userId),
        actorRole: actor.role,
        reason,
        // The task no longer knows who held it by now, so the outgoing captain
        // is named here rather than left to the save hook.
        captainId,
        at: new Date(),
      },
    ],
    { inc: { reassignmentCount: 1 }, pushCaptainId: captainId },
  );
  if (!claimed) throw alreadyDecided('in the state it was read in');

  // Retire the outgoing captain's proof. It stays on record, but it is no
  // longer this task's proof — otherwise the next captain could never submit.
  await supersedeProofFor(task._id);

  if (captainId) {
    // They never sent the money, so the DMC they committed at the claim is
    // theirs again. Completion is the only exit that pays them more than this.
    await releasePayoutHold(captainId, task.amountPaise);
    await recordAudit({
      action: 'COLLATERAL_RELEASED',
      targetCollection: 'Captain',
      targetId: captainId,
      userId: actor.userId,
      role: actor.role,
      metadata: { taskId: String(task._id), amountPaise: task.amountPaise, reason },
    });
  }

  await recordAudit({
    action: 'TASK_REASSIGNED',
    targetCollection: 'Task',
    targetId: task._id,
    userId: actor.userId,
    role: actor.role,
    metadata: { taskCode: claimed.taskCode, reassignmentCount: claimed.reassignmentCount },
  });

  // Back into routing, offered to the next-best captain who has not already
  // had this task. A routing hiccup must not undo the reassignment itself —
  // the sweeper re-offers anything left without one.
  try {
    await resetRoutingForReassignment(task._id);
  } catch (err) {
    logger.error({ err, taskCode: task.taskCode }, 'Re-routing after reassignment failed; sweeper will retry');
  }

  return claimed;
}

/**
 * AUDIT_PENDING -> REJECTED. The task stays exactly as it is — same captain,
 * collateral still locked — pending admin's review; it no longer reassigns
 * itself automatically. See resolveTaskRejection for what happens next.
 */
export async function rejectTask(
  taskId: string,
  reason: string,
  category: RejectionCategory,
  actor: ActorContext,
): Promise<ITask> {
  if (!reason || reason.trim().length < 5) {
    throw AppError.badRequest(
      ErrorCodes.REJECTION_REASON_REQUIRED,
      'A rejection reason of at least 5 characters is required',
    );
  }
  if (!Types.ObjectId.isValid(taskId)) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  const task = await Task.findById(taskId);
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  if (task.status !== 'AUDIT_PENDING') {
    throw AppError.conflict(
      ErrorCodes.NOT_PENDING_AUDIT,
      `Only tasks awaiting audit can be rejected (currently ${task.status})`,
      { status: task.status },
    );
  }

  const captainId = task.captainId;
  const now = new Date();
  const trimmedReason = reason.trim();

  assertTransition('AUDIT_PENDING', 'REJECTED');

  // The other half of the approve/reject pair. Approval is claimed with a swap
  // because it moves money; this one moves none, but leaving it as a plain
  // save would make the pair only half explicit — and it was the losing
  // rejection in that pair that used to strand an approval's commission row.
  const rejected = await claimTransition(
    task._id,
    { status: 'AUDIT_PENDING' },
    {
      status: 'REJECTED',
      rejectionReason: trimmedReason,
      rejectionCategory: category,
      // Remembered so the captain being complained about can still read the
      // party's own words, while whoever inherits the task later cannot.
      rejectedCaptainId: captainId ?? null,
      auditedAt: now,
      auditedBy: new Types.ObjectId(actor.userId),
    },
    [
      {
        from: 'AUDIT_PENDING',
        to: 'REJECTED',
        actorUserId: new Types.ObjectId(actor.userId),
        actorRole: actor.role,
        reason: trimmedReason,
        at: now,
      },
    ],
  );
  if (!rejected) throw alreadyDecided('awaiting audit');

  // Rating: the party was not satisfied. Counted now; if admin later upholds
  // the rejection, that is recorded separately and weighs far more heavily.
  if (captainId) await recordOutcome(captainId, { totalProofsRejected: 1 });

  await recordAudit({
    action: 'TASK_REJECTED',
    targetCollection: 'Task',
    targetId: task._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    oldState: { status: 'AUDIT_PENDING' },
    newState: { status: 'REJECTED' },
    metadata: { taskCode: rejected.taskCode, reason: trimmedReason, category, captainId: captainId ? String(captainId) : null },
  });

  return rejected;
}

/**
 * Admin's resolution of a rejected proof — the one point where admin has
 * final say, exactly because party and captain could not agree. APPROVE
 * overrules the rejection and completes the task normally (captain credited);
 * REASSIGN releases the captain and returns the task to the open pool.
 */
export async function resolveTaskRejection(
  taskId: string,
  decision: 'APPROVE' | 'REASSIGN',
  actor: ActorContext,
): Promise<{ task: ITask; commissionPaise: number | null }> {
  if (!Types.ObjectId.isValid(taskId)) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  const task = await Task.findById(taskId);
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  if (task.status !== 'REJECTED') {
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `This task has no rejection pending admin review (currently ${task.status})`,
      { status: task.status },
    );
  }

  if (decision === 'REASSIGN') {
    // Admin sided with the party: the rejection stands. This is the heaviest
    // mark against a captain, since two independent parties judged the work
    // to have failed — see captainRating.service.ts.
    const rejectedCaptainId = task.captainId;
    // Written by the claim itself rather than by a second save afterwards: the
    // in-memory copy is stale the moment the swap lands.
    const reassigned = await reassignTask(
      task,
      actor,
      'Admin resolved a proof rejection by returning the task to the pool',
      { adminRejectionResolution: 'REASSIGNED' },
    );
    if (rejectedCaptainId) await recordOutcome(rejectedCaptainId, { totalRejectionsUpheldByAdmin: 1 });
    await recordAudit({
      action: 'TASK_REJECTION_RESOLVED',
      targetCollection: 'Task',
      targetId: task._id,
      userId: actor.userId,
      role: actor.role,
      ip: actor.ip,
      metadata: { taskCode: reassigned.taskCode, decision },
    });
    return { task: reassigned, commissionPaise: null };
  }

  const result = await completeTask(task, actor, 'REJECTED', { adminRejectionResolution: 'APPROVED' });
  await recordAudit({
    action: 'TASK_REJECTION_RESOLVED',
    targetCollection: 'Task',
    targetId: task._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    metadata: { taskCode: task.taskCode, decision },
  });
  return result;
}

/**
 * Walks an EXPIRED task back out to the pool: EXPIRED -> REJECTED ->
 * REASSIGNED, with the captain who held it excluded from future offers on it.
 *
 * Shared by the two ways that happens — the captain acknowledging it
 * themselves, and the system reclaiming it when they never do — so both leave
 * the task in exactly the same shape. `actor` is null for the system path.
 *
 * Collateral was already released when the task expired, so it is deliberately
 * not released again here; doing so would credit the captain twice.
 */
async function returnExpiredTaskToPool(
  task: ITask,
  reason: string,
  actor: ActorContext | null,
): Promise<ITask> {
  assertTransition(task.status, 'REJECTED');

  const now = new Date();
  const previousCaptainId = task.captainId;
  const actorUserId = actor ? new Types.ObjectId(actor.userId) : undefined;

  assertTransition('REJECTED', 'REASSIGNED');

  // Both hops are recorded, but only one write happens, and it is conditional
  // on the task still being EXPIRED. The captain acknowledging their own
  // expiry and the sweeper reclaiming it can arrive together; whichever loses
  // must not walk the task out of the pool a second time.
  const claimed = await claimTransition(
    task._id,
    { status: 'EXPIRED' },
    {
      status: 'REASSIGNED',
      rejectionReason: reason,
      captainId: null,
      claimedAt: null,
      startedAt: null,
      proofSubmittedAt: null,
      expiresAt: null,
      expiryAckDeadline: null,
      providerReference: null,
    },
    [
      {
        from: 'EXPIRED',
        to: 'REJECTED',
        ...(actorUserId ? { actorUserId } : {}),
        actorRole: actor?.role ?? 'SYSTEM',
        reason,
        captainId: previousCaptainId,
        at: now,
      },
      {
        from: 'REJECTED',
        to: 'REASSIGNED',
        actorRole: 'SYSTEM',
        reason: 'Returned to the available pool after expiry',
        captainId: previousCaptainId,
        at: now,
      },
    ],
    { inc: { reassignmentCount: 1 }, pushCaptainId: previousCaptainId },
  );
  if (!claimed) throw alreadyDecided('expired and awaiting recovery');

  await recordAudit({
    action: 'TASK_REJECTED',
    targetCollection: 'Task',
    targetId: task._id,
    ...(actor ? { userId: actor.userId, role: actor.role, ip: actor.ip } : {}),
    oldState: { status: 'EXPIRED', captainId: previousCaptainId ? String(previousCaptainId) : null },
    newState: { status: 'REASSIGNED' },
    metadata: { taskCode: claimed.taskCode, reason, source: 'EXPIRED', reclaimedBySystem: actor === null },
  });
  await recordAudit({
    action: 'TASK_REASSIGNED',
    targetCollection: 'Task',
    targetId: task._id,
    ...(actor ? { userId: actor.userId, role: actor.role } : {}),
    metadata: { taskCode: claimed.taskCode, reassignmentCount: claimed.reassignmentCount },
  });

  // Straight back into routing rather than waiting for the next sweep.
  try {
    await resetRoutingForReassignment(task._id);
  } catch (err) {
    logger.error({ err, taskCode: task.taskCode }, 'Re-routing after expiry recovery failed; sweeper will retry');
  }

  return claimed;
}

/**
 * The system taking back an EXPIRED task whose captain never acknowledged it.
 *
 * The captain is given `taskExpiryAckMinutes` to explain what went wrong,
 * because that explanation is genuinely useful. But a captain who has already
 * let one deadline pass may never come back at all, and until this ran, such a
 * task sat in EXPIRED permanently — the party's DMC tied up in it, with
 * neither the party, admin, nor the max-age sweep able to move it.
 */
export async function reclaimUnacknowledgedExpiredTasks(): Promise<ITask[]> {
  const now = new Date();
  const abandoned = await Task.find({
    status: 'EXPIRED' as TaskState,
    expiryAckDeadline: { $ne: null, $lte: now },
  }).limit(200);

  const reclaimed: ITask[] = [];
  for (const task of abandoned) {
    try {
      const heldBy = task.captainId;
      await returnExpiredTaskToPool(task, 'Expired and not acknowledged in time — reclaimed automatically', null);
      logger.info(
        { taskCode: task.taskCode, captainId: heldBy ? String(heldBy) : null },
        'Reclaimed an unacknowledged expired task',
      );
      reclaimed.push(task);
    } catch (err) {
      logger.error({ err, taskId: String(task._id) }, 'Failed to reclaim an unacknowledged expired task');
    }
  }
  return reclaimed;
}

/**
 * A captain's own acknowledgement that an EXPIRED task (deadline passed
 * while they held it) will not be completed. Records why, then rejects and
 * reassigns it back to the pool — the same recovery path as an admin
 * rejection — so another captain can pick it up.
 */
export async function rejectExpiredTask(
  taskId: string,
  captainId: Types.ObjectId,
  reason: string,
  actor: ActorContext,
): Promise<ITask> {
  if (!reason || reason.trim().length < 5) {
    throw AppError.badRequest(
      ErrorCodes.REJECTION_REASON_REQUIRED,
      'A reason of at least 5 characters is required',
    );
  }

  const task = await loadOwnedTask(taskId, captainId);
  return returnExpiredTaskToPool(task, reason.trim(), actor);
}

/**
 * The platform earns its cut when the task completes, not when it is created.
 *
 * The party was already billed this at creation — that is what reserved the
 * money — but until the work is actually done the platform has earned
 * nothing, so there is no wallet credit and no allocation to withdraw
 * against. Mirrors the captain's side exactly: both are paid out of the same
 * completion, in the same place, from the same amounts the task locked in.
 *
 * Because COMPLETED has no outgoing transition, a task credited here can
 * never be cancelled afterwards, so this credit never has to be reversed.
 */
/**
 * Pay the captain for a task they have finished.
 *
 * Everything moves through the pool, and that is the whole design:
 *
 *   the party's charge  ->  pool  ->  the captain's share
 *                            |
 *                            `-> what is left stays as the platform's
 *
 * So this funds the pool with what the party was actually billed, then pays
 * the captain out of it. The platform's cut is never credited anywhere on its
 * own — it is simply the part nobody took, which is why the three figures can
 * never fail to add up.
 *
 * The captain is paid into their spendable DMC together with the amount they
 * laid out. There is no separate commission balance any more: it was a second
 * pocket the captain had to move money out of before it was any use to them,
 * and every screen had to explain the difference.
 *
 * Twice the amount comes back, and that is not a bug. One is the hold taken
 * when they claimed the work — DMC that never left the system, only their
 * balance — and the other is the reimbursement for the real money they went
 * and sent. Add the fee and a completed pay-out leaves them better off by the
 * fee alone, which is exactly what it should be.
 */
async function payCaptainForCompletedTask(
  task: ITask,
  captainId: Types.ObjectId,
  session?: mongoose.ClientSession,
): Promise<void> {
  const captainCommissionPaise = task.commissionPaise ?? 0;
  const partyChargePaise = captainCommissionPaise + (task.adminCommissionPaise ?? 0);

  // What the party was billed, arriving where the captain is paid from. Funded
  // at completion rather than at creation, so a task that never completes
  // refunds cleanly and the pool was never told about it.
  if (partyChargePaise > 0) {
    await collectIntoPool(partyChargePaise, session);
  }

  // The hold released and the outlay reimbursed, both as capital they can
  // trade with again.
  await Captain.updateOne(
    { _id: captainId },
    { $inc: { dmcBalancePaise: task.amountPaise * 2 } },
    session ? { session } : {},
  );

  // And their share, out of the pool that was just funded — so it can never
  // pay out more than the party was charged.
  if (captainCommissionPaise > 0) {
    await payCommissionToCaptain(captainId, captainCommissionPaise, session, task.taskCode);
  }
}


/**
 * A cancelled task never got completed, so the party's up-front debit (task
 * amount + both commissions, see task.service.ts::createTask) is refunded in
 * full.
 *
 * Neither side has been credited anything at this point — the captain is paid
 * on completion, and so is the platform — so there is nothing to claw back
 * from either. This used to reverse a platform credit made at creation, which
 * drove the wallet negative whenever admin had already withdrawn it.
 */
async function refundPartyForCancelledTask(task: ITask, actor: ActorContext): Promise<void> {
  const totalPaise = task.amountPaise + (task.commissionPaise ?? 0) + (task.adminCommissionPaise ?? 0);
  await Party.findByIdAndUpdate(task.partyId, { $inc: { dmcBalancePaise: totalPaise } });
  await recordAudit({
    action: 'PARTY_DMC_REFUNDED',
    targetCollection: 'Party',
    targetId: task.partyId,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    metadata: { taskCode: task.taskCode, amountPaise: totalPaise },
  });
}

/**
 * Cancel a task — initiated by the party who placed it, or by the captain
 * holding it (never by admin). A task nobody has claimed yet is cancelled
 * outright: no captain has anything at stake. One a captain is actively
 * holding is not — it goes to CANCEL_REVIEW for whichever side did NOT ask
 * (captain if party asked; party if captain asked) to approve or dispute.
 * Only that review — or admin's, on a dispute — makes it final.
 */
export async function requestCancellation(
  taskId: string,
  reason: string,
  actor: ActorContext,
): Promise<ITask> {
  if (!Types.ObjectId.isValid(taskId)) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  const task = await Task.findById(taskId);
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  const from = task.status;

  if (!task.captainId) {
    // Nobody holds it — cancel outright, exactly as before. Only reachable
    // for a party (a captain can only ever request this on a task they hold).
    assertTransition(from, 'CANCELLED');
    // Claimed before the refund. The precondition also pins captainId to null,
    // so a captain claiming the task in the same instant cannot end up holding
    // one that has just been cancelled and refunded underneath them.
    const claimed = await claimTransition(
      task._id,
      { status: from, captainId: null },
      { status: 'CANCELLED' },
      [
        {
          from,
          to: 'CANCELLED',
          actorUserId: new Types.ObjectId(actor.userId),
          actorRole: actor.role,
          reason,
          at: new Date(),
        },
      ],
    );
    if (!claimed) throw alreadyDecided('open and unclaimed');
    await refundPartyForCancelledTask(claimed, actor);

    await recordAudit({
      action: 'TASK_CANCELLED',
      targetCollection: 'Task',
      targetId: task._id,
      userId: actor.userId,
      role: actor.role,
      ip: actor.ip,
      oldState: { status: from },
      newState: { status: 'CANCELLED' },
      metadata: { taskCode: claimed.taskCode, reason },
    });
    return claimed;
  }

  // A captain holds it — the other side's review decides whether this is final.
  assertTransition(from, 'CANCEL_REVIEW');
  const initiatedBy = actor.role === 'CAPTAIN' ? 'CAPTAIN' : 'PARTY';
  const inReview = await claimTransition(
    task._id,
    { status: from },
    {
      status: 'CANCEL_REVIEW',
      preCancelStatus: from,
      cancelInitiatedBy: initiatedBy,
      cancelInitiatedByUserId: new Types.ObjectId(actor.userId),
      cancelReason: reason,
    },
    [
      {
        from,
        to: 'CANCEL_REVIEW',
        actorUserId: new Types.ObjectId(actor.userId),
        actorRole: actor.role,
        reason,
        at: new Date(),
      },
    ],
  );
  if (!inReview) throw alreadyDecided(`in ${from.toLowerCase()}`);

  await recordAudit({
    action: 'TASK_CANCEL_REQUESTED',
    targetCollection: 'Task',
    targetId: task._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    oldState: { status: from },
    newState: { status: 'CANCEL_REVIEW' },
    metadata: { taskCode: inReview.taskCode, reason, initiatedBy: inReview.cancelInitiatedBy },
  });
  return inReview;
}

/**
 * Shared core of a cancellation review: approving makes it final (and
 * releases the captain's collateral); rejecting escalates to admin rather
 * than reverting it unilaterally. Ownership of who is allowed to review is
 * checked by the two role-specific wrappers below.
 */
async function applyCancelReviewDecision(
  task: ITask,
  decision: 'APPROVE' | 'REJECT',
  reason: string | undefined,
  actor: ActorContext,
): Promise<ITask> {
  if (task.status !== 'CANCEL_REVIEW') {
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `This task is not awaiting a cancellation decision (currently ${task.status})`,
      { status: task.status },
    );
  }

  const from = task.status;
  const to = decision === 'APPROVE' ? 'CANCELLED' : 'CANCEL_DISPUTED';
  assertTransition(from, to);

  // The decision is claimed before the refund. Both sides can be looking at
  // the same pending cancellation, and an approval is what releases the
  // captain's collateral and returns the party's DMC — running that twice
  // would refund a task once and pay for it twice.
  const decided = await claimTransition(
    task._id,
    { status: 'CANCEL_REVIEW' },
    {
      status: to,
      cancelReviewDecision: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      cancelReviewDecisionReason: reason ?? null,
    },
    [
      {
        from,
        to,
        actorUserId: new Types.ObjectId(actor.userId),
        actorRole: actor.role,
        reason,
        at: new Date(),
      },
    ],
  );
  if (!decided) throw alreadyDecided('awaiting a cancellation decision');

  if (decision === 'APPROVE') {
    // The party gets its money back and the captain gets their hold back.
    // Nothing was sent, so neither side is owed anything for it.
    if (decided.captainId) {
      await releasePayoutHold(decided.captainId, decided.amountPaise);
    }
    await refundPartyForCancelledTask(decided, actor);
  }

  await recordAudit({
    action: decision === 'APPROVE' ? 'TASK_CANCEL_APPROVED' : 'TASK_CANCEL_DISPUTED',
    targetCollection: 'Task',
    targetId: task._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    oldState: { status: from },
    newState: { status: to },
    metadata: { taskCode: decided.taskCode, reason },
  });
  return decided;
}

/** The captain's review of a cancellation the PARTY requested. */
export async function reviewCancellationAsCaptain(
  taskId: string,
  captainId: Types.ObjectId,
  decision: 'APPROVE' | 'REJECT',
  reason: string | undefined,
  actor: ActorContext,
): Promise<ITask> {
  const task = await loadOwnedTask(taskId, captainId);
  if (task.cancelInitiatedBy !== 'PARTY') {
    throw AppError.forbidden('This cancellation was not requested by the party');
  }
  return applyCancelReviewDecision(task, decision, reason, actor);
}

/** The party's review of a cancellation the CAPTAIN requested. */
export async function reviewCancellationAsParty(
  taskId: string,
  partyId: Types.ObjectId,
  decision: 'APPROVE' | 'REJECT',
  reason: string | undefined,
  actor: ActorContext,
): Promise<ITask> {
  if (!Types.ObjectId.isValid(taskId)) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  const task = await Task.findOne({ _id: taskId, partyId });
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  if (task.cancelInitiatedBy !== 'CAPTAIN') {
    throw AppError.forbidden('This cancellation was not requested by the captain');
  }
  return applyCancelReviewDecision(task, decision, reason, actor);
}

/**
 * Admin's resolution of a disputed cancellation — the one point where admin
 * has final say in this flow, exactly because the two sides could not agree.
 * APPROVE leaves the task exactly as it was before the cancellation attempt
 * (same captain, nothing rolled back); REASSIGN releases the captain and
 * returns the task to the open pool.
 */
export async function resolveCancelDispute(
  taskId: string,
  decision: 'APPROVE' | 'REASSIGN',
  actor: ActorContext,
): Promise<ITask> {
  if (!Types.ObjectId.isValid(taskId)) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  const task = await Task.findById(taskId);
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  if (task.status !== 'CANCEL_DISPUTED') {
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `This task has no cancellation dispute to resolve (currently ${task.status})`,
      { status: task.status },
    );
  }

  if (decision === 'REASSIGN') {
    const reassigned = await reassignTask(
      task,
      actor,
      'Admin resolved a disputed cancellation by returning the task to the pool',
      { adminCancelResolution: 'REASSIGNED' },
    );
    await recordAudit({
      action: 'TASK_CANCEL_DISPUTE_RESOLVED',
      targetCollection: 'Task',
      targetId: task._id,
      userId: actor.userId,
      role: actor.role,
      ip: actor.ip,
      metadata: { taskCode: reassigned.taskCode, decision },
    });
    return reassigned;
  }

  const from = task.status;
  const to = task.preCancelStatus ?? 'ASSIGNED';
  assertTransition(from, to);

  const restored = await claimTransition(
    task._id,
    { status: 'CANCEL_DISPUTED' },
    { status: to, adminCancelResolution: 'APPROVED' },
    [
      {
        from,
        to,
        actorUserId: new Types.ObjectId(actor.userId),
        actorRole: actor.role,
        at: new Date(),
      },
    ],
  );
  if (!restored) throw alreadyDecided('under a cancellation dispute');

  await recordAudit({
    action: 'TASK_CANCEL_DISPUTE_RESOLVED',
    targetCollection: 'Task',
    targetId: task._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    oldState: { status: from },
    newState: { status: to },
    metadata: { taskCode: restored.taskCode, decision },
  });
  return restored;
}

/**
 * Sweep tasks whose deadline has passed. Runs on a timer; each expiry releases
 * the captain's collateral so it is not held indefinitely by an inactive user.
 */
export async function expireOverdueTasks(): Promise<number> {
  const now = new Date();
  const config = await getConfig();
  // A task claimed but never started is just as overdue as one left half
  // finished — the completion clock runs from the claim, not from the start.
  const overdue = await Task.find({
    status: { $in: ['ASSIGNED', 'IN_PROGRESS'] as TaskState[] },
    expiresAt: { $lte: now },
  }).limit(200);

  let expired = 0;
  for (const task of overdue) {
    try {
      const from = task.status;
      assertTransition(from, 'EXPIRED');
      const captainId = task.captainId;

      // Claimed before the collateral is released. Two overlapping sweeps, or
      // a sweep racing the captain's own proof submission, must not release
      // the same hold twice.
      const expiredTask = await claimTransition(
        task._id,
        { status: from },
        {
          status: 'EXPIRED',
          // Starts the captain's grace period to explain what happened; once
          // it lapses the task is reclaimed rather than sitting frozen. The
          // length is this task's, settled from its party at creation.
          expiryAckDeadline: new Date(
            now.getTime() + clocksOf(task, config).expiryAckMinutes * 60_000,
          ),
        },
        [
          {
            from,
            to: 'EXPIRED',
            actorRole: 'SYSTEM',
            reason: 'Deadline passed without proof submission',
            at: now,
          },
        ],
      );
      if (!expiredTask) continue;

      // Rating: they held the task and let the clock run out.
      if (captainId) {
        await releasePayoutHold(captainId, task.amountPaise);
        await recordOutcome(captainId, { totalTasksExpired: 1 });
      }

      await recordAudit({
        action: 'TASK_EXPIRED',
        targetCollection: 'Task',
        targetId: task._id,
        metadata: { taskCode: task.taskCode, captainId: captainId ? String(captainId) : null },
      });
      expired += 1;
    } catch (err) {
      logger.error({ err, taskId: String(task._id) }, 'Failed to expire task');
    }
  }
  return expired;
}

/**
 * The hard ceiling on how long a task may sit unclaimed.
 *
 * Routing will keep looking for a captain, and once it runs out the task waits
 * in the open pool — but not forever. Past `taskMaxAgeMinutes` from creation,
 * an unclaimed task is cancelled outright and the party is refunded in full,
 * exactly as if they had cancelled it themselves, so their DMC is not left
 * tied up in work nobody is going to do. Only unclaimed tasks qualify: once a
 * captain holds it, their own completion deadline governs instead.
 */
export async function expireStaleUnclaimedTasks(): Promise<ITask[]> {
  const config = await getConfig();
  const now = new Date();

  /**
   * Each task against its own ceiling rather than one cutoff for all of them,
   * because the ceiling is the party's and two parties' tasks can be stale at
   * different ages. Expressed server-side so the comparison stays one query
   * instead of fetching every open task to filter in memory.
   *
   * The status and captainId filters still narrow this to open, unheld work
   * before the per-row arithmetic runs, and the sweep is capped at 200.
   */
  const stale = await Task.find({
    status: { $in: ['CREATED', 'REASSIGNED'] as TaskState[] },
    captainId: null,
    $expr: {
      $lte: [
        {
          $add: [
            '$createdAt',
            {
              $multiply: [
                { $ifNull: ['$maxAgeMinutes', config.taskMaxAgeMinutes] },
                60_000,
              ],
            },
          ],
        },
        now,
      ],
    },
  }).limit(200);

  const cancelled: ITask[] = [];
  const systemActor: ActorContext = { userId: String(new Types.ObjectId()), role: 'ADMIN' };

  for (const task of stale) {
    try {
      const from = task.status;
      assertTransition(from, 'CANCELLED');
      const { maxAgeMinutes } = clocksOf(task, config);
      const cancelReason = `No captain accepted within ${maxAgeMinutes} minutes`;

      // Claimed before the refund, and pinned to captainId null: a captain
      // claiming in the same instant means the task is no longer stale, and
      // the party must not be refunded for work now under way.
      const claimed = await claimTransition(
        task._id,
        { status: from, captainId: null },
        {
          status: 'CANCELLED',
          cancelReason,
          offeredCaptainId: null,
          offeredAt: null,
          offerExpiresAt: null,
        },
        [
          {
            from,
            to: 'CANCELLED',
            actorRole: 'SYSTEM',
            reason: cancelReason,
            at: new Date(),
          },
        ],
      );
      if (!claimed) continue;

      await withdrawOpenOffers(claimed._id);
      await refundPartyForCancelledTask(claimed, systemActor);

      await recordAudit({
        action: 'TASK_CANCELLED',
        targetCollection: 'Task',
        targetId: claimed._id,
        metadata: { taskCode: claimed.taskCode, reason: cancelReason, maxAgeMinutes },
      });
      cancelled.push(claimed);
    } catch (err) {
      logger.error({ err, taskId: String(task._id) }, 'Failed to expire stale unclaimed task');
    }
  }
  return cancelled;
}

/**
 * Payouts nobody came back on.
 *
 * A captain who has already sent real money cannot be left waiting on a party
 * that never asked their customer, or a customer who never looked. Past the
 * deadline the payout approves itself, and the audit trail says so in as many
 * words rather than leaving it looking like somebody decided.
 *
 * Entirely server-side: no browser needs to be open, and a page refresh or a
 * re-login changes nothing. `autoApproveOnTimeout` clears the deadline in a
 * conditional write, so two overlapping sweeps cannot both approve one payout
 * and a confirmation arriving at the same instant is either applied or told
 * the payout is already decided — never both.
 */
export async function autoApproveUnconfirmedPayouts(): Promise<ITask[]> {
  const due = await Task.find({
    status: 'AUDIT_PENDING',
    confirmationDeadline: { $ne: null, $lte: new Date() },
  }).limit(200);

  const approved: ITask[] = [];
  for (const task of due) {
    try {
      const done = await autoApproveOnTimeout(task);
      if (done) approved.push(done);
    } catch (err) {
      // One payout that cannot be approved must not stop the rest.
      logger.error({ err, taskCode: task.taskCode }, 'Auto-approval on confirmation timeout failed');
    }
  }
  return approved;
}
