/**
 * Money in the right total is not the same as money in the right hands.
 *
 * The original reconciliation summed balances and proved every rupee was
 * somewhere. It could not prove any rupee was somewhere *correct*: a
 * commission credited to the wrong captain, an allocation sourced from a party
 * that never generated it, an amount that drifted from the task it belongs to
 * — all of those net to zero across a total and are invisible to it.
 *
 * These assertions are on ownership and amount, per record, rebuilt from the
 * task rather than read back from whatever the service wrote. They exist so a
 * regression of that shape fails in CI rather than waiting for someone to run
 * the audit harness.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, Commission, DMCAllocation, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import {
  startTask, submitProof, approveTask, rejectTask, resolveTaskRejection, requestCancellation,
} from '../../services/workflow.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('the ledger names the right owner for every entry', () => {
  const adminId = new Types.ObjectId();
  let adminActor: { userId: string; role: 'ADMIN' };

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
    const admin = await User.create({
      email: `admin-${new Types.ObjectId().toHexString()}@own.test`,
      passwordHash: await hashPassword('Demo@12345'), name: 'A', role: 'ADMIN',
    });
    adminActor = { userId: String(admin._id), role: 'ADMIN' };
  });

  interface PartyRef { id: Types.ObjectId; userId: Types.ObjectId; actor: { userId: string; role: 'PARTY' } }
  interface CaptainRef { id: Types.ObjectId; actor: { userId: string; role: 'CAPTAIN' } }

  async function makeParty(label: string): Promise<PartyRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `party-${unique}@own.test`, passwordHash: await hashPassword('Demo@12345'), name: label, role: 'PARTY',
    });
    const party = await Party.create({
      userId: user._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: label,
      contactEmail: user.email,
      dmcBalancePaise: rupeesToPaise(1_000_000),
    });
    return { id: party._id, userId: user._id, actor: { userId: String(user._id), role: 'PARTY' } };
  }

  /** What every captain in this suite starts with, so earnings can be measured. */
  const OPENING_DMC = rupeesToPaise(1_000_000);

  async function makeCaptain(label: string): Promise<CaptainRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@own.test`, passwordHash: await hashPassword('Demo@12345'), name: label, role: 'CAPTAIN',
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

  async function openTask(party: PartyRef, amountRupees: number): Promise<string> {
    const task = await createTask(
      {
        partyId: party.id, createdBy: party.userId, customerName: 'Owner Test',
        amountPaise: rupeesToPaise(amountRupees),
        payoutMethod: { type: 'UPI', upiId: 'own@bank' },
      },
      party.actor,
    );
    const id = String(task._id);
    await Task.updateOne({ _id: id }, { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } });
    return id;
  }

  async function complete(id: string, party: PartyRef, captain: CaptainRef): Promise<void> {
    await claimTask(id, captain.id, captain.actor);
    await startTask(id, captain.id, captain.actor);
    await submitProof({ taskId: id, captainId: captain.id, providerReference: `UTR${Date.now()}${Math.random()}` }, captain.actor);
    await approveTask(id, party.actor);
  }

  it('gives the commission row the task’s own captain, party and amounts', async () => {
    const party = await makeParty('Owner Party');
    const captain = await makeCaptain('Owner Captain');
    const id = await openTask(party, 10_000);
    await complete(id, party, captain);

    const task = await Task.findById(id).lean();
    const rows = await Commission.find({ taskId: new Types.ObjectId(id) }).lean();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(String(row?.captainId)).toBe(String(task?.captainId));
    expect(String(row?.partyId)).toBe(String(task?.partyId));
    expect(row?.commissionPaise).toBe(task?.commissionPaise);
    expect(row?.taskAmountPaise).toBe(task?.amountPaise);
  });

  it('gives each allocation the right owner, party and amount', async () => {
    const party = await makeParty('Alloc Party');
    const captain = await makeCaptain('Alloc Captain');
    const id = await openTask(party, 10_000);
    await complete(id, party, captain);

    const task = await Task.findById(id).lean();
    const allocs = await DMCAllocation.find({ taskId: new Types.ObjectId(id) }).lean();
    const captainAlloc = allocs.find((a) => a.ownerType === 'CAPTAIN');
    const adminAlloc = allocs.find((a) => a.ownerType === 'ADMIN');

    expect(captainAlloc).toBeDefined();
    expect(String(captainAlloc?.ownerId)).toBe(String(task?.captainId));
    expect(String(captainAlloc?.sourcePartyId)).toBe(String(task?.partyId));
    // The captain is owed their outlay back plus their commission.
    expect(captainAlloc?.amountPaise).toBe((task?.amountPaise ?? 0) + (task?.commissionPaise ?? 0));

    expect(adminAlloc).toBeDefined();
    expect(String(adminAlloc?.sourcePartyId)).toBe(String(task?.partyId));
    expect(adminAlloc?.amountPaise).toBe(task?.adminCommissionPaise);
  });

  it('credits the finishing captain after a reassignment, not the first one', async () => {
    const party = await makeParty('Chain Party');
    const first = await makeCaptain('First Captain');
    const second = await makeCaptain('Second Captain');
    const id = await openTask(party, 10_000);

    await claimTask(id, first.id, first.actor);
    await startTask(id, first.id, first.actor);
    await submitProof({ taskId: id, captainId: first.id, providerReference: 'UTR111111111' }, first.actor);
    await rejectTask(id, 'Beneficiary never received it', 'NOT_RECEIVED', party.actor);
    await resolveTaskRejection(id, 'REASSIGN', adminActor);

    await Task.updateOne({ _id: id }, { $set: { openPoolAt: new Date(), offeredCaptainId: null, offerExpiresAt: null } });
    await complete(id, party, second);

    const rows = await Commission.find({ taskId: new Types.ObjectId(id) }).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.captainId)).toBe(String(second.id));

    const allocs = await DMCAllocation.find({ taskId: new Types.ObjectId(id), ownerType: 'CAPTAIN' }).lean();
    expect(allocs).toHaveLength(1);
    expect(String(allocs[0]?.ownerId)).toBe(String(second.id));

    // The released captain holds nothing at all.
    const firstAfter = await Captain.findById(first.id).lean();
    expect((firstAfter?.dmcBalancePaise ?? 0) - OPENING_DMC).toBe(0);
    expect(firstAfter?.lockedAmountPaise).toBe(0);
    expect(await DMCAllocation.countDocuments({ ownerId: first.id })).toBe(0);
  });

  it('keeps two parties’ tasks entirely separate', async () => {
    const a = await makeParty('Party A');
    const b = await makeParty('Party B');
    const captain = await makeCaptain('Shared Captain');

    const idA = await openTask(a, 10_000);
    await complete(idA, a, captain);
    const idB = await openTask(b, 4_000);
    await complete(idB, b, captain);

    // Each allocation points at the party whose task generated it.
    const allocA = await DMCAllocation.findOne({ taskId: new Types.ObjectId(idA), ownerType: 'CAPTAIN' }).lean();
    const allocB = await DMCAllocation.findOne({ taskId: new Types.ObjectId(idB), ownerType: 'CAPTAIN' }).lean();
    expect(String(allocA?.sourcePartyId)).toBe(String(a.id));
    expect(String(allocB?.sourcePartyId)).toBe(String(b.id));
    expect(paiseToRupees(allocA?.amountPaise ?? 0)).toBe(10_100);
    expect(paiseToRupees(allocB?.amountPaise ?? 0)).toBe(4_040);

    // And the captain's balance is exactly the two together.
    const after = await Captain.findById(captain.id).lean();
    expect(paiseToRupees((after?.dmcBalancePaise ?? 0) - OPENING_DMC)).toBe(14_140);
  });

  it('leaves no commission or allocation on a cancelled task', async () => {
    const party = await makeParty('Cancel Party');
    const id = await openTask(party, 8_000);
    await requestCancellation(id, 'Customer backed out at once', party.actor);

    expect(await Commission.countDocuments({ taskId: new Types.ObjectId(id) })).toBe(0);
    expect(await DMCAllocation.countDocuments({ taskId: new Types.ObjectId(id) })).toBe(0);
  });

  it('refuses to rewrite a commission entry through the model', async () => {
    // The ledger is append-only by design; this is the guard that says so.
    const party = await makeParty('Immutable Party');
    const captain = await makeCaptain('Immutable Captain');
    const id = await openTask(party, 10_000);
    await complete(id, party, captain);

    await expect(
      Commission.updateOne({ taskId: new Types.ObjectId(id) }, { $set: { commissionPaise: 1 } }),
    ).rejects.toThrow(/immutable/i);
    await expect(Commission.deleteOne({ taskId: new Types.ObjectId(id) })).rejects.toThrow(/immutable/i);

    const row = await Commission.findOne({ taskId: new Types.ObjectId(id) }).lean();
    const task = await Task.findById(id).lean();
    expect(row?.commissionPaise).toBe(task?.commissionPaise);
  });
});
