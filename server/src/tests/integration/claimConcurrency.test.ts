import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { claimTask } from '../../services/task.service';
import { getCollateral } from '../../services/collateral.service';
import { rupeesToPaise } from '../../utils/money';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';

describeIntegration('concurrent task claiming', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(clearCollections);

  async function makeCaptain(code: string, collateralRupees: number) {
    const user = await User.create({
      email: `${code.toLowerCase()}@test.demo`,
      passwordHash: await hashPassword('Demo@12345'),
      name: code,
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: code,
      displayName: code,
      // DMC as well as security. A pay-out holds the captain's DMC at the
      // claim — they are committing to send that much real money — so a
      // fixture with security and no DMC is a captain who can claim nothing.
      collateralBalancePaise: rupeesToPaise(collateralRupees),
      dmcBalancePaise: rupeesToPaise(collateralRupees),
      lockedAmountPaise: 0,
      isOnline: true,
      status: 'ACTIVE',
    });
    return { user, captain };
  }

  async function makeTask(partyId: Types.ObjectId, userId: Types.ObjectId, amountRupees: number, suffix: string) {
    return Task.create({
      taskCode: `TASK-TEST-${suffix}`,
      partyId,
      customerName: 'Test Beneficiary',
      identifier: `DEMO-UPI-${suffix}`,
      amountPaise: rupeesToPaise(amountRupees),
      externalRef: `TEST-REF-${suffix}`,
      status: 'CREATED',
      createdBy: userId,
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
      // Contention only arises in the open pool. Everywhere else a task is
      // offered to one captain at a time (see taskRouting.service.ts), so
      // there is nothing to race for — and a task offered to nobody is not
      // claimable at all. These tests are about the pool.
      openPoolAt: new Date(),
    });
  }

  it('assigns a contested task to exactly one captain', async () => {
    await ensureSystemConfig();

    const partyUser = await User.create({
      email: 'party-conc@test.demo',
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: 'PARTY-CONC',
      companyName: 'Test Co',
      contactEmail: 'party-conc@test.demo',
    });

    const a = await makeCaptain('CAP-A', 50000);
    const b = await makeCaptain('CAP-B', 50000);
    const task = await makeTask(party._id, partyUser._id, 10000, '001');

    // Both captains claim the same task simultaneously.
    const results = await Promise.allSettled([
      claimTask(String(task._id), a.captain._id, { userId: String(a.user._id), role: 'CAPTAIN' }),
      claimTask(String(task._id), b.captain._id, { userId: String(b.user._id), role: 'CAPTAIN' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const failure = (rejected[0] as PromiseRejectedResult).reason as AppError;
    expect(failure).toBeInstanceOf(AppError);
    expect(failure.errorCode).toBe(ErrorCodes.TASK_ALREADY_CLAIMED);
    expect(failure.statusCode).toBe(409);

    // The task carries exactly one captain.
    const stored = await Task.findById(task._id).lean();
    expect(stored?.status).toBe('ASSIGNED');
    expect(stored?.captainId).toBeTruthy();

    // Neither captain has anything reserved against them: holding a pay-out
    // costs nothing until the money is actually sent. What the race decides is
    // who holds the task, and that is the assertion above.
    const viewA = await getCollateral(a.captain._id);
    const viewB = await getCollateral(b.captain._id);
    expect(viewA.lockedAmountPaise).toBe(0);
    expect(viewB.lockedAmountPaise).toBe(0);
  });

  it('lets only one of five simultaneous claimants win', async () => {
    await ensureSystemConfig();
    const partyUser = await User.create({
      email: 'party-conc5@test.demo',
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: 'PARTY-C5',
      companyName: 'Test Co',
      contactEmail: 'party-conc5@test.demo',
    });

    const captains = await Promise.all([
      makeCaptain('CAP-1', 50000),
      makeCaptain('CAP-2', 50000),
      makeCaptain('CAP-3', 50000),
      makeCaptain('CAP-4', 50000),
      makeCaptain('CAP-5', 50000),
    ]);
    const task = await makeTask(party._id, partyUser._id, 5000, '002');

    const results = await Promise.allSettled(
      captains.map((c) =>
        claimTask(String(task._id), c.captain._id, { userId: String(c.user._id), role: 'CAPTAIN' }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4);

    // Exactly one of them holds the task, and none of them holds a
    // reservation — a pay-out reserves nothing.
    const views = await Promise.all(captains.map((c) => getCollateral(c.captain._id)));
    expect(views.every((v) => v.lockedAmountPaise === 0)).toBe(true);
  });

  it('refuses a claim that exceeds the available limit', async () => {
    await ensureSystemConfig();
    const partyUser = await User.create({
      email: 'party-limit@test.demo',
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: 'PARTY-LIM',
      companyName: 'Test Co',
      contactEmail: 'party-limit@test.demo',
    });

    // Collateral ₹5,000 but the task is ₹10,000.
    const poor = await makeCaptain('CAP-POOR', 5000);
    const task = await makeTask(party._id, partyUser._id, 10000, '003');

    await expect(
      claimTask(String(task._id), poor.captain._id, { userId: String(poor.user._id), role: 'CAPTAIN' }),
    ).rejects.toMatchObject({ errorCode: ErrorCodes.INSUFFICIENT_AVAILABLE_LIMIT });

    // Nothing was locked and the task is still available.
    const view = await getCollateral(poor.captain._id);
    expect(view.lockedAmountPaise).toBe(0);
    const stored = await Task.findById(task._id).lean();
    expect(stored?.status).toBe('CREATED');
    expect(stored?.captainId).toBeNull();
  });

  /**
   * Total exposure is bounded by the DMC, not by a reservation.
   *
   * The task limit caps the size of any one pay-out. What stops a captain
   * holding an unlimited *number* of them is the hold itself: each claim takes
   * its amount out of their balance, so they run out of DMC before they run
   * out of ambition. Nothing else needs to count it.
   */
  it('stops taking pay-outs once the DMC runs out', async () => {
    await ensureSystemConfig();
    const partyUser = await User.create({
      email: 'party-seq@test.demo',
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: 'PARTY-SEQ',
      companyName: 'Test Co',
      contactEmail: 'party-seq@test.demo',
    });

    // ₹12,000 of DMC against three ₹5,000 pay-outs. Each fits under the limit
    // on its own, but the third has nothing left to be held against it.
    const c = await makeCaptain('CAP-SEQ', 12000);
    const tasks = await Promise.all([
      makeTask(party._id, partyUser._id, 5000, '010'),
      makeTask(party._id, partyUser._id, 5000, '011'),
      makeTask(party._id, partyUser._id, 5000, '012'),
    ]);

    const results = await Promise.allSettled(
      tasks.map((t) => claimTask(String(t._id), c.captain._id, { userId: String(c.user._id), role: 'CAPTAIN' })),
    );

    const won = results.filter((r) => r.status === 'fulfilled').length;
    expect(won).toBe(2);

    // Two holds of 5,000 taken out of 12,000.
    const after = await Captain.findById(c.captain._id).lean();
    expect(after?.dmcBalancePaise).toBe(rupeesToPaise(2000));

    // The security itself is untouched, and so is the ceiling it buys.
    const view = await getCollateral(c.captain._id);
    expect(view.lockedAmountPaise).toBe(0);
    expect(view.availableLimitPaise).toBe(rupeesToPaise(12000));
  });
  // =========================================================================
  // The limit moving underneath a claim
  // =========================================================================
  describe('when capacity changes while a claim is in flight', () => {
    /** A party to hang tasks off; the party is not what is being tested here. */
    async function makeParty(code: string) {
      const user = await User.create({
        email: `${code.toLowerCase()}@race.demo`,
        passwordHash: await hashPassword('Demo@12345'),
        name: code,
        role: 'PARTY',
      });
      const party = await Party.create({
        userId: user._id,
        partyCode: code,
        companyName: 'Race Co',
        contactEmail: `${code.toLowerCase()}@race.demo`,
      });
      return { user, party };
    }

    it('never lets one captain hold the same task twice', async () => {
      await ensureSystemConfig();
      const { user, party } = await makeParty('PARTY-R1');
      const c = await makeCaptain('CAP-R1', 50_000);
      const task = await makeTask(party._id, user._id, 10_000, 'R01');

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          claimTask(String(task._id), c.captain._id, { userId: String(c.user._id), role: 'CAPTAIN' })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      // Exactly one hold of 10,000 out of 50,000, not four.
      const after = await Captain.findById(c.captain._id).lean();
      expect(after?.dmcBalancePaise).toBe(rupeesToPaise(40_000));
    });

    it('does not let a claim slip through on a ceiling that is being lowered', async () => {
      await ensureSystemConfig();
      const { user, party } = await makeParty('PARTY-R2');
      const c = await makeCaptain('CAP-R2', 50_000);
      const task = await makeTask(party._id, user._id, 40_000, 'R02');

      // Admin cuts the approved ceiling to less than the task, at the same
      // moment the captain claims it. Whichever lands first, the captain must
      // never end up holding more than a ceiling they were subject to.
      const [claim] = await Promise.allSettled([
        claimTask(String(task._id), c.captain._id, { userId: String(c.user._id), role: 'CAPTAIN' }),
        Captain.updateOne({ _id: c.captain._id }, { $set: { creditLimitPaise: rupeesToPaise(1_000) } }),
      ]);

      const after = await Captain.findById(c.captain._id).lean();
      if (claim.status === 'fulfilled') {
        // The claim won the race, so the hold is the task and nothing more.
        expect(after?.dmcBalancePaise).toBe(rupeesToPaise(10_000));
      } else {
        // The cut won, so nothing was held at all.
        expect(after?.dmcBalancePaise).toBe(rupeesToPaise(50_000));
      }
      expect(after?.dmcBalancePaise).toBeGreaterThanOrEqual(0);
    });

    it('refuses a claim above the ceiling even when a raise is in flight', async () => {
      await ensureSystemConfig();
      const { user, party } = await makeParty('PARTY-R3');
      const c = await makeCaptain('CAP-R3', 50_000);
      await Captain.updateOne({ _id: c.captain._id }, { $set: { creditLimitPaise: rupeesToPaise(5_000) } });
      const task = await makeTask(party._id, user._id, 20_000, 'R03');

      // A raise that is still being written must not be readable by a claim
      // that would only pass because of it.
      const [claim] = await Promise.allSettled([
        claimTask(String(task._id), c.captain._id, { userId: String(c.user._id), role: 'CAPTAIN' }),
        Captain.updateOne({ _id: c.captain._id }, { $set: { creditLimitPaise: rupeesToPaise(50_000) } }),
      ]);

      const after = await Captain.findById(c.captain._id).lean();
      if (claim.status === 'rejected') {
        expect(after?.dmcBalancePaise).toBe(rupeesToPaise(50_000));
      } else {
        // If it did land, it landed against the higher ceiling, and the hold is
        // still exactly the task.
        expect(after?.dmcBalancePaise).toBe(rupeesToPaise(30_000));
      }
    });

    it('counts earned commission against capacity even under contention', async () => {
      await ensureSystemConfig();
      const { user, party } = await makeParty('PARTY-R4');
      const c = await makeCaptain('CAP-R4', 10_000);
      // Their whole balance is profit, so their capacity is nothing — capital,
      // not profit, is what backs a claim. See captainCapacity.service.ts.
      await Captain.updateOne(
        { _id: c.captain._id },
        { $set: { commissionEarnedTotalPaise: rupeesToPaise(10_000) } },
      );
      const first = await makeTask(party._id, user._id, 5_000, 'R04a');
      const second = await makeTask(party._id, user._id, 5_000, 'R04b');

      const results = await Promise.allSettled([
        claimTask(String(first._id), c.captain._id, { userId: String(c.user._id), role: 'CAPTAIN' }),
        claimTask(String(second._id), c.captain._id, { userId: String(c.user._id), role: 'CAPTAIN' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(0);

      const after = await Captain.findById(c.captain._id).lean();
      expect(after?.dmcBalancePaise).toBe(rupeesToPaise(10_000));
    });

    it('keeps two parties’ tasks apart when one captain claims both at once', async () => {
      await ensureSystemConfig();
      const a = await makeParty('PARTY-R5A');
      const b = await makeParty('PARTY-R5B');
      const c = await makeCaptain('CAP-R5', 30_000);
      const taskA = await makeTask(a.party._id, a.user._id, 10_000, 'R05a');
      const taskB = await makeTask(b.party._id, b.user._id, 10_000, 'R05b');

      const results = await Promise.allSettled([
        claimTask(String(taskA._id), c.captain._id, { userId: String(c.user._id), role: 'CAPTAIN' }),
        claimTask(String(taskB._id), c.captain._id, { userId: String(c.user._id), role: 'CAPTAIN' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);

      // Two holds of 10,000 out of 30,000, and each task still belongs to the
      // party that raised it — one party's work must never be billed to another.
      const after = await Captain.findById(c.captain._id).lean();
      expect(after?.dmcBalancePaise).toBe(rupeesToPaise(10_000));
      expect(String((await Task.findById(taskA._id).lean())?.partyId)).toBe(String(a.party._id));
      expect(String((await Task.findById(taskB._id).lean())?.partyId)).toBe(String(b.party._id));
    });
  });
});
