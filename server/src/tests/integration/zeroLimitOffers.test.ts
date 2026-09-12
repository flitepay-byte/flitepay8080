/**
 * A captain whose Current Limit is nothing must be offered nothing.
 *
 * Reported from the console: a captain showing Available DMC 242 and Current
 * Limit 0 was being offered — and shown in their queue — a payout of 3,000.
 * Their whole balance was commission they had earned, which is theirs to keep
 * and is not capacity, so the limit of zero is correct and the offer is not.
 *
 * These tests separate the three questions that look like one:
 *
 *   is the captain *offered* the work        (routing)
 *   is the work *shown* in their queue       (listing)
 *   is the claim *allowed*                   (the money guard)
 *
 * They are three different pieces of code and they were not asking the same
 * question, which is exactly how a queue can advertise work that cannot be
 * taken.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import { currentLimitPaise } from '../../services/captainCapacity.service';
import { toCaptainDto } from '../../utils/serializers';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('a captain with no Current Limit', () => {
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
    await updateConfig(
      { payOutPartyCommissionPercentage: 0, payOutCaptainCommissionPercentage: 0 },
      new Types.ObjectId(),
    );

    const unique = new Types.ObjectId().toHexString();
    const partyUser = await User.create({
      email: `party-${unique}@zero.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Zero Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(1_000_000),
    });
    partyId = party._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };
  });

  interface CaptainRef {
    id: Types.ObjectId;
    actor: { userId: string; role: 'CAPTAIN' };
  }

  /** The captain exactly as reported: all balance, no capacity. */
  async function reportedCaptain(): Promise<CaptainRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@zero.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Zero Captain',
      collateralBalancePaise: rupeesToPaise(10_000),
      lockedAmountPaise: 0,
      dmcBalancePaise: rupeesToPaise(242),
      // Every rupee they hold is commission they earned. Capacity is capital.
      commissionEarnedTotalPaise: rupeesToPaise(242),
      isOnline: true,
      status: 'ACTIVE',
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  const makeTask = (amountRupees: number) =>
    createTask(
      {
        partyId,
        createdBy: partyId,
        customerName: 'Shop customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: rupeesToPaise(amountRupees),
      },
      partyActor,
    );

  /** The queue exactly as the captain's screen builds it. */
  async function queueFor(captain: CaptainRef): Promise<number> {
    const { getCollateral } = await import('../../services/collateral.service');
    const view = await getCollateral(captain.id);
    return Task.countDocuments({
      status: { $in: ['CREATED', 'REASSIGNED'] },
      captainId: null,
      amountPaise: { $lte: view.availableLimitPaise },
      previousCaptainIds: { $ne: captain.id },
      $or: [
        { offeredCaptainId: captain.id, offerExpiresAt: { $gt: new Date() } },
        { openPoolAt: { $ne: null } },
      ],
    });
  }

  // =========================================================================
  // The figure itself is right
  // =========================================================================

  it('reads Current Limit as nothing, which is correct', async () => {
    const captain = await reportedCaptain();
    const doc = await Captain.findById(captain.id);

    const dto = toCaptainDto(doc!) as { canTakeNow: number; dmcBalance: number; taskLimit: number };
    expect(dto.dmcBalance).toBe(242);
    expect(dto.taskLimit).toBe(10_000);
    expect(dto.canTakeNow).toBe(0);
    expect(currentLimitPaise(doc!)).toBe(0);
  });

  // =========================================================================
  // The reported case, in three parts
  // =========================================================================

  it('is not offered a payout it cannot take', async () => {
    await reportedCaptain();
    const task = await makeTask(3_000);

    const offered = await Task.findById(task._id).lean();
    expect(offered?.offeredCaptainId).toBeNull();
  });

  it('is not shown that payout in their queue', async () => {
    const captain = await reportedCaptain();
    await makeTask(3_000);

    expect(await queueFor(captain)).toBe(0);
  });

  it('cannot claim that payout even if it reaches them', async () => {
    // The money guard, asked directly — this is the one that must hold however
    // the task got in front of them.
    const captain = await reportedCaptain();
    const task = await makeTask(3_000);
    await Task.updateOne({ _id: task._id }, { $set: { openPoolAt: new Date() } });

    await expect(claimTask(String(task._id), captain.id, captain.actor)).rejects.toThrow();
    expect((await Task.findById(task._id).lean())?.captainId).toBeNull();
  });

  // =========================================================================
  // The boundary
  // =========================================================================

  it('cannot take even the smallest task the system allows', async () => {
    // The system minimum, not a rupee: anything smaller is refused at creation
    // for an unrelated reason and would not test the limit at all.
    const captain = await reportedCaptain();
    const task = await makeTask(100);
    await Task.updateOne({ _id: task._id }, { $set: { openPoolAt: new Date() } });

    await expect(claimTask(String(task._id), captain.id, captain.actor)).rejects.toThrow();
  });

  it('is offered work again the moment they have capital', async () => {
    // The rule must not be "this captain is finished" — it is "not right now".
    const captain = await reportedCaptain();
    await Captain.updateOne(
      { _id: captain.id },
      { $set: { dmcBalancePaise: rupeesToPaise(5_000) } },
    );

    const task = await makeTask(3_000);

    expect(String((await Task.findById(task._id).lean())?.offeredCaptainId)).toBe(String(captain.id));
  });

  // =========================================================================
  // An offer made while they still had room
  // =========================================================================

  it('refuses a claim on an offer that was fair when it was made', async () => {
    /**
     * The stale-offer case. The captain had capacity when the task was routed
     * to them and spent it before claiming. Whatever the queue still shows,
     * the claim is judged at the moment it happens.
     */
    const captain = await reportedCaptain();
    await Captain.updateOne(
      { _id: captain.id },
      { $set: { dmcBalancePaise: rupeesToPaise(5_000) } },
    );
    const task = await makeTask(3_000);
    expect((await Task.findById(task._id).lean())?.offeredCaptainId).not.toBeNull();

    // Their capital goes elsewhere before they act on it.
    await Captain.updateOne(
      { _id: captain.id },
      { $set: { dmcBalancePaise: rupeesToPaise(242) } },
    );

    await expect(claimTask(String(task._id), captain.id, captain.actor)).rejects.toThrow();
  });
});
