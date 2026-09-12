/**
 * The identifier a captain is shown must not name the party.
 *
 * `taskCode` is formed as TASK-<partyCode>-<year>-<sequence>, so a captain
 * reading it off their screen learns exactly what every serialiser, socket
 * payload and search filter in the system works to withhold — and can group
 * their work by client, or measure one party's volume, without touching the
 * API. Captains are shown an unrelated opaque code instead.
 */
import { toTaskDto, toCaptainTaskDto, toQueueCardDto } from '../../utils/serializers';
import { generateCaptainTaskCode } from '../../utils/ids';
import { taskSearchClause } from '../../utils/taskSearch';
import type { ITask } from '../../models';

const PARTY_CODE = 'PARTY-003';
const PARTY_FACING = `TASK-${PARTY_CODE}-2026-000042`;
const CAPTAIN_FACING = 'JOB-K7M2QX94';
const CAPTAIN_ID = 'captain-oid';

function task(overrides: Record<string, unknown> = {}): ITask {
  const now = new Date('2026-06-01T09:00:00Z');
  return {
    _id: 'task-oid',
    taskCode: PARTY_FACING,
    captainTaskCode: CAPTAIN_FACING,
    partyId: 'party-oid',
    captainId: CAPTAIN_ID,
    customerName: 'Rahul Sharma',
    identifier: 'DEMO-UPI-042',
    amountPaise: 400_000,
    externalRef: 'PARTY-REF-042',
    status: 'IN_PROGRESS',
    commissionPaise: 10_000,
    reassignmentCount: 0,
    previousCaptainIds: [],
    stateHistory: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as ITask;
}

describe('the code a captain is shown', () => {
  it('is the opaque one, not the party-scoped one', () => {
    expect(toCaptainTaskDto(task(), CAPTAIN_ID)['taskCode']).toBe(CAPTAIN_FACING);
  });

  it('appears on the queue card too, before anything is claimed', () => {
    expect(toQueueCardDto(task(), 5_000)['taskCode']).toBe(CAPTAIN_FACING);
  });

  it('never carries the party-scoped code anywhere in the payload', () => {
    const serialised = JSON.stringify(toCaptainTaskDto(task(), CAPTAIN_ID));
    expect(serialised).not.toContain(PARTY_FACING);
    expect(serialised).not.toContain(PARTY_CODE);
  });

  it('is the same on a task the captain has been released from', () => {
    const released = task({ captainId: 'someone-else', previousCaptainIds: [CAPTAIN_ID] });
    const view = toCaptainTaskDto(released, CAPTAIN_ID);
    expect(view['taskCode']).toBe(CAPTAIN_FACING);
    expect(JSON.stringify(view)).not.toContain(PARTY_CODE);
  });

  it('is not also exposed under a second name', () => {
    // One value, one key. Two names for the same thing is another chance to
    // send the wrong one.
    expect(toCaptainTaskDto(task(), CAPTAIN_ID)).not.toHaveProperty('captainTaskCode');
  });

  it('falls back to the real code only when a task predates the field', () => {
    // Better a legible code than none while the backfill runs; the migration
    // exists so this is never the steady state.
    const legacy = task({ captainTaskCode: undefined });
    expect(toCaptainTaskDto(legacy, CAPTAIN_ID)['taskCode']).toBe(PARTY_FACING);
  });
});

describe('what party and admin see', () => {
  it('keeps the party-scoped code they have always used', () => {
    expect(toTaskDto(task()).taskCode).toBe(PARTY_FACING);
  });

  it('also carries the captain-facing code, so admin can trace a quoted one', () => {
    expect(toTaskDto(task()).captainTaskCode).toBe(CAPTAIN_FACING);
  });
});

describe('searching by the code you were shown', () => {
  it('lets a captain find a task by the opaque code', () => {
    const fields = (taskSearchClause(CAPTAIN_FACING, { includeExternalRef: false }) ?? [])
      .flatMap((clause) => Object.keys(clause));
    expect(fields).toContain('captainTaskCode');
    expect(fields).not.toContain('taskCode');
  });

  it('lets admin find it by either code', () => {
    const fields = (taskSearchClause('anything', { includeExternalRef: true }) ?? [])
      .flatMap((clause) => Object.keys(clause));
    expect(fields).toEqual(expect.arrayContaining(['taskCode', 'captainTaskCode']));
  });
});

describe('the generated code itself', () => {
  it('carries no party information and is distinguishable at a glance', () => {
    const code = generateCaptainTaskCode();
    expect(code).toMatch(/^JOB-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(code).not.toContain('PARTY');
    expect(code).not.toContain('TASK-');
  });

  it('avoids the characters that get confused on a screen', () => {
    // 0/O and 1/I are the pairs that actually cause mistyped codes. Only the
    // random part is checked — the fixed "JOB-" prefix is a word, not
    // something anyone transcribes character by character.
    const random = Array.from({ length: 200 }, () => generateCaptainTaskCode().slice(4)).join('');
    expect(random).not.toMatch(/[01IO]/);
  });

  it('does not repeat itself', () => {
    const codes = new Set(Array.from({ length: 2_000 }, () => generateCaptainTaskCode()));
    expect(codes.size).toBe(2_000);
  });
});
