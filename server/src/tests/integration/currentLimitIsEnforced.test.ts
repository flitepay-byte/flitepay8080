/**
 * A captain may only take on what their Current Limit allows.
 *
 * Current Limit is the figure their dashboard shows and the only one that
 * answers "how much more can I take": the ceiling admin approved, and their
 * own capital, whichever binds — with commission they have already earned
 * subtracted, because profit is not capacity.
 *
 * The claim guards used to enforce something looser. They asked two questions —
 * "do they hold at least this much DMC" and "is this within the ceiling" — and
 * neither subtracts earned commission, which is the entire difference between
 * the ceiling and Current Limit. A captain who had earned anything could
 * therefore claim work the screen had already told them they could not:
 *
 *     Available DMC 8,150 · Current Limit 8,000 · task 8,100  ->  accepted
 *
 * The number on the screen and the number enforced were computed in different
 * places from different formulas, so they were free to disagree, and did.
 * These tests pin them together, on both directions.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, Transaction, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import { createPayIn, assignCaptain } from '../../services/transaction.service';
import { toCaptainDto } from '../../utils/serializers';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('a claim is bounded by Current Limit', () => {
  let partyId: Types.ObjectId;
  let partyActor: { userId: string; role: 'PARTY' };

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    // Zero commission, so the fixtures' own numbers are the only thing moving
    // and a rate change cannot quietly shift what a claim costs.
    await updateConfig(
      {
        payOutPartyCommissionPercentage: 0, payOutCaptainCommissionPercentage: 0,
        payInPartyCommissionPercentage: 0, payInCaptainCommissionPercentage: 0,
      },
      new Types.ObjectId(),
    );

    const unique = new Types.ObjectId().toHexString();
    const partyUser = await User.create({
      email: `party-${unique}@limit.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Limit Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(10_000_000),
    });
    partyId = party._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };
  });

  interface CaptainRef {
    id: Types.ObjectId;
    actor: { userId: string; role: 'CAPTAIN' };
  }

  /**
   * A captain whose three numbers are set independently, because the bug lived
   * exactly in the gap between them: `dmc` is what they hold, `ceiling` is what
   * admin approved, and `earned` is the commission that is theirs to keep but
   * is not capacity.
   */
  async function makeCaptain(opts: {
    dmc: number;
    ceiling: number;
    earned?: number;
  }): Promise<CaptainRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@limit.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Limit Captain',
      collateralBalancePaise: rupeesToPaise(opts.ceiling),
      lockedAmountPaise: 0,
      dmcBalancePaise: rupeesToPaise(opts.dmc),
      commissionEarnedTotalPaise: rupeesToPaise(opts.earned ?? 0),
      isOnline: true,
      status: 'ACTIVE',
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  /** Current Limit as the captain's own dashboard reports it. */
  async function currentLimit(captain: CaptainRef): Promise<number> {
    const doc = await Captain.findById(captain.id);
    return (toCaptainDto(doc!) as { canTakeNow: number }).canTakeNow;
  }

  /** A pay-out claim, attempted. Resolves to whether it was allowed. */
  async function tryPayOut(captain: CaptainRef, amountRupees: number): Promise<boolean> {
    const task = await createTask(
      {
        partyId,
        createdBy: partyId,
        customerName: 'Customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: rupeesToPaise(amountRupees),
      },
      partyActor,
    );
    await Task.updateOne({ _id: task._id }, { $set: { openPoolAt: new Date() } });
    try {
      await claimTask(String(task._id), captain.id, captain.actor);
      return true;
    } catch {
      return false;
    }
  }

  /** A pay-in assignment, attempted. Routing picks the captain; there is one. */
  async function tryPayIn(captain: CaptainRef, amountRupees: number): Promise<boolean> {
    const { transaction } = await createPayIn(
      partyId,
      {
        partyReference: `PI-${Date.now()}-${Math.random()}`,
        amountPaise: rupeesToPaise(amountRupees),
      },
      partyActor,
    );
    await assignCaptain(transaction._id);
    const after = await Transaction.findById(transaction._id).lean();
    return String(after?.captainId ?? '') === String(captain.id);
  }

  // =========================================================================
  // The reported case
  // =========================================================================

  it('refuses the exact case that was reported', async () => {
    // Available DMC 8,150 · Current Limit 8,000 · task 8,100.
    // The 150 of earned commission is theirs, and is not capacity.
    const captain = await makeCaptain({ dmc: 8_150, ceiling: 10_000, earned: 150 });

    expect(await currentLimit(captain)).toBe(8_000);
    expect(await tryPayOut(captain, 8_100)).toBe(false);
  });

  it('refuses the same case on a pay-in', async () => {
    const captain = await makeCaptain({ dmc: 8_150, ceiling: 10_000, earned: 150 });

    expect(await currentLimit(captain)).toBe(8_000);
    expect(await tryPayIn(captain, 8_100)).toBe(false);
  });

  // =========================================================================
  // The boundary
  // =========================================================================

  it('allows an amount below Current Limit', async () => {
    const captain = await makeCaptain({ dmc: 8_150, ceiling: 10_000, earned: 150 });

    expect(await tryPayOut(captain, 7_999)).toBe(true);
  });

  it('allows an amount exactly at Current Limit', async () => {
    // The limit is what they may take, not what they must stay under.
    const captain = await makeCaptain({ dmc: 8_150, ceiling: 10_000, earned: 150 });

    expect(await tryPayOut(captain, 8_000)).toBe(true);
  });

  it('refuses an amount one rupee over Current Limit', async () => {
    const captain = await makeCaptain({ dmc: 8_150, ceiling: 10_000, earned: 150 });

    expect(await tryPayOut(captain, 8_001)).toBe(false);
  });

  // =========================================================================
  // The two halves are not interchangeable
  // =========================================================================

  it('refuses when they hold the DMC but the ceiling does not allow it', async () => {
    // Plenty of capital, a low ceiling. The ceiling is what their security
    // backs and it binds on its own.
    const captain = await makeCaptain({ dmc: 50_000, ceiling: 1_000 });

    expect(await currentLimit(captain)).toBe(1_000);
    expect(await tryPayOut(captain, 1_500)).toBe(false);
  });

  it('refuses when the ceiling allows it but they do not hold the DMC', async () => {
    const captain = await makeCaptain({ dmc: 500, ceiling: 50_000 });

    expect(await currentLimit(captain)).toBe(500);
    expect(await tryPayOut(captain, 1_000)).toBe(false);
  });

  it('refuses when only the earned commission would cover it', async () => {
    /**
     * The heart of the bug. Their balance covers the amount and the ceiling
     * allows it, and they still may not take it — because the part of the
     * balance that covers it is commission they earned, which is theirs to
     * keep and not capital to trade on.
     */
    const captain = await makeCaptain({ dmc: 5_000, ceiling: 50_000, earned: 4_500 });

    expect(await currentLimit(captain)).toBe(500);
    expect(await tryPayOut(captain, 4_000)).toBe(false);
    expect(await tryPayIn(captain, 4_000)).toBe(false);
  });

  // =========================================================================
  // Two at once
  // =========================================================================

  it('does not let two simultaneous claims exceed the limit together', async () => {
    /**
     * Each is within the limit on its own; together they are not. The guard is
     * one conditional write against the stored balance, so the first claim's
     * deduction is already visible to the second — there is no window in which
     * both read the same "before" figure.
     */
    const captain = await makeCaptain({ dmc: 10_000, ceiling: 10_000 });

    const tasks = await Promise.all([
      createTask(
        {
          partyId, createdBy: partyId, customerName: 'A',
          payoutMethod: { type: 'UPI', upiId: 'a@bank' },
          amountPaise: rupeesToPaise(6_000),
        },
        partyActor,
      ),
      createTask(
        {
          partyId, createdBy: partyId, customerName: 'B',
          payoutMethod: { type: 'UPI', upiId: 'b@bank' },
          amountPaise: rupeesToPaise(6_000),
        },
        partyActor,
      ),
    ]);
    await Task.updateMany(
      { _id: { $in: tasks.map((t) => t._id) } },
      { $set: { openPoolAt: new Date() } },
    );

    const results = await Promise.all(
      tasks.map((t) =>
        claimTask(String(t._id), captain.id, captain.actor).then(
          () => true,
          () => false,
        ),
      ),
    );

    // Exactly one, and the balance reflects exactly one.
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await Captain.findById(captain.id).lean();
    expect(after?.dmcBalancePaise).toBe(rupeesToPaise(4_000));
  });

  // =========================================================================
  // Nothing is re-judged afterwards
  // =========================================================================

  it('does not reconsider a claim that was already allowed', async () => {
    /**
     * Commission earned later lowers Current Limit, and that must not reach
     * back into work already taken. The guard runs once, at the claim.
     */
    const captain = await makeCaptain({ dmc: 10_000, ceiling: 10_000 });
    const task = await createTask(
      {
        partyId, createdBy: partyId, customerName: 'Customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: rupeesToPaise(9_000),
      },
      partyActor,
    );
    await Task.updateOne({ _id: task._id }, { $set: { openPoolAt: new Date() } });
    await claimTask(String(task._id), captain.id, captain.actor);

    // Their limit collapses afterwards; the claim stands.
    await Captain.updateOne(
      { _id: captain.id },
      { $set: { commissionEarnedTotalPaise: rupeesToPaise(900) } },
    );

    const held = await Task.findById(task._id).lean();
    expect(held?.status).toBe('ASSIGNED');
    expect(String(held?.captainId)).toBe(String(captain.id));
  });

  it('still lets an ordinary captain claim ordinary work', async () => {
    // The guard tightened; it must not have closed. A captain with capital and
    // no earnings should be unaffected by any of this.
    const captain = await makeCaptain({ dmc: 50_000, ceiling: 50_000 });

    expect(await tryPayOut(captain, 10_000)).toBe(true);
    expect(await tryPayIn(captain, 10_000)).toBe(true);
  });
});
