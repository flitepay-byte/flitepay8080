/**
 * Creating a task debits the party before the task row is written, so anything
 * that fails in between has to give the money back.
 *
 * This matters more now that a party can supply its own reference: a repeated
 * submission is meant to be refused by the unique (partyId, externalRef) index,
 * and a refusal that kept the DMC would trade one bug for a worse one.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Task, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createTask } from '../../services/task.service';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('task creation and repeated submissions', () => {
  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
    await Task.syncIndexes();
  });
  afterAll(teardownDatabase);
  beforeEach(clearCollections);

  const OPENING = rupeesToPaise(100_000);
  const AMOUNT = rupeesToPaise(500);

  interface Fixture {
    partyId: Types.ObjectId;
    actor: { userId: string; role: 'PARTY' };
    userId: Types.ObjectId;
  }

  async function party(): Promise<Fixture> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `party-${unique}@idem.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Idem Party',
      role: 'PARTY',
    });
    const doc = await Party.create({
      userId: user._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Idem Party Ltd',
      contactEmail: user.email,
      dmcBalancePaise: OPENING,
    });
    return { partyId: doc._id, userId: user._id, actor: { userId: String(user._id), role: 'PARTY' } };
  }

  const input = (f: Fixture, externalRef?: string) => ({
    partyId: f.partyId,
    createdBy: f.userId,
    customerName: 'Rahul Sharma',
    amountPaise: AMOUNT,
    payoutMethod: { type: 'UPI' as const, upiId: 'idem@bank' },
    ...(externalRef ? { externalRef } : {}),
  });

  async function balance(f: Fixture): Promise<number> {
    return (await Party.findById(f.partyId).lean())?.dmcBalancePaise ?? 0;
  }

  it('creates one task when the same reference is submitted twice', async () => {
    const f = await party();
    await createTask(input(f, 'ORDER-4471'), f.actor);

    await expect(createTask(input(f, 'ORDER-4471'), f.actor)).rejects.toThrow();
    expect(await Task.countDocuments({ partyId: f.partyId })).toBe(1);
  });

  it('bills the party once for a repeated reference', async () => {
    const f = await party();
    await createTask(input(f, 'ORDER-4472'), f.actor);
    const afterFirst = await balance(f);

    await expect(createTask(input(f, 'ORDER-4472'), f.actor)).rejects.toThrow();

    // The refused attempt debited the party before it failed; that has to come
    // back, or the party pays for a task that was never created.
    expect(await balance(f)).toBe(afterFirst);
    expect(afterFirst).toBeLessThan(OPENING);
  });

  it('survives a double-click on the same reference', async () => {
    const f = await party();

    const settled = await Promise.allSettled([
      createTask(input(f, 'ORDER-4473'), f.actor),
      createTask(input(f, 'ORDER-4473'), f.actor),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(await Task.countDocuments({ partyId: f.partyId })).toBe(1);

    const task = await Task.findOne({ partyId: f.partyId }).lean();
    const cost = (task?.amountPaise ?? 0) + (task?.commissionPaise ?? 0) + (task?.adminCommissionPaise ?? 0);
    expect(await balance(f)).toBe(OPENING - cost);
  });

  it('still allows two genuinely different orders', async () => {
    const f = await party();
    await createTask(input(f, 'ORDER-A'), f.actor);
    await createTask(input(f, 'ORDER-B'), f.actor);
    expect(await Task.countDocuments({ partyId: f.partyId })).toBe(2);
  });

  it('generates its own reference when the party does not supply one', async () => {
    const f = await party();
    const a = await createTask(input(f), f.actor);
    const b = await createTask(input(f), f.actor);
    expect(a.externalRef).toBeTruthy();
    expect(b.externalRef).not.toBe(a.externalRef);
    expect(await Task.countDocuments({ partyId: f.partyId })).toBe(2);
  });

  it('lets two different parties use the same reference', async () => {
    // The reference is the party's own; uniqueness is scoped to them.
    const one = await party();
    const two = await party();
    await createTask(input(one, 'PO-1000'), one.actor);
    await createTask(input(two, 'PO-1000'), two.actor);
    expect(await Task.countDocuments({})).toBe(2);
  });
});
