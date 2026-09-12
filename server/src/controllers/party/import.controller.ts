import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, created } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { ImportBatch } from '../../models';
import { createTask } from '../../services/task.service';
import { createPreviewBatch, buildErrorReportCsv } from '../../services/csvImport.service';
import { notifyTaskAvailable } from '../../services/notification.service';
import { recordAudit } from '../../services/audit.service';
import { paiseToRupees } from '../../utils/money';
import type { ValidRow } from '../../services/csvImport.service';
import { partyContext } from './context';
/** Step 1 of bulk import: validate and stage, creating nothing. */
export const previewImport = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  if (!req.file) throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'A CSV file is required');

  const preview = await createPreviewBatch(
    req.file.buffer,
    req.file.originalname,
    partyId,
    new Types.ObjectId(actor.userId),
  );

  return ok(
    res,
    {
      ...preview,
      sample: preview.sample.map((row) => ({
        rowNumber: row.rowNumber,
        customerName: row.customerName,
        identifier: row.identifier,
        amount: paiseToRupees(row.amountPaise),
        externalRef: row.externalRef,
      })),
    },
    `${preview.valid} of ${preview.total} rows are ready to import`,
  );
});

/** Step 2: create tasks from a previously staged batch. */
export const confirmImport = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const { batchId } = req.body as { batchId: string };

  const batch = await ImportBatch.findOne({ _id: batchId, partyId });
  if (!batch) throw AppError.notFound('Import batch not found', ErrorCodes.IMPORT_BATCH_NOT_FOUND);
  if (batch.status !== 'PREVIEW') {
    throw AppError.conflict(ErrorCodes.CONFLICT, `This batch has already been ${batch.status.toLowerCase()}`);
  }

  const rows = batch.stagedRows as ValidRow[];
  const createdTasks: string[] = [];
  const failures: Array<{ externalRef: string; message: string }> = [];

  for (const row of rows) {
    try {
      const task = await createTask(
        {
          partyId,
          createdBy: new Types.ObjectId(actor.userId),
          customerName: row.customerName,
          identifier: row.identifier,
          amountPaise: row.amountPaise,
          externalRef: row.externalRef,
          batchId: batch._id,
        },
        actor,
      );
      createdTasks.push(String(task._id));
      notifyTaskAvailable(task, task.commissionPaise ?? 0);
    } catch (err) {
      // One bad row must not abort the whole import; it is reported instead.
      failures.push({
        externalRef: row.externalRef,
        message: err instanceof AppError ? err.message : 'Could not create task',
      });
    }
  }

  batch.status = 'IMPORTED';
  batch.importedRows = createdTasks.length;
  batch.importedAt = new Date();
  await batch.save();

  await recordAudit({
    action: 'TASK_BULK_IMPORTED',
    targetCollection: 'ImportBatch',
    targetId: batch._id,
    userId: actor.userId,
    role: 'PARTY',
    ip: actor.ip,
    metadata: {
      batchCode: batch.batchCode,
      imported: createdTasks.length,
      failed: failures.length,
    },
  });

  return created(
    res,
    { batchId: String(batch._id), batchCode: batch.batchCode, imported: createdTasks.length, failures },
    `Imported ${createdTasks.length} task(s)`,
  );
});

export const downloadErrorReport = asyncHandler(async (req: Request, res: Response) => {
  const { partyId } = partyContext(req);
  const batch = await ImportBatch.findOne({ _id: req.params['batchId'], partyId }).lean();
  if (!batch) throw AppError.notFound('Import batch not found', ErrorCodes.IMPORT_BATCH_NOT_FOUND);

  const invalid = batch.rowErrors.filter((e) => !e.message.toLowerCase().includes('duplicate'));
  const duplicates = batch.rowErrors.filter((e) => e.message.toLowerCase().includes('duplicate'));
  const csv = buildErrorReportCsv(invalid, duplicates);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${batch.batchCode}-errors.csv"`);
  res.send(csv);
});
