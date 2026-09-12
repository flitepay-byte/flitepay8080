/**
 * A captain hears about their own work, not somebody else's.
 *
 * Every connected captain sits in one broadcast room, which is what lets a
 * queue drop a card the moment someone else takes the task. That room is a
 * cache channel, and treating it as a notification channel is how each captain
 * ended up being told what the other was doing: with two captains online, one
 * claiming a task alerted the other, and a task falling into the open pool
 * alerted captains who were permanently barred from it.
 *
 * These tests pin down who each announcement is addressed to.
 */
import { jest } from '@jest/globals';
import { Types } from 'mongoose';

const emitToCaptain = jest.fn();
const emitToCaptainPool = jest.fn();
const emitToParty = jest.fn();
const emitToAdmins = jest.fn();
const emitToPartyPool = jest.fn();
const emitToUser = jest.fn();

jest.mock('../../sockets', () => ({
  emitToCaptain,
  emitToCaptainPool,
  emitToParty,
  emitToAdmins,
  emitToPartyPool,
  emitToUser,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const notify = require('../../services/notification.service') as typeof import('../../services/notification.service');

function fakeTask(): never {
  return {
    _id: new Types.ObjectId(),
    partyId: new Types.ObjectId(),
    taskCode: 'TASK-000123',
    captainTaskCode: 'CT-000123',
    externalRef: 'PARTY-REF-9',
    customerName: 'Rahul Sharma',
    amountPaise: 500_000,
    commissionPaise: 5_000,
    status: 'REASSIGNED',
    previousCaptainIds: [],
    createdAt: new Date('2026-03-01T09:00:00Z'),
    updatedAt: new Date('2026-03-01T09:00:00Z'),
  } as never;
}

describe('who a task announcement is addressed to', () => {
  beforeEach(() => {
    emitToCaptain.mockClear();
    emitToCaptainPool.mockClear();
    emitToParty.mockClear();
    emitToAdmins.mockClear();
  });

  describe('a task opening to the pool', () => {
    it('is sent only to the captains who may actually take it', () => {
      notify.notifyTaskOpenedToPool(fakeTask(), 5_000, ['cap-1', 'cap-3']);

      // Never the blanket room: a captain rejected off this task, or one who
      // cannot cover it, is in there too and must not be alerted.
      expect(emitToCaptainPool).not.toHaveBeenCalled();
      expect(emitToCaptain.mock.calls.map((c) => c[0])).toEqual(['cap-1', 'cap-3']);
    });

    it('tells each of them the same thing', () => {
      notify.notifyTaskOpenedToPool(fakeTask(), 5_000, ['cap-1', 'cap-2']);
      expect(emitToCaptain).toHaveBeenCalledTimes(2);
      for (const call of emitToCaptain.mock.calls) {
        expect(call[1]).toBe('task:available');
      }
      expect(emitToCaptain.mock.calls[0]?.[2]).toEqual(emitToCaptain.mock.calls[1]?.[2]);
    });

    it('says nothing at all when nobody is eligible', () => {
      notify.notifyTaskOpenedToPool(fakeTask(), 5_000, []);
      expect(emitToCaptain).not.toHaveBeenCalled();
      expect(emitToCaptainPool).not.toHaveBeenCalled();
    });

    it('still keeps the party reference away from captains', () => {
      notify.notifyTaskOpenedToPool(fakeTask(), 5_000, ['cap-1']);
      const payload = emitToCaptain.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('externalRef');
      expect(JSON.stringify(payload)).not.toContain('PARTY-REF-9');
    });
  });

  describe('a task being claimed', () => {
    it('goes to the whole pool, because every queue must drop the card', () => {
      notify.notifyTaskClaimed(fakeTask(), 'cap-1');
      expect(emitToCaptainPool).toHaveBeenCalledTimes(1);
      expect(emitToCaptainPool.mock.calls[0]?.[0]).toBe('task:claimed');
    });

    it('is not addressed to any captain personally', () => {
      // The distinction that matters: this is a cache signal for everyone, not
      // a message to anyone. The client must not raise it as a notification.
      notify.notifyTaskClaimed(fakeTask(), 'cap-1');
      expect(emitToCaptain).not.toHaveBeenCalled();
    });

    it('still tells the party and admin, who do want to know', () => {
      notify.notifyTaskClaimed(fakeTask(), 'cap-1');
      expect(emitToParty).toHaveBeenCalledTimes(1);
      expect(emitToAdmins).toHaveBeenCalledTimes(1);
    });
  });

  describe('an offer to one captain', () => {
    it('reaches that captain alone', () => {
      notify.notifyTaskOffered(fakeTask(), 'cap-2', 5_000, new Date());
      expect(emitToCaptainPool).not.toHaveBeenCalled();
      expect(emitToCaptain).toHaveBeenCalledTimes(1);
      expect(emitToCaptain.mock.calls[0]?.[0]).toBe('cap-2');
    });
  });

  describe('a proof decision', () => {
    it('reaches only the captain it concerns', () => {
      notify.notifyProofRejected(fakeTask(), 'cap-2', 'not received');
      expect(emitToCaptainPool).not.toHaveBeenCalled();
      expect(emitToCaptain.mock.calls.map((c) => c[0])).toEqual(['cap-2']);
    });

    it('does the same on approval', () => {
      notify.notifyProofApproved(fakeTask(), 'cap-2', 5_000);
      expect(emitToCaptainPool).not.toHaveBeenCalled();
      expect(emitToCaptain.mock.calls.map((c) => c[0])).toEqual(['cap-2']);
    });
  });
});
