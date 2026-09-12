/**
 * A task that has run out of captains raises itself to admin.
 *
 * Being rejected off a task excludes a captain from it permanently. With a
 * small roster that can exhaust every captain there is: the task returns to
 * the pool, routing finds nobody, and — because "nobody right now" looked
 * exactly like "nobody ever" — it was left unrouted for a sweeper that would
 * retry forever and fail every time. Nothing surfaced it: not the review
 * queue, which only listed decisions someone had asked for, and not a
 * notification. It simply sat there with the party's DMC committed to it.
 *
 * The distinction these tests hold is between a drought and a dead end. A
 * drought — everyone offline, or short on collateral — passes on its own and
 * must stay unmarked. A dead end cannot, and must be raised.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { offerToNextCaptain } from '../../services/taskRouting.service';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('a task with no captain left', () => {
  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
  });

  const TASK = 5_000;

  async function makeCaptain(opts: { online?: boolean; collateral?: number } = {}): Promise<Types.ObjectId> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@stall.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Stall Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Stall Captain',
      collateralBalancePaise: rupeesToPaise(opts.collateral ?? 100_000),
      lockedAmountPaise: 0,
      // Capital as well as security. Routing offers work by Current Limit,
      // which is the lesser of the ceiling and the captain's own DMC — so a
      // fixture with collateral and no DMC is a captain who can take nothing,
      // and would be offered nothing.
      dmcBalancePaise: rupeesToPaise(opts.collateral ?? 100_000),
      isOnline: opts.online ?? true,
      status: 'ACTIVE',
    });
    return captain._id;
  }

  /**
   * A task back in the pool after rejections, with `rejectedOff` captains
   * already excluded from it — the state resetRoutingForReassignment leaves.
   */
  async function reassignedTask(rejectedOff: Types.ObjectId[]): Promise<Types.ObjectId> {
    const unique = new Types.ObjectId().toHexString();
    const partyUser = await User.create({
      email: `party-${unique}@stall.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Stall Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Stall Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(100_000),
    });
    const task = await Task.create({
      partyId: party._id,
      createdBy: partyUser._id,
      taskCode: `TASK-STALL-${unique.slice(-8)}`,
      externalRef: `STALL-${unique.slice(-8)}`,
      customerName: 'Stall Test',
      identifier: 'stall@bank',
      payoutMethod: { type: 'UPI', upiId: 'stall@bank' },
      amountPaise: rupeesToPaise(TASK),
      commissionPaise: rupeesToPaise(50),
      adminCommissionPaise: rupeesToPaise(100),
      status: 'REASSIGNED',
      captainId: null,
      reassignmentCount: rejectedOff.length,
      previousCaptainIds: rejectedOff,
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });
    return task._id;
  }

  const stalledAt = async (taskId: Types.ObjectId): Promise<Date | null | undefined> =>
    (await Task.findById(taskId).lean())?.routingStalledAt;

  it('marks the task when every captain has been rejected off it', async () => {
    const a = await makeCaptain();
    const b = await makeCaptain();
    const taskId = await reassignedTask([a, b]);

    await offerToNextCaptain(taskId);

    expect(await stalledAt(taskId)).toBeTruthy();
  });

  it('leaves the task open rather than closing it', async () => {
    const a = await makeCaptain();
    const taskId = await reassignedTask([a]);
    await offerToNextCaptain(taskId);

    const task = await Task.findById(taskId).lean();
    // Still claimable, still nobody's — raising it to admin changes nothing
    // about the task itself.
    expect(task?.status).toBe('REASSIGNED');
    expect(task?.captainId ?? null).toBeNull();
  });

  it('does not mark a task that simply has nobody online right now', async () => {
    // A captain exists who has never held this task — they are just offline.
    // That resolves itself, so it must not be raised to admin.
    const rejected = await makeCaptain();
    await makeCaptain({ online: false });
    const taskId = await reassignedTask([rejected]);

    await offerToNextCaptain(taskId);

    expect(await stalledAt(taskId) ?? null).toBeNull();
  });

  it('does not mark a task whose only captain is merely short on collateral', async () => {
    const rejected = await makeCaptain();
    await makeCaptain({ collateral: 10 }); // cannot afford this task today
    const taskId = await reassignedTask([rejected]);

    await offerToNextCaptain(taskId);

    expect(await stalledAt(taskId) ?? null).toBeNull();
  });

  it('does not re-stamp the timestamp on every sweep', async () => {
    const a = await makeCaptain();
    const taskId = await reassignedTask([a]);

    await offerToNextCaptain(taskId);
    const first = await stalledAt(taskId);

    await offerToNextCaptain(taskId);
    await offerToNextCaptain(taskId);

    // Admin should read "stuck since 09:14", not a time that keeps resetting.
    expect((await stalledAt(taskId))?.getTime()).toBe(first?.getTime());
  });

  it('clears the mark once a new captain can take it', async () => {
    const a = await makeCaptain();
    const taskId = await reassignedTask([a]);
    await offerToNextCaptain(taskId);
    expect(await stalledAt(taskId)).toBeTruthy();

    // Onboard someone who has never held it — routing should recover by itself.
    await makeCaptain();
    const result = await offerToNextCaptain(taskId);

    expect(result.captainId).not.toBeNull();
    expect(await stalledAt(taskId) ?? null).toBeNull();
  });

  it('never marks a task while an untried captain is available', async () => {
    const a = await makeCaptain();
    await makeCaptain();
    const taskId = await reassignedTask([a]);

    await offerToNextCaptain(taskId);

    expect(await stalledAt(taskId) ?? null).toBeNull();
  });
});
