/**
 * ADMIN — RECONCILIATION
 *
 * Running the DMC reconciliation and reading past runs. The ledger is expected
 * to settle to exactly zero; a run that does not is the alarm.
 */
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, created, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { Task, ReconciliationRun, nextSequence } from '../../models';
import { parseStatement, reconcile, type SystemRecord } from '../../services/reconciliation.service';
import { recordAudit } from '../../services/audit.service';
import { paiseToRupees } from '../../utils/money';
import { adminActor } from './actor';
/**
 * Reconciliation: compare a mock statement against completed tasks.
 * The statement is fictional; this exercises the matching logic, not a real
 * bank feed.
 */
export const runReconciliation = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  if (!req.file) throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'A CSV statement file is required');

  const { rows, errors } = parseStatement(req.file.buffer);

  const completed = await Task.find({
    status: 'COMPLETED',
    providerReference: { $ne: null },
  })
    .select('providerReference amountPaise taskCode')
    .lean();

  const systemRecords: SystemRecord[] = completed
    .filter((t): t is typeof t & { providerReference: string } => Boolean(t.providerReference))
    .map((t) => ({
      reference: t.providerReference,
      amountPaise: t.amountPaise,
      taskId: String(t._id),
      taskCode: t.taskCode,
    }));

  const summary = reconcile(rows, systemRecords);

  const year = new Date().getFullYear();
  const runCode = `RECON-${year}-${String(await nextSequence(`recon:${year}`)).padStart(5, '0')}`;

  const run = await ReconciliationRun.create({
    runCode,
    uploadedBy: new Types.ObjectId(actor.userId),
    originalFileName: req.file.originalname,
    totalStatementRows: rows.length,
    matchedCount: summary.matched,
    discrepancyCount: summary.discrepancy,
    unmatchedStatementCount: summary.unmatchedStatement,
    unmatchedSystemCount: summary.unmatchedSystem,
    entries: summary.entries.map((e) => ({
      reference: e.reference,
      systemAmountPaise: e.systemAmountPaise,
      statementAmountPaise: e.statementAmountPaise,
      differencePaise: e.differencePaise,
      taskId: e.taskId && Types.ObjectId.isValid(e.taskId) ? new Types.ObjectId(e.taskId) : null,
      taskCode: e.taskCode,
      result: e.result,
      note: e.note,
    })),
  });

  await recordAudit({
    action: 'RECONCILIATION_RUN',
    targetCollection: 'ReconciliationRun',
    targetId: run._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    metadata: {
      runCode,
      matched: summary.matched,
      discrepancy: summary.discrepancy,
      unmatchedStatement: summary.unmatchedStatement,
      unmatchedSystem: summary.unmatchedSystem,
    },
  });

  return created(
    res,
    {
      runId: String(run._id),
      runCode,
      summary: {
        totalStatementRows: rows.length,
        matched: summary.matched,
        discrepancy: summary.discrepancy,
        unmatchedStatement: summary.unmatchedStatement,
        unmatchedSystem: summary.unmatchedSystem,
      },
      parseErrors: errors,
      entries: summary.entries.map((e) => ({
        reference: e.reference,
        systemAmount: e.systemAmountPaise != null ? paiseToRupees(e.systemAmountPaise) : null,
        statementAmount: e.statementAmountPaise != null ? paiseToRupees(e.statementAmountPaise) : null,
        difference: e.differencePaise != null ? paiseToRupees(e.differencePaise) : null,
        taskCode: e.taskCode,
        result: e.result,
        note: e.note ?? null,
      })),
    },
    'Reconciliation complete',
  );
});

export const reconciliationHistory = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as { page: number; limit: number };
  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    ReconciliationRun.find().select('-entries').sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
    ReconciliationRun.countDocuments(),
  ]);

  return ok(
    res,
    paginate(
      items.map((r) => ({
        id: String(r._id),
        runCode: r.runCode,
        fileName: r.originalFileName,
        totalStatementRows: r.totalStatementRows,
        matched: r.matchedCount,
        discrepancy: r.discrepancyCount,
        unmatchedStatement: r.unmatchedStatementCount,
        unmatchedSystem: r.unmatchedSystemCount,
        createdAt: r.createdAt.toISOString(),
      })),
      query.page,
      query.limit,
      total,
    ),
  );
});
