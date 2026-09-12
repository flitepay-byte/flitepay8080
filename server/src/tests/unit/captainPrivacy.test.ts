/**
 * A captain must never receive `externalRef` — the party's own tracking
 * reference for the task. Handing it to a captain would let them contact the
 * customer directly, outside the party's book.
 *
 * The rule is easy to state and easy to break, because the party's and the
 * captain's payloads look almost identical. These tests hold the line on both
 * channels it could escape through: the REST serialisers and the socket
 * notifications.
 */
import { toTaskDto, toCaptainTaskDto, toQueueCardDto } from '../../utils/serializers';
import type { ITask } from '../../models';

const emitted: Array<{ room: 'captain' | 'captainPool' | 'party' | 'admins'; event: string; payload: unknown }> = [];

jest.mock('../../sockets', () => ({
  emitToCaptain: (_id: string, event: string, payload: unknown) =>
    emitted.push({ room: 'captain', event, payload }),
  emitToCaptainPool: (event: string, payload: unknown) =>
    emitted.push({ room: 'captainPool', event, payload }),
  emitToParty: (_id: string, event: string, payload: unknown) =>
    emitted.push({ room: 'party', event, payload }),
  emitToAdmins: (event: string, payload: unknown) => emitted.push({ room: 'admins', event, payload }),
  emitToUser: () => undefined,
  emitToPartyPool: () => undefined,
}));

// Imported after the mock is registered so the service binds to it.
import * as notify from '../../services/notification.service';

const EXTERNAL_REF = 'PARTY-TRACKING-REF-0099';

function fakeTask(overrides: Partial<ITask> = {}): ITask {
  const now = new Date('2026-03-01T09:00:00Z');
  return {
    _id: 'task-oid',
    taskCode: 'TASK-2026-000900',
    partyId: 'party-oid',
    captainId: 'captain-oid',
    customerName: 'Rahul Sharma',
    identifier: 'DEMO-UPI-009',
    amountPaise: 250_000,
    externalRef: EXTERNAL_REF,
    status: 'ASSIGNED',
    commissionPaise: 5_000,
    adminCommissionPaise: 2_000,
    reassignmentCount: 0,
    previousCaptainIds: [],
    stateHistory: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as ITask;
}

/** Anywhere in the payload, at any depth, under any key. */
function mentionsRef(payload: unknown): boolean {
  return JSON.stringify(payload ?? null).includes(EXTERNAL_REF);
}

const captainRooms = ['captain', 'captainPool'];

beforeEach(() => {
  emitted.length = 0;
});

describe('externalRef is withheld from captains — REST', () => {
  it('is absent from a captain’s own task view', () => {
    const dto = toCaptainTaskDto(fakeTask(), 'captain-oid');
    expect(dto).not.toHaveProperty('externalRef');
    expect(mentionsRef(dto)).toBe(false);
  });

  it('is absent from the queue card shown before claiming', () => {
    const card = toQueueCardDto(fakeTask(), 5_000);
    expect(card).not.toHaveProperty('externalRef');
    expect(mentionsRef(card)).toBe(false);
  });

  it('remains available to party and admin, who own the reference', () => {
    expect(toTaskDto(fakeTask()).externalRef).toBe(EXTERNAL_REF);
  });
});

describe('externalRef is withheld from captains — sockets', () => {
  /**
   * Every notification that addresses a captain. Each entry runs the real
   * function; the assertions below read whatever it emitted.
   */
  const captainFacing: Array<[string, () => void]> = [
    ['notifyTaskOffered', () => notify.notifyTaskOffered(fakeTask(), 'captain-oid', 5_000, new Date())],
    ['notifyTaskOpenedToPool', () => notify.notifyTaskOpenedToPool(fakeTask(), 5_000, ['captain-oid'])],
    ['notifyTaskClaimed', () => notify.notifyTaskClaimed(fakeTask(), 'captain-oid')],
    ['notifyExpiredTaskReclaimed', () => notify.notifyExpiredTaskReclaimed(fakeTask(), 'captain-oid')],
    ['notifyProofApproved', () => notify.notifyProofApproved(fakeTask(), 'captain-oid', 5_000)],
    ['notifyProofRejected', () => notify.notifyProofRejected(fakeTask(), 'captain-oid', 'not received')],
    ['notifyTaskExpired', () => notify.notifyTaskExpired(fakeTask(), 'captain-oid')],
    [
      'notifyRejectionResolved',
      () => notify.notifyRejectionResolved(fakeTask(), 'captain-oid', 'REASSIGN'),
    ],
    ['notifyCancelRequested', () => notify.notifyCancelRequested(fakeTask({ cancelInitiatedBy: 'PARTY' } as Partial<ITask>))],
    ['notifyCancelReviewed', () => notify.notifyCancelReviewed(fakeTask({ cancelInitiatedBy: 'CAPTAIN' } as Partial<ITask>), 'REJECTED')],
    ['notifyCancelDisputeResolved', () => notify.notifyCancelDisputeResolved(fakeTask(), 'REASSIGN')],
  ];

  it.each(captainFacing)('%s sends captains nothing carrying the reference', (_name, run) => {
    run();
    const toCaptains = emitted.filter((e) => captainRooms.includes(e.room));
    // Guards the guard: a typo in the fixture that stopped these from
    // emitting at all would otherwise make the assertion below vacuous.
    expect(toCaptains.length).toBeGreaterThan(0);
    for (const e of toCaptains) {
      expect(e.payload).not.toHaveProperty('externalRef');
      expect(mentionsRef(e.payload)).toBe(false);
    }
  });

  it('still gives the party its own reference on the same events', () => {
    notify.notifyProofApproved(fakeTask(), 'captain-oid', 5_000);
    const toParty = emitted.filter((e) => e.room === 'party');
    expect(toParty.length).toBeGreaterThan(0);
    expect(toParty.every((e) => mentionsRef(e.payload))).toBe(true);
  });

  it('still gives admin the reference', () => {
    notify.notifyTaskAvailable(fakeTask(), 5_000);
    notify.notifyProofRejected(fakeTask(), 'captain-oid', 'not received');
    const toAdmins = emitted.filter((e) => e.room === 'admins');
    expect(toAdmins.length).toBeGreaterThan(0);
    expect(toAdmins.every((e) => mentionsRef(e.payload))).toBe(true);
  });

  it('leaks nothing to captains across every task notification at once', () => {
    for (const [, run] of captainFacing) run();
    const leaks = emitted
      .filter((e) => captainRooms.includes(e.room))
      .filter((e) => mentionsRef(e.payload))
      .map((e) => e.event);
    expect(leaks).toEqual([]);
  });
});
