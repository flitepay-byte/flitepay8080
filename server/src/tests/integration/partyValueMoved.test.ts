/**
 * What a party has actually moved, in both directions.
 *
 * The headline on a party's own overview counted only their pay-outs. From
 * their side that is half the story: money their customers paid in moved
 * through them just as much as money they sent out, and a figure labelled
 * "total value moved" that silently means "pay-outs only" answers a narrower
 * question than it asks.
 *
 * The two halves have different rules, and deliberately so:
 *
 *   pay-out — everything except cancelled, including work still in flight,
 *             because the party has committed that amount (taskValue.ts)
 *   pay-in  — settled only, because until the customer pays nothing has moved
 *             at all and several states never will (payInValue.ts)
 *
 * They live in separate collections, so nothing can be counted twice.
 */
import '../../globalErrorHandlers';
import request from 'supertest';
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { createApp } from '../../app';
import { User, Party, Captain, Task, Transaction, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import { startTask, submitProof, approveTask } from '../../services/workflow.service';
import {
  createPayIn, assignCaptain, openToCustomer, confirmMovement, settle, expire,
} from '../../services/transaction.service';
import { env } from '../../config/env';
import { rupeesToPaise } from '../../utils/money';

const P = env.API_PREFIX;

describeIntegration('a party’s total value moved', () => {
  const app = createApp();

  let partyId: Types.ObjectId;
  let partyActor: { userId: string; role: 'PARTY' };
  let captainId: Types.ObjectId;
  let captainActor: { userId: string; role: 'CAPTAIN' };
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    // No commission, so every figure below is the payment itself and a rate
    // change cannot move what these assertions expect.
    await updateConfig(
      {
        payOutPartyCommissionPercentage: 0, payOutCaptainCommissionPercentage: 0,
        payInPartyCommissionPercentage: 0, payInCaptainCommissionPercentage: 0,
      },
      new Types.ObjectId(),
    );

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');

    const partyUser = await User.create({
      email: `party-${unique}@moved.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Moved Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(1_000_000),
    });
    partyId = party._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };

    const captainUser = await User.create({
      email: `cap-${unique}@moved.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Moved Captain',
      collateralBalancePaise: rupeesToPaise(1_000_000),
      dmcBalancePaise: rupeesToPaise(1_000_000),
      isOnline: true,
      status: 'ACTIVE',
    });
    captainId = captain._id;
    captainActor = { userId: String(captainUser._id), role: 'CAPTAIN' };

    agent = request.agent(app);
    const step1 = await agent.post(`${P}/auth/login`).send({ email: partyUser.email, password: 'Demo@12345' });
    await agent
      .post(`${P}/auth/verify-otp`)
      .send({ challengeId: step1.body?.data?.challengeId, otp: step1.body?.data?.devOtp });
  });

  interface Dashboard {
    totalValue: number;
    completedValue: number;
    totalTasks: number;
    byStatus: Record<string, number>;
  }

  const dashboard = async (): Promise<Dashboard> =>
    (await agent.get(`${P}/party/dashboard`)).body.data as Dashboard;

  /** A pay-out task, left wherever the caller wants it. */
  async function makeTask(amountRupees: number): Promise<string> {
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
    return String(task._id);
  }

  async function completedPayOut(amountRupees: number): Promise<void> {
    const id = await makeTask(amountRupees);
    await claimTask(id, captainId, captainActor);
    await startTask(id, captainId, captainActor);
    await submitProof({ taskId: id, captainId, providerReference: 'NEFT-1' }, captainActor);
    await approveTask(id, partyActor);
  }

  /** Created then cancelled outright — never claimed, so the party is refunded. */
  async function cancelledPayOut(amountRupees: number): Promise<void> {
    const id = await makeTask(amountRupees);
    await Task.updateOne({ _id: id }, { $set: { status: 'CANCELLED' } });
  }

  async function settledPayIn(amountRupees: number): Promise<void> {
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: `PI-${Date.now()}-${Math.random()}`, amountPaise: rupeesToPaise(amountRupees) },
      partyActor,
    );
    const id = transaction._id;
    await assignCaptain(id);
    await openToCustomer(id, { gatewayQrPayload: 'upi://pay?x=1' });
    await confirmMovement(id, `UTR${Date.now()}${Math.random()}`);
    await settle(id);
  }

  /** Raised, offered, and then nobody paid. */
  async function expiredPayIn(amountRupees: number): Promise<void> {
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: `PI-${Date.now()}-${Math.random()}`, amountPaise: rupeesToPaise(amountRupees) },
      partyActor,
    );
    await assignCaptain(transaction._id);
    await expire(transaction._id, 'Nobody paid');
  }

  // =========================================================================
  // The reported example
  // =========================================================================

  it('adds a settled pay-in to a completed pay-out, and leaves the cancelled one out', async () => {
    await settledPayIn(5_000);
    await completedPayOut(1_000);
    await cancelledPayOut(8_100);

    expect((await dashboard()).totalValue).toBe(6_000);
  });

  // =========================================================================
  // Each half on its own
  // =========================================================================

  it('counts pay-outs when there are no pay-ins', async () => {
    await completedPayOut(1_000);

    expect((await dashboard()).totalValue).toBe(1_000);
  });

  it('counts pay-ins when there are no pay-outs', async () => {
    // The half that was missing entirely.
    await settledPayIn(5_000);

    expect((await dashboard()).totalValue).toBe(5_000);
  });

  it('is zero when nothing has happened', async () => {
    expect((await dashboard()).totalValue).toBe(0);
  });

  it('adds up several of each', async () => {
    await settledPayIn(1_000);
    await settledPayIn(2_500);
    await completedPayOut(400);
    await completedPayOut(600);

    expect((await dashboard()).totalValue).toBe(4_500);
  });

  // =========================================================================
  // What does not count
  // =========================================================================

  it('leaves out a cancelled pay-out, because the party was refunded', async () => {
    await cancelledPayOut(8_100);

    expect((await dashboard()).totalValue).toBe(0);
  });

  it('leaves out a pay-in nobody paid', async () => {
    await expiredPayIn(5_000);

    expect((await dashboard()).totalValue).toBe(0);
  });

  it('leaves out a pay-in that has not settled yet', async () => {
    /**
     * Confirmed is a claim that the money moved, not the settlement — the
     * party has not been credited and the state can still end in a dispute.
     */
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: `PI-${Date.now()}`, amountPaise: rupeesToPaise(5_000) },
      partyActor,
    );
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id, { gatewayQrPayload: 'upi://pay?x=1' });
    await confirmMovement(transaction._id, `UTR${Date.now()}`);

    expect((await Transaction.findById(transaction._id).lean())?.status).toBe('CONFIRMED');
    expect((await dashboard()).totalValue).toBe(0);
  });

  it('counts a pay-out still in flight, which is not the same rule', async () => {
    // Deliberately asymmetric, and worth pinning: the party has committed this
    // amount — it is out of their balance — so it counts before it finishes.
    // A pay-in commits them nothing until the customer actually pays.
    await makeTask(2_000);

    expect((await dashboard()).totalValue).toBe(2_000);
  });

  // =========================================================================
  // Nothing is counted twice
  // =========================================================================

  it('counts one settled pay-in once', async () => {
    await settledPayIn(5_000);
    // Read twice: an aggregate that joined the two collections wrongly would
    // show it, and so would a second query being added later.
    expect((await dashboard()).totalValue).toBe(5_000);
    expect((await dashboard()).totalValue).toBe(5_000);
  });

  it('does not let another party’s money reach this one', async () => {
    const other = await Party.create({
      userId: new Types.ObjectId(),
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Somebody Else',
      contactEmail: `other-${new Types.ObjectId().toHexString()}@moved.test`,
      dmcBalancePaise: rupeesToPaise(1_000_000),
    });
    await createPayIn(
      other._id,
      { partyReference: `PI-other-${Date.now()}`, amountPaise: rupeesToPaise(9_999) },
      { userId: String(other.userId), role: 'PARTY' },
    );
    await settledPayIn(1_000);

    expect((await dashboard()).totalValue).toBe(1_000);
  });

  // =========================================================================
  // The tiles beside it are unchanged
  // =========================================================================

  it('leaves Completed value counting completed pay-outs only', async () => {
    /**
     * It sits with the task tiles and answers "how much of my own work
     * finished". Folding pay-ins into it would make it a different figure
     * under the same label, which is the problem being fixed, not repeated.
     */
    await settledPayIn(5_000);
    await completedPayOut(1_000);
    await makeTask(2_000);

    const d = await dashboard();
    expect(d.completedValue).toBe(1_000);
    expect(d.totalValue).toBe(8_000);
  });

  it('leaves Total tasks counting tasks only', async () => {
    await settledPayIn(5_000);
    await completedPayOut(1_000);
    await cancelledPayOut(8_100);

    const d = await dashboard();
    expect(d.totalTasks).toBe(2);
    expect(d.byStatus['COMPLETED']).toBe(1);
    expect(d.byStatus['CANCELLED']).toBe(1);
  });
});
