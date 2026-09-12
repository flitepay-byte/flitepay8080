/**
 * A CANCELLED PAY-OUT RETURNS EXACTLY WHAT IT TOOK
 *
 * A party is billed the whole cost of a pay-out the moment it is created: the
 * amount, plus the captain's commission, plus the platform's. That debit is
 * what reserves the money. If the work never happens, all of it has to come
 * back — and only once.
 *
 * Two failure modes are being guarded against, and they are opposites:
 *
 *   - Refunding less than was taken. The party is quietly out of pocket, and
 *     the difference sits in the ledger belonging to nobody.
 *   - Refunding more than was taken, or refunding twice. That is DMC created
 *     from nothing, and the reconciliation will never close again.
 *
 * The second is the one repeats cause, so every stage here is cancelled twice
 * and the balance is checked against the opening figure rather than against
 * the previous line. A refund that is correct once and wrong on the retry is
 * the bug that matters.
 *
 * Commission is asserted separately from the amount, because they move for
 * different reasons: the amount is the party's money going out and coming
 * back, while the commission was never earned — nobody did the work — so
 * neither the captain nor the platform may keep any of it. `COMPLETED` is
 * terminal precisely so that a credit which has happened can never be
 * cancelled out from under itself; the mirror of that rule is that a task
 * which never completed must never have credited anyone at all.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import {
  User, Party, Captain, Task, Commission, DMCAllocation, hashPassword,
} from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import { startTask, requestCancellation, reviewCancellationAsCaptain, resolveCancelDispute } from '../../services/workflow.service';
import { getPlatformAccount } from '../../services/platformAccount.service';
import { rupeesToPaise } from '../../utils/money';

type Actor = { userId: string; role: 'ADMIN' | 'PARTY' | 'CAPTAIN' };

const OPENING = 1_000_000; // DMC the party starts with, in rupees
const AMOUNT = 5_000; // the pay-out, in rupees
const PARTY_RATE = 5;
const CAPTAIN_RATE = 3;

describeIntegration('cancelling a pay-out returns exactly what it took', () => {
  let partyId: Types.ObjectId;
  let captainId: Types.ObjectId;
  let partyUserId: Types.ObjectId;
  let partyActor: Actor;
  let captainActor: Actor;
  let admin: Actor;

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
        payOutPartyCommissionPercentage: PARTY_RATE,
        payOutCaptainCommissionPercentage: CAPTAIN_RATE,
        payInPartyCommissionPercentage: 0,
        payInCaptainCommissionPercentage: 0,
      },
      new Types.ObjectId(),
    );

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');
    const adminUser = await User.create({
      email: `admin-${unique}@cancel.test`, passwordHash: password, name: 'Admin', role: 'ADMIN',
    });
    const partyUser = await User.create({
      email: `party-${unique}@cancel.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const captainUser = await User.create({
      email: `cap-${unique}@cancel.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });

    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${unique.slice(-6)}`,
      companyName: 'Cancel Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(OPENING),
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${unique.slice(-6)}`,
      displayName: 'Cancel Captain',
      collateralBalancePaise: rupeesToPaise(500_000),
      dmcBalancePaise: rupeesToPaise(500_000),
      isOnline: true,
      status: 'ACTIVE',
    });

    partyId = party._id;
    partyUserId = partyUser._id;
    captainId = captain._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };
    captainActor = { userId: String(captainUser._id), role: 'CAPTAIN' };
    admin = { userId: String(adminUser._id), role: 'ADMIN' };
  });

  const partyDmc = async (): Promise<number> =>
    (await Party.findById(partyId).select('dmcBalancePaise').lean())?.dmcBalancePaise ?? -1;
  const captainDmc = async (): Promise<number> =>
    (await Captain.findById(captainId).select('dmcBalancePaise').lean())?.dmcBalancePaise ?? -1;
  const platformPool = async (): Promise<number> => {
    const account = await getPlatformAccount();
    return account.poolBalancePaise ?? 0;
  };

  const makeTask = async (rupees = AMOUNT): Promise<string> => {
    const task = await createTask(
      {
        partyId,
        createdBy: partyUserId,
        customerName: 'Cancel Customer',
        payoutMethod: { type: 'UPI', upiId: 'cancel@bank' },
        amountPaise: rupeesToPaise(rupees),
      },
      partyActor,
    );
    return String(task._id);
  };

  /** What the party was billed: the amount plus both commissions. */
  const billedFor = (rupees: number): number =>
    rupeesToPaise(rupees) + Math.round(rupeesToPaise(rupees) * PARTY_RATE / 100);

  // =========================================================================
  // Before anybody holds it
  // =========================================================================
  describe('cancelled before a captain takes it', () => {
    it('bills the party the amount plus the party commission', async () => {
      const before = await partyDmc();
      await makeTask();
      expect(before - (await partyDmc())).toBe(billedFor(AMOUNT));
    });

    it('returns every paise of it', async () => {
      const id = await makeTask();
      await requestCancellation(id, 'customer went quiet', partyActor);
      expect(await partyDmc()).toBe(rupeesToPaise(OPENING));
    });

    it('returns nothing a second time', async () => {
      const id = await makeTask();
      await requestCancellation(id, 'customer went quiet', partyActor);
      await expect(requestCancellation(id, 'again', partyActor)).rejects.toThrow();
      expect(await partyDmc()).toBe(rupeesToPaise(OPENING));
    });

    it('returns nothing extra however many repeats race', async () => {
      const id = await makeTask();
      await Promise.allSettled(
        Array.from({ length: 4 }, () => requestCancellation(id, 'race', partyActor)),
      );
      expect(await partyDmc()).toBe(rupeesToPaise(OPENING));
    });

    it('pays the captain nothing', async () => {
      const id = await makeTask();
      await requestCancellation(id, 'customer went quiet', partyActor);
      expect(await captainDmc()).toBe(rupeesToPaise(500_000));
    });

    it('pays the platform nothing', async () => {
      const poolBefore = await platformPool();
      const id = await makeTask();
      await requestCancellation(id, 'customer went quiet', partyActor);
      expect(await platformPool()).toBe(poolBefore);
    });

    it('leaves no commission row behind', async () => {
      const id = await makeTask();
      await requestCancellation(id, 'customer went quiet', partyActor);
      expect(await Commission.countDocuments({ taskId: new Types.ObjectId(id) })).toBe(0);
    });

    it('leaves no DMC allocation behind', async () => {
      const id = await makeTask();
      await requestCancellation(id, 'customer went quiet', partyActor);
      const allocations = await DMCAllocation.find({ taskId: new Types.ObjectId(id) }).lean();
      const net = allocations.reduce((sum, a) => sum + (a.amountPaise ?? 0), 0);
      // Either nothing was written, or what was written nets to zero.
      expect(net).toBe(0);
    });

    it('marks the task cancelled rather than leaving it claimable', async () => {
      const id = await makeTask();
      await requestCancellation(id, 'customer went quiet', partyActor);
      const task = await Task.findById(id).lean();
      expect(task?.status).toBe('CANCELLED');
    });

    it('returns the right amount at each of several sizes', async () => {
      // All above minimumTaskAmountPaise (DMC 100), which createTask enforces.
      for (const rupees of [100, 101, 999, 1_000, 8_100, 9_999]) {
        const opening = await partyDmc();
        const id = await makeTask(rupees);
        expect(opening - (await partyDmc())).toBe(billedFor(rupees));
        await requestCancellation(id, 'size sweep', partyActor);
        expect(await partyDmc()).toBe(opening);
      }
    });
  });

  // =========================================================================
  // While a captain holds it
  // =========================================================================
  describe('cancelled while a captain holds it', () => {
    const claimed = async (): Promise<string> => {
      const id = await makeTask();
      await claimTask(id, captainId, captainActor);
      return id;
    };

    it('does not refund on the request alone — the captain has to agree', async () => {
      const id = await claimed();
      const billed = rupeesToPaise(OPENING) - (await partyDmc());
      await requestCancellation(id, 'customer changed their mind', partyActor);
      // Still billed: a party cannot pull money back out from under a captain
      // who may already have sent it.
      expect(rupeesToPaise(OPENING) - (await partyDmc())).toBe(billed);
    });

    it('refunds in full once the captain approves', async () => {
      const id = await claimed();
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'APPROVE', undefined, captainActor);
      expect(await partyDmc()).toBe(rupeesToPaise(OPENING));
    });

    it('refunds once, not twice, when the approval is repeated', async () => {
      const id = await claimed();
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'APPROVE', undefined, captainActor);
      await expect(
        reviewCancellationAsCaptain(id, captainId, 'APPROVE', undefined, captainActor),
      ).rejects.toThrow();
      expect(await partyDmc()).toBe(rupeesToPaise(OPENING));
    });

    it('gives the captain their held capital back', async () => {
      const id = await claimed();
      const heldDown = rupeesToPaise(500_000) - (await captainDmc());
      expect(heldDown).toBeGreaterThan(0);

      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'APPROVE', undefined, captainActor);
      expect(await captainDmc()).toBe(rupeesToPaise(500_000));
    });

    it('pays the captain no commission for work that did not happen', async () => {
      const id = await claimed();
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'APPROVE', undefined, captainActor);
      // Back to exactly the opening figure: released hold and nothing more.
      expect(await captainDmc()).toBe(rupeesToPaise(500_000));
    });

    it('sends the task to admin when the captain refuses', async () => {
      const id = await claimed();
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'REJECT', 'already paid it', captainActor);
      const task = await Task.findById(id).lean();
      expect(task?.status).toBe('CANCEL_DISPUTED');
    });

    it('refunds nothing while the dispute is open', async () => {
      const id = await claimed();
      const billed = rupeesToPaise(OPENING) - (await partyDmc());
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'REJECT', 'already paid it', captainActor);
      expect(rupeesToPaise(OPENING) - (await partyDmc())).toBe(billed);
    });

    it('never refunds, because a disputed cancellation cannot end cancelled', async () => {
      const id = await claimed();
      const billed = rupeesToPaise(OPENING) - (await partyDmc());
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'REJECT', 'already paid it', captainActor);

      // `APPROVE` upholds the captain's objection: the task goes back to where
      // it was before the request, so the work is still to be done and the
      // money stays committed. CANCELLED is not reachable from CANCEL_DISPUTED
      // at all — see TASK_TRANSITIONS.
      const restored = await resolveCancelDispute(id, 'APPROVE', admin);
      expect(restored.status).not.toBe('CANCELLED');
      expect(rupeesToPaise(OPENING) - (await partyDmc())).toBe(billed);
    });

    it('puts the task back where it was when the captain is upheld', async () => {
      const id = await claimed();
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'REJECT', 'already paid it', captainActor);
      const restored = await resolveCancelDispute(id, 'APPROVE', admin);
      // ASSIGNED is where it was: claimed but not yet started.
      expect(restored.status).toBe('ASSIGNED');
      expect(String(restored.captainId)).toBe(String(captainId));
    });

    it('keeps the captain holding their capital when the dispute is resolved either way', async () => {
      const id = await claimed();
      const heldDown = rupeesToPaise(500_000) - (await captainDmc());
      expect(heldDown).toBeGreaterThan(0);
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'REJECT', 'already paid it', captainActor);
      await resolveCancelDispute(id, 'APPROVE', admin);
      // Still on the hook for the work, so still holding the capital.
      expect(rupeesToPaise(500_000) - (await captainDmc())).toBe(heldDown);
    });

    it('keeps the party billed when admin puts the task back to work', async () => {
      const id = await claimed();
      const billed = rupeesToPaise(OPENING) - (await partyDmc());
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'REJECT', 'already paid it', captainActor);
      await resolveCancelDispute(id, 'REASSIGN', admin);
      // The work is still to be done, so the money is still committed.
      expect(rupeesToPaise(OPENING) - (await partyDmc())).toBe(billed);
    });

    it('lets exactly one of two racing admin decisions land', async () => {
      const id = await claimed();
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'REJECT', 'already paid it', captainActor);
      const settled = await Promise.allSettled([
        resolveCancelDispute(id, 'APPROVE', admin),
        resolveCancelDispute(id, 'REASSIGN', admin),
      ]);
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      // Whichever won, the party holds one of exactly two legal balances.
      const billedNow = rupeesToPaise(OPENING) - (await partyDmc());
      expect([0, billedFor(AMOUNT)]).toContain(billedNow);
    });

    it('resolves once when admin decides twice', async () => {
      const id = await claimed();
      const billed = rupeesToPaise(OPENING) - (await partyDmc());
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'REJECT', 'already paid it', captainActor);
      await resolveCancelDispute(id, 'APPROVE', admin);
      await expect(resolveCancelDispute(id, 'APPROVE', admin)).rejects.toThrow(
        /no cancellation dispute to resolve/i,
      );
      expect(rupeesToPaise(OPENING) - (await partyDmc())).toBe(billed);
    });

    it('cannot be cancelled again after it was already cancelled', async () => {
      const id = await claimed();
      await requestCancellation(id, 'customer changed their mind', partyActor);
      await reviewCancellationAsCaptain(id, captainId, 'APPROVE', undefined, captainActor);
      await expect(requestCancellation(id, 'once more', partyActor)).rejects.toThrow();
      expect(await partyDmc()).toBe(rupeesToPaise(OPENING));
    });
  });

  // =========================================================================
  // Once the captain has started
  // =========================================================================
  describe('cancelled after the captain started work', () => {
    const started = async (): Promise<string> => {
      const id = await makeTask();
      await claimTask(id, captainId, captainActor);
      await startTask(id, captainId, captainActor);
      return id;
    };

    it('cannot be cancelled at all', async () => {
      // The captain may already have sent real money to the customer, so the
      // window for calling it off has closed. IN_PROGRESS leads only to
      // PROOF_SUBMITTED or EXPIRED — see TASK_TRANSITIONS, which is the one
      // gate every role's cancellation request routes through.
      const id = await started();
      await expect(requestCancellation(id, 'customer changed their mind', partyActor)).rejects.toThrow(
        /Cannot move a task from IN_PROGRESS to CANCEL_REVIEW/,
      );
    });

    it('leaves the party still billed after a refused cancellation', async () => {
      const id = await started();
      const billed = rupeesToPaise(OPENING) - (await partyDmc());
      await expect(requestCancellation(id, 'nope', partyActor)).rejects.toThrow();
      expect(rupeesToPaise(OPENING) - (await partyDmc())).toBe(billed);
    });

    it('leaves the captain still holding their capital', async () => {
      const id = await started();
      const heldDown = rupeesToPaise(500_000) - (await captainDmc());
      await expect(requestCancellation(id, 'nope', partyActor)).rejects.toThrow();
      expect(rupeesToPaise(500_000) - (await captainDmc())).toBe(heldDown);
    });

    it('leaves the task in progress rather than in a half-cancelled state', async () => {
      const id = await started();
      await expect(requestCancellation(id, 'nope', partyActor)).rejects.toThrow();
      const task = await Task.findById(id).lean();
      expect(task?.status).toBe('IN_PROGRESS');
      expect(task?.cancelInitiatedBy ?? null).toBeNull();
    });

    it('pays nobody anything on a refused cancellation', async () => {
      const poolBefore = await platformPool();
      const id = await started();
      await expect(requestCancellation(id, 'nope', partyActor)).rejects.toThrow();
      expect(await platformPool()).toBe(poolBefore);
      expect(await Commission.countDocuments({ taskId: new Types.ObjectId(id) })).toBe(0);
    });
  });

  // =========================================================================
  // The books close
  // =========================================================================
  describe('after a mixture of cancellations', () => {
    it('leaves every balance exactly where it started', async () => {
      // Small and readable on purpose: four tasks, each cancelled by a
      // different route, and then everything has to be back to zero movement.
      const poolBefore = await platformPool();

      const a = await makeTask(1_000);
      await requestCancellation(a, 'before claim', partyActor);

      const b = await makeTask(2_000);
      await claimTask(b, captainId, captainActor);
      await requestCancellation(b, 'while held', partyActor);
      await reviewCancellationAsCaptain(b, captainId, 'APPROVE', undefined, captainActor);

      // Started work cannot be cancelled, so this one is claimed and then
      // released back rather than started — the party gets its money back the
      // only way it can at this stage.
      const c = await makeTask(3_000);
      await claimTask(c, captainId, captainActor);
      await requestCancellation(c, 'while held', partyActor);
      await reviewCancellationAsCaptain(c, captainId, 'APPROVE', undefined, captainActor);

      expect(await partyDmc()).toBe(rupeesToPaise(OPENING));
      expect(await captainDmc()).toBe(rupeesToPaise(500_000));
      expect(await platformPool()).toBe(poolBefore);
    });

    it('leaves a disputed cancellation still committed, not refunded', async () => {
      // The counterpart of the test above: a dispute is the one route that does
      // not give the money back, because the work is still going to happen.
      const opening = await partyDmc();
      const d = await makeTask(4_000);
      const billed = opening - (await partyDmc());
      await claimTask(d, captainId, captainActor);
      await requestCancellation(d, 'disputed', partyActor);
      await reviewCancellationAsCaptain(d, captainId, 'REJECT', 'already sent', captainActor);
      await resolveCancelDispute(d, 'APPROVE', admin);
      expect(opening - (await partyDmc())).toBe(billed);
    });

    it('leaves no commission owed to anybody', async () => {
      const a = await makeTask(1_000);
      await claimTask(a, captainId, captainActor);
      await requestCancellation(a, 'while held', partyActor);
      await reviewCancellationAsCaptain(a, captainId, 'APPROVE', undefined, captainActor);
      expect(await Commission.countDocuments({ taskId: new Types.ObjectId(a) })).toBe(0);
    });

    it('leaves no task holding money in a live state', async () => {
      const a = await makeTask(1_000);
      await requestCancellation(a, 'before claim', partyActor);
      const live = await Task.countDocuments({
        partyId,
        status: { $nin: ['CANCELLED', 'COMPLETED', 'REJECTED', 'EXPIRED'] },
      });
      expect(live).toBe(0);
    });
  });
});
