import { parse } from 'csv-parse/sync';
import { Types } from 'mongoose';
import { Task, ImportBatch, nextSequence, type IImportRowError } from '../models';
import { rupeesToPaise, MoneyError, formatPaise } from '../utils/money';
import { formatBatchCode } from '../utils/ids';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { getConfig } from './systemConfig.service';

export const CSV_HEADERS = ['customerName', 'identifier', 'amount', 'externalRef'] as const;

export interface RawCsvRow {
  customerName?: string;
  identifier?: string;
  amount?: string;
  externalRef?: string;
}

export interface ValidRow {
  rowNumber: number;
  customerName: string;
  identifier: string;
  amountPaise: number;
  externalRef: string;
}

export interface ValidationOutcome {
  total: number;
  valid: ValidRow[];
  errors: IImportRowError[];
  duplicates: IImportRowError[];
}

export interface ValidationBounds {
  minimumTaskAmountPaise: number;
  maximumTaskAmountPaise: number;
}

/**
 * Pure row validation. Kept free of database access so it can be unit tested
 * and so the preview and the import share exactly one implementation.
 *
 * `existingRefs` carries references already present for this party, which is
 * how cross-file duplicates are detected in addition to within-file ones.
 */
export function validateRows(
  rows: RawCsvRow[],
  bounds: ValidationBounds,
  existingRefs: ReadonlySet<string> = new Set(),
): ValidationOutcome {
  const valid: ValidRow[] = [];
  const errors: IImportRowError[] = [];
  const duplicates: IImportRowError[] = [];
  const seenInFile = new Set<string>();

  rows.forEach((row, index) => {
    // Row 1 is the header, so data starts at 2.
    const rowNumber = index + 2;
    const rowErrors: IImportRowError[] = [];

    const customerName = (row.customerName ?? '').trim();
    const identifier = (row.identifier ?? '').trim();
    const externalRef = (row.externalRef ?? '').trim();
    const amountRaw = (row.amount ?? '').trim();

    if (!customerName) {
      rowErrors.push({ rowNumber, field: 'customerName', message: 'Customer name is required' });
    } else if (customerName.length > 160) {
      rowErrors.push({ rowNumber, field: 'customerName', message: 'Customer name exceeds 160 characters' });
    }

    if (!identifier) {
      rowErrors.push({ rowNumber, field: 'identifier', message: 'Identifier is required' });
    }

    if (!externalRef) {
      rowErrors.push({ rowNumber, field: 'externalRef', message: 'External reference is required' });
    } else if (!/^[A-Za-z0-9._\-/]+$/.test(externalRef)) {
      rowErrors.push({
        rowNumber,
        field: 'externalRef',
        message: 'Reference may only contain letters, numbers, and . _ - /',
        rawValue: externalRef,
      });
    }

    let amountPaise = 0;
    if (!amountRaw) {
      rowErrors.push({ rowNumber, field: 'amount', message: 'Amount is required' });
    } else {
      try {
        amountPaise = rupeesToPaise(amountRaw);
        if (amountPaise <= 0) {
          rowErrors.push({
            rowNumber,
            field: 'amount',
            message: 'Amount must be greater than zero',
            rawValue: amountRaw,
          });
        } else if (amountPaise < bounds.minimumTaskAmountPaise) {
          rowErrors.push({
            rowNumber,
            field: 'amount',
            message: `Amount is below the minimum of ${formatPaise(bounds.minimumTaskAmountPaise)}`,
            rawValue: amountRaw,
          });
        } else if (amountPaise > bounds.maximumTaskAmountPaise) {
          rowErrors.push({
            rowNumber,
            field: 'amount',
            message: `Amount exceeds the maximum of ${formatPaise(bounds.maximumTaskAmountPaise)}`,
            rawValue: amountRaw,
          });
        }
      } catch (err) {
        rowErrors.push({
          rowNumber,
          field: 'amount',
          message: err instanceof MoneyError ? err.message : 'Invalid amount',
          rawValue: amountRaw,
        });
      }
    }

    // Duplicates are counted separately from validation failures, because the
    // import screen reports them as their own category.
    if (externalRef) {
      const key = externalRef.toLowerCase();
      if (seenInFile.has(key)) {
        duplicates.push({
          rowNumber,
          field: 'externalRef',
          message: 'Duplicate reference within this file',
          rawValue: externalRef,
        });
        return;
      }
      if (existingRefs.has(key)) {
        duplicates.push({
          rowNumber,
          field: 'externalRef',
          message: 'A task with this reference already exists',
          rawValue: externalRef,
        });
        seenInFile.add(key);
        return;
      }
      seenInFile.add(key);
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      return;
    }

    valid.push({ rowNumber, customerName, identifier, amountPaise, externalRef });
  });

  return { total: rows.length, valid, errors, duplicates };
}

