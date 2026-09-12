/**
 * What the platform kept, on both directions.
 *
 * The commission screen used to report what *captains* earned, which was
 * already answered on the payments list and again on each captain's profile.
 * The one figure only admin cares about — the platform's own margin — had no
 * home. This is that figure, and these tests hold it to the rule the engine
 * prices by: the platform takes what nobody else took.
 *
 * Nothing new is stored for it. A completed task already carries
 * `adminCommissionPaise`, and a settled pay-in carries the two halves whose
 * difference is the platform's, so this is read from rows that already exist.
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
  createPayIn, assignCaptain, openToCustomer, confirmMovement, settle,
} from '../../services/transaction.service';
import { env } from '../../config/env';
import { rupeesToPaise } from '../../utils/money';

const P = env.API_PREFIX;

describeIntegration('what the platform kept', () => {
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
    // 7% charged, 5% paid — so the platform keeps 2% of every amount, both
    // ways. Round numbers, because the arithmetic is the assertion.
    await updateConfig(
      {
        payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5,
        payInPartyCommissionPercentage: 7, payInCaptainCommissionPercentage: 5,
      },
      new Types.ObjectId(),
    );

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');

    const partyUser = await User.create({
      email: `party-${unique}@platform.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Platform Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(1_000_000),
    });
    partyId = party._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };

    const captainUser = await User.create({
      email: `cap-${unique}@platform.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Platform Captain',
      collateralBalancePaise: rupeesToPaise(1_000_000),
      dmcBalancePaise: rupeesToPaise(10_000_000),
      isOnline: true,
      status: 'ACTIVE',
    });
    captainId = captain._id;
    captainActor = { userId: String(captainUser._id), role: 'CAPTAIN' };

    const adminEmail = `admin-${unique}@platform.test`;
    await User.create({ email: adminEmail, passwordHash: password, name: 'Admin', role: 'ADMIN' });
    agent = request.agent(app);
    const step1 = await agent.post(`${P}/auth/login`).send({ email: adminEmail, password: 'Demo@12345' });
    await agent
      .post(`${P}/auth/verify-otp`)
      .send({ challengeId: step1.body?.data?.challengeId, otp: step1.body?.data?.devOtp });
  });

  /** A pay-out carried all the way to completed. */
  async function completedPayOut(amountRupees: number): Promise<void> {
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
    const id = String(task._id);
    await Task.updateOne({ _id: task._id }, { $set: { openPoolAt: new Date() } });
    await claimTask(id, captainId, captainActor);
    await startTask(id, captainId, captainActor);
    await submitProof({ taskId: id, captainId, providerReference: 'NEFT-1' }, captainActor);
    await approveTask(id, partyActor);
  }

  /** A pay-in carried all the way to settled. */
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

  const summary = () => agent.get(`${P}/admin/commissions/summary`);

  // =========================================================================
  // The figure itself
  // =========================================================================

  it('keeps the party’s charge less the captain’s share, on a pay-out', async () => {
    await completedPayOut(10_000);

    const res = await summary();

    // 700 charged, 500 paid, 200 kept.
    expect(res.status).toBe(200);
    expect(res.body.data.payOut.total.amount).toBe(200);
    expect(res.body.data.payOut.total.count).toBe(1);
  });

  it('keeps the same difference on a pay-in', async () => {
    await settledPayIn(10_000);

    const res = await summary();

    expect(res.body.data.payIn.total.amount).toBe(200);
    expect(res.body.data.payIn.total.count).toBe(1);
  });

  it('reports the two directions separately and together', async () => {
    await completedPayOut(10_000);
    await settledPayIn(20_000);

    const res = await summary();

    expect(res.body.data.payOut.total.amount).toBe(200);
    expect(res.body.data.payIn.total.amount).toBe(400);
    expect(res.body.data.combined.total.amount).toBe(600);
    expect(res.body.data.combined.total.count).toBe(2);
  });

  it('counts nothing before the money has landed', async () => {
    /**
     * A task that is merely claimed has been billed to the party, but nobody
     * has earned anything: the captain is paid at completion and so is the
     * platform. Counting it here would report money the platform does not have.
     */
    const task = await createTask(
      {
        partyId,
        createdBy: partyId,
        customerName: 'Customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: rupeesToPaise(10_000),
      },
      partyActor,
    );
    await Task.updateOne({ _id: task._id }, { $set: { openPoolAt: new Date() } });
    await claimTask(String(task._id), captainId, captainActor);

    const res = await summary();

    expect(res.body.data.payOut.total.amount).toBe(0);
    expect(res.body.data.combined.total.count).toBe(0);
  });

  it('keeps the whole charge when the captain earns nothing', async () => {
    await updateConfig({ payOutCaptainCommissionPercentage: 0 }, new Types.ObjectId());

    await completedPayOut(10_000);

    expect((await summary()).body.data.payOut.total.amount).toBe(700);
  });

  it('keeps nothing when the captain’s rate matches the party’s', async () => {
    // Not an error state — a party and captain on the same rate simply leave
    // the platform no margin, and the screen has to be able to say zero.
    await updateConfig({ payInCaptainCommissionPercentage: 7 }, new Types.ObjectId());

    await settledPayIn(10_000);

    expect((await summary()).body.data.payIn.total.amount).toBe(0);
  });

  // =========================================================================
  // It reconciles
  // =========================================================================

  it('adds back to what each party was charged', async () => {
    /**
     * The property the whole scheme rests on. Whatever the rates, the
     * captain's share and the platform's must sum to the charge — otherwise
     * DMC is being invented or lost between them.
     */
    await completedPayOut(10_000);
    await settledPayIn(20_000);

    const task = await Task.findOne({ status: 'COMPLETED' }).lean();
    expect((task?.commissionPaise ?? 0) + (task?.adminCommissionPaise ?? 0)).toBe(rupeesToPaise(700));

    const txn = await Transaction.findOne({ status: 'SETTLED' }).lean();
    const platform = (txn?.partyCommissionPaise ?? 0) - (txn?.commissionPaise ?? 0);
    expect((txn?.commissionPaise ?? 0) + platform).toBe(txn?.partyCommissionPaise);
  });

  // =========================================================================
  // What the lists carry
  // =========================================================================

  it('gives a pay-in row both halves of the fee', async () => {
    await settledPayIn(10_000);

    const res = await agent.get(`${P}/admin/transactions?direction=PAY_IN&status=SETTLED&page=1&limit=10`);

    const row = res.body.data.items[0];
    expect(row.partyCharge).toBe(700);
    expect(row.commission).toBe(500);
    expect(row.platformCommission).toBe(200);
    // Stated rather than assumed: the three must agree on every row.
    expect(row.commission + row.platformCommission).toBe(row.partyCharge);
  });

  it('gives a pay-out row the platform’s half already', async () => {
    // Nothing was added for this side — a task has always carried it.
    await completedPayOut(10_000);

    const res = await agent.get(`${P}/admin/tasks?status=COMPLETED&page=1&limit=10`);

    const row = res.body.data.items[0];
    expect(row.commission).toBe(500);
    expect(row.adminCommission).toBe(200);
  });

  it('is admin-only', async () => {
    const res = await request(app).get(`${P}/admin/commissions/summary`);
    expect([401, 403]).toContain(res.status);
  });
});
