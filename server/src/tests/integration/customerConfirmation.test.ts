/**
 * Who decides a payout arrived.
 *
 * A payout used to approve itself the moment a captain submitted proof, on the
 * grounds that an API party is a server with nobody present to audit. That had
 * the platform deciding, on the customer's behalf, whether their money had
 * turned up — the one fact it is in no position to know.
 *
 * Now the party is asked and given a deadline. OTDMS never contacts the
 * customer: it has no account for them and holds nothing about them. The chain
 * is captain -> OTDMS -> party -> customer, and the answer returns the same
 * way. Past the deadline the payout approves itself after all, because a
 * captain who has already sent real money cannot wait forever on somebody who
 * may never look — and the trail says that is what happened.
 *
 * No new state was needed. AUDIT_PENDING already means "waiting on a decision",
 * REJECTED already means "waiting on admin", and the Review queue already reads
 * REJECTED.
 */
import '../../globalErrorHandlers';
import request from 'supertest';
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { createApp } from '../../app';
import { User, Party, Captain, Task, AuditLog, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import {
  startTask, submitProof, autoApproveUnconfirmedPayouts,
} from '../../services/workflow.service';
import { applyCustomerConfirmation } from '../../services/customerConfirmation.service';
import { env } from '../../config/env';
import { rupeesToPaise } from '../../utils/money';

const P = env.API_PREFIX;

describeIntegration('a payout waits on the party’s customer', () => {
  const app = createApp();

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
    await updateConfig(
      {
        payOutPartyCommissionPercentage: 0,
        payOutCaptainCommissionPercentage: 0,
        customerConfirmationMinutes: 30,
      },
      new Types.ObjectId(),
    );

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');

    const partyUser = await User.create({
      email: `party-${unique}@confirm.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Confirm Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(1_000_000),
    });
    partyId = party._id;
    partyUserId = partyUser._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };

    const captainUser = await User.create({
      email: `cap-${unique}@confirm.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Confirm Captain',
      collateralBalancePaise: rupeesToPaise(1_000_000),
      dmcBalancePaise: rupeesToPaise(1_000_000),
      isOnline: true,
      status: 'ACTIVE',
    });
    captainId = captain._id;
    captainActor = { userId: String(captainUser._id), role: 'CAPTAIN' };
  });

  /** A payout carried to the point where proof has been submitted. */
  async function awaitingConfirmation(
    opts: {
      origin?: 'DASHBOARD' | 'API';
      amount?: number;
      party?: Types.ObjectId;
      captain?: { id: Types.ObjectId; actor: { userId: string; role: 'CAPTAIN' } };
    } = {},
  ): Promise<string> {
    const task = await createTask(
      {
        partyId: opts.party ?? partyId,
        createdBy: opts.party ?? partyId,
        customerName: 'Customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: rupeesToPaise(opts.amount ?? 1_000),
      },
      partyActor,
    );
    const id = String(task._id);
    if (opts.origin) await Task.updateOne({ _id: task._id }, { $set: { origin: opts.origin } });
    await Task.updateOne({ _id: task._id }, { $set: { openPoolAt: new Date() } });
    const who = opts.captain ?? { id: captainId, actor: captainActor };
    await claimTask(id, who.id, who.actor);
    await startTask(id, who.id, who.actor);
    await submitProof({ taskId: id, captainId: who.id, providerReference: 'NEFT-1' }, who.actor);
    return id;
  }

  const load = (id: string) => Task.findById(id).lean();

  // =========================================================================
  // Proof no longer decides anything
  // =========================================================================

  it('does not approve itself when proof is submitted', async () => {
    // The behaviour that was removed: an API payout used to be COMPLETED by
    // the time this line ran.
    const id = await awaitingConfirmation({ origin: 'API' });

    const task = await load(id);
    expect(task?.status).toBe('AUDIT_PENDING');
    expect(task?.completedAt).toBeNull();
  });

  it('starts the confirmation window and records who was asked, and by when', async () => {
    const id = await awaitingConfirmation();

    const task = await load(id);
    expect(task?.confirmationRequestedAt).not.toBeNull();
    expect(task?.confirmationDeadline).not.toBeNull();
    const minutes = Math.round(
      ((task!.confirmationDeadline!.getTime() - task!.confirmationRequestedAt!.getTime()) / 60_000),
    );
    expect(minutes).toBe(30);

    const asked = await AuditLog.findOne({ action: 'TASK_CONFIRMATION_REQUESTED', targetId: id }).lean();
    expect(asked).not.toBeNull();
  });

  it('asks only once, however the submission is raced', async () => {
    // The deadline is set under a guard on it being unset, so a second write
    // finds nothing to do rather than restarting somebody's clock.
    const id = await awaitingConfirmation();
    const first = (await load(id))!.confirmationDeadline;

    await submitProof({ taskId: id, captainId, providerReference: 'NEFT-2' }, captainActor).catch(() => undefined);

    expect((await load(id))!.confirmationDeadline).toEqual(first);
    expect(await AuditLog.countDocuments({ action: 'TASK_CONFIRMATION_REQUESTED', targetId: id })).toBe(1);
  });

  // =========================================================================
  // The customer said yes
  // =========================================================================

  it('settles when the party relays that the money arrived', async () => {
    const id = await awaitingConfirmation();

    await applyCustomerConfirmation({ taskId: id, partyId, received: true, actor: partyActor });

    const task = await load(id);
    expect(task?.status).toBe('COMPLETED');
    expect(task?.confirmationDeadline).toBeNull();
    expect(
      await AuditLog.countDocuments({ action: 'TASK_CUSTOMER_CONFIRMED', targetId: id }),
    ).toBe(1);
  });

  it('pays the captain their commission on that settlement', async () => {
    // The existing money path, untouched — this change moved who decides, not
    // what happens once the decision is made.
    await updateConfig(
      { payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5 },
      new Types.ObjectId(),
    );
    const before = (await Captain.findById(captainId).lean())!.dmcBalancePaise;
    const id = await awaitingConfirmation({ amount: 10_000 });

    await applyCustomerConfirmation({ taskId: id, partyId, received: true, actor: partyActor });

    const after = (await Captain.findById(captainId).lean())!.dmcBalancePaise;
    // A completed pay-out returns the hold, reimburses the real money the
    // captain sent, and pays the fee — so the fee is what is left once the
    // amount itself is taken back out.
    expect(after - before - rupeesToPaise(10_000)).toBe(rupeesToPaise(500));
  });

  // =========================================================================
  // The customer said no
  // =========================================================================

  it('sends a dispute to admin rather than settling', async () => {
    const id = await awaitingConfirmation();

    await applyCustomerConfirmation({
      taskId: id, partyId, received: false,
      reason: 'Customer says nothing arrived in their account',
      actor: partyActor,
    });

    const task = await load(id);
    // REJECTED is where a disputed proof already waits for admin, and what the
    // Review queue already reads — no second review system was added.
    expect(task?.status).toBe('REJECTED');
    expect(task?.completedAt).toBeNull();
    expect(await AuditLog.countDocuments({ action: 'TASK_CUSTOMER_DISPUTED', targetId: id })).toBe(1);
  });

  it('shows that dispute in the admin review queue', async () => {
    const id = await awaitingConfirmation();
    await applyCustomerConfirmation({
      taskId: id, partyId, received: false,
      reason: 'Customer says nothing arrived', actor: partyActor,
    });

    const admin = await User.create({
      email: `admin-${new Types.ObjectId().toHexString()}@confirm.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Admin',
      role: 'ADMIN',
    });
    const agent = request.agent(app);
    const step1 = await agent.post(`${P}/auth/login`).send({ email: admin.email, password: 'Demo@12345' });
    await agent
      .post(`${P}/auth/verify-otp`)
      .send({ challengeId: step1.body?.data?.challengeId, otp: step1.body?.data?.devOtp });

    const queue = await agent.get(`${P}/admin/review-queue?page=1&limit=50`);
    const items = queue.body.data.items as Array<{ targetId?: string; id?: string }>;
    expect(JSON.stringify(items)).toContain(id);
  });

  it('insists on a reason when the answer is no', async () => {
    const id = await awaitingConfirmation();

    await expect(
      applyCustomerConfirmation({ taskId: id, partyId, received: false, actor: partyActor }),
    ).rejects.toThrow();

    expect((await load(id))?.status).toBe('AUDIT_PENDING');
  });

  // =========================================================================
  // Nobody came back
  // =========================================================================

  it('approves itself once the window has passed, and says so', async () => {
    const id = await awaitingConfirmation();
    await Task.updateOne({ _id: id }, { $set: { confirmationDeadline: new Date(Date.now() - 1_000) } });

    const approved = await autoApproveUnconfirmedPayouts();

    expect(approved).toHaveLength(1);
    expect((await load(id))?.status).toBe('COMPLETED');
    const entry = await AuditLog.findOne({ action: 'TASK_AUTO_APPROVED', targetId: id }).lean();
    expect((entry?.metadata as { reason?: string })?.reason).toContain('did not respond');
  });

  it('leaves a payout alone while its window is still open', async () => {
    const id = await awaitingConfirmation();

    expect(await autoApproveUnconfirmedPayouts()).toHaveLength(0);
    expect((await load(id))?.status).toBe('AUDIT_PENDING');
  });

  it('approves once, however many times the sweep runs', async () => {
    const id = await awaitingConfirmation();
    await Task.updateOne({ _id: id }, { $set: { confirmationDeadline: new Date(Date.now() - 1_000) } });

    await autoApproveUnconfirmedPayouts();
    const second = await autoApproveUnconfirmedPayouts();

    expect(second).toHaveLength(0);
    expect(await AuditLog.countDocuments({ action: 'TASK_AUTO_APPROVED', targetId: id })).toBe(1);
  });

  it('does not sweep a payout the customer already answered', async () => {
    const id = await awaitingConfirmation();
    await applyCustomerConfirmation({
      taskId: id, partyId, received: false,
      reason: 'Customer says nothing arrived', actor: partyActor,
    });
    // Even with a lapsed deadline forced back on, the state has moved on.
    await Task.updateOne({ _id: id }, { $set: { confirmationDeadline: new Date(Date.now() - 1_000) } });

    expect(await autoApproveUnconfirmedPayouts()).toHaveLength(0);
    expect((await load(id))?.status).toBe('REJECTED');
  });

  it('refuses an answer that arrives after the sweep has settled it', async () => {
    /**
     * The race, from the other side. Both paths clear the same field in a
     * conditional write, so whichever lands first decides and the other is
     * told the payout is no longer waiting — never settled twice.
     */
    const id = await awaitingConfirmation();
    await Task.updateOne({ _id: id }, { $set: { confirmationDeadline: new Date(Date.now() - 1_000) } });
    await autoApproveUnconfirmedPayouts();

    await expect(
      applyCustomerConfirmation({ taskId: id, partyId, received: true, actor: partyActor }),
    ).rejects.toThrow(/no longer waiting/i);

    expect((await load(id))?.status).toBe('COMPLETED');
    expect(await AuditLog.countDocuments({ action: 'TASK_CUSTOMER_CONFIRMED', targetId: id })).toBe(0);
  });

  // =========================================================================
  // The window is configurable
  // =========================================================================

  it('uses a twenty-minute window when admin sets one', async () => {
    await updateConfig({ customerConfirmationMinutes: 20 }, new Types.ObjectId());

    const id = await awaitingConfirmation();

    const task = await load(id);
    const minutes = Math.round(
      (task!.confirmationDeadline!.getTime() - task!.confirmationRequestedAt!.getTime()) / 60_000,
    );
    expect(minutes).toBe(20);
  });

  it('is the same window for every party', async () => {
    /**
     * Global, unlike the four task clocks beside it. Those are each party's
     * promise to their own customers and properly differ; this is how long the
     * platform waits before deciding for itself, and a captain who has already
     * sent real money should wait the same time whoever they were working for.
     */
    const second = await Party.create({
      userId: new Types.ObjectId(),
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Another Ltd',
      contactEmail: `other-${new Types.ObjectId().toHexString()}@confirm.test`,
      dmcBalancePaise: rupeesToPaise(1_000_000),
    });
    await updateConfig({ customerConfirmationMinutes: 25 }, new Types.ObjectId());

    const mine = await load(await awaitingConfirmation());
    const theirs = await load(await awaitingConfirmation({ party: second._id }));

    expect(mine?.confirmationMinutes).toBe(25);
    expect(theirs?.confirmationMinutes).toBe(25);
  });

  it('ignores anything a party may have stored of its own', async () => {
    // The per-party override was removed. Writing the field directly proves
    // the resolution does not read it rather than that nobody set it.
    await Party.collection.updateOne({ _id: partyId }, { $set: { confirmationMinutes: 45 } });

    const task = await load(await awaitingConfirmation());

    expect(task?.confirmationMinutes).toBe(30);
  });

  it('is the same window whichever captain takes the work', async () => {
    const unique = new Types.ObjectId().toHexString();
    const other = await User.create({
      email: `cap2-${unique}@confirm.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Other Captain',
      role: 'CAPTAIN',
    });
    const otherCaptain = await Captain.create({
      userId: other._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Other Captain',
      collateralBalancePaise: rupeesToPaise(1_000_000),
      dmcBalancePaise: rupeesToPaise(1_000_000),
      isOnline: true,
      status: 'ACTIVE',
    });

    const first = await load(await awaitingConfirmation());
    const second = await load(
      await awaitingConfirmation({
        captain: { id: otherCaptain._id, actor: { userId: String(other._id), role: 'CAPTAIN' } },
      }),
    );

    expect(first?.confirmationMinutes).toBe(30);
    expect(second?.confirmationMinutes).toBe(30);
  });

  it('does not move a window that is already running', async () => {
    // The length is snapshotted at creation, like the other task clocks, so a
    // settings change cannot shorten a window somebody is waiting inside.
    const id = await awaitingConfirmation();
    const deadline = (await load(id))!.confirmationDeadline;

    await updateConfig({ customerConfirmationMinutes: 1 }, new Types.ObjectId());

    expect((await load(id))!.confirmationDeadline).toEqual(deadline);
  });

  // =========================================================================
  // It belongs to exactly one party
  // =========================================================================

  it('will not let another party answer for this one', async () => {
    /**
     * The confirmation is scoped by partyId in the query itself. One party
     * settling another's payout would be a party approving money moving to a
     * customer who is not theirs.
     */
    const other = await Party.create({
      userId: new Types.ObjectId(),
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Somebody Else',
      contactEmail: `other-${new Types.ObjectId().toHexString()}@confirm.test`,
      dmcBalancePaise: rupeesToPaise(1_000),
    });
    const id = await awaitingConfirmation();

    await expect(
      applyCustomerConfirmation({
        taskId: id,
        partyId: other._id,
        received: true,
        actor: { userId: String(other.userId), role: 'PARTY' },
      }),
    ).rejects.toThrow();

    expect((await load(id))?.status).toBe('AUDIT_PENDING');
  });

  // =========================================================================
  // Nothing else moved
  // =========================================================================

  it('leaves the party’s own approve and reject working', async () => {
    // The dashboard audit was not deleted — a party that looks at the proof
    // and decides for themselves still can.
    const id = await awaitingConfirmation();
    const { approveTask } = await import('../../services/workflow.service');

    await approveTask(id, { userId: String(partyUserId), role: 'PARTY' });

    expect((await load(id))?.status).toBe('COMPLETED');
  });

  it('leaves the captain’s completion window alone', async () => {
    // The confirmation window is a separate clock. The captain's deadline to
    // submit proof is still the party's completionMinutes, untouched.
    const id = await awaitingConfirmation();

    const task = await load(id);
    expect(task?.completionMinutes).toBe(30);
    expect(task?.confirmationMinutes).toBe(30);
    expect(task?.expiresAt).not.toBeNull();
  });
});
