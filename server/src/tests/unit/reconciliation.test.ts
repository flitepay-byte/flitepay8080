import { reconcile, parseStatement, type StatementRow, type SystemRecord } from '../../services/reconciliation.service';
import { rupeesToPaise } from '../../utils/money';

function stmt(reference: string, rupees: number, rowNumber = 2): StatementRow {
  return { reference, amountPaise: rupeesToPaise(rupees), rowNumber };
}
function sys(reference: string, rupees: number, code = 'TASK-2026-000001'): SystemRecord {
  return { reference, amountPaise: rupeesToPaise(rupees), taskId: '507f1f77bcf86cd799439011', taskCode: code };
}

describe('reconciliation matching', () => {
  it('marks equal amounts as MATCHED', () => {
    // DEMO123: system ₹10,000, statement ₹10,000 -> MATCHED
    const result = reconcile([stmt('DEMO123', 10000)], [sys('DEMO123', 10000)]);
    expect(result.matched).toBe(1);
    expect(result.discrepancy).toBe(0);
    expect(result.entries[0]?.result).toBe('MATCHED');
    expect(result.entries[0]?.differencePaise).toBe(0);
  });

  it('marks differing amounts as DISCREPANCY and reports the difference', () => {
    // System ₹10,000 vs statement ₹9,500 -> difference ₹500
    const result = reconcile([stmt('DEMO124', 9500)], [sys('DEMO124', 10000)]);
    expect(result.discrepancy).toBe(1);
    expect(result.entries[0]?.result).toBe('DISCREPANCY');
    expect(result.entries[0]?.differencePaise).toBe(rupeesToPaise(500));
  });

  it('flags a statement entry with no system counterpart', () => {
    const result = reconcile([stmt('GHOST-1', 1000)], []);
    expect(result.unmatchedStatement).toBe(1);
    expect(result.entries[0]?.result).toBe('UNMATCHED_STATEMENT_ENTRY');
    expect(result.entries[0]?.systemAmountPaise).toBeNull();
  });

  it('flags a system task absent from the statement', () => {
    const result = reconcile([], [sys('MISSING-1', 1000)]);
    expect(result.unmatchedSystem).toBe(1);
    expect(result.entries[0]?.result).toBe('UNMATCHED_SYSTEM_TASK');
    expect(result.entries[0]?.statementAmountPaise).toBeNull();
  });

  it('matches references case-insensitively', () => {
    const result = reconcile([stmt('demo123', 10000)], [sys('DEMO123', 10000)]);
    expect(result.matched).toBe(1);
  });

  it('categorises a mixed batch correctly', () => {
    const statement = [
      stmt('A-1', 1000),
      stmt('A-2', 900),
      stmt('A-3', 500),
    ];
    const system = [
      sys('A-1', 1000),
      sys('A-2', 1000),
      sys('A-4', 700),
    ];
    const result = reconcile(statement, system);
    expect(result.matched).toBe(1);
    expect(result.discrepancy).toBe(1);
    expect(result.unmatchedStatement).toBe(1);
    expect(result.unmatchedSystem).toBe(1);
    expect(result.entries).toHaveLength(4);
  });

  it('detects a shortfall and an overage with the correct sign', () => {
    const short = reconcile([stmt('S', 900)], [sys('S', 1000)]);
    expect(short.entries[0]?.differencePaise).toBe(rupeesToPaise(100));
    const over = reconcile([stmt('O', 1100)], [sys('O', 1000)]);
    expect(over.entries[0]?.differencePaise).toBe(rupeesToPaise(-100));
  });

  it('detects a one-paise difference rather than rounding it away', () => {
    const result = reconcile(
      [{ reference: 'P', amountPaise: 999_999, rowNumber: 2 }],
      [{ reference: 'P', amountPaise: 1_000_000, taskId: 'x', taskCode: 'T' }],
    );
    expect(result.discrepancy).toBe(1);
    expect(result.entries[0]?.differencePaise).toBe(1);
  });
});

describe('statement parsing', () => {
  it('parses reference and amount columns', () => {
    const { rows, errors } = parseStatement(Buffer.from('reference,amount\nDEMO123,10000\n'));
    expect(errors).toHaveLength(0);
    expect(rows[0]?.reference).toBe('DEMO123');
    expect(rows[0]?.amountPaise).toBe(rupeesToPaise(10000));
  });

  it('accepts utr as an alias for reference', () => {
    const { rows } = parseStatement(Buffer.from('utr,amount\nSIM123456789012,5000\n'));
    expect(rows[0]?.reference).toBe('SIM123456789012');
  });

  it('surfaces malformed rows instead of dropping them silently', () => {
    const { rows, errors } = parseStatement(Buffer.from('reference,amount\nA,abc\n,1000\nB,2000\n'));
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(2);
  });
});
