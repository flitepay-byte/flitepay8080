import { validateRows, parseCsv, buildErrorReportCsv, type RawCsvRow } from '../../services/csvImport.service';
import { rupeesToPaise } from '../../utils/money';

const bounds = {
  minimumTaskAmountPaise: rupeesToPaise(100),
  maximumTaskAmountPaise: rupeesToPaise(200000),
};

describe('CSV import validation', () => {
  it('accepts the specification example file', () => {
    const rows: RawCsvRow[] = [
      { customerName: 'Rahul Sharma', identifier: 'DEMO-UPI-001', amount: '10000', externalRef: 'DEMO-REF-001' },
      { customerName: 'Amit Kumar', identifier: 'DEMO-UPI-002', amount: '5000', externalRef: 'DEMO-REF-002' },
    ];
    const outcome = validateRows(rows, bounds);
    expect(outcome.total).toBe(2);
    expect(outcome.valid).toHaveLength(2);
    expect(outcome.errors).toHaveLength(0);
    expect(outcome.valid[0]?.amountPaise).toBe(rupeesToPaise(10000));
  });

  it('reports each missing required field', () => {
    const outcome = validateRows(
      [{ customerName: '', identifier: '', amount: '', externalRef: '' }],
      bounds,
    );
    expect(outcome.valid).toHaveLength(0);
    const fields = outcome.errors.map((e) => e.field);
    expect(fields).toContain('customerName');
    expect(fields).toContain('identifier');
    expect(fields).toContain('amount');
    expect(fields).toContain('externalRef');
  });

  it('rejects a non-positive amount', () => {
    const outcome = validateRows(
      [
        { customerName: 'A', identifier: 'X', amount: '0', externalRef: 'R1' },
        { customerName: 'B', identifier: 'Y', amount: '-500', externalRef: 'R2' },
      ],
      bounds,
    );
    expect(outcome.valid).toHaveLength(0);
    expect(outcome.errors.every((e) => e.field === 'amount')).toBe(true);
  });

  it('rejects a non-numeric amount', () => {
    const outcome = validateRows(
      [{ customerName: 'A', identifier: 'X', amount: 'ten thousand', externalRef: 'R1' }],
      bounds,
    );
    expect(outcome.errors[0]?.field).toBe('amount');
  });

  it('enforces the configured amount bounds', () => {
    const outcome = validateRows(
      [
        { customerName: 'A', identifier: 'X', amount: '50', externalRef: 'R1' },
        { customerName: 'B', identifier: 'Y', amount: '999999', externalRef: 'R2' },
      ],
      bounds,
    );
    expect(outcome.valid).toHaveLength(0);
    expect(outcome.errors).toHaveLength(2);
  });

  it('rejects a reference with unsafe characters', () => {
    const outcome = validateRows(
      [{ customerName: 'A', identifier: 'X', amount: '1000', externalRef: 'REF$ne' }],
      bounds,
    );
    expect(outcome.errors[0]?.field).toBe('externalRef');
  });

  it('detects duplicates within the file and counts them separately', () => {
    const rows: RawCsvRow[] = [
      { customerName: 'A', identifier: 'X', amount: '1000', externalRef: 'DUP-1' },
      { customerName: 'B', identifier: 'Y', amount: '2000', externalRef: 'DUP-1' },
    ];
    const outcome = validateRows(rows, bounds);
    expect(outcome.valid).toHaveLength(1);
    expect(outcome.duplicates).toHaveLength(1);
    expect(outcome.errors).toHaveLength(0);
  });

  it('detects duplicates against references already in the system', () => {
    const outcome = validateRows(
      [{ customerName: 'A', identifier: 'X', amount: '1000', externalRef: 'EXISTING-1' }],
      bounds,
      new Set(['existing-1']),
    );
    expect(outcome.valid).toHaveLength(0);
    expect(outcome.duplicates).toHaveLength(1);
  });

  it('matches duplicates case-insensitively', () => {
    const outcome = validateRows(
      [
        { customerName: 'A', identifier: 'X', amount: '1000', externalRef: 'ref-1' },
        { customerName: 'B', identifier: 'Y', amount: '2000', externalRef: 'REF-1' },
      ],
      bounds,
    );
    expect(outcome.duplicates).toHaveLength(1);
  });

  it('produces the counts shown on the import screen', () => {
    // 10 rows: 6 valid, 2 invalid, 2 duplicate.
    const rows: RawCsvRow[] = [];
    for (let i = 1; i <= 6; i += 1) {
      rows.push({ customerName: `C${i}`, identifier: `ID${i}`, amount: '1000', externalRef: `OK-${i}` });
    }
    rows.push({ customerName: '', identifier: 'ID7', amount: '1000', externalRef: 'BAD-1' });
    rows.push({ customerName: 'C8', identifier: 'ID8', amount: 'xyz', externalRef: 'BAD-2' });
    rows.push({ customerName: 'C9', identifier: 'ID9', amount: '1000', externalRef: 'OK-1' });
    rows.push({ customerName: 'C10', identifier: 'ID10', amount: '1000', externalRef: 'OK-2' });

    const outcome = validateRows(rows, bounds);
    expect(outcome.total).toBe(10);
    expect(outcome.valid).toHaveLength(6);
    expect(outcome.duplicates).toHaveLength(2);
    expect(new Set(outcome.errors.map((e) => e.rowNumber)).size).toBe(2);
  });

  it('reports row numbers that account for the header line', () => {
    const outcome = validateRows(
      [{ customerName: '', identifier: 'X', amount: '1000', externalRef: 'R1' }],
      bounds,
    );
    // First data row is line 2 of the file.
    expect(outcome.errors[0]?.rowNumber).toBe(2);
  });
});

describe('parseCsv', () => {
  it('parses a well-formed file', () => {
    const csv = Buffer.from(
      'customerName,identifier,amount,externalRef\nRahul Sharma,DEMO-UPI-001,10000,DEMO-REF-001\n',
    );
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.customerName).toBe('Rahul Sharma');
  });

  it('rejects a file with no data rows', () => {
    expect(() => parseCsv(Buffer.from('customerName,identifier,amount,externalRef\n'))).toThrow();
  });
});

describe('error report', () => {
  it('emits a CSV that escapes embedded quotes', () => {
    const report = buildErrorReportCsv(
      [{ rowNumber: 2, field: 'amount', message: 'Bad "value"', rawValue: 'x' }],
      [{ rowNumber: 3, field: 'externalRef', message: 'Duplicate', rawValue: 'R1' }],
    );
    const lines = report.split('\n');
    expect(lines[0]).toBe('row,field,issue,message,value');
    expect(lines[1]).toContain('INVALID');
    expect(lines[1]).toContain('""value""');
    expect(lines[2]).toContain('DUPLICATE');
  });
});
