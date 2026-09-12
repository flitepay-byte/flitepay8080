import { Types } from 'mongoose';
import { Task, Party, type ITask } from '../models';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { approveTask, rejectTask } from './workflow.service';
import { recordAudit } from './audit.service';
import { notifyPayoutSettled } from './notification.service';
import type { ActorContext } from './task.service';

/**
 * THE PARTY RELAYS THEIR CUSTOMER'S ANSWER.
 *
 * OTDMS never speaks to a customer. It has no account for them, no channel to
 * them, and deliberately holds none of their contact details — the party owns
 * that relationship and already has a way to reach them. So the chain runs
 *
 *     captain -> OTDMS -> party -> customer
 *
 * and the answer comes back the same way, through this one function. There is
 * no path from a customer to OTDMS and none from a customer to admin; a
 * dispute reaches admin only because the party brought it.
 *
 * Both halves reuse what already exists rather than adding a parallel scheme:
 * "received" is the approval the party would otherwise have made by hand, and
 * "not received" is the rejection — which already lands in REJECTED, and
 * REJECTED is already what the admin Review queue reads. Nothing new needed a
 * state, and nothing new needed a queue.
 */
export interface ConfirmationInput {
  taskId: Types.ObjectId | string;
  partyId: Types.ObjectId;
  received: boolean;
  /** Required when the answer is no — admin will read it. */
  reason?: string;
  actor: ActorContext;
}

/**
 * Load the task, and refuse anything that is not this party's to answer.
 *
 * Scoped by partyId in the query itself rather than checked afterwards: one
 * party must never be able to settle another's payout, and a filter applied
 * after the read is one refactor away from being dropped.
 */
async function loadAwaiting(taskId: Types.ObjectId | string, partyId: Types.ObjectId): Promise<ITask> {
  if (!Types.ObjectId.isValid(String(taskId))) {
    throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  }
  const task = await Task.findOne({ _id: taskId, partyId });
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);
  return task;
}

/**
 * Apply the customer's answer.
 *
 * The deadline is cleared in one conditional write before anything else
 * happens, and that write is what decides. It is the same claim-before-money
 * shape the rest of the app uses: the sweep that auto-approves on timeout
 * clears the very same field, so an answer arriving in the same instant as the
 * deadline can only be applied by whichever write lands first. The loser is
 * told the payout has already been decided rather than deciding it twice.
 */
export async function applyCustomerConfirmation(input: ConfirmationInput): Promise<ITask> {
  const task = await loadAwaiting(input.taskId, input.partyId);

  if (!input.received && (!input.reason || input.reason.trim().length < 5)) {
    throw AppError.badRequest(
      ErrorCodes.REJECTION_REASON_REQUIRED,
      'Say what your customer reported, in at least 5 characters',
    );
  }

  const now = new Date();
  const claimed = await Task.findOneAndUpdate(
    { _id: task._id, status: 'AUDIT_PENDING', confirmationDeadline: { $ne: null } },
    { $set: { confirmationDeadline: null } },
    { new: true },
  );
  if (!claimed) {
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      'This payout is no longer waiting on your customer',
      { status: task.status },
    );
  }

  await recordAudit({
    action: input.received ? 'TASK_CUSTOMER_CONFIRMED' : 'TASK_CUSTOMER_DISPUTED',
    targetCollection: 'Task',
    targetId: task._id,
    userId: input.actor.userId,
    role: input.actor.role,
    ip: input.actor.ip,
    oldState: { status: 'AUDIT_PENDING' },
    metadata: {
      taskCode: task.taskCode,
      // The whole trail in one row: when we asked, by when we needed it, and
      // when it came — so how long the customer took is answerable later
      // without joining anything.
      requestedAt: task.confirmationRequestedAt?.toISOString() ?? null,
      deadline: task.confirmationDeadline?.toISOString() ?? null,
      respondedAt: now.toISOString(),
      received: input.received,
      ...(input.reason ? { reason: input.reason.trim() } : {}),
    },
  });

  if (input.received) {
    const owner = await Party.findById(input.partyId).select('userId').lean();
    const completed = await approveTask(String(task._id), {
      userId: String(owner?.userId ?? input.actor.userId),
      role: 'PARTY',
      ip: input.actor.ip,
    });
    notifyPayoutSettled(completed.task);
    return completed.task;
  }

  /**
   * Not received. The existing rejection path takes it from here: REJECTED is
   * where a disputed proof already waits, and the admin Review queue already
   * reads that state. Admin's two options are unchanged — overrule it, or
   * reassign the task — which is exactly the last-resort arbitration they
   * already have and not a second review system.
   */
  return rejectTask(
    String(task._id),
    input.reason!.trim(),
    // The category that already exists for exactly this: the money never
    // reached the customer. A customer saying so is the same finding, reported
    // through the party rather than noticed by them.
    'NOT_RECEIVED',
    input.actor,
  );
}

/**
 * Approve a payout nobody came back on.
 *
 * Used only by the sweep. The same conditional clear as an answer, so a
 * confirmation arriving at the deadline cannot be overtaken by this — and so
 * two sweeps overlapping cannot both approve one payout.
 *
 * Returns null when there was nothing left to do, which is the honest answer
 * for a sweep that lost the race rather than an error.
 */
export async function autoApproveOnTimeout(task: ITask): Promise<ITask | null> {
  const claimed = await Task.findOneAndUpdate(
    { _id: task._id, status: 'AUDIT_PENDING', confirmationDeadline: { $ne: null, $lte: new Date() } },
    { $set: { confirmationDeadline: null } },
    { new: true },
  );
  if (!claimed) return null;

  const owner = await Party.findById(task.partyId).select('userId').lean();
  if (!owner) return null;

  const systemActor: ActorContext = { userId: String(owner.userId), role: 'PARTY' };
  const completed = await approveTask(String(task._id), systemActor);

  await recordAudit({
    action: 'TASK_AUTO_APPROVED',
    targetCollection: 'Task',
    targetId: task._id,
    userId: String(owner.userId),
    role: 'PARTY',
    metadata: {
      taskCode: task.taskCode,
      reason: 'Auto-approved — customer did not respond within configured confirmation window.',
      requestedAt: task.confirmationRequestedAt?.toISOString() ?? null,
      deadline: task.confirmationDeadline?.toISOString() ?? null,
      autoApprovedAt: new Date().toISOString(),
    },
  });

  notifyPayoutSettled(completed.task);
  return completed.task;
}
