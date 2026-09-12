/**
 * The payment reference is the captain's, not the system's.
 *
 * A mock payout provider used to issue a fabricated `SIM…` reference, and the
 * captain's only job was to pass it back — the proof form was pre-filled with
 * it and the party "audit" compared the string to itself. That checked
 * nothing: the money moves outside this app, so the only reference worth
 * recording is the one the captain's bank actually gave them.
 *
 * Now the captain types their UTR when they submit proof. These tests hold
 * that what they typed is what is stored, that nothing invents one for them,
 * and that a task carries no reference until they report it.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, Proof, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { submitProof } from '../../services/workflow.service';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('the captain-reported payment reference', () => {
  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
    await Proof.syncIndexes();
  });
  afterAll(teardownDatabase);
  beforeEach(clearCollections);

  interface Fixture {
    taskId: string;
    captainId: Types.ObjectId;
    actor: { userId: string; role: 'CAPTAIN' };
  }

  /** A task the captain has started but not yet reported a payment for. */
  async function startedTask(): Promise<Fixture> {
    const password = await hashPassword('Demo@12345');
    const unique = new Types.ObjectId().toHexString();

    const captainUser = await User.create({
      email: `cap-${unique}@utr.test`, passwordHash: password, name: 'UTR Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'UTR Captain',
      collateralBalancePaise: rupeesToPaise(100_000),
      lockedAmountPaise: rupeesToPaise(500),
      isOnline: true,
      status: 'ACTIVE',
    });

    const partyUser = await User.create({
      email: `party-${unique}@utr.test`, passwordHash: password, name: 'UTR Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'UTR Party Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(100_000),
    });

    const now = new Date();
    const task = await Task.create({
      partyId: party._id,
      createdBy: partyUser._id,
      taskCode: `TASK-UTR-${unique.slice(-8)}`,
      externalRef: `UTR-${unique.slice(-8)}`,
      customerName: 'Rahul Sharma',
      identifier: 'utr@bank',
      payoutMethod: { type: 'UPI', upiId: 'utr@bank' },
      amountPaise: rupeesToPaise(500),
      commissionPaise: 250,
      adminCommissionPaise: 100,
      status: 'IN_PROGRESS',
      captainId: captain._id,
      claimedAt: now,
      startedAt: now,
      stateHistory: [{ from: null, to: 'CREATED', at: now }],
    });

    return {
      taskId: String(task._id),
      captainId: captain._id,
      actor: { userId: String(captainUser._id), role: 'CAPTAIN' },
    };
  }

  it('carries no reference until the captain reports one', async () => {
    const f = await startedTask();
    const task = await Task.findById(f.taskId).lean();
    // Nothing issues a reference at claim or start any more.
    expect(task?.providerReference ?? null).toBeNull();
  });

  it('stores exactly the reference the captain typed', async () => {
    const f = await startedTask();
    await submitProof(
      { taskId: f.taskId, captainId: f.captainId, providerReference: '412345678901' },
      f.actor,
    );

    const task = await Task.findById(f.taskId).lean();
    const proof = await Proof.findOne({ taskId: new Types.ObjectId(f.taskId) }).lean();
    expect(task?.providerReference).toBe('412345678901');
    expect(proof?.providerReference).toBe('412345678901');
  });

  it('does not fabricate a SIM-style reference anywhere', async () => {
    const f = await startedTask();
    await submitProof(
      { taskId: f.taskId, captainId: f.captainId, providerReference: 'HDFCN52412345678' },
      f.actor,
    );

    const task = await Task.findById(f.taskId).lean();
    expect(task?.providerReference).not.toMatch(/^SIM/);
    expect(task?.providerReference).toBe('HDFCN52412345678');
  });

  it('lets two captains report different references for their own tasks', async () => {
    const a = await startedTask();
    const b = await startedTask();

    await submitProof({ taskId: a.taskId, captainId: a.captainId, providerReference: 'AAA111222333' }, a.actor);
    await submitProof({ taskId: b.taskId, captainId: b.captainId, providerReference: 'BBB444555666' }, b.actor);

    expect((await Task.findById(a.taskId).lean())?.providerReference).toBe('AAA111222333');
    expect((await Task.findById(b.taskId).lean())?.providerReference).toBe('BBB444555666');
  });

  it('moves the task to audit on the captain’s own report, with no gateway to satisfy first', async () => {
    // Previously a proof was only accepted after a simulated payout returned
    // SUCCESS, so a captain could be blocked by a dice roll after really paying.
    const f = await startedTask();
    await submitProof(
      { taskId: f.taskId, captainId: f.captainId, providerReference: '998877665544' },
      f.actor,
    );
    expect((await Task.findById(f.taskId).lean())?.status).toBe('AUDIT_PENDING');
  });
});
