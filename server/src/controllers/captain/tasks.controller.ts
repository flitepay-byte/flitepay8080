import type { Request, Response } from 'express';
import { asyncHandler, ok, created, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { Task, Captain, Proof, findLiveProof } from '../../models';
import { claimTask } from '../../services/task.service';
import {
  startTask,
  submitProof,
  rejectExpiredTask,
  requestCancellation,
  reviewCancellationAsCaptain,
} from '../../services/workflow.service';
import * as collateral from '../../services/collateral.service';
import { currentLimitPaise } from '../../services/captainCapacity.service';
import { notifyTaskClaimed, notifyAuditRequired, notifyLimitUpdated, notifyCancelRequested, notifyCancelReviewed } from '../../services/notification.service';
import { toCaptainTaskDto, toQueueCardDto, toProofDto } from '../../utils/serializers';
import { paiseToRupees } from '../../utils/money';
import { verifyFileSignature } from '../../middleware/upload.middleware';
import { uploadFile, deleteFile } from '../../services/storage.service';
import { CLAIMABLE_STATES, DMC_HELD_STATES } from '../../types';
import { applyTaskSearch } from '../../utils/taskSearch';
import { captainContext } from './context';

/**
 * Available task queue.
 *
 * Filtered server-side by the captain's own available limit, so a task they
 * could not claim is never shown. This is a usability measure; the claim
 * endpoint re-checks eligibility regardless.
 */
export const queue = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const query = req.query as unknown as { page: number; limit: number };

  const view = await collateral.getCollateral(captainId);
  /**
   * What this captain may actually take on, which is what the queue must be
   * filtered by — see captainCapacity.service.ts.
   *
   * It was filtered by collateral headroom, which is the ceiling and takes no
   * account of the capital behind it. A captain whose whole balance was earned
   * commission was shown a payout of three thousand against a Current Limit of
   * nothing, and the claim then refused it. The screen has to ask the question
   * the claim will answer.
   */
  const doc = await Captain.findById(captainId)
    .select('creditLimitPaise collateralBalancePaise dmcBalancePaise commissionEarnedTotalPaise')
    .lean();
  if (!doc) throw AppError.notFound('Captain profile not found');
  const limitPaise = currentLimitPaise(doc);

  // A task is offered to one captain at a time (see taskRouting.service.ts),
  // so the queue holds what is offered to *me*, plus anything that ran out of
  // captains and fell back to the open pool.
  const filter = {
    status: { $in: [...CLAIMABLE_STATES] },
    captainId: null,
    amountPaise: { $lte: limitPaise },
    // A captain who already had this task rejected is not re-offered it.
    previousCaptainIds: { $ne: captainId },
    // An offer drops out of the queue the moment its window closes, rather
    // than lingering until the once-a-minute sweeper retires it — the claim
    // guard in task.service.ts enforces the same deadline.
    $or: [
      { offeredCaptainId: captainId, offerExpiresAt: { $gt: new Date() } },
      { openPoolAt: { $ne: null } },
    ],
  };

  const skip = (query.page - 1) * query.limit;
  const [tasks, total] = await Promise.all([
    // Oldest first, so the queue is fair rather than favouring fresh tasks.
    Task.find(filter).sort({ createdAt: 1 }).skip(skip).limit(query.limit),
    Task.countDocuments(filter),
  ]);

  // Commission is locked in at task creation now, not re-estimated here.
  const cards = tasks.map((task) => toQueueCardDto(task, task.commissionPaise ?? 0));

  return ok(res, {
    ...paginate(cards, query.page, query.limit, total),
    availableLimit: paiseToRupees(view.availableLimitPaise),
  });
});

/** The contended endpoint. Concurrency safety lives in the service layer. */
export const claim = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const taskId = req.params['taskId'] as string;

  const result = await claimTask(taskId, captainId, actor);

  notifyTaskClaimed(result.task, String(captainId));
  notifyLimitUpdated(String(captainId), result.collateral.availableLimitPaise);

  return ok(
    res,
    {
      task: toCaptainTaskDto(result.task, captainId),
      collateral: {
        collateralBalance: paiseToRupees(result.collateral.collateralBalancePaise),
        lockedAmount: paiseToRupees(result.collateral.lockedAmountPaise),
        availableLimit: paiseToRupees(result.collateral.availableLimitPaise),
      },
    },
    'Task claimed',
  );
});

export const start = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const task = await startTask(req.params['taskId'] as string, captainId, actor);
  return ok(res, toCaptainTaskDto(task, captainId), 'Task started');
});

/**
 * Captain's acknowledgement of a missed deadline: records why, then rejects
 * and returns the task to the pool for another captain.
 */
export const rejectExpired = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const { reason } = req.body as { reason: string };
  const task = await rejectExpiredTask(req.params['taskId'] as string, captainId, reason, actor);
  return ok(res, toCaptainTaskDto(task, captainId), 'Task returned to the pool');
});

export const submitTaskProof = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const body = req.body as { providerReference: string; notes?: string };
  const file = req.file;

  let receipt:
    | { originalName: string; url: string; publicId: string; mimeType: string; sizeBytes: number }
    | undefined;

  if (file) {
    // A declared MIME type is attacker-controlled, so the bytes are checked
    // before anything is uploaded.
    if (!verifyFileSignature(file.buffer, file.mimetype)) {
      throw AppError.badRequest(
        ErrorCodes.UNSUPPORTED_FILE_TYPE,
        'The uploaded file contents do not match its declared type',
      );
    }
    const uploaded = await uploadFile(file.buffer, file.mimetype);
    receipt = {
      originalName: file.originalname,
      url: uploaded.url,
      publicId: uploaded.publicId,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    };
  }

  try {
    const task = await submitProof(
      {
        taskId: req.params['taskId'] as string,
        captainId,
        providerReference: body.providerReference,
        notes: body.notes,
        receipt,
      },
      actor,
    );

    notifyAuditRequired(task);
    return created(res, toCaptainTaskDto(task, captainId), 'Proof submitted and queued for audit');
  } catch (err) {
    // Do not leave an orphaned upload behind if the submission is rejected.
    if (receipt) await deleteFile(receipt.publicId, receipt.mimeType);
    throw err;
  }
});

