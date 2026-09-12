/**
 * ACCEPTANCE WINDOW -> POOL -> COMPLETION WINDOW
 *
 * A pay-out passes through three separate clocks before it settles, and the
 * whole point of these tests is that they are three, not one:
 *
 *   1. The acceptance window. A task is offered to exactly one captain at a
 *      time — best fit first — and only they may see or claim it until their
 *      window lapses. Default `taskAcceptanceMinutes` = 5.
 *   2. The completion window. It starts at the *claim*, not at the start of
 *      work, and it is the party's own `completionMinutes` where they have set
 *      one. Default `taskCompletionMinutes` = 30.
 *   3. The customer-confirmation window, which begins only when proof is
 *      submitted, and which is global rather than per party.
 *
 * Nothing here assumes those numbers; each is read back out of the config or
 * off the task the assertion is about.
 *
 * The financial spine of the whole workflow is that **routing moves no money**.
 * An offer, a lapsed offer, and a re-offer to somebody else are all bookkeeping
 * about who is being asked — no hold is taken, no commission accrues, nobody is
 * debited. Money moves at exactly two points: the party is billed when the task
 * is created, and the captain's capital is held when they claim. So a task can
 * be offered to five captains in turn and the ledger must look identical to one
 * that was never offered at all.
 *
 * The two expiries are deliberately opposite, and that is worth stating plainly
 * because it is the easiest thing in this file to get backwards:
 *
 *   - `expireStaleUnclaimedTasks` gives up on a task nobody ever claimed, past
 *     `taskMaxAgeMinutes` from creation. It cancels outright and refunds the
 *     party in full — their DMC should not stay tied up in work nobody will do.
 *   - `expireOverdueTasks` catches a task somebody *did* claim and did not
 *     finish. It releases the captain's hold and moves the task to EXPIRED —
 *     and the party is **not** refunded, because the work is still owed. EXPIRED
 *     leads only to REJECTED, which puts it back in front of another captain.
 *
 * Time is moved by back-dating the deadline the sweeper reads, through the raw
 * driver where mongoose would otherwise maintain the field. The sweeps are
 * plain functions; the sixty-second interval they run on in production is a
 * polling frequency and is not a business rule, so it is never used as one here.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import {
  User, Party, Captain, Task, TaskOffer, Commission, hashPassword,
} from '../../models';
import { ensureSystemConfig, updateConfig, getConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import { sweepOffers } from '../../services/taskRouting.service';
import {
  startTask, submitProof, expireOverdueTasks, expireStaleUnclaimedTasks,
} from '../../services/workflow.service';
import { applyCustomerConfirmation } from '../../services/customerConfirmation.service';
import { getPlatformAccount } from '../../services/platformAccount.service';
import { rupeesToPaise } from '../../utils/money';

type Actor = { userId: string; role: 'ADMIN' | 'PARTY' | 'CAPTAIN' };

interface CaptainRef {
  id: Types.ObjectId;
  actor: Actor;
}
interface PartyRef {
  id: Types.ObjectId;
  userId: Types.ObjectId;
  actor: Actor;
}

/** Everything that can move, in one shape, so a step can be compared whole. */
interface Snapshot {
  party: number;
  captains: Record<string, number>;
  pool: number;
  commissionRows: number;
}

const PARTY_OPENING = 1_000_000;
const CAPTAIN_CAPITAL = 100_000;
const AMOUNT = 5_000;

