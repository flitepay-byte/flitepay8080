/**
 * Searching the money ledgers by who is involved.
 *
 * The subtle case is a term that matches nobody. A filter builder that simply
 * adds nothing when it finds no ids would answer "show me Sharma's
 * withdrawals" with the entire ledger — the most alarming possible answer to
 * a question about one person. These tests pin that down alongside the
 * ordinary behaviour.
 */
const captainFind = jest.fn();
const partyFind = jest.fn();

jest.mock('../../models', () => ({
  Captain: { find: (...args: unknown[]) => captainFind(...args) },
  Party: { find: (...args: unknown[]) => partyFind(...args) },
}));

import { applyCounterpartySearch, resolveCounterparties } from '../../utils/counterpartySearch';

/** Mongoose's `.select().lean()` chain, resolving to the given rows. */
function chain(rows: Array<{ _id: string }>) {
  return { select: () => ({ lean: () => Promise.resolve(rows) }) };
}

function whenMatched(captains: string[], parties: string[]): void {
  captainFind.mockReturnValue(chain(captains.map((_id) => ({ _id }))));
  partyFind.mockReturnValue(chain(parties.map((_id) => ({ _id }))));
}

beforeEach(() => {
  captainFind.mockReset();
  partyFind.mockReset();
});

describe('resolving a name to ids', () => {
  it('returns the matching captains and parties', async () => {
    whenMatched(['cap-1', 'cap-2'], ['party-9']);
    await expect(resolveCounterparties('sharma')).resolves.toEqual({
      captainIds: ['cap-1', 'cap-2'],
      partyIds: ['party-9'],
    });
  });

  it.each([undefined, '', '   '])('does not query at all for %p', async (term) => {
    await expect(resolveCounterparties(term)).resolves.toBeNull();
    expect(captainFind).not.toHaveBeenCalled();
    expect(partyFind).not.toHaveBeenCalled();
  });

  it('searches names and codes together, since admin pastes either', async () => {
    whenMatched([], []);
    await resolveCounterparties('CAP-002');
    expect(captainFind).toHaveBeenCalledWith({
      $or: [{ displayName: expect.any(RegExp) }, { captainCode: expect.any(RegExp) }],
    });
    expect(partyFind).toHaveBeenCalledWith({
      $or: [{ companyName: expect.any(RegExp) }, { partyCode: expect.any(RegExp) }],
    });
  });

  it('matches the term as text, not as a pattern', async () => {
    whenMatched([], []);
    await resolveCounterparties('.*');
    const pattern = (captainFind.mock.calls[0]?.[0] as { $or: Array<{ displayName: RegExp }> }).$or[0]
      ?.displayName as RegExp;
    expect(pattern.test('.*')).toBe(true);
    expect(pattern.test('Anyone At All')).toBe(false);
  });
});

describe('narrowing a filter', () => {
  it('matches records involving either side', async () => {
    whenMatched(['cap-1'], ['party-9']);
    const filter: Record<string, unknown> = {};
    await applyCounterpartySearch(filter, 'demo');
    expect(filter['$or']).toEqual([
      { captainId: { $in: ['cap-1'] } },
      { partyId: { $in: ['party-9'] } },
    ]);
  });

  it('searches only the party side when asked — a top-up has no captain', async () => {
    whenMatched(['cap-1'], ['party-9']);
    const filter: Record<string, unknown> = {};
    await applyCounterpartySearch(filter, 'demo', { party: true });
    expect(filter['$or']).toEqual([{ partyId: { $in: ['party-9'] } }]);
  });

  it('narrows to nothing when the name matches nobody', async () => {
    whenMatched([], []);
    const filter: Record<string, unknown> = {};
    await applyCounterpartySearch(filter, 'nobody by that name');
    // Empty $in matches no document — which is the correct answer, and very
    // much not the same as leaving the filter untouched.
    expect(filter['$or']).toEqual([{ captainId: { $in: [] } }, { partyId: { $in: [] } }]);
  });

  it('leaves the filter completely alone when there is no term', async () => {
    const filter: Record<string, unknown> = { status: 'DISPUTED' };
    await applyCounterpartySearch(filter, '  ');
    expect(filter).toEqual({ status: 'DISPUTED' });
  });

  it('keeps the caller’s own scope intact', async () => {
    whenMatched(['cap-1'], []);
    const filter: Record<string, unknown> = { status: 'PENDING', partyId: 'party-3' };
    await applyCounterpartySearch(filter, 'demo');
    expect(filter['status']).toBe('PENDING');
    expect(filter['partyId']).toBe('party-3');
    expect(filter['$or']).toBeDefined();
  });
});
