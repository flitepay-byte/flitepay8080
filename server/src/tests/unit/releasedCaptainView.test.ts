/**
 * A captain who was rejected off a task keeps it in their history.
 *
 * The row has to say two things at once: this was yours, and this is over.
 * Getting the second half wrong is the dangerous direction — the task carries
 * on under a different captain, and its live fields would tell the released
 * captain who took it and how it went. So these tests check what the row says
 * about their own turn, and then check, field by field, that it says nothing
 * about anyone else's.
 */
import { toCaptainTaskDto } from '../../utils/serializers';
import type { ITask } from '../../models';

const FIRST = 'captain-one';
const SECOND = 'captain-two';
const PARTY_WORDS = 'Customer never received it';
const SECOND_REFERENCE = 'SIM-SECOND-CAPTAIN-9999';

/** A task the first captain lost to a rejection, then the second one completed. */
function reassignedTask(overrides: Record<string, unknown> = {}): ITask {
  const now = new Date('2026-04-01T10:00:00Z');
  const at = (minutes: number): Date => new Date(now.getTime() + minutes * 60_000);

  return {
    _id: 'task-oid',
    taskCode: 'TASK-2026-000500',
    partyId: 'party-oid',
    customerName: 'Rahul Sharma',
    identifier: 'DEMO-UPI-500',
    amountPaise: 500_000,
    externalRef: 'PARTY-REF-500',

    // As it stands now: finished, by somebody else.
    status: 'COMPLETED',
    captainId: SECOND,
    previousCaptainIds: [FIRST],
    reassignmentCount: 1,
    completedAt: at(120),
    claimedAt: at(65),
    commissionPaise: 12_500,
    providerReference: SECOND_REFERENCE,
    adminRejectionResolution: 'REASSIGNED',

    rejectionReason: PARTY_WORDS,
    rejectionCategory: 'NOT_RECEIVED',
    rejectedCaptainId: FIRST,

    stateHistory: [
      { from: null, to: 'CREATED', at: at(0), captainId: null },
      { from: 'CREATED', to: 'ASSIGNED', at: at(1), captainId: FIRST },
      { from: 'ASSIGNED', to: 'IN_PROGRESS', at: at(5), captainId: FIRST },
      { from: 'IN_PROGRESS', to: 'PROOF_SUBMITTED', at: at(20), captainId: FIRST },
      { from: 'PROOF_SUBMITTED', to: 'AUDIT_PENDING', at: at(21), captainId: FIRST },
      { from: 'AUDIT_PENDING', to: 'REJECTED', at: at(40), captainId: FIRST },
      { from: 'REJECTED', to: 'REASSIGNED', at: at(50), captainId: FIRST },
      { from: 'CREATED', to: 'ASSIGNED', at: at(65), captainId: SECOND },
      { from: 'ASSIGNED', to: 'COMPLETED', at: at(120), captainId: SECOND },
    ],
    createdAt: now,
    updatedAt: at(120),
    ...overrides,
  } as unknown as ITask;
}

describe('the captain who was rejected off the task', () => {
  const view = (): Record<string, unknown> => toCaptainTaskDto(reassignedTask(), FIRST);

  it('still gets the task — it was their work', () => {
    expect(view()['taskCode']).toBe('TASK-2026-000500');
  });

  it('is told plainly that it is no longer theirs', () => {
    expect(view()['releasedFromYou']).toBe(true);
    expect(view()['releasedAt']).toBe('2026-04-01T10:50:00.000Z');
  });

  it('sees their own outcome as the status, not the live one', () => {
    expect(view()['status']).toBe('REJECTED');
  });

  it('still reads the party’s reason, which was written about their work', () => {
    expect(view()['rejectionReason']).toBe(PARTY_WORDS);
  });

  it('is not also handed the generic guidance meant for their replacement', () => {
    expect(view()['rejectionGuidance']).toBeNull();
  });
});

describe('what the released captain must not learn', () => {
  const view = (): Record<string, unknown> => toCaptainTaskDto(reassignedTask(), FIRST);

  it.each([
    ['the live status', 'status', 'COMPLETED'],
    ['who holds it now', 'captainId', SECOND],
    ['the replacement’s payout result', 'payoutResult', 'SUCCESS'],
    ['the replacement’s provider reference', 'providerReference', SECOND_REFERENCE],
  ])('never %s', (_label, field, liveValue) => {
    expect(view()[field]).not.toBe(liveValue);
  });

  it('is shown no commission, having earned none', () => {
    expect(view()['commission']).toBeNull();
  });

  it('is not told the task was ever completed', () => {
    expect(view()['completedAt']).toBeNull();
  });

  it('carries no trace of the second captain anywhere in the payload', () => {
    const serialised = JSON.stringify(view());
    expect(serialised).not.toContain(SECOND);
    expect(serialised).not.toContain(SECOND_REFERENCE);
  });

  it('still withholds the party’s tracking reference, as for any captain', () => {
    expect(view()).not.toHaveProperty('externalRef');
    expect(JSON.stringify(view())).not.toContain('PARTY-REF-500');
  });
});

describe('how their turn ended is read from their own history', () => {
  it('says REJECTED when the party rejected their proof', () => {
    expect(toCaptainTaskDto(reassignedTask(), FIRST)['status']).toBe('REJECTED');
  });

  it('says EXPIRED when they simply ran out of time', () => {
    // The expiry path also passes through REJECTED on its way out, so a naive
    // reading would tell a captain their work was rejected when it never was.
    const at = (m: number): Date => new Date(new Date('2026-04-01T10:00:00Z').getTime() + m * 60_000);
    const task = reassignedTask({
      rejectedCaptainId: null,
      rejectionReason: null,
      stateHistory: [
        { from: null, to: 'CREATED', at: at(0), captainId: null },
        { from: 'CREATED', to: 'ASSIGNED', at: at(1), captainId: FIRST },
        { from: 'ASSIGNED', to: 'EXPIRED', at: at(35), captainId: FIRST },
        { from: 'EXPIRED', to: 'REJECTED', at: at(36), captainId: FIRST },
        { from: 'REJECTED', to: 'REASSIGNED', at: at(36), captainId: FIRST },
        { from: 'CREATED', to: 'ASSIGNED', at: at(40), captainId: SECOND },
      ],
    });
    expect(toCaptainTaskDto(task, FIRST)['status']).toBe('EXPIRED');
  });
});

describe('everyone else is unaffected', () => {
  it('the captain holding it now sees the real task', () => {
    const view = toCaptainTaskDto(reassignedTask(), SECOND);
    expect(view['status']).toBe('COMPLETED');
    expect(view['releasedFromYou']).toBe(false);
    expect(view['commission']).not.toBeNull();
  });

  it('a captain who never touched it is not treated as released', () => {
    const view = toCaptainTaskDto(reassignedTask(), 'captain-three');
    expect(view['releasedFromYou']).toBe(false);
    expect(view['status']).toBe('COMPLETED');
  });

  it('a task with no reassignment behaves exactly as before', () => {
    const task = reassignedTask({ previousCaptainIds: [], captainId: FIRST });
    const view = toCaptainTaskDto(task, FIRST);
    expect(view['releasedFromYou']).toBe(false);
    expect(view['status']).toBe('COMPLETED');
  });
});
