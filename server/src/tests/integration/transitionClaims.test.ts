/**
 * Every task transition is claimed explicitly, and a loser moves no money.
 *
 * These paths were safe before, but only by accident: each `save()` also
 * pushed to `stateHistory`, which makes Mongoose include the version key in
 * the update, so a losing writer failed with a VersionError. Correctness
 * rested on an array happening to be modified — reshape one of those writes
 * and the guard vanishes silently, with a double refund on the other side.
 *
 * Each transition is now a compare-and-swap whose filter is the precondition.
 * What these tests hold is the property that matters: whatever the outcome of
 * a race, exactly one caller wins and the losers move **zero** DMC. Every
 * assertion is on money and collateral, not on which caller happened to win.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import {
  startTask, submitProof, approveTask, rejectTask, resolveTaskRejection,
  requestCancellation, reviewCancellationAsCaptain, reviewCancellationAsParty,
  resolveCancelDispute, rejectExpiredTask, reclaimUnacknowledgedExpiredTasks,
  expireOverdueTasks, expireStaleUnclaimedTasks,
} from '../../services/workflow.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('state transitions are claimed, not assumed', () => {
  const adminId = new Types.ObjectId();
  const TASK = 10_000;
  /** amount + 1% captain + 2% platform */
  const BILLED = 10_300;

  let partyId: Types.ObjectId;
  let partyUserId: Types.ObjectId;
  let partyActor: { userId: string; role: 'PARTY' };
  let adminActor: { userId: string; role: 'ADMIN' };
  let opening: number;

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
        // The party is charged 3%; the captain takes 1 of it and the platform
        // keeps the 2 that are left.
        payOutPartyCommissionPercentage: 3, payOutCaptainCommissionPercentage: 1,
      },
      adminId,
    );

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');
    const adminUser = await User.create({
      email: `admin-${unique}@claim.test`, passwordHash: password, name: 'A', role: 'ADMIN',
    });
    const partyUser = await User.create({
      email: `party-${unique}@claim.test`, passwordHash: password, name: 'P', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Claim Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(1_000_000),
    });
    partyId = party._id;
    partyUserId = partyUser._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };
    adminActor = { userId: String(adminUser._id), role: 'ADMIN' };
    opening = party.dmcBalancePaise;
  });

  /** What every captain in this suite starts with, so earnings can be measured. */
  const OPENING_DMC = rupeesToPaise(1_000_000);

  async function makeCaptain(label: string): Promise<{ id: Types.ObjectId; actor: { userId: string; role: 'CAPTAIN' } }> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@claim.test`, passwordHash: await hashPassword('Demo@12345'), name: label, role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: label,
      collateralBalancePaise: rupeesToPaise(1_000_000),
      lockedAmountPaise: 0,
      // A pay-out holds DMC at the claim, so a captain needs some to claim at all.
      dmcBalancePaise: rupeesToPaise(1_000_000),
      isOnline: true,
      status: 'ACTIVE',
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  async function newTask(): Promise<string> {
    const task = await createTask(
      {
        partyId,
        createdBy: partyUserId,
        customerName: 'Claim Customer',
        amountPaise: rupeesToPaise(TASK),
        payoutMethod: { type: 'UPI', upiId: 'claim@bank' },
      },
      partyActor,
    );
    const id = String(task._id);
    await Task.updateOne({ _id: id }, { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } });
    return id;
  }

  const partyBalance = async (): Promise<number> =>
    (await Party.findById(partyId).lean())?.dmcBalancePaise ?? 0;
  const lockOf = async (id: Types.ObjectId): Promise<number> =>
    (await Captain.findById(id).lean())?.lockedAmountPaise ?? 0;

  /** Whatever the winner did, the party is either billed once or refunded once. */
  const expectBilledOnceOrRefundedOnce = async (): Promise<void> => {
    const balance = await partyBalance();
    expect([opening, opening - rupeesToPaise(BILLED)]).toContain(balance);
  };

  // ------------------------------------------------------------ cancellation

  it('refunds once when three callers cancel an unclaimed task together', async () => {
    const id = await newTask();
    const settled = await Promise.allSettled([
      requestCancellation(id, 'Customer backed out at once', partyActor),
      requestCancellation(id, 'Customer backed out at once', partyActor),
      requestCancellation(id, 'Customer backed out at once', partyActor),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // Refunded exactly what was billed — never twice.
    expect(await partyBalance()).toBe(opening);
  });

  it('refunds once when three captains approve the same cancellation', async () => {
    const captain = await makeCaptain('Cancel Captain');
    const id = await newTask();
    await claimTask(id, captain.id, captain.actor);
    await requestCancellation(id, 'Customer backed out at once', partyActor);

    const settled = await Promise.allSettled([
      reviewCancellationAsCaptain(id, captain.id, 'APPROVE', undefined, captain.actor),
      reviewCancellationAsCaptain(id, captain.id, 'APPROVE', undefined, captain.actor),
      reviewCancellationAsCaptain(id, captain.id, 'APPROVE', undefined, captain.actor),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await partyBalance()).toBe(opening);
    // The hold is given back once, not three times — a clamped release would
    // hide a triple credit, so the lock must land exactly on zero.
    expect(await lockOf(captain.id)).toBe(0);
  });

  it('does not both refund and escalate when approve races reject', async () => {
    const captain = await makeCaptain('Split Captain');
    const id = await newTask();
    await claimTask(id, captain.id, captain.actor);
    await requestCancellation(id, 'Customer backed out at once', partyActor);

    await Promise.allSettled([
      reviewCancellationAsCaptain(id, captain.id, 'APPROVE', undefined, captain.actor),
      reviewCancellationAsCaptain(id, captain.id, 'REJECT', 'I already started this', captain.actor),
    ]);

    const task = await Task.findById(id).lean();
    expect(['CANCELLED', 'CANCEL_DISPUTED']).toContain(task?.status);
    if (task?.status === 'CANCELLED') {
      expect(await partyBalance()).toBe(opening);
      expect(await lockOf(captain.id)).toBe(0);
    } else {
      // Escalated: nothing refunded, the captain still holds it. Holding it
      // reserves nothing — a pay-out costs them only when they send the money.
      expect(await partyBalance()).toBe(opening - rupeesToPaise(BILLED));
      expect(await lockOf(captain.id)).toBe(0);
    }
  });

  it('releases the hold once when a disputed cancellation is resolved twice', async () => {
    const captain = await makeCaptain('Dispute Captain');
    const id = await newTask();
    await claimTask(id, captain.id, captain.actor);
    await requestCancellation(id, 'Customer backed out at once', partyActor);
    await reviewCancellationAsCaptain(id, captain.id, 'REJECT', 'I already started this', captain.actor);

    const settled = await Promise.allSettled([
      resolveCancelDispute(id, 'REASSIGN', adminActor),
      resolveCancelDispute(id, 'REASSIGN', adminActor),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await lockOf(captain.id)).toBe(0);
    // Reassignment refunds nothing: the money stays committed to the task.
    expect(await partyBalance()).toBe(opening - rupeesToPaise(BILLED));
  });

  // ------------------------------------------------------------ reassignment

  it('releases the hold once when a rejection is resolved twice', async () => {
    const captain = await makeCaptain('Rejected Captain');
    const id = await newTask();
    await claimTask(id, captain.id, captain.actor);
    await startTask(id, captain.id, captain.actor);
    await submitProof({ taskId: id, captainId: captain.id, providerReference: 'UTR100100100' }, captain.actor);
    await rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', partyActor);

    const settled = await Promise.allSettled([
      resolveTaskRejection(id, 'REASSIGN', adminActor),
      resolveTaskRejection(id, 'REASSIGN', adminActor),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await lockOf(captain.id)).toBe(0);
    // Counted once, so the captain is excluded from this task exactly once.
    const task = await Task.findById(id).lean();
    expect(task?.reassignmentCount).toBe(1);
    expect((task?.previousCaptainIds ?? []).map(String)).toEqual([String(captain.id)]);
  });

  it('never both completes and reassigns the same rejection', async () => {
    const captain = await makeCaptain('Contested Captain');
    const id = await newTask();
    await claimTask(id, captain.id, captain.actor);
    await startTask(id, captain.id, captain.actor);
    await submitProof({ taskId: id, captainId: captain.id, providerReference: 'UTR200200200' }, captain.actor);
    await rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', partyActor);

    await Promise.allSettled([
      resolveTaskRejection(id, 'APPROVE', adminActor),
      resolveTaskRejection(id, 'REASSIGN', adminActor),
    ]);

    const task = await Task.findById(id).lean();
    const after = await Captain.findById(captain.id).lean();
    if (task?.status === 'COMPLETED') {
      expect(paiseToRupees((after?.dmcBalancePaise ?? 0) - OPENING_DMC)).toBe(10_100);
    } else {
      // Reassigned: paid nothing, and the money is still committed to the task.
      expect((after?.dmcBalancePaise ?? 0) - OPENING_DMC).toBe(0);
      await expectBilledOnceOrRefundedOnce();
    }
    expect(after?.lockedAmountPaise).toBe(0);
  });

  // ------------------------------------------------------------------ expiry

  it('releases the hold once when two sweeps expire the same task', async () => {
    const captain = await makeCaptain('Expiring Captain');
    const id = await newTask();
    await claimTask(id, captain.id, captain.actor);
    await Task.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });

    await Promise.allSettled([expireOverdueTasks(), expireOverdueTasks()]);

    expect((await Task.findById(id).lean())?.status).toBe('EXPIRED');
    expect(await lockOf(captain.id)).toBe(0);
    // Expiry resolves nothing financially: the task is still live.
    expect(await partyBalance()).toBe(opening - rupeesToPaise(BILLED));
  });

  it('returns an expired task to the pool once when the captain and the sweeper race', async () => {
    const captain = await makeCaptain('Racing Captain');
    const id = await newTask();
    await claimTask(id, captain.id, captain.actor);
    await Task.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
    await expireOverdueTasks();
    await Task.updateOne({ _id: id }, { $set: { expiryAckDeadline: new Date(Date.now() - 60_000) } });

    await Promise.allSettled([
      rejectExpiredTask(id, captain.id, 'Bank was down all evening', captain.actor),
      reclaimUnacknowledgedExpiredTasks(),
    ]);

    const task = await Task.findById(id).lean();
    expect(task?.status).toBe('REASSIGNED');
    // Walked out of the pool exactly once, however the race landed.
    expect(task?.reassignmentCount).toBe(1);
    expect((task?.previousCaptainIds ?? []).map(String)).toEqual([String(captain.id)]);
    expect(await lockOf(captain.id)).toBe(0);
  });

  it('refunds a stale unclaimed task once when two sweeps overlap', async () => {
    const id = await newTask();
    // Through the driver, not the model: Mongoose marks `createdAt` immutable
    // under `timestamps: true` and drops a model-level $set on it silently.
    await Task.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { createdAt: new Date(Date.now() - 90 * 24 * 60 * 60_000) } },
    );

    await Promise.allSettled([expireStaleUnclaimedTasks(), expireStaleUnclaimedTasks()]);

    expect((await Task.findById(id).lean())?.status).toBe('CANCELLED');
    expect(await partyBalance()).toBe(opening);
  });

  it('does not refund a stale task a captain claims in the same instant', async () => {
    const captain = await makeCaptain('Late Captain');
    const id = await newTask();
    // Through the driver, not the model: Mongoose marks `createdAt` immutable
    // under `timestamps: true` and drops a model-level $set on it silently.
    await Task.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { createdAt: new Date(Date.now() - 90 * 24 * 60 * 60_000) } },
    );

    await Promise.allSettled([
      expireStaleUnclaimedTasks(),
      claimTask(id, captain.id, captain.actor),
    ]);

    const task = await Task.findById(id).lean();
    if (task?.status === 'CANCELLED') {
      // Cancelled: refunded once, and nobody is holding it.
      expect(await partyBalance()).toBe(opening);
      expect(task.captainId ?? null).toBeNull();
      expect(await lockOf(captain.id)).toBe(0);
    } else {
      // Claimed: no refund, and nothing reserved against it.
      expect(await partyBalance()).toBe(opening - rupeesToPaise(BILLED));
      expect(await lockOf(captain.id)).toBe(0);
    }
  });

  // ----------------------------------------------------- ordinary behaviour

  it('leaves every ordinary transition working exactly as before', async () => {
    const captain = await makeCaptain('Ordinary Captain');
    const id = await newTask();
    expect(await partyBalance()).toBe(opening - rupeesToPaise(BILLED));

    await claimTask(id, captain.id, captain.actor);
    expect(await lockOf(captain.id)).toBe(0);

    await startTask(id, captain.id, captain.actor);
    expect((await Task.findById(id).lean())?.status).toBe('IN_PROGRESS');

    await submitProof({ taskId: id, captainId: captain.id, providerReference: 'UTR300300300' }, captain.actor);
    const submitted = await Task.findById(id).lean();
    expect(submitted?.status).toBe('AUDIT_PENDING');
    // The history of both hops survives being written by swaps rather than saves.
    const hops = (submitted?.stateHistory ?? []).map((h) => `${h.from}->${h.to}`);
    expect(hops).toContain('IN_PROGRESS->PROOF_SUBMITTED');
    expect(hops).toContain('PROOF_SUBMITTED->AUDIT_PENDING');

    await approveTask(id, partyActor);
    const done = await Task.findById(id).lean();
    expect(done?.status).toBe('COMPLETED');
    expect(await lockOf(captain.id)).toBe(0);
    const after = await Captain.findById(captain.id).lean();
    expect(paiseToRupees((after?.dmcBalancePaise ?? 0) - OPENING_DMC)).toBe(10_100);
  });

  it('still reports a plain conflict when a decision arrives late', async () => {
    const captain = await makeCaptain('Late Decider');
    const id = await newTask();
    await claimTask(id, captain.id, captain.actor);
    await requestCancellation(id, 'Customer backed out at once', partyActor);
    await reviewCancellationAsCaptain(id, captain.id, 'APPROVE', undefined, captain.actor);

    // The party's review of a cancellation already settled.
    await expect(
      reviewCancellationAsParty(id, partyId, 'APPROVE', undefined, partyActor),
    ).rejects.toThrow();
    expect(await partyBalance()).toBe(opening);
  });
});
