/**
 * The captain's three numbers, walked step by step.
 *
 * This is the specification, written as arithmetic, because the three numbers
 * move differently and the difference is the whole point:
 *
 *   Task limit      what admin has approved. Read-only to the captain, and it
 *                   never moves for anything they do.
 *   Available DMC   their money. A pay-in transfers it to the party; a pay-out
 *                   holds it at claim and repays it, with commission, on
 *                   completion.
 *   Can take now    how much more work they may pick up. It tracks the same
 *                   movements as the DMC *except* commission — profit is not
 *                   capacity — and it can never exceed the task limit.
 *
 * The last part is what makes it a separate figure rather than a copy of the
 * balance: after a few completed pay-outs a captain holds more DMC than they
 * started with, and they still may not take on more work than their security
 * backs.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import { startTask, submitProof, approveTask } from '../../services/workflow.service';
import {
  createPayIn, assignCaptain, openToCustomer, confirmMovement, settle,
} from '../../services/transaction.service';
import { toCaptainDto } from '../../utils/serializers';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('a captain’s capacity, step by step', () => {
  const adminId = new Types.ObjectId();

  let partyId: Types.ObjectId;
  let partyUserId: Types.ObjectId;
  let partyActor: { userId: string; role: 'PARTY' };
  let captainId: Types.ObjectId;
  let captainActor: { userId: string; role: 'CAPTAIN' };

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    // 5% of a pay-out goes to the captain, and nothing on a pay-in — so the
    // only commission in the walkthrough is the 50 on each completed pay-out.
    await updateConfig(
      {
        payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5,
        payInPartyCommissionPercentage: 0, payInCaptainCommissionPercentage: 0,
      },
      adminId,
    );

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');

    const partyUser = await User.create({
      email: `party-${unique}@walk.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Walkthrough Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(1_000_000),
    });
    partyId = party._id;
    partyUserId = partyUser._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };

    // The opening position: a ₹20,000 deposit, split half into security and
    // half into spendable DMC.
    const captainUser = await User.create({
      email: `cap-${unique}@walk.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Walkthrough Captain',
      collateralBalancePaise: rupeesToPaise(10_000),
      dmcBalancePaise: rupeesToPaise(10_000),
      lockedAmountPaise: 0,
      isOnline: true,
      status: 'ACTIVE',
    });
    captainId = captain._id;
    captainActor = { userId: String(captainUser._id), role: 'CAPTAIN' };
  });

  /** The three numbers, exactly as the captain's dashboard shows them. */
  async function numbers(): Promise<{ taskLimit: number; dmc: number; canTake: number }> {
    const captain = await Captain.findById(captainId);
    if (!captain) throw new Error('captain vanished');
    const dto = toCaptainDto(captain) as unknown as {
      taskLimit: number; dmcBalance: number; canTakeNow: number;
    };
    return { taskLimit: dto.taskLimit, dmc: dto.dmcBalance, canTake: dto.canTakeNow };
  }

  const expectNumbers = async (dmc: number, canTake: number): Promise<void> => {
    const n = await numbers();
    expect({ taskLimit: n.taskLimit, dmc: n.dmc, canTake: n.canTake })
      .toEqual({ taskLimit: 10_000, dmc, canTake });
  };

  /** A pay-in, taken all the way to settled: the DMC goes to the party. */
  async function payInSettled(amount: number): Promise<void> {
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: `PI-${Date.now()}-${Math.random()}`, amountPaise: rupeesToPaise(amount) },
      partyActor,
    );
    const id = transaction._id;
    await assignCaptain(id);
    await openToCustomer(id, { gatewayQrPayload: 'upi://pay?x=1' });
    await confirmMovement(id, `UTR${Date.now()}${Math.random()}`);
    await settle(id);
  }

  /** A pay-out, claimed but not yet finished. */
  async function payOutClaimed(amount: number): Promise<string> {
    const task = await createTask(
      {
        partyId,
        createdBy: partyUserId,
        amountPaise: rupeesToPaise(amount),
        customerName: 'Walkthrough Customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@upi' },
      },
      partyActor,
    );
    const id = String(task._id);
    await Task.updateOne(
      { _id: task._id },
      { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } },
    );
    await claimTask(id, captainId, captainActor);
    return id;
  }

  async function finish(id: string): Promise<void> {
    await startTask(id, captainId, captainActor);
    await submitProof({ taskId: id, captainId, providerReference: `UTR${Date.now()}` }, captainActor);
    await approveTask(id, partyActor);
  }

  it('follows the whole sequence, number for number', async () => {
    // ---- opening ---------------------------------------------------------
    await expectNumbers(10_000, 10_000);

    // ---- 1. a ₹1,000 pay-in ---------------------------------------------
    // The captain hands 1,000 DMC to the party and keeps the customer's cash.
    await payInSettled(1_000);
    await expectNumbers(9_000, 9_000);

    // ---- 2. a second ₹1,000 pay-in --------------------------------------
    await payInSettled(1_000);
    await expectNumbers(8_000, 8_000);

    // ---- 3. a ₹1,000 pay-out --------------------------------------------
    // Held at the claim: the captain is committed to sending real money.
    const first = await payOutClaimed(1_000);
    await expectNumbers(7_000, 7_000);

    // Completed: the hold comes back, the outlay is reimbursed, and 5% is
    // earned on top. The 50 of commission raises the balance but not the
    // capacity — profit is not capital.
    await finish(first);
    await expectNumbers(9_050, 9_000);

    // ---- 4. a third ₹1,000 pay-in ---------------------------------------
    // The distinction made visible: 8,050 in the bank, 8,000 of work allowed.
    await payInSettled(1_000);
    await expectNumbers(8_050, 8_000);

    // ---- 5. a second ₹1,000 pay-out -------------------------------------
    const second = await payOutClaimed(1_000);
    await expectNumbers(7_050, 7_000);

    await finish(second);
    await expectNumbers(9_100, 9_000);

    // ---- 6. a fourth ₹1,000 pay-in --------------------------------------
    await payInSettled(1_000);
    await expectNumbers(8_100, 8_000);
  });

  it('never lets capacity exceed the task limit, however much is earned', async () => {
    // Nothing but pay-outs: the balance climbs past the opening position, and
    // the capacity stops dead at the ceiling admin approved.
    for (let i = 0; i < 4; i += 1) {
      await finish(await payOutClaimed(1_000));
    }

    // Each completed pay-out leaves them 1,050 better off: they sent 1,000 of
    // real money and got 1,000 back plus the 50 fee.
    const n = await numbers();
    expect(n.dmc).toBe(14_200);
    expect(n.canTake).toBe(10_000);
    expect(n.taskLimit).toBe(10_000);
  });

  it('gives the hold straight back if the pay-out is cancelled after the claim', async () => {
    const id = await payOutClaimed(1_000);
    await expectNumbers(9_000, 9_000);

    const { requestCancellation, reviewCancellationAsCaptain } =
      await import('../../services/workflow.service');
    await requestCancellation(id, 'Customer changed their mind', partyActor);
    await reviewCancellationAsCaptain(id, captainId, 'APPROVE', undefined, captainActor);

    // Nothing was sent, so nothing is owed and nothing was earned.
    await expectNumbers(10_000, 10_000);
  });

  it('leaves the task limit alone throughout', async () => {
    // The one number the captain cannot move. It is admin's decision, shown so
    // they know what they have been approved for.
    const id = await payOutClaimed(1_000);
    expect((await numbers()).taskLimit).toBe(10_000);
    await finish(id);
    expect((await numbers()).taskLimit).toBe(10_000);
    await payInSettled(2_000);
    expect((await numbers()).taskLimit).toBe(10_000);
  });
});
