/**
 * A task carries exactly one live proof.
 *
 * The "has a proof already been submitted" check could never enforce that on
 * its own: concurrent submissions all read the task as IN_PROGRESS, all see no
 * live proof, and all proceed to write one. Three simultaneous calls produced
 * three live proofs with the same reference, milliseconds apart, and the party
 * was left auditing an ambiguous record.
 *
 * The transition is now claimed with a compare-and-swap before anything is
 * written, and a partial unique index backs it up at the database.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, Proof, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { submitProof } from '../../services/workflow.service';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('concurrent proof submission', () => {
  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
    // The partial unique index is part of what is under test, so it has to
    // exist on the collection rather than only in the schema.
    await Proof.syncIndexes();
  });
  afterAll(teardownDatabase);
  beforeEach(clearCollections);

  const REFERENCE = 'SIM900000000001';

  interface Fixture {
    taskId: string;
    captainId: Types.ObjectId;
    actor: { userId: string; role: 'CAPTAIN' };
  }

  /** A task in IN_PROGRESS, ready for the captain to report their payment. */
  async function taskAwaitingProof(): Promise<Fixture> {
    const password = await hashPassword('Demo@12345');
    const unique = new Types.ObjectId().toHexString();

    const captainUser = await User.create({
      email: `cap-${unique}@proof.test`, passwordHash: password, name: 'Proof Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Proof Captain',
      collateralBalancePaise: rupeesToPaise(100_000),
      lockedAmountPaise: rupeesToPaise(500),
      isOnline: true,
      status: 'ACTIVE',
    });

    const partyUser = await User.create({
      email: `party-${unique}@proof.test`, passwordHash: password, name: 'Proof Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Proof Party Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(100_000),
    });

    const now = new Date();
    const task = await Task.create({
      partyId: party._id,
      createdBy: partyUser._id,
      taskCode: `TASK-PROOF-${unique.slice(-8)}`,
      externalRef: `PROOF-${unique.slice(-8)}`,
      customerName: 'Rahul Sharma',
      identifier: 'proof@bank',
      payoutMethod: { type: 'UPI', upiId: 'proof@bank' },
      amountPaise: rupeesToPaise(500),
      commissionPaise: 250,
      adminCommissionPaise: 100,
      status: 'IN_PROGRESS',
      captainId: captain._id,
      claimedAt: now,
      startedAt: now,
      providerReference: REFERENCE,
      stateHistory: [{ from: null, to: 'CREATED', at: now }],
    });

    return {
      taskId: String(task._id),
      captainId: captain._id,
      actor: { userId: String(captainUser._id), role: 'CAPTAIN' },
    };
  }

  async function liveProofCount(taskId: string): Promise<number> {
    return Proof.countDocuments({ taskId: new Types.ObjectId(taskId), supersededAt: null });
  }

  it('leaves exactly one live proof when three submissions race', async () => {
    const f = await taskAwaitingProof();

    const settled = await Promise.allSettled([
      submitProof({ taskId: f.taskId, captainId: f.captainId, providerReference: REFERENCE }, f.actor),
      submitProof({ taskId: f.taskId, captainId: f.captainId, providerReference: REFERENCE }, f.actor),
      submitProof({ taskId: f.taskId, captainId: f.captainId, providerReference: REFERENCE }, f.actor),
    ]);

    const accepted = settled.filter((s) => s.status === 'fulfilled').length;
    expect(accepted).toBe(1);
    expect(await liveProofCount(f.taskId)).toBe(1);
  });

  it('holds up under a wider race', async () => {
    const f = await taskAwaitingProof();

    await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        submitProof({ taskId: f.taskId, captainId: f.captainId, providerReference: REFERENCE }, f.actor),
      ),
    );

    expect(await liveProofCount(f.taskId)).toBe(1);
    // And no orphaned proofs written by callers that then failed.
    expect(await Proof.countDocuments({ taskId: new Types.ObjectId(f.taskId) })).toBe(1);
  });

  it('moves the task on exactly once', async () => {
    const f = await taskAwaitingProof();

    await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        submitProof({ taskId: f.taskId, captainId: f.captainId, providerReference: REFERENCE }, f.actor),
      ),
    );

    const task = await Task.findById(f.taskId).lean();
    expect(task?.status).toBe('AUDIT_PENDING');
    // One submission, one pair of history events — not four.
    const submitted = task?.stateHistory.filter((e) => e.to === 'PROOF_SUBMITTED') ?? [];
    expect(submitted).toHaveLength(1);
  });

  it('still refuses a second submission made later, not just concurrently', async () => {
    const f = await taskAwaitingProof();
    await submitProof({ taskId: f.taskId, captainId: f.captainId, providerReference: REFERENCE }, f.actor);

    await expect(
      submitProof({ taskId: f.taskId, captainId: f.captainId, providerReference: REFERENCE }, f.actor),
    ).rejects.toThrow();
    expect(await liveProofCount(f.taskId)).toBe(1);
  });

  it('the database refuses a second live proof even if the guard is bypassed', async () => {
    const f = await taskAwaitingProof();
    await submitProof({ taskId: f.taskId, captainId: f.captainId, providerReference: REFERENCE }, f.actor);

    // Writing straight to the collection, as a stray code path would.
    await expect(
      Proof.create({
        taskId: new Types.ObjectId(f.taskId),
        captainId: f.captainId,
        providerReference: REFERENCE,
        submittedAt: new Date(),
      }),
    ).rejects.toThrow();
    expect(await liveProofCount(f.taskId)).toBe(1);
  });
});
