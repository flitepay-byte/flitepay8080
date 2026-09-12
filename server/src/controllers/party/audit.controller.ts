import type { Request, Response } from 'express';
import { asyncHandler, ok, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { Task, findLiveProof } from '../../models';
import { approveTask, rejectTask } from '../../services/workflow.service';
import type { RejectionCategory } from '../../utils/rejectionCategories';
import * as collateral from '../../services/collateral.service';
import { notifyProofApproved, notifyProofRejected, notifyLimitUpdated } from '../../services/notification.service';
import { toPartyTaskDto, toProofDto } from '../../utils/serializers';
import { paiseToRupees } from '../../utils/money';
import { partyContext } from './context';
/**
 * PARTY AUDIT DESK — the party that placed the task now decides whether the
 * captain's proof is good, not admin. Scoped strictly to the party's own
 * tasks (unlike admin's equivalent, which sees every task); captain identity
 * stays stripped, exactly like every other party-facing task view.
 */
export const auditQueue = asyncHandler(async (req: Request, res: Response) => {
  const { partyId } = partyContext(req);
  const query = req.query as unknown as { page: number; limit: number };
  const skip = (query.page - 1) * query.limit;
  const filter = { status: 'AUDIT_PENDING', partyId };

  const [items, total] = await Promise.all([
    Task.find(filter).sort({ proofSubmittedAt: 1 }).skip(skip).limit(query.limit),
    Task.countDocuments(filter),
  ]);

  const stripped = items.map((task) => {
    const dto = toPartyTaskDto(task);
    return dto;
  });
  return ok(res, paginate(stripped, query.page, query.limit, total));
});

/**
 * The other thing waiting on this party's decision: a captain who has asked to
 * drop a task they were holding. It belongs beside the proof queue on the
 * audit desk rather than buried in the task list, because the captain is
 * blocked until the party answers.
 */
export const cancelReviewQueue = asyncHandler(async (req: Request, res: Response) => {
  const { partyId } = partyContext(req);
  const query = req.query as unknown as { page: number; limit: number };
  const skip = (query.page - 1) * query.limit;
  // Only the captain's own requests — a party never reviews its own.
  const filter = { status: 'CANCEL_REVIEW', partyId, cancelInitiatedBy: 'CAPTAIN' };

  const [items, total] = await Promise.all([
    Task.find(filter).sort({ updatedAt: 1 }).skip(skip).limit(query.limit),
    Task.countDocuments(filter),
  ]);

  // Captain identity is need-to-know for admin only, as everywhere else a
  // party sees a task.
  const stripped = items.map((task) => {
    const dto = toPartyTaskDto(task);
    return dto;
  });
  return ok(res, paginate(stripped, query.page, query.limit, total));
});

export const auditDetail = asyncHandler(async (req: Request, res: Response) => {
  const { partyId } = partyContext(req);
  const taskId = req.params['taskId'] as string;
  const task = await Task.findOne({ _id: taskId, partyId });
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  const proof = await findLiveProof(task._id);
  const taskDto = toPartyTaskDto(task);

  return ok(res, {
    task: taskDto,
    proof: proof ? toProofDto(proof) : null,
    // The reference the captain reported for the payment they made. Nothing in
    // this system issued it, so there is nothing here to check it against —
    // the party checks it against their own record of the customer being paid.
    reportedReference: proof?.providerReference ?? task.providerReference,
    stateHistory: task.stateHistory.map((e) => ({
      from: e.from,
      to: e.to,
      role: e.actorRole,
      reason: e.reason ?? null,
      at: e.at.toISOString(),
    })),
  });
});

export const auditApprove = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const taskId = req.params['taskId'] as string;
  const owned = await Task.exists({ _id: taskId, partyId });
  if (!owned) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  const { task, commissionPaise } = await approveTask(taskId, actor);

  if (task.captainId) {
    notifyProofApproved(task, String(task.captainId), commissionPaise);
    const view = await collateral.getCollateral(task.captainId);
    notifyLimitUpdated(String(task.captainId), view.availableLimitPaise);
  }

  const taskDto = toPartyTaskDto(task);
  return ok(res, { task: taskDto, commission: paiseToRupees(commissionPaise) }, 'Task approved and commission credited');
});

export const auditReject = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const taskId = req.params['taskId'] as string;
  const owned = await Task.exists({ _id: taskId, partyId });
  if (!owned) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  const { reason, category } = req.body as { reason: string; category: RejectionCategory };
  const beforeCaptainId = (await Task.findById(taskId).select('captainId').lean())?.captainId;
  const task = await rejectTask(taskId, reason, category, actor);

  if (beforeCaptainId) {
    notifyProofRejected(task, String(beforeCaptainId), reason);
    const view = await collateral.getCollateral(beforeCaptainId);
    notifyLimitUpdated(String(beforeCaptainId), view.availableLimitPaise);
  }

  const taskDto = toPartyTaskDto(task);
  return ok(res, taskDto, 'Task rejected — sent to admin for review');
});
