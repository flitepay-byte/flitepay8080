/**
 * A party never learns which captain is working its task.
 *
 * This was enforced by each party handler destructuring `captainId` out of the
 * response by hand — nine places, of which the task list forgot, so the busiest
 * party endpoint shipped the captain's id to every party. The rule now lives in
 * one serialiser, and these tests hold it there.
 */
import { toPartyTaskDto, toTaskDto } from '../../utils/serializers';
import type { ITask } from '../../models';

const CAPTAIN_ID = 'captain-oid-999';

function task(overrides: Record<string, unknown> = {}): ITask {
  const now = new Date('2026-05-01T09:00:00Z');
  return {
    _id: 'task-oid',
    taskCode: 'TASK-2026-000700',
    partyId: 'party-oid',
    captainId: CAPTAIN_ID,
    customerName: 'Rahul Sharma',
    identifier: 'DEMO-UPI-700',
    amountPaise: 300_000,
    externalRef: 'PARTY-REF-700',
    status: 'IN_PROGRESS',
    commissionPaise: 7_500,
    adminCommissionPaise: 3_000,
    reassignmentCount: 0,
    previousCaptainIds: [],
    stateHistory: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as ITask;
}

describe('the party view of a task', () => {
  it('carries no captain id', () => {
    expect(toPartyTaskDto(task())).not.toHaveProperty('captainId');
  });

  it('carries no trace of the captain anywhere in the payload', () => {
    expect(JSON.stringify(toPartyTaskDto(task()))).not.toContain(CAPTAIN_ID);
  });

  it('still keeps everything the party owns', () => {
    const dto = toPartyTaskDto(task());
    // The party's own tracking reference is theirs — this is the field a
    // captain never sees, and the party always does.
    expect(dto.externalRef).toBe('PARTY-REF-700');
    expect(dto.taskCode).toBe('TASK-2026-000700');
    expect(dto.customerName).toBe('Rahul Sharma');
    expect(dto.amount).toBe(3_000);
  });

  it('drops the captain even on a task nobody holds', () => {
    expect(toPartyTaskDto(task({ captainId: null }))).not.toHaveProperty('captainId');
  });

  it('differs from the unrestricted view by exactly that one field', () => {
    // Guards against the serialiser quietly dropping something else the party
    // needs, or growing a second responsibility later.
    const full = Object.keys(toTaskDto(task())).sort();
    const party = Object.keys(toPartyTaskDto(task())).sort();
    expect(full.filter((k) => !party.includes(k))).toEqual(['captainId']);
    expect(party.filter((k) => !full.includes(k))).toEqual([]);
  });
});