describeIntegration('a pay-out through acceptance, the pool, and completion', () => {

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    await updateConfig(
      {
        payOutPartyCommissionPercentage: 5,
        payOutCaptainCommissionPercentage: 3,
        payInPartyCommissionPercentage: 0,
        payInCaptainCommissionPercentage: 0,
      },
      new Types.ObjectId(),
    );
  });

  // -------------------------------------------------------------------------
  // Fixtures. Small on purpose: at most three captains and three parties.
  // -------------------------------------------------------------------------
  async function makeParty(clocks?: { completionMinutes?: number; acceptanceMinutes?: number; maxAgeMinutes?: number }): Promise<PartyRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `party-${unique}@route.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: user._id,
      partyCode: `PARTY-${unique.slice(-6)}`,
      companyName: 'Routing Ltd',
      contactEmail: user.email,
      dmcBalancePaise: rupeesToPaise(PARTY_OPENING),
      ...(clocks ?? {}),
    });
    return { id: party._id, userId: user._id, actor: { userId: String(user._id), role: 'PARTY' } };
  }

  async function makeCaptain(label: string): Promise<CaptainRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@route.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: label,
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${unique.slice(-6)}`,
      displayName: label,
      collateralBalancePaise: rupeesToPaise(CAPTAIN_CAPITAL),
      dmcBalancePaise: rupeesToPaise(CAPTAIN_CAPITAL),
      lockedAmountPaise: 0,
      isOnline: true,
      status: 'ACTIVE',
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  async function makeTask(party: PartyRef, rupees = AMOUNT): Promise<Types.ObjectId> {
    const task = await createTask(
      {
        partyId: party.id,
        createdBy: party.userId,
        customerName: 'Routing Customer',
        payoutMethod: { type: 'UPI', upiId: 'route@bank' },
        amountPaise: rupeesToPaise(rupees),
      },
      party.actor,
    );
    return task._id;
  }

  const snapshot = async (party: PartyRef, captains: CaptainRef[]): Promise<Snapshot> => {
    const p = await Party.findById(party.id).select('dmcBalancePaise').lean();
    const caps: Record<string, number> = {};
    for (const c of captains) {
      const doc = await Captain.findById(c.id).select('dmcBalancePaise').lean();
      caps[String(c.id)] = doc?.dmcBalancePaise ?? -1;
    }
    return {
      party: p?.dmcBalancePaise ?? -1,
      captains: caps,
      pool: (await getPlatformAccount()).poolBalancePaise ?? 0,
      commissionRows: await Commission.countDocuments({}),
    };
  };

  /** Move a deadline into the past so the sweeper sees it as due. */
  const lapseOffer = async (taskId: Types.ObjectId): Promise<void> => {
    await Task.collection.updateOne(
      { _id: taskId },
      { $set: { offerExpiresAt: new Date(Date.now() - 1_000) } },
    );
  };
  const lapseCompletion = async (taskId: Types.ObjectId): Promise<void> => {
    await Task.collection.updateOne(
      { _id: taskId },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );
  };
  const ageTask = async (taskId: Types.ObjectId, minutes: number): Promise<void> => {
    await Task.collection.updateOne(
      { _id: taskId },
      { $set: { createdAt: new Date(Date.now() - minutes * 60_000) } },
    );
  };

  const load = async (taskId: Types.ObjectId) =>
    Task.findById(taskId).lean();

  // =========================================================================
  // 34.1 Creation
  // =========================================================================
  describe('when the task is created', () => {
    it('bills the party the amount plus their commission, and nobody else moves', async () => {
      const party = await makeParty();
      const cap = await makeCaptain('A');
      const before = await snapshot(party, [cap]);

      await makeTask(party);
      const after = await snapshot(party, [cap]);

      expect(before.party - after.party).toBe(rupeesToPaise(AMOUNT) + rupeesToPaise(AMOUNT) * 5 / 100);
      expect(after.captains[String(cap.id)]).toBe(before.captains[String(cap.id)]);
      expect(after.pool).toBe(before.pool);
    });

    it('pays no captain commission merely for existing', async () => {
      const party = await makeParty();
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      // Nothing is earned until COMPLETED; a created task has earned nobody
      // anything, however long it sits.
      expect(await Commission.countDocuments({ taskId: id })).toBe(0);
      expect((await snapshot(party, [cap])).pool).toBe(0);
    });

    it('offers it to exactly one captain, with that captain’s countdown on it', async () => {
      const party = await makeParty();
      await makeCaptain('A');
      await makeCaptain('B');
      const id = await makeTask(party);

      const task = await load(id);
      expect(task?.status).toBe('CREATED');
      expect(task?.captainId ?? null).toBeNull();
      expect(task?.offeredCaptainId).toBeTruthy();
      expect(task?.offerExpiresAt).toBeTruthy();
    });

    it('sets the acceptance countdown from the configured window, not a guess', async () => {
      const config = await getConfig();
      const party = await makeParty();
      await makeCaptain('A');
      const id = await makeTask(party);

      const task = await load(id);
      const offered = task?.offeredAt?.getTime() ?? 0;
      const expires = task?.offerExpiresAt?.getTime() ?? 0;
      // Read the window off the config rather than writing 5 here, so the test
      // follows a settings change instead of contradicting it.
      expect(Math.round((expires - offered) / 60_000)).toBe(config.taskAcceptanceMinutes);
    });

    it('writes the party’s own clocks onto the task', async () => {
      const party = await makeParty({ completionMinutes: 20, acceptanceMinutes: 7 });
      await makeCaptain('A');
      const id = await makeTask(party);

      const task = await load(id);
      expect(task?.acceptanceMinutes).toBe(7);
      expect(task?.completionMinutes).toBe(20);
    });

    it('leaves the completion clock unstarted until somebody claims it', async () => {
      const party = await makeParty();
      await makeCaptain('A');
      const id = await makeTask(party);
      // `expiresAt` is the completion deadline and is set at the claim.
      expect((await load(id))?.expiresAt ?? null).toBeNull();
    });
  });

  // =========================================================================
  // 34.2 / 34.6 Accepting inside the window
  // =========================================================================
  describe('when the offered captain accepts', () => {
    it('assigns the task and stops the acceptance countdown', async () => {
      const party = await makeParty();
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      await claimTask(String(id), cap.id, cap.actor);

      const task = await load(id);
      expect(task?.status).toBe('ASSIGNED');
      expect(String(task?.captainId)).toBe(String(cap.id));
      expect(task?.offeredCaptainId ?? null).toBeNull();
      expect(task?.offerExpiresAt ?? null).toBeNull();
    });

    it('starts the completion countdown from the claim', async () => {
      const config = await getConfig();
      const party = await makeParty();
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      await claimTask(String(id), cap.id, cap.actor);

      const task = await load(id);
      const claimed = task?.claimedAt?.getTime() ?? 0;
      const expires = task?.expiresAt?.getTime() ?? 0;
      expect(Math.round((expires - claimed) / 60_000)).toBe(config.taskCompletionMinutes);
    });

    it('holds the captain’s capital and nothing more', async () => {
      const party = await makeParty();
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      const before = await snapshot(party, [cap]);

      await claimTask(String(id), cap.id, cap.actor);
      const after = await snapshot(party, [cap]);

      // The captain undertakes to send the amount, so the amount is held.
      expect(before.captains[String(cap.id)]! - after.captains[String(cap.id)]!).toBe(rupeesToPaise(AMOUNT));
      // The party was billed at creation and is not billed again.
      expect(after.party).toBe(before.party);
      expect(after.pool).toBe(before.pool);
    });

    it('pays no commission at the moment of acceptance', async () => {
      const party = await makeParty();
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      await claimTask(String(id), cap.id, cap.actor);
      expect(await Commission.countDocuments({ taskId: id })).toBe(0);
      expect((await snapshot(party, [cap])).pool).toBe(0);
    });

    it('refuses a captain the task was never offered to', async () => {
      const party = await makeParty();
      const a = await makeCaptain('A');
      const b = await makeCaptain('B');
      const id = await makeTask(party);

      const task = await load(id);
      const offered = String(task?.offeredCaptainId);
      const other = offered === String(a.id) ? b : a;
      // Exclusive offer: nobody else may take it while the window is live.
      await expect(claimTask(String(id), other.id, other.actor)).rejects.toThrow();
    });
  });

  // =========================================================================
  // 34.3 / 34.4 The acceptance window lapsing, and re-routing
  // =========================================================================
  describe('when the acceptance window lapses', () => {
    it('passes the task to a different captain', async () => {
      const party = await makeParty();
      await makeCaptain('A');
      await makeCaptain('B');
      const id = await makeTask(party);
      const first = String((await load(id))?.offeredCaptainId);

      await lapseOffer(id);
      await sweepOffers();

      const task = await load(id);
      expect(task?.offeredCaptainId).toBeTruthy();
      expect(String(task?.offeredCaptainId)).not.toBe(first);
      expect(task?.offeredCaptainIds.map(String)).toContain(first);
    });

    it('moves no money at all', async () => {
      const party = await makeParty();
      const a = await makeCaptain('A');
      const b = await makeCaptain('B');
      const id = await makeTask(party);
      const before = await snapshot(party, [a, b]);

      await lapseOffer(id);
      await sweepOffers();

      // Routing is bookkeeping about who is being asked. No hold, no debit,
      // no commission, no refund.
      expect(await snapshot(party, [a, b])).toEqual(before);
    });

    it('records the miss against the captain who let it lapse', async () => {
      const party = await makeParty();
      await makeCaptain('A');
      await makeCaptain('B');
      const id = await makeTask(party);
      const first = String((await load(id))?.offeredCaptainId);

      await lapseOffer(id);
      await sweepOffers();

      const missed = await TaskOffer.countDocuments({ taskId: id, captainId: first, status: 'MISSED' });
      expect(missed).toBe(1);
    });

    it('stops the passed-over captain from claiming it afterwards', async () => {
      const party = await makeParty();
      const a = await makeCaptain('A');
      const b = await makeCaptain('B');
      const id = await makeTask(party);
      const firstId = String((await load(id))?.offeredCaptainId);
      const first = String(a.id) === firstId ? a : b;

      await lapseOffer(id);
      await sweepOffers();

      await expect(claimTask(String(id), first.id, first.actor)).rejects.toThrow();
    });

    it('lets the captain it moved to claim it', async () => {
      const party = await makeParty();
      const a = await makeCaptain('A');
      const b = await makeCaptain('B');
      const id = await makeTask(party);
      await lapseOffer(id);
      await sweepOffers();

      const secondId = String((await load(id))?.offeredCaptainId);
      const second = String(a.id) === secondId ? a : b;
      await claimTask(String(id), second.id, second.actor);

      const task = await load(id);
      expect(task?.status).toBe('ASSIGNED');
      expect(String(task?.captainId)).toBe(secondId);
    });

    it('leaves the task assigned to exactly one captain, never two', async () => {
      const party = await makeParty();
      const a = await makeCaptain('A');
      const b = await makeCaptain('B');
      const id = await makeTask(party);
      await lapseOffer(id);
      await sweepOffers();
      const secondId = String((await load(id))?.offeredCaptainId);
      const second = String(a.id) === secondId ? a : b;
      const first = second === a ? b : a;

      await claimTask(String(id), second.id, second.actor);
      await expect(claimTask(String(id), first.id, first.actor)).rejects.toThrow();

      // Exactly one hold exists across both captains.
      const after = await snapshot(party, [a, b]);
      const held = Object.values(after.captains).filter((v) => v < rupeesToPaise(CAPTAIN_CAPITAL));
      expect(held).toHaveLength(1);
    });

    it('bills the party once however many captains it passed through', async () => {
      const party = await makeParty();
      const a = await makeCaptain('A');
      const b = await makeCaptain('B');
      const c = await makeCaptain('C');
      const opening = rupeesToPaise(PARTY_OPENING);
      const id = await makeTask(party);
      const billed = opening - (await snapshot(party, [a, b, c])).party;

      for (let i = 0; i < 2; i += 1) {
        await lapseOffer(id);
        await sweepOffers();
      }

      expect(opening - (await snapshot(party, [a, b, c])).party).toBe(billed);
      expect(await Task.countDocuments({ partyId: party.id })).toBe(1);
    });
  });

  // =========================================================================
  // 34.5 Routing to exhaustion
  // =========================================================================
  describe('when every captain has had a turn', () => {
    it('falls back to the open pool rather than losing the task', async () => {
      const party = await makeParty();
      const a = await makeCaptain('A');
      const b = await makeCaptain('B');
      const id = await makeTask(party);

      // Two captains, so two lapses exhausts routing.
      for (let i = 0; i < 3; i += 1) {
        await lapseOffer(id);
        await sweepOffers();
      }

      const task = await load(id);
      expect(task?.openPoolAt).toBeTruthy();
      expect(task?.status).toBe('CREATED');
      expect(await snapshot(party, [a, b])).toMatchObject({ pool: 0, commissionRows: 0 });
    });

    it('lets any eligible captain take it out of the pool', async () => {
      const party = await makeParty();
      const a = await makeCaptain('A');
      const b = await makeCaptain('B');
      const id = await makeTask(party);
      for (let i = 0; i < 3; i += 1) {
        await lapseOffer(id);
        await sweepOffers();
      }
      expect((await load(id))?.openPoolAt).toBeTruthy();

      await claimTask(String(id), a.id, a.actor);
      expect(String((await load(id))?.captainId)).toBe(String(a.id));
      expect(b).toBeTruthy();
    });

    it('routes a task nobody could take when a captain appears later', async () => {
      const party = await makeParty();
      const id = await makeTask(party); // no captains exist yet
      expect((await load(id))?.offeredCaptainId ?? null).toBeNull();

      await makeCaptain('LateArrival');
      await sweepOffers();

      expect((await load(id))?.offeredCaptainId).toBeTruthy();
    });

    it('moves no money while a task waits with nobody to offer it to', async () => {
      const party = await makeParty();
      const opening = rupeesToPaise(PARTY_OPENING);
      const id = await makeTask(party);
      const billed = opening - (await snapshot(party, [])).party;

      await sweepOffers();
      await sweepOffers();

      expect(opening - (await snapshot(party, [])).party).toBe(billed);
      expect(id).toBeTruthy();
    });

    it('is unchanged by the sweep running twice over the same lapse', async () => {
      const party = await makeParty();
      const a = await makeCaptain('A');
      const b = await makeCaptain('B');
      const id = await makeTask(party);
      await lapseOffer(id);

      await sweepOffers();
      const afterFirst = await snapshot(party, [a, b]);
      const offered = String((await load(id))?.offeredCaptainId);

      // A second sweep with nothing newly due must not advance anything: the
      // production job runs every sixty seconds and will see this task again.
      await sweepOffers();
      expect(await snapshot(party, [a, b])).toEqual(afterFirst);
      expect(String((await load(id))?.offeredCaptainId)).toBe(offered);
    });
  });

  // =========================================================================
  // 34.3 (financial) The hard ceiling on an unclaimed task
  // =========================================================================
  describe('when an unclaimed task passes its maximum age', () => {
    it('cancels it and refunds the party in full', async () => {
      const party = await makeParty({ maxAgeMinutes: 10 });
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      await ageTask(id, 30);

      await expireStaleUnclaimedTasks();

      expect((await load(id))?.status).toBe('CANCELLED');
      const after = await snapshot(party, [cap]);
      expect(after.party).toBe(rupeesToPaise(PARTY_OPENING));
      expect(after.pool).toBe(0);
      expect(after.commissionRows).toBe(0);
    });

    it('refunds once however many times the sweep runs', async () => {
      const party = await makeParty({ maxAgeMinutes: 10 });
      const id = await makeTask(party);
      await ageTask(id, 30);

      await expireStaleUnclaimedTasks();
      await expireStaleUnclaimedTasks();
      await expireStaleUnclaimedTasks();

      expect((await snapshot(party, [])).party).toBe(rupeesToPaise(PARTY_OPENING));
    });

    it('leaves a claimed task alone — the captain’s own deadline governs it', async () => {
      const party = await makeParty({ maxAgeMinutes: 10 });
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      await claimTask(String(id), cap.id, cap.actor);
      await ageTask(id, 30);

      await expireStaleUnclaimedTasks();

      expect((await load(id))?.status).toBe('ASSIGNED');
    });
  });

  // =========================================================================
  // 34.7 / 34.8 / 34.18 The completion window is the party's
  // =========================================================================
  describe('the completion window', () => {
    it('falls back to the configured default when the party has set none', async () => {
      const config = await getConfig();
      const party = await makeParty();
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      await claimTask(String(id), cap.id, cap.actor);

      const task = await load(id);
      const minutes = Math.round(
        ((task?.expiresAt?.getTime() ?? 0) - (task?.claimedAt?.getTime() ?? 0)) / 60_000,
      );
      expect(minutes).toBe(config.taskCompletionMinutes);
    });

    it('uses each party’s own window, and never another party’s', async () => {
      const a = await makeParty({ completionMinutes: 20 });
      const b = await makeParty({ completionMinutes: 45 });
      const capA = await makeCaptain('A');
      const capB = await makeCaptain('B');

      const idA = await makeTask(a);
      const idB = await makeTask(b);
      // Whoever each was offered to, claim it as them.
      const offeredA = String((await load(idA))?.offeredCaptainId);
      const offeredB = String((await load(idB))?.offeredCaptainId);
      const asA = offeredA === String(capA.id) ? capA : capB;
      const asB = offeredB === String(capA.id) ? capA : capB;
      await claimTask(String(idA), asA.id, asA.actor);
      await claimTask(String(idB), asB.id, asB.actor);

      const windowOf = async (id: Types.ObjectId): Promise<number> => {
        const t = await load(id);
        return Math.round(((t?.expiresAt?.getTime() ?? 0) - (t?.claimedAt?.getTime() ?? 0)) / 60_000);
      };
      expect(await windowOf(idA)).toBe(20);
      expect(await windowOf(idB)).toBe(45);
    });

    it('holds a captain to the window of the party whose task they took', async () => {
      // The same captain works for two parties; the clock is the task's, not
      // theirs. A captain has no window of their own.
      const slow = await makeParty({ completionMinutes: 45 });
      const fast = await makeParty({ completionMinutes: 20 });
      const cap = await makeCaptain('Only');

      const slowId = await makeTask(slow);
      await claimTask(String(slowId), cap.id, cap.actor);
      const fastId = await makeTask(fast);
      await claimTask(String(fastId), cap.id, cap.actor);

      const windowOf = async (id: Types.ObjectId): Promise<number> => {
        const t = await load(id);
        return Math.round(((t?.expiresAt?.getTime() ?? 0) - (t?.claimedAt?.getTime() ?? 0)) / 60_000);
      };
      expect(await windowOf(slowId)).toBe(45);
      expect(await windowOf(fastId)).toBe(20);
    });

    it('does not move a running task’s clock when the party changes theirs', async () => {
      const party = await makeParty({ completionMinutes: 20 });
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      await claimTask(String(id), cap.id, cap.actor);
      const before = (await load(id))?.expiresAt?.getTime();

      await Party.updateOne({ _id: party.id }, { $set: { completionMinutes: 90 } });

      // Settled at creation and written onto the task, so a later edit applies
      // to tasks created from then on and never to a countdown already running.
      expect((await load(id))?.expiresAt?.getTime()).toBe(before);
      expect((await load(id))?.completionMinutes).toBe(20);
    });

    it('applies a changed window to tasks created after the change', async () => {
      const party = await makeParty({ completionMinutes: 20 });
      await makeCaptain('A');
      await Party.updateOne({ _id: party.id }, { $set: { completionMinutes: 90 } });
      const id = await makeTask(party);
      expect((await load(id))?.completionMinutes).toBe(90);
    });
  });

  // =========================================================================
  // 34.9 / 34.11 / 34.13 Finishing, or not, inside the window
  // =========================================================================
  describe('the completion deadline', () => {
    const claimed = async (): Promise<{ party: PartyRef; cap: CaptainRef; id: Types.ObjectId }> => {
      const party = await makeParty();
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      await claimTask(String(id), cap.id, cap.actor);
      return { party, cap, id };
    };

    it('lets a captain finish while the window is still open', async () => {
      const { cap, id } = await claimed();
      await startTask(String(id), cap.id, cap.actor);
      await submitProof(
        { taskId: String(id), captainId: cap.id, providerReference: 'UTR-INTIME' },
        cap.actor,
      );
      // Proof applies two transitions at once — IN_PROGRESS -> PROOF_SUBMITTED
      // -> AUDIT_PENDING — so the state that persists is AUDIT_PENDING, waiting
      // on the party to relay their customer's answer.
      expect((await load(id))?.status).toBe('AUDIT_PENDING');
    });

    it('does not expire a task whose window has not passed', async () => {
      const { id } = await claimed();
      expect(await expireOverdueTasks()).toBe(0);
      expect((await load(id))?.status).toBe('ASSIGNED');
    });

    it('expires a claimed task that ran out of time', async () => {
      const { id } = await claimed();
      await lapseCompletion(id);
      await expireOverdueTasks();
      expect((await load(id))?.status).toBe('EXPIRED');
    });

    it('expires one left claimed but never started, just the same', async () => {
      // The completion clock runs from the claim, not from the start.
      const { id } = await claimed();
      await lapseCompletion(id);
      await expireOverdueTasks();
      expect((await load(id))?.status).toBe('EXPIRED');
    });

    it('gives the captain their held capital back on expiry', async () => {
      const { party, cap, id } = await claimed();
      await lapseCompletion(id);
      await expireOverdueTasks();
      expect((await snapshot(party, [cap])).captains[String(cap.id)]).toBe(rupeesToPaise(CAPTAIN_CAPITAL));
    });

    it('does NOT refund the party, because the work is still owed', async () => {
      const { party, cap, id } = await claimed();
      const billed = rupeesToPaise(PARTY_OPENING) - (await snapshot(party, [cap])).party;
      await lapseCompletion(id);
      await expireOverdueTasks();
      // EXPIRED leads only to REJECTED, which puts the task back in front of
      // another captain — the opposite of the unclaimed max-age expiry above.
      expect(rupeesToPaise(PARTY_OPENING) - (await snapshot(party, [cap])).party).toBe(billed);
    });

    it('pays nobody any commission on expiry', async () => {
      const { party, cap, id } = await claimed();
      await lapseCompletion(id);
      await expireOverdueTasks();
      const after = await snapshot(party, [cap]);
      expect(after.pool).toBe(0);
      expect(await Commission.countDocuments({ taskId: id })).toBe(0);
    });

    it('starts the captain’s grace period to explain what happened', async () => {
      const { id } = await claimed();
      await lapseCompletion(id);
      await expireOverdueTasks();
      expect((await load(id))?.expiryAckDeadline).toBeTruthy();
    });

    it('refuses proof once the task has expired', async () => {
      const { cap, id } = await claimed();
      await lapseCompletion(id);
      await expireOverdueTasks();
      await expect(
        submitProof({ taskId: String(id), captainId: cap.id, providerReference: 'UTR-LATE' }, cap.actor),
      ).rejects.toThrow();
    });

    it('releases the hold exactly once when the sweep runs repeatedly', async () => {
      const { party, cap, id } = await claimed();
      await lapseCompletion(id);
      await expireOverdueTasks();
      await expireOverdueTasks();
      await expireOverdueTasks();
      expect((await snapshot(party, [cap])).captains[String(cap.id)]).toBe(rupeesToPaise(CAPTAIN_CAPITAL));
    });

    it('leaves a task that already submitted proof alone', async () => {
      const { cap, id } = await claimed();
      await startTask(String(id), cap.id, cap.actor);
      await submitProof({ taskId: String(id), captainId: cap.id, providerReference: 'UTR-OK' }, cap.actor);
      await lapseCompletion(id);
      // The sweep only looks at ASSIGNED and IN_PROGRESS, and proof has moved
      // this one past both.
      await expireOverdueTasks();
      expect((await load(id))?.status).toBe('AUDIT_PENDING');
    });
  });

  // =========================================================================
  // 34.12 Three clocks, not one
  // =========================================================================
  describe('the three windows stay separate', () => {
    it('does not start the completion clock when the acceptance clock lapses', async () => {
      const party = await makeParty();
      await makeCaptain('A');
      await makeCaptain('B');
      const id = await makeTask(party);
      await lapseOffer(id);
      await sweepOffers();
      expect((await load(id))?.expiresAt ?? null).toBeNull();
    });

    it('does not start the confirmation clock before proof is submitted', async () => {
      const party = await makeParty();
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      await claimTask(String(id), cap.id, cap.actor);
      await startTask(String(id), cap.id, cap.actor);
      expect((await load(id))?.confirmationDeadline ?? null).toBeNull();
    });

    it('starts the confirmation clock at the proof, from the global setting', async () => {
      const config = await getConfig();
      const party = await makeParty({ completionMinutes: 20 });
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      await claimTask(String(id), cap.id, cap.actor);
      await startTask(String(id), cap.id, cap.actor);
      await submitProof({ taskId: String(id), captainId: cap.id, providerReference: 'UTR-P' }, cap.actor);

      const task = await load(id);
      const minutes = Math.round(
        ((task?.confirmationDeadline?.getTime() ?? 0) - Date.now()) / 60_000,
      );
      // The party's 20-minute completion window must not have become the
      // confirmation window; that one is global.
      expect(minutes).toBe(config.customerConfirmationMinutes);
      expect(minutes).not.toBe(20);
    });

    it('does not let the completion sweep touch a task waiting on the customer', async () => {
      const party = await makeParty();
      const cap = await makeCaptain('A');
      const id = await makeTask(party);
      await claimTask(String(id), cap.id, cap.actor);
      await startTask(String(id), cap.id, cap.actor);
      await submitProof({ taskId: String(id), captainId: cap.id, providerReference: 'UTR-P' }, cap.actor);
      await lapseCompletion(id);

      await expireOverdueTasks();
      expect((await load(id))?.status).toBe('AUDIT_PENDING');
    });
  });

  // =========================================================================
  // 34.16 The whole path, with a re-route in the middle
  // =========================================================================
  describe('the full path from creation to settlement', () => {
    it('settles correctly after the first captain let the offer lapse', async () => {
      const party = await makeParty({ completionMinutes: 25 });
      const a = await makeCaptain('A');
      const b = await makeCaptain('B');
      const opening = await snapshot(party, [a, b]);

      // 1. Created and billed.
      const id = await makeTask(party);
      const created = await snapshot(party, [a, b]);
      const billed = opening.party - created.party;
      expect(billed).toBe(rupeesToPaise(AMOUNT) + rupeesToPaise(AMOUNT) * 5 / 100);

      // 2. First captain lets the window lapse — no money moves.
      const firstId = String((await load(id))?.offeredCaptainId);
      await lapseOffer(id);
      await sweepOffers();
      expect(await snapshot(party, [a, b])).toEqual(created);

      // 3. The second takes it.
      const secondId = String((await load(id))?.offeredCaptainId);
      expect(secondId).not.toBe(firstId);
      const second = String(a.id) === secondId ? a : b;
      const first = second === a ? b : a;
      await claimTask(String(id), second.id, second.actor);

      const held = await snapshot(party, [a, b]);
      expect(held.captains[secondId]).toBe(rupeesToPaise(CAPTAIN_CAPITAL) - rupeesToPaise(AMOUNT));
      // The captain who let it lapse is untouched throughout.
      expect(held.captains[String(first.id)]).toBe(rupeesToPaise(CAPTAIN_CAPITAL));

      // 4. Work, proof, and the customer's answer.
      await startTask(String(id), second.id, second.actor);
      await submitProof({ taskId: String(id), captainId: second.id, providerReference: 'UTR-FULL' }, second.actor);
      expect((await load(id))?.status).toBe('AUDIT_PENDING');

      await applyCustomerConfirmation({
        taskId: String(id),
        partyId: party.id,
        received: true,
        actor: party.actor,
      });

      // 5. Settled.
      const done = await load(id);
      expect(done?.status).toBe('COMPLETED');

      const final = await snapshot(party, [a, b]);
      // The party paid the amount plus its commission, and nothing came back.
      expect(opening.party - final.party).toBe(billed);
      /**
       * The captain's DMC comes back three ways at once, which is worth
       * spelling out because it is easy to count twice:
       *
       *   + the hold released (the amount, which was taken at the claim)
       *   + the reimbursement (the same amount again — they sent real money to
       *     the customer out of their own pocket, and this is the system paying
       *     them back for it)
       *   + their commission
       *
       * Netting the hold against itself, they end up ahead by the amount they
       * fronted plus their fee.
       */
      const captainGain = final.captains[secondId]! - rupeesToPaise(CAPTAIN_CAPITAL);
      const captainFee = rupeesToPaise(AMOUNT) * 3 / 100;
      expect(captainGain).toBe(rupeesToPaise(AMOUNT) + captainFee);

      // The platform keeps what the captain did not: the remainder of the
      // party's charge, by subtraction and never as its own percentage.
      expect(final.pool).toBe(rupeesToPaise(AMOUNT) * 5 / 100 - captainFee);
      // The passed-over captain never moved.
      expect(final.captains[String(first.id)]).toBe(rupeesToPaise(CAPTAIN_CAPITAL));

      // Nothing was created from nothing: every paise the party lost arrived
      // somewhere, and no paise arrived from anywhere else.
      expect(billed).toBe(captainGain + final.pool);
    });
  });

  // =========================================================================
  // 34.17 The whole path, ending in a completion timeout
  // =========================================================================
  describe('the full path ending in a completion timeout', () => {
    it('releases the second captain’s hold and leaves the party still committed', async () => {
      const party = await makeParty();
      const a = await makeCaptain('A');
      const b = await makeCaptain('B');
      const opening = await snapshot(party, [a, b]);

      const id = await makeTask(party);
      const created = await snapshot(party, [a, b]);
      const billed = opening.party - created.party;

      await lapseOffer(id);
      await sweepOffers();
      const secondId = String((await load(id))?.offeredCaptainId);
      const second = String(a.id) === secondId ? a : b;
      const first = second === a ? b : a;
      await claimTask(String(id), second.id, second.actor);

      await lapseCompletion(id);
      await expireOverdueTasks();

      const final = await snapshot(party, [a, b]);
      expect((await load(id))?.status).toBe('EXPIRED');
      // Hold released.
      expect(final.captains[secondId]).toBe(rupeesToPaise(CAPTAIN_CAPITAL));
      // First captain never involved.
      expect(final.captains[String(first.id)]).toBe(rupeesToPaise(CAPTAIN_CAPITAL));
      // Party still billed — the work is still owed, not refunded.
      expect(opening.party - final.party).toBe(billed);
      // Nobody earned anything.
      expect(final.pool).toBe(0);
      expect(final.commissionRows).toBe(0);
    });
  });
});
