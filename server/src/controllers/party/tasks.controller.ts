import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, created, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { Task, findLiveProof, type ITaskPayoutMethod } from '../../models';
import { createTask } from '../../services/task.service';
import { requestCancellation, reviewCancellationAsParty } from '../../services/workflow.service';
import { applyTaskSearch } from '../../utils/taskSearch';
import { notifyTaskAvailable, notifyCancelRequested, notifyCancelReviewed } from '../../services/notification.service';
import { toPartyTaskDto, toProofDto } from '../../utils/serializers';
import { verifyFileSignature } from '../../middleware/upload.middleware';
import { uploadFile, deleteFile } from '../../services/storage.service';
import type { PayoutMethodFormInput } from '../../validators/task.validators';
import { applyCustomerConfirmation } from '../../services/customerConfirmation.service';
import { partyContext } from './context';
export const create = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const body = req.body as { customerName: string; amount: number; externalRef?: string } & PayoutMethodFormInput;
  const file = req.file;

  let screenshot: { url: string; publicId: string; fileName: string; mimeType: string } | undefined;
  if (body.payoutType === 'UPI' && file) {
    if (file.mimetype !== 'image/jpeg' && file.mimetype !== 'image/png') {
      throw AppError.badRequest(ErrorCodes.UNSUPPORTED_FILE_TYPE, 'The screenshot must be a JPEG or PNG image');
    }
    // A declared MIME type is attacker-controlled, so the bytes are checked
    // before anything is uploaded.
    if (!verifyFileSignature(file.buffer, file.mimetype)) {
      throw AppError.badRequest(
        ErrorCodes.UNSUPPORTED_FILE_TYPE,
        'The uploaded file contents do not match its declared type',
      );
    }
    const uploaded = await uploadFile(file.buffer, file.mimetype);
    screenshot = { url: uploaded.url, publicId: uploaded.publicId, fileName: file.originalname, mimeType: file.mimetype };
  }

  const payoutMethod: ITaskPayoutMethod =
    body.payoutType === 'BANK'
      ? {
          type: 'BANK',
          bankName: body.bankName,
          accountNumber: body.accountNumber,
          ifscCode: body.ifscCode,
          accountHolderName: body.accountHolderName,
        }
      : body.payoutType === 'UPI'
        ? {
            type: 'UPI',
            upiId: body.upiId,
            screenshotUrl: screenshot?.url ?? null,
            screenshotFileName: screenshot?.fileName ?? null,
            screenshotMimeType: screenshot?.mimeType ?? null,
          }
        : { type: 'USDT', walletAddress: body.walletAddress };

  try {
    const task = await createTask(
      {
        partyId,
        createdBy: new Types.ObjectId(actor.userId),
        customerName: body.customerName,
        payoutMethod,
        amountPaise: body.amount,
        // Passed through so a repeated submission collides on the unique
        // (partyId, externalRef) index instead of billing the party twice.
        ...(body.externalRef ? { externalRef: body.externalRef } : {}),
      },
      actor,
    );

    notifyTaskAvailable(task, task.commissionPaise ?? 0);
    return created(res, toPartyTaskDto(task), 'Task created');
  } catch (err) {
    // Do not leave an orphaned upload behind if task creation is rejected.
    if (screenshot) await deleteFile(screenshot.publicId, screenshot.mimeType);
    throw err;
  }
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { partyId } = partyContext(req);
  const query = req.query as unknown as {
    page: number;
    limit: number;
    status?: string;
    search?: string;
    from?: Date;
    to?: Date;
  };

  const filter: Record<string, unknown> = { partyId };
  if (query.status) filter['status'] = query.status;
  if (query.from || query.to) {
    filter['createdAt'] = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }
  // The party owns the tracking reference, so it is searched too.
  applyTaskSearch(filter, query.search, { includeExternalRef: true });

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    Task.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    Task.countDocuments(filter),
  ]);

  return ok(res, paginate(items.map(toPartyTaskDto), query.page, query.limit, total));
});

/**
 * A party sees proof of completion but never which captain is assigned —
 * captain identity is need-to-know for admin and the captain themselves only.
 */
export const detail = asyncHandler(async (req: Request, res: Response) => {
  const { partyId } = partyContext(req);
  const task = await Task.findOne({ _id: req.params['taskId'], partyId });
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  const proof = await findLiveProof(task._id);
  const taskDto = toPartyTaskDto(task);

  return ok(res, {
    ...taskDto,
    proof: proof ? toProofDto(proof) : null,
    stateHistory: task.stateHistory.map((event) => ({
      from: event.from,
      to: event.to,
      role: event.actorRole,
      reason: event.reason ?? null,
      at: event.at.toISOString(),
    })),
  });
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const taskId = req.params['taskId'] as string;
  const owned = await Task.exists({ _id: taskId, partyId });
  if (!owned) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  const task = await requestCancellation(taskId, (req.body as { reason: string }).reason, actor);
  const taskDto = toPartyTaskDto(task);
  if (task.status === 'CANCEL_REVIEW') {
    notifyCancelRequested(task);
    return ok(res, taskDto, 'Cancellation requested — awaiting the captain’s review');
  }
  return ok(res, taskDto, 'Task cancelled');
});

/**
 * The party's decision on a cancellation the CAPTAIN requested for a task
 * they hold. Approving finalises it; rejecting escalates to admin.
 */
export const reviewCancel = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const taskId = req.params['taskId'] as string;
  const { decision, reason } = req.body as { decision: 'APPROVE' | 'REJECT'; reason?: string };

  const task = await reviewCancellationAsParty(taskId, partyId, decision, reason, actor);
  notifyCancelReviewed(task, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED');

  const taskDto = toPartyTaskDto(task);
  return ok(
    res,
    taskDto,
    decision === 'APPROVE' ? 'Cancellation approved' : 'Cancellation disputed — escalated to admin',
  );
});

/**
 * A dashboard party relaying their customer's answer.
 *
 * The same function the API endpoint calls, so an integrated party and one
 * working from the dashboard settle a payout by exactly the same rules — and
 * a change to those rules cannot reach one and miss the other.
 */
export const confirmPayout = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const { received, reason } = req.body as { received: boolean; reason?: string };

  const task = await applyCustomerConfirmation({
    taskId: req.params['taskId'] as string,
    partyId,
    received,
    ...(reason ? { reason } : {}),
    actor,
  });

  return ok(
    res,
    toPartyTaskDto(task),
    received ? 'Payout approved' : 'Reported to an administrator for review',
  );
});
