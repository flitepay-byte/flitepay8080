/**
 * A party saying an API payout never reached their customer.
 *
 * A payout created through the API approves itself the moment the captain
 * submits their transfer reference — there is nobody at the party to audit it,
 * so waiting for one would leave every payout hanging. That trade only works
 * if the party has a way to object *afterwards*, and this is it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT UNDO THE MONEY
 * ---------------------------------------------------------------------------
 *
 * By the time a dispute arrives the task is COMPLETED, which is terminal: the
 * captain has been paid and their collateral released. Reversing that from
 * here would be exactly the "credit early, compensate later" pattern the rest
 * of the system is built to avoid — and it would let a party claw back money
 * from a captain who really did make the transfer, on nothing but their word.
 *
 * So this records the objection and puts it in front of admin, who can see the
 * captain's reference and decide. Any money that has to move afterwards is
 * moved by that decision, by a person, with both sides visible.
 */
import { Types } from 'mongoose';
import { Task, type ITask } from '../models';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { recordAudit } from './audit.service';
import type { Role } from '../types';

export interface ActorContext {
  userId: string;
  role: Role;
  ip?: string;
}

/** Statuses in which objecting still means something. */
const DISPUTABLE = new Set(['COMPLETED', 'PROOF_SUBMITTED', 'AUDIT_PENDING']);

export async function disputePayoutTask(
  task: ITask,
  reason: string,
  actor: ActorContext,
): Promise<ITask> {
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Say what went wrong with the payout');
  }

  if (!DISPUTABLE.has(task.status)) {
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      task.status === 'CANCELLED' || task.status === 'EXPIRED'
        ? 'This payout never went out, so there is nothing to dispute'
        : `This payout is ${task.status} and cannot be disputed yet`,
    );
  }

  // Recorded on the task rather than moved through the state machine. The task
  // is terminal and must stay terminal — what is being raised is an objection
  // to a completed payment, not a new state for the payment itself.
  const flagged = await Task.findOneAndUpdate(
    { _id: task._id, payoutDisputedAt: null },
    {
      $set: {
        payoutDisputedAt: new Date(),
        payoutDisputeReason: trimmed,
        payoutDisputedBy: new Types.ObjectId(actor.userId),
      },
    },
    { new: true },
  );

  if (!flagged) {
    // Already raised. Returning it is the honest answer — a party asking twice
    // has not failed at anything, and there is only ever one objection.
    const current = await Task.findById(task._id);
    if (!current) throw AppError.notFound('Payout not found', ErrorCodes.TASK_NOT_FOUND);
    return current;
  }

  await recordAudit({
    action: 'TRANSACTION_DISPUTED',
    targetCollection: 'Task',
    targetId: flagged._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { payoutDisputed: true, reason: trimmed },
    metadata: { taskCode: flagged.taskCode, providerReference: flagged.providerReference ?? null },
  });

  return flagged;
}

/** Everything a party has objected to and admin has not yet answered. */
export async function listOpenPayoutDisputes(limit = 200): Promise<ITask[]> {
  return Task.find({ payoutDisputedAt: { $ne: null }, payoutDisputeResolvedAt: null })
    .sort({ payoutDisputedAt: 1 })
    .limit(limit)
    .lean() as unknown as Promise<ITask[]>;
}

/**
 * Admin's answer. Two outcomes, because only two things can be true: the
 * captain did make the transfer, or they did not.
 *
 * Neither outcome moves money here. Whatever is owed after the decision is
 * settled through the existing paths — a captain who did not pay owes it back
 * through their own balance, which admin can see — because a silent correcting
 * write on a terminal task is precisely how a ledger stops being checkable.
 */
export async function resolvePayoutDispute(
  taskId: string,
  decision: 'UPHELD' | 'REJECTED',
  reason: string,
  actor: ActorContext,
): Promise<ITask> {
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Give a reason both sides can read');
  }

  const resolved = await Task.findOneAndUpdate(
    { _id: taskId, payoutDisputedAt: { $ne: null }, payoutDisputeResolvedAt: null },
    {
      $set: {
        payoutDisputeResolvedAt: new Date(),
        payoutDisputeDecision: decision,
        payoutDisputeResolution: trimmed,
      },
    },
    { new: true },
  );
  if (!resolved) {
    throw AppError.conflict(ErrorCodes.INVALID_STATE_TRANSITION, 'This payout has no open dispute');
  }

  await recordAudit({
    action: 'TRANSACTION_DISPUTE_RESOLVED',
    targetCollection: 'Task',
    targetId: resolved._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { decision, resolution: trimmed },
    metadata: { taskCode: resolved.taskCode },
  });

  return resolved;
}