/** Parse a CSV buffer into raw rows, with a clear error on malformed input. */
export function parseCsv(buffer: Buffer): RawCsvRow[] {
  let records: RawCsvRow[];
  try {
    records = parse(buffer, {
      columns: (header: string[]) => header.map((h) => h.trim()),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    }) as RawCsvRow[];
  } catch (err) {
    throw AppError.badRequest(
      ErrorCodes.CSV_PARSE_ERROR,
      err instanceof Error ? `Could not parse the CSV: ${err.message}` : 'Could not parse the CSV',
    );
  }

  if (records.length === 0) {
    throw AppError.badRequest(ErrorCodes.CSV_EMPTY, 'The uploaded file contains no data rows');
  }
  return records;
}

/** Build a downloadable error report from a validation outcome. */
export function buildErrorReportCsv(errors: IImportRowError[], duplicates: IImportRowError[]): string {
  const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  const lines = ['row,field,issue,message,value'];
  for (const e of errors) {
    lines.push([e.rowNumber, escape(e.field), 'INVALID', escape(e.message), escape(e.rawValue ?? '')].join(','));
  }
  for (const d of duplicates) {
    lines.push([d.rowNumber, escape(d.field), 'DUPLICATE', escape(d.message), escape(d.rawValue ?? '')].join(','));
  }
  return lines.join('\n');
}

/** Stage an upload for preview. No tasks are created at this point. */
export async function createPreviewBatch(
  buffer: Buffer,
  originalFileName: string,
  partyId: Types.ObjectId,
  uploadedBy: Types.ObjectId,
): Promise<{
  batchId: string;
  batchCode: string;
  total: number;
  valid: number;
  invalid: number;
  duplicate: number;
  errors: IImportRowError[];
  duplicates: IImportRowError[];
  sample: ValidRow[];
}> {
  const rows = parseCsv(buffer);
  const config = await getConfig();

  const refsInFile = rows
    .map((r) => (r.externalRef ?? '').trim())
    .filter((r) => r.length > 0);

  const existing = await Task.find({ partyId, externalRef: { $in: refsInFile } })
    .select('externalRef')
    .lean();
  const existingRefs = new Set(existing.map((t) => t.externalRef.toLowerCase()));

  const outcome = validateRows(
    rows,
    {
      minimumTaskAmountPaise: config.minimumTaskAmountPaise,
      maximumTaskAmountPaise: config.maximumTaskAmountPaise,
    },
    existingRefs,
  );

  const year = new Date().getFullYear();
  const batchCode = formatBatchCode(year, await nextSequence(`batch:${year}`));

  const batch = await ImportBatch.create({
    batchCode,
    partyId,
    uploadedBy,
    originalFileName,
    status: 'PREVIEW',
    totalRows: outcome.total,
    validRows: outcome.valid.length,
    invalidRows: outcome.errors.length,
    duplicateRows: outcome.duplicates.length,
    rowErrors: [...outcome.errors, ...outcome.duplicates],
    stagedRows: outcome.valid,
  });

  return {
    batchId: String(batch._id),
    batchCode,
    total: outcome.total,
    valid: outcome.valid.length,
    invalid: outcome.errors.length,
    duplicate: outcome.duplicates.length,
    errors: outcome.errors,
    duplicates: outcome.duplicates,
    sample: outcome.valid.slice(0, 10),
  };
}