export const myTasks = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const query = req.query as unknown as {
    page: number; limit: number; status?: string; search?: string; holding?: boolean;
  };

  // Tasks they hold now, plus ones they used to. A task rejected off a captain
  // and handed to someone else was still their work, and vanishing from their
  // own history is not something they can explain to anyone — so it stays,
  // frozen at the point they lost it (see toCaptainTaskDto).
  //
  // Kept in `$and` so it survives alongside the search's own `$or`.
  const filter: Record<string, unknown> = {
    $and: [{ $or: [{ captainId }, { previousCaptainIds: captainId }] }],
  };
  if (query.holding) {
    // What their money is actually committed to right now: held by them, and
    // in a state where the DMC taken at the claim has not yet come back.
    filter['status'] = { $in: [...DMC_HELD_STATES] };
    (filter['$and'] as Array<Record<string, unknown>>).push({ captainId });
  }
  if (query.status) {
    filter['status'] = query.status;
    // A live status only describes a task they still hold. Matching released
    // ones against it would let them ask "is the task I lost COMPLETED yet?"
    // and read the answer off whether the row comes back.
    (filter['$and'] as Array<Record<string, unknown>>).push({ captainId });
  }
  // No externalRef here: a captain never receives it, so letting them search
  // it would just turn the search box into a way to confirm one by guessing.
  applyTaskSearch(filter, query.search, { includeExternalRef: false });

  const skip = (query.page - 1) * query.limit;
  const [tasks, total] = await Promise.all([
    // A released task has had its claimedAt cleared, so it sorts last — which
    // is where finished history belongs, under whatever they are working on.
    Task.find(filter).sort({ claimedAt: -1, createdAt: -1 }).skip(skip).limit(query.limit),
    Task.countDocuments(filter),
  ]);

  return ok(res, paginate(tasks.map((t) => toCaptainTaskDto(t, captainId)), query.page, query.limit, total));
});

/** Full detail for one of the captain's own tasks, including any submitted proof. */
export const taskDetail = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const task = await Task.findOne({
    _id: req.params['taskId'],
    $or: [{ captainId }, { previousCaptainIds: captainId }],
  });
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  const released = !task.captainId || String(task.captainId) !== String(captainId);

  // A released captain's history stops where their involvement did. Past that
  // point the events belong to whoever holds the task now — how fast they
  // claimed it, whether they finished — and none of it is this captain's to
  // read. Their own last event is the cut.
  const lastOwnIndex = task.stateHistory.reduce(
    (found, event, index) => (event.captainId && String(event.captainId) === String(captainId) ? index : found),
    -1,
  );
  const visibleHistory = released ? task.stateHistory.slice(0, lastOwnIndex + 1) : task.stateHistory;

  // The live proof belongs to whoever is working it now; a released captain
  // gets nothing rather than a stranger's evidence.
  const proof = released ? null : await findLiveProof(task._id);

  return ok(res, {
    ...toCaptainTaskDto(task, captainId),
    proof: proof ? toProofDto(proof) : null,
    stateHistory: visibleHistory.map((event) => ({
      from: event.from,
      to: event.to,
      role: event.actorRole,
      reason: event.reason ?? null,
      at: event.at.toISOString(),
    })),
  });
});

export const taskProof = asyncHandler(async (req: Request, res: Response) => {
  const { captainId } = captainContext(req);
  const proof = await Proof.findOne({ taskId: req.params['taskId'], captainId });
  if (!proof) throw AppError.notFound('No proof has been submitted for this task', ErrorCodes.PROOF_REQUIRED);
  return ok(res, toProofDto(proof));
});

/**
 * "PAY IN" — a captain cashing out earned DMC. See withdrawal.service.ts.
 */

/** The captain's own request to cancel a task they hold — reviewed by the party, never by admin directly. */
export const requestCancel = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const taskId = req.params['taskId'] as string;
  const owned = await Task.exists({ _id: taskId, captainId });
  if (!owned) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  const { reason } = req.body as { reason: string };
  const task = await requestCancellation(taskId, reason, actor);
  notifyCancelRequested(task);

  return ok(res, toCaptainTaskDto(task, captainId), 'Cancellation requested — awaiting the party’s review');
});

/** The captain's decision on a cancellation the PARTY requested for a task they hold. */
export const reviewCancel = asyncHandler(async (req: Request, res: Response) => {
  const { captainId, actor } = captainContext(req);
  const taskId = req.params['taskId'] as string;
  const { decision, reason } = req.body as { decision: 'APPROVE' | 'REJECT'; reason?: string };

  const task = await reviewCancellationAsCaptain(taskId, captainId, decision, reason, actor);
  notifyCancelReviewed(task, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED');

  return ok(
    res,
    toCaptainTaskDto(task, captainId),
    decision === 'APPROVE' ? 'Cancellation approved' : 'Cancellation disputed — escalated to admin',
  );
});

// ---------------------------------------------------------------------------
// The captain's own money: commission, capital, and cashing out
// ---------------------------------------------------------------------------
