/**
 * One search shared by three roles, so the differences between them are the
 * only thing worth testing: what each may search, and that a search term is
 * always matched as text rather than executed as a pattern.
 */
import { taskSearchClause, applyTaskSearch } from '../../utils/taskSearch';

const PARTY = { includeExternalRef: true };
const CAPTAIN = { includeExternalRef: false };

/** The field names a clause searches, in order. */
function fields(clause: Array<Record<string, unknown>> | null): string[] {
  return (clause ?? []).flatMap((c) => Object.keys(c));
}

describe('what each role may search', () => {
  it('searches a task number and the customer name for everyone', () => {
    // "The task number" differs by role: a captain is shown the opaque
    // captainTaskCode, so that is the one their search has to match.
    expect(fields(taskSearchClause('anything', PARTY))).toEqual(
      expect.arrayContaining(['taskCode', 'captainTaskCode', 'customerName']),
    );
    expect(fields(taskSearchClause('anything', CAPTAIN))).toEqual(
      expect.arrayContaining(['captainTaskCode', 'customerName']),
    );
  });

  it('never lets a captain search the party-facing task code', () => {
    // That code reads TASK-PARTY-003-..., so matching on it would confirm a
    // party's identity — and let a captain enumerate one party's work.
    expect(fields(taskSearchClause('TASK-PARTY-003', CAPTAIN))).not.toContain('taskCode');
  });

  it('lets admin look up whichever code a captain reads out', () => {
    const admin = fields(taskSearchClause('JOB-ABC', PARTY));
    expect(admin).toContain('taskCode');
    expect(admin).toContain('captainTaskCode');
  });

  it('lets party and admin search the tracking reference they own', () => {
    expect(fields(taskSearchClause('REF-1', PARTY))).toContain('externalRef');
  });

  it('never lets a captain search the tracking reference', () => {
    // Withheld from their responses, so searchable would make the box an
    // oracle: guess a reference, see whether a task comes back.
    expect(fields(taskSearchClause('REF-1', CAPTAIN))).not.toContain('externalRef');
    expect(taskSearchClause('REF-1', CAPTAIN)).toHaveLength(2);
  });
});

describe('a search term is text, never a pattern', () => {
  const cases: Array<[string, string]> = [
    ['a regex wildcard', '.*'],
    ['an anchor', '^TASK'],
    ['a quantifier', 'a+b'],
    ['a group', '(x|y)'],
    ['a character class', '[a-z]'],
    ['a catastrophic backtrack', '(a+)+$'],
    ['a lone backslash', 'back\slash'],
  ];

  it.each(cases)('escapes %s', (_label, term) => {
    const clause = taskSearchClause(term, PARTY);
    const pattern = (clause?.[0]?.['taskCode'] ?? null) as RegExp | null;
    expect(pattern).toBeInstanceOf(RegExp);
    // The literal characters match themselves...
    expect(pattern?.test(`prefix ${term} suffix`)).toBe(true);
    // ...and nothing else does. '.*' must not match an arbitrary string.
    expect(pattern?.test('completely unrelated')).toBe(false);
  });

  it('matches case-insensitively, since nobody types a task code in caps', () => {
    const clause = taskSearchClause('task-2026', PARTY);
    expect((clause?.[0]?.['taskCode'] as RegExp).test('TASK-2026-000125')).toBe(true);
  });

  it('matches partially, so a fragment of a name is enough', () => {
    const clause = taskSearchClause('sharm', PARTY) ?? [];
    const nameClause = clause.find((c) => 'customerName' in c);
    expect((nameClause?.['customerName'] as RegExp).test('Rahul Sharma')).toBe(true);
  });
});

describe('an absent search changes nothing', () => {
  it.each([undefined, '', '   '])('returns null for %p', (term) => {
    expect(taskSearchClause(term, PARTY)).toBeNull();
  });

  it('leaves the filter untouched rather than adding an empty $or', () => {
    // An empty $or matches nothing, which would silently empty every list.
    const filter: Record<string, unknown> = { partyId: 'party-oid' };
    applyTaskSearch(filter, '   ', PARTY);
    expect(filter).toEqual({ partyId: 'party-oid' });
    expect(filter).not.toHaveProperty('$or');
  });

  it('adds the clause without disturbing the existing scope', () => {
    const filter: Record<string, unknown> = { captainId: 'captain-oid', status: 'COMPLETED' };
    applyTaskSearch(filter, 'Rahul', CAPTAIN);
    expect(filter['captainId']).toBe('captain-oid');
    expect(filter['status']).toBe('COMPLETED');
    expect(fields(filter['$or'] as Array<Record<string, unknown>>)).toEqual(['captainTaskCode', 'customerName']);
  });
});
