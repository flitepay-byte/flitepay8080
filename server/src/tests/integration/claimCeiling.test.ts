/**
 * A captain's collateral is their security money. It is also, by default, the
 * ceiling on how much live work they may hold — but admin can set that ceiling
 * separately, and doing so must never move the money.
 *
 * These tests hold both halves: the ceiling is what actually gates a claim,
 * and the collateral comes out the other side untouched no matter where the
 * ceiling is put.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import { lockCollateral, getCollateral } from '../../services/collateral.service';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('the claim ceiling', () => {
  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);
  beforeEach(clearCollections);

  const COLLATERAL = rupeesToPaise(50_000);

  interface Fixture {
    captainId: Types.ObjectId;
    partyId: Types.ObjectId;
    partyUserId: Types.ObjectId;
    captainActor: { userId: string; role: 'CAPTAIN' };
    partyActor: { userId: string; role: 'PARTY' };
  }

  async function setup(creditLimitPaise?: number | null): Promise<Fixture> {
    const password = await hashPassword('Demo@12345');
    const unique = new Types.ObjectId().toHexString();

    const captainUser = await User.create({
      email: `cap-${unique}@ceiling.test`, passwordHash: password, name: 'Ceiling Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Ceiling Captain',
      // DMC as well as security. A pay-out holds the captain's DMC at the
      // claim — they are committing to send that much real money — so a
      // fixture with security and no DMC is a captain who can claim nothing.
      collateralBalancePaise: COLLATERAL,
      dmcBalancePaise: rupeesToPaise(10_000_000),
      lockedAmountPaise: 0,
      isOnline: true,
      status: 'ACTIVE',
      ...(creditLimitPaise === undefined ? {} : { creditLimitPaise }),
    });

    const partyUser = await User.create({
      email: `party-${unique}@ceiling.test`, passwordHash: password, name: 'Ceiling Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Ceiling Party Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(10_000_000),
    });

    return {
      captainId: captain._id,
      partyId: party._id,
      partyUserId: partyUser._id,
      captainActor: { userId: String(captainUser._id), role: 'CAPTAIN' },
      partyActor: { userId: String(partyUser._id), role: 'PARTY' },
    };
  }

  /** A task open to anyone, so the claim is gated by the ceiling and nothing else. */
  async function openTask(f: Fixture, rupees: number): Promise<string> {
    const task = await createTask(
      {
        partyId: f.partyId,
        createdBy: f.partyUserId,
        customerName: 'Ceiling Test',
        amountPaise: rupeesToPaise(rupees),
        payoutMethod: { type: 'UPI', upiId: 'ceiling@bank' },
      },
      f.partyActor,
    );
    await Task.updateOne(
      { _id: task._id },
      { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } },
    );
    return String(task._id);
  }

  it('starts every captain with their collateral as the ceiling', async () => {
    const f = await setup();
    const view = await getCollateral(f.captainId);
    expect(view.creditLimitPaise).toBeNull();
    expect(view.availableLimitPaise).toBe(COLLATERAL);
  });

  it('lets a captain claim beyond their collateral once admin raises the ceiling', async () => {
    const f = await setup(rupeesToPaise(80_000));
    const task = await openTask(f, 70_000);

    await expect(claimTask(task, f.captainId, f.captainActor)).resolves.toBeDefined();

    const captain = await Captain.findById(f.captainId).lean();
    // The whole point: they claimed ₹70,000 of work against ₹50,000 posted,
    // and the ₹50,000 is still exactly where it was. Nothing is reserved
    // against it either — the ceiling is checked, not consumed.
    expect(captain?.collateralBalancePaise).toBe(COLLATERAL);
    expect(captain?.lockedAmountPaise).toBe(0);
  });

  it('refuses a claim above a lowered ceiling, without touching the collateral', async () => {
    const f = await setup(rupeesToPaise(20_000));
    const task = await openTask(f, 30_000);

    await expect(claimTask(task, f.captainId, f.captainActor)).rejects.toThrow();

    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.collateralBalancePaise).toBe(COLLATERAL);
    expect(captain?.lockedAmountPaise).toBe(0);
  });

  it('treats a zero ceiling as a real decision, not as unset', async () => {
    const f = await setup(0);
    const view = await getCollateral(f.captainId);
    expect(view.availableLimitPaise).toBe(0);

    // The smallest task the system will accept still does not fit a zero ceiling.
    const task = await openTask(f, 100);
    await expect(claimTask(task, f.captainId, f.captainActor)).rejects.toThrow();
    expect((await Captain.findById(f.captainId).lean())?.collateralBalancePaise).toBe(COLLATERAL);
  });

  it('is what the lock guard enforces, not the collateral', async () => {
    const f = await setup(rupeesToPaise(80_000));
    // Straight at the guard: ₹75,000 exceeds the collateral but fits the ceiling.
    await expect(lockCollateral(f.captainId, rupeesToPaise(75_000))).resolves.toBe(true);
    await expect(lockCollateral(f.captainId, rupeesToPaise(10_000))).resolves.toBe(false);
  });

  it('subtracts work already in hand from the ceiling', async () => {
    const f = await setup(rupeesToPaise(80_000));
    await lockCollateral(f.captainId, rupeesToPaise(30_000));

    const view = await getCollateral(f.captainId);
    expect(view.availableLimitPaise).toBe(rupeesToPaise(50_000));
    expect(view.collateralBalancePaise).toBe(COLLATERAL);
  });

  it('leaves work already claimed alone when the ceiling is cut below it', async () => {
    const f = await setup();
    const task = await openTask(f, 40_000);
    await claimTask(task, f.captainId, f.captainActor);

    // Admin pulls the ceiling under what they are already holding.
    await Captain.updateOne({ _id: f.captainId }, { $set: { creditLimitPaise: rupeesToPaise(10_000) } });

    const held = await Task.findById(task).lean();
    expect(held?.status).toBe('ASSIGNED');
    expect(held?.captainId).toBeTruthy();

    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.lockedAmountPaise).toBe(0);
    expect(captain?.collateralBalancePaise).toBe(COLLATERAL);

    // A small one still fits under the lowered ceiling and is allowed —
    // nothing was reserved by the work already in hand.
    const small = await openTask(f, 1_000);
    await expect(claimTask(small, f.captainId, f.captainActor)).resolves.toBeDefined();

    // Anything above the new ceiling is refused, which is what cutting it did.
    const tooBig = await openTask(f, 11_000);
    await expect(claimTask(tooBig, f.captainId, f.captainActor)).rejects.toThrow();
  });

  it('goes back to the collateral when the ceiling is cleared', async () => {
    const f = await setup(rupeesToPaise(20_000));
    await Captain.updateOne({ _id: f.captainId }, { $set: { creditLimitPaise: null } });

    const view = await getCollateral(f.captainId);
    expect(view.creditLimitPaise).toBeNull();
    expect(view.availableLimitPaise).toBe(COLLATERAL);

    const task = await openTask(f, 40_000);
    await expect(claimTask(task, f.captainId, f.captainActor)).resolves.toBeDefined();
  });
});
