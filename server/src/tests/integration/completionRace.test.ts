/**
 * A completion is claimed before anything is written for it.
 *
 * Approving a proof used to write the Commission row first and change the
 * task's status afterwards, and the status check that guarded it was an
 * ordinary read. Two callers could therefore both see AUDIT_PENDING: a party
 * approving and, at the same moment, rejecting. The approval wrote its
 * commission, the rejection won the status, and the task ended REJECTED
 * carrying a commission for a captain who had not been paid.
 *
 * That stale row was not merely untidy. `taskId` is unique on Commission and
 * `creditCommission` treats a duplicate key as "already credited", so when the
 * task was reassigned and a different captain actually completed it, that
 * captain received the money while the ledger went on naming the first one.
 * The books and the balances disagreed permanently about who earned it.
 *
 * These tests hold the ordering that prevents it: claim the transition, then
 * move the money.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, Commission, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import { startTask, submitProof, approveTask, rejectTask, resolveTaskRejection } from '../../services/workflow.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('approval racing rejection', () => {
  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
    // The unique index on taskId is half of what this test is about, so it has
    // to exist on the collection rather than only in the schema.
    await Commission.syncIndexes();
  });
  afterAll(teardownDatabase);

  const adminId = new Types.ObjectId();
  let partyId: Types.ObjectId;
  let partyUserId: Types.ObjectId;
  let partyActor: { userId: string; role: 'PARTY' };
  let adminActor: { userId: string; role: 'ADMIN' };

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
      email: `admin-${unique}@race.test`, passwordHash: password, name: 'A', role: 'ADMIN',
    });
    const partyUser = await User.create({
      email: `party-${unique}@race.test`, passwordHash: password, name: 'P', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Race Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(1_000_000),
    });
    partyId = party._id;
    partyUserId = partyUser._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };
    adminActor = { userId: String(adminUser._id), role: 'ADMIN' };
  });

  /** What every captain in this suite starts with, so earnings can be measured. */
  const OPENING_DMC = rupeesToPaise(1_000_000);

  async function makeCaptain(label: string): Promise<{ id: Types.ObjectId; actor: { userId: string; role: 'CAPTAIN' } }> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@race.test`, passwordHash: await hashPassword('Demo@12345'), name: label, role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: label,
      collateralBalancePaise: rupeesToPaise(1_000_000),
      // A pay-out holds DMC at the claim, so a captain needs some to claim.
      dmcBalancePaise: rupeesToPaise(1_000_000),
      lockedAmountPaise: 0,
      isOnline: true,
      status: 'ACTIVE',
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  /** A task sitting at AUDIT_PENDING, held by the given captain. */
  async function taskAwaitingAudit(captain: { id: Types.ObjectId; actor: { userId: string; role: 'CAPTAIN' } }): Promise<string> {
    const task = await createTask(
      {
        partyId,
        createdBy: partyUserId,
        customerName: 'Race Customer',
        amountPaise: rupeesToPaise(10_000),
        payoutMethod: { type: 'UPI', upiId: 'race@bank' },
      },
      partyActor,
    );
    const id = String(task._id);
    await Task.updateOne({ _id: id }, { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } });
    await claimTask(id, captain.id, captain.actor);
    await startTask(id, captain.id, captain.actor);
    await submitProof({ taskId: id, captainId: captain.id, providerReference: 'UTR100200300' }, captain.actor);
    return id;
  }

  it('never leaves a commission on a task that ended rejected', async () => {
    const captain = await makeCaptain('Race Captain');
    const id = await taskAwaitingAudit(captain);

    await Promise.allSettled([
      approveTask(id, partyActor),
      rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', partyActor),
    ]);

    const task = await Task.findById(id).lean();
    const rows = await Commission.find({ taskId: new Types.ObjectId(id) }).lean();
    if (task?.status !== 'COMPLETED') {
      expect(rows).toHaveLength(0);
    }
  });

  it('only pays the captain when the task actually completed', async () => {
    const captain = await makeCaptain('Race Captain');
    const id = await taskAwaitingAudit(captain);

    await Promise.allSettled([
      approveTask(id, partyActor),
      rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', partyActor),
    ]);

    const task = await Task.findById(id).lean();
    const after = await Captain.findById(captain.id).lean();
    const paid = (after?.dmcBalancePaise ?? 0) - OPENING_DMC;
    if (task?.status === 'COMPLETED') {
      // Hold returned, outlay reimbursed, 1% earned — a net 10,100 up.
      expect(paiseToRupees(paid)).toBe(10_100);
    } else {
      // The rejection won, so the captain still holds the task and the hold
      // is still out. They have been paid nothing, which is the point: the
      // 10,000 is committed, not earned.
      expect(paiseToRupees(paid)).toBe(-10_000);
    }
  });

  /**
   * The consequence that made this worth fixing rather than tidying: whoever
   * really does the work must be the one the ledger names.
   */
  it('credits the captain who actually completed it, even after a raced rejection', async () => {
    const first = await makeCaptain('First Captain');
    const second = await makeCaptain('Second Captain');
    const id = await taskAwaitingAudit(first);

    await Promise.allSettled([
      approveTask(id, partyActor),
      rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', partyActor),
    ]);

    const afterRace = await Task.findById(id).lean();
    if (afterRace?.status === 'COMPLETED') {
      // The approval won outright; there is nothing left to reassign.
      const rows = await Commission.find({ taskId: new Types.ObjectId(id) }).lean();
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.captainId)).toBe(String(first.id));
      return;
    }

    // The rejection won. Admin sends it back and the second captain finishes it.
    await resolveTaskRejection(id, 'REASSIGN', adminActor);
    await Task.updateOne({ _id: id }, { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } });
    await claimTask(id, second.id, second.actor);
    await startTask(id, second.id, second.actor);
    await submitProof({ taskId: id, captainId: second.id, providerReference: 'UTR400500600' }, second.actor);
    await approveTask(id, partyActor);

    const rows = await Commission.find({ taskId: new Types.ObjectId(id) }).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.captainId)).toBe(String(second.id));

    const firstAfter = await Captain.findById(first.id).lean();
    const secondAfter = await Captain.findById(second.id).lean();
    expect((firstAfter?.dmcBalancePaise ?? 0) - OPENING_DMC).toBe(0);
    expect(paiseToRupees((secondAfter?.dmcBalancePaise ?? 0) - OPENING_DMC)).toBe(10_100);
  });

  it('still completes normally when nothing is racing it', async () => {
    const captain = await makeCaptain('Solo Captain');
    const id = await taskAwaitingAudit(captain);
    await approveTask(id, partyActor);

    const task = await Task.findById(id).lean();
    expect(task?.status).toBe('COMPLETED');
    expect(task?.completedAt).toBeTruthy();
    // The history entry has to survive being written by the swap rather than a save.
    expect((task?.stateHistory ?? []).some((h) => h.to === 'COMPLETED')).toBe(true);

    const rows = await Commission.find({ taskId: new Types.ObjectId(id) }).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.captainId)).toBe(String(captain.id));
  });

  it('four simultaneous approvals still credit exactly once', async () => {
    const captain = await makeCaptain('Contended Captain');
    const id = await taskAwaitingAudit(captain);

    const settled = await Promise.allSettled([
      approveTask(id, partyActor), approveTask(id, partyActor),
      approveTask(id, partyActor), approveTask(id, partyActor),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);

    const rows = await Commission.find({ taskId: new Types.ObjectId(id) }).lean();
    expect(rows).toHaveLength(1);
    const after = await Captain.findById(captain.id).lean();
    expect(paiseToRupees((after?.dmcBalancePaise ?? 0) - OPENING_DMC)).toBe(10_100);
  });
});
