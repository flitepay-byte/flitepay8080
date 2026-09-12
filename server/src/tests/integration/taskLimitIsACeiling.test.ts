/**
 * The task limit is a ceiling, not a balance.
 *
 * The captain's screens showed the *remainder* under the name "Task limit", so
 * a captain with DMC 10,000 of security posted saw "Task limit 550" while
 * holding work, and reasonably concluded their security had been spent on it.
 * It had not, and it never is: security backs the work, and the only thing a
 * claim consumes is headroom under the ceiling that security buys.
 *
 * So there are two figures and they answer two questions:
 *
 *   taskLimit       what you may hold at once — moves only when your security
 *                   or admin's override moves
 *   availableLimit  what is left of it right now
 *
 * These tests hold the difference, because collapsing them back into one
 * number is a one-line change and looks harmless.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, Transaction, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import { startTask, submitProof, approveTask } from '../../services/workflow.service';
import { createPayIn, assignCaptain, expire } from '../../services/transaction.service';
import { toCaptainDto } from '../../utils/serializers';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('the captain’s task limit', () => {
  let partyId: Types.ObjectId;
  let partyUserId: Types.ObjectId;
  let partyActor: { userId: string; role: 'PARTY' };

  const SECURITY = rupeesToPaise(10_000);

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();

    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `party-${unique}@limit.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: user._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Limit Ltd',
      contactEmail: user.email,
      dmcBalancePaise: rupeesToPaise(500_000),
    });
    partyId = party._id;
    partyUserId = user._id;
    partyActor = { userId: String(user._id), role: 'PARTY' };
  });

  async function makeCaptain(overrides: Record<string, unknown> = {}) {
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
      collateralBalancePaise: SECURITY,
      lockedAmountPaise: 0,
      dmcBalancePaise: rupeesToPaise(50_000),
      isOnline: true,
      status: 'ACTIVE',
      ...overrides,
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' as const } };
  }

  const view = async (id: Types.ObjectId) => {
    const captain = await Captain.findById(id);
    if (!captain) throw new Error('captain vanished');
    return toCaptainDto(captain) as unknown as {
      taskLimit: number;
      canTakeNow: number;
      availableLimit: number;
      collateralBalance: number;
      dmcBalance: number;
    };
  };

  async function openPayout(amount: number): Promise<string> {
    const task = await createTask(
      {
        partyId,
        createdBy: partyUserId,
        amountPaise: rupeesToPaise(amount),
        customerName: 'Limit Customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@upi' },
      },
      partyActor,
    );
    await Task.updateOne(
      { _id: task._id },
      { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } },
    );
    return String(task._id);
  }

  // =========================================================================
  // The ceiling
  // =========================================================================

  it('is the security money the captain posted', async () => {
    const captain = await makeCaptain();
    const v = await view(captain.id);
    expect(v.taskLimit).toBe(10_000);
    expect(v.collateralBalance).toBe(10_000);
  });

  it('is admin’s override when they have set one', async () => {
    const captain = await makeCaptain({ creditLimitPaise: rupeesToPaise(25_000) });
    const v = await view(captain.id);
    // The security is untouched by the decision — that is the whole point of
    // the override being a separate field rather than an edit to the money.
    expect(v.taskLimit).toBe(25_000);
    expect(v.collateralBalance).toBe(10_000);
  });

  it('does not move when a task is claimed', async () => {
    const captain = await makeCaptain();
    const before = await view(captain.id);

    await claimTask(await openPayout(4_000), captain.id, captain.actor);

    const after = await view(captain.id);
    expect(after.taskLimit).toBe(before.taskLimit);
    // And the security behind it is exactly as it was. A claim spends nothing.
    expect(after.collateralBalance).toBe(before.collateralBalance);
  });

  // =========================================================================
  // The remainder
  // =========================================================================

  it('reserves nothing when a pay-out is claimed', async () => {
    const captain = await makeCaptain();
    await claimTask(await openPayout(4_000), captain.id, captain.actor);

    // Holding a pay-out costs the captain nothing until they actually send the
    // money, so there is nothing to reserve against it.
    const v = await view(captain.id);
    expect(v.taskLimit).toBe(10_000);
    expect(v.availableLimit).toBe(10_000);
  });

  it('reserves nothing for a second one either', async () => {
    const captain = await makeCaptain();
    await claimTask(await openPayout(4_000), captain.id, captain.actor);
    await claimTask(await openPayout(2_500), captain.id, captain.actor);

    const v = await view(captain.id);
    expect(v.availableLimit).toBe(10_000);
  });

  it('starts equal to the ceiling when nothing is in hand', async () => {
    const captain = await makeCaptain();
    const v = await view(captain.id);
    expect(v.availableLimit).toBe(v.taskLimit);
  });

  // =========================================================================
  // What a payout does and does not touch
  // =========================================================================

  it('claiming a payout holds the captain’s DMC', async () => {
    const captain = await makeCaptain();
    const before = await view(captain.id);

    await claimTask(await openPayout(4_000), captain.id, captain.actor);

    // They have committed to sending that much real money, so it leaves their
    // balance until the job is done. It comes back at completion alongside the
    // reimbursement, so a finished pay-out leaves them up by the fee alone.
    const after = await view(captain.id);
    expect(after.dmcBalance).toBe(before.dmcBalance - 4_000);
  });

  // =========================================================================
  // The line under the ceiling: what you can actually take right now
  //
  // Walked through exactly as it was specified: start at the limit, a pay-in
  // of 500 takes it to 9,500, a failed one puts it back, and a completed
  // pay-out of 300 raises it to 9,800.
  // =========================================================================

  async function payIn(amount: number): Promise<string> {
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: `PI-${Date.now()}-${Math.random()}`, amountPaise: rupeesToPaise(amount) },
      partyActor,
    );
    await assignCaptain(transaction._id);
    return String(transaction._id);
  }

  it('starts at the ceiling when the captain has the DMC to match', async () => {
    const captain = await makeCaptain({ dmcBalancePaise: SECURITY });
    const v = await view(captain.id);
    expect(v.taskLimit).toBe(10_000);
    expect(v.canTakeNow).toBe(10_000);
  });

  it('drops by a pay-in the moment a captain is given one', async () => {
    const captain = await makeCaptain({ dmcBalancePaise: SECURITY });
    await payIn(500);

    const v = await view(captain.id);
    // The ceiling is untouched; only what they can still take moves.
    expect(v.taskLimit).toBe(10_000);
    expect(v.canTakeNow).toBe(9_500);
  });

  it('goes back when the payment never happens', async () => {
    const captain = await makeCaptain({ dmcBalancePaise: SECURITY });
    const id = await payIn(500);
    expect((await view(captain.id)).canTakeNow).toBe(9_500);

    await expire(id, 'Nobody paid in time');
    expect((await view(captain.id)).canTakeNow).toBe(10_000);
  });

  it('rises again when a pay-out completes and repays the captain', async () => {
    const captain = await makeCaptain({ dmcBalancePaise: SECURITY });
    await payIn(500);
    expect((await view(captain.id)).canTakeNow).toBe(9_500);

    // A pay-out reimburses the captain what they sent, so their DMC comes back
    // up and with it what they can take on. 9,500 + 300 = 9,800.
    const id = await openPayout(300);
    await claimTask(id, captain.id, captain.actor);
    await startTask(id, captain.id, captain.actor);
    await submitProof({ taskId: id, captainId: captain.id, providerReference: 'UTR-LINE-1' }, captain.actor);
    await approveTask(id, partyActor);

    expect((await view(captain.id)).canTakeNow).toBe(9_800);
  });

  it('takes the hold out of what they can still take on', async () => {
    const captain = await makeCaptain({ dmcBalancePaise: SECURITY });
    const before = await view(captain.id);

    await claimTask(await openPayout(3_000), captain.id, captain.actor);

    // Committed money is neither spendable nor available for more work.
    const after = await view(captain.id);
    expect(after.dmcBalance).toBe(before.dmcBalance - 3_000);
    expect(after.canTakeNow).toBe(before.canTakeNow - 3_000);
  });

  it('is capped by the ceiling however much DMC the captain holds', async () => {
    // Half a million in DMC against a limit of 10,000. The limit is what the
    // security buys and it binds on its own — that is the whole point of it.
    const captain = await makeCaptain({ dmcBalancePaise: rupeesToPaise(500_000) });
    const v = await view(captain.id);
    expect(v.canTakeNow).toBe(10_000);
  });

  it('refuses a pay-in larger than the ceiling, however much DMC they hold', async () => {
    await makeCaptain({ dmcBalancePaise: rupeesToPaise(500_000) });

    const tooBig = await payIn(12_000);
    const after = await Transaction.findById(tooBig).lean();
    expect(after?.captainId ?? null).toBeNull();
  });

  it('refuses a single pay-out bigger than the ceiling', async () => {
    const captain = await makeCaptain();

    // The limit is a cap on the size of one job, checked rather than consumed.
    // It still has to bind, or the pair of numbers means nothing.
    await expect(
      claimTask(await openPayout(12_000), captain.id, captain.actor),
    ).rejects.toThrow();
  });

  it('lets two pay-outs be held at once, each within the ceiling', async () => {
    const captain = await makeCaptain();
    await claimTask(await openPayout(9_000), captain.id, captain.actor);

    // Each fits on its own, and nothing was reserved by the first, so the
    // second is allowed. What backs both is the security money, which is what
    // answers for a captain who takes work and never pays it out.
    await claimTask(await openPayout(9_000), captain.id, captain.actor);

    const v = await view(captain.id);
    expect(v.availableLimit).toBe(10_000);
  });
});
