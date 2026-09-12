import { parse } from 'csv-parse/sync';
import { rupeesToPaise, MoneyError } from '../utils/money';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import type { ReconResult } from '../types';

export interface StatementRow {
  reference: string;
  amountPaise: number;
  rowNumber: number;
}

export interface SystemRecord {
  reference: string;
  amountPaise: number;
  taskId: string;
  taskCode: string;
}

export interface MatchEntry {
  reference: string;
  systemAmountPaise: number | null;
  statementAmountPaise: number | null;
  differencePaise: number | null;
  taskId: string | null;
  taskCode: string | null;
  result: ReconResult;
  note?: string;
}

export interface MatchSummary {
  entries: MatchEntry[];
  matched: number;
  discrepancy: number;
  unmatchedStatement: number;
  unmatchedSystem: number;
}

/**
 * Parse a mock bank statement CSV. Expected headers: reference, amount.
 * Malformed rows are surfaced rather than silently skipped, because a row that
 * quietly disappears from a reconciliation is worse than a visible error.
 */
export function parseStatement(buffer: Buffer): { rows: StatementRow[]; errors: string[] } {
  let records: Array<Record<string, string>>;
  try {
    records = parse(buffer, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Array<Record<string, string>>;
  } catch (err) {
    throw AppError.badRequest(
      ErrorCodes.CSV_PARSE_ERROR,
      err instanceof Error ? `Could not parse the statement: ${err.message}` : 'Could not parse the statement',
    );
  }

  const rows: StatementRow[] = [];
  const errors: string[] = [];

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const reference = (record['reference'] ?? record['utr'] ?? record['ref'] ?? '').trim();
    const amountRaw = (record['amount'] ?? '').trim();

    if (!reference) {
      errors.push(`Row ${rowNumber}: missing reference`);
      return;
    }
    if (!amountRaw) {
      errors.push(`Row ${rowNumber}: missing amount`);
      return;
    }
    try {
      rows.push({ reference, amountPaise: rupeesToPaise(amountRaw), rowNumber });
    } catch (err) {
      errors.push(`Row ${rowNumber}: ${err instanceof MoneyError ? err.message : 'invalid amount'}`);
    }
  });

  return { rows, errors };
}

/**
 * RECONCILIATION MATCHING — pure function.
 *
 * Categories:
 *   MATCHED                    reference present on both sides, amounts equal
 *   DISCREPANCY                reference present on both sides, amounts differ
 *   UNMATCHED_STATEMENT_ENTRY  in the statement, absent from the system
 *   UNMATCHED_SYSTEM_TASK      in the system, absent from the statement
 *
 * Matching is case-insensitive because statement exports are inconsistent
 * about casing, and a false mismatch is expensive to investigate.
 */
export function reconcile(statement: readonly StatementRow[], system: readonly SystemRecord[]): MatchSummary {
  const systemByRef = new Map<string, SystemRecord>();
  for (const record of system) {
    systemByRef.set(record.reference.toLowerCase(), record);
  }

  const entries: MatchEntry[] = [];
  const seenSystemRefs = new Set<string>();
  let matched = 0;
  let discrepancy = 0;
  let unmatchedStatement = 0;

  for (const row of statement) {
    const key = row.reference.toLowerCase();
    const record = systemByRef.get(key);

    if (!record) {
      unmatchedStatement += 1;
      entries.push({
        reference: row.reference,
        systemAmountPaise: null,
        statementAmountPaise: row.amountPaise,
        differencePaise: null,
        taskId: null,
        taskCode: null,
        result: 'UNMATCHED_STATEMENT_ENTRY',
        note: 'No task in the system carries this reference',
      });
      continue;
    }

    seenSystemRefs.add(key);
    const difference = record.amountPaise - row.amountPaise;

    if (difference === 0) {
      matched += 1;
      entries.push({
        reference: row.reference,
        systemAmountPaise: record.amountPaise,
        statementAmountPaise: row.amountPaise,
        differencePaise: 0,
        taskId: record.taskId,
        taskCode: record.taskCode,
        result: 'MATCHED',
      });
    } else {
      discrepancy += 1;
      entries.push({
        reference: row.reference,
        systemAmountPaise: record.amountPaise,
        statementAmountPaise: row.amountPaise,
        differencePaise: difference,
        taskId: record.taskId,
        taskCode: record.taskCode,
        result: 'DISCREPANCY',
        note: `System and statement differ by ${difference > 0 ? '+' : ''}${difference} paise`,
      });
    }
  }

  // System-side records with no statement counterpart.
  let unmatchedSystem = 0;
  for (const record of system) {
    if (seenSystemRefs.has(record.reference.toLowerCase())) continue;
    unmatchedSystem += 1;
    entries.push({
      reference: record.reference,
      systemAmountPaise: record.amountPaise,
      statementAmountPaise: null,
      differencePaise: null,
      taskId: record.taskId,
      taskCode: record.taskCode,
      result: 'UNMATCHED_SYSTEM_TASK',
      note: 'Completed in the system but absent from the statement',
    });
  }

  return { entries, matched, discrepancy, unmatchedStatement, unmatchedSystem };
}
