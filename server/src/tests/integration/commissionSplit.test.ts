/**
 * What a payment costs the party, and what the captain is paid out of it.
 *
 * There used to be two unrelated rates — one for the captain, one for the
 * platform — applied side by side. Nothing tied them together, so a captain
 * could be promised more than the party was ever charged and the difference
 * came from nowhere.
 *
 * Now there is one charge and one share of it:
 *
 *   the party is charged  ->  the pool  ->  the captain is paid
 *                              |
 *                              `-> what nobody took is the platform's
 *
 * These tests hold that shape end to end: what the party is billed, when the
 * pool receives it, what the captain gets, and that the three figures always
 * add back to the charge.
 *
 * This file replaces the old adminCommissionRate and partyCommissionOverride
 * suites, which tested a scheme that no longer exists.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { getPlatformAccount } from '../../services/platformAccount.service';
import { createTask, claimTask } from '../../services/task.service';
import { startTask, submitProof, approveTask } from '../../services/workflow.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('what a payment costs and what it pays', () => {
  let partyId: Types.ObjectId;
  let partyActor: { userId: string; role: 'PARTY' };

  const OPENING = rupeesToPaise(100_000);

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    // The worked example: 7% charged, 5% paid, 2% left over.
    await updateConfig(
      { payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5 },
      new Types.ObjectId(),
    );

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');
    const partyUser = await User.create({
      email: `party-${unique}@split.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Split Commerce',
      contactEmail: partyUser.email,
      dmcBalancePaise: OPENING,
    });
    partyId = party._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };
  });

  interface CaptainRef {
    id: Types.ObjectId;
    actor: { userId: string; role: 'CAPTAIN' };
  }

  async function makeCaptain(): Promise<CaptainRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@split.test`, passwordHash: await hashPassword('Demo@12345'), name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Split Captain',
      // DMC as well as security. A pay-out holds the captain's DMC at the
      // claim — they are committing to send that much real money — so a
      // fixture with security and no DMC is a captain who can claim nothing.
      collateralBalancePaise: rupeesToPaise(100_000),
      dmcBalancePaise: rupeesToPaise(1_000_000),
      isOnline: true,
      status: 'ACTIVE',
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  const makeTask = (amountRupees: number) =>
    createTask(
      {
        partyId,
        createdBy: partyId,
        customerName: 'Customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: rupeesToPaise(amountRupees),
      },
      partyActor,
    );

  async function carryOut(taskId: string, captain: CaptainRef): Promise<void> {
    await claimTask(taskId, captain.id, captain.actor);
    await startTask(taskId, captain.id, captain.actor);
    await submitProof({ taskId, captainId: captain.id, providerReference: 'NEFT-1' }, captain.actor);
    await approveTask(taskId, partyActor);
  }

  const partyDmc = async (): Promise<number> =>
    (await Party.findById(partyId).lean())?.dmcBalancePaise ?? -1;

  const poolBalance = async (): Promise<number> => (await getPlatformAccount()).poolBalancePaise;

  /**
   * What the captain has *earned*, not what they hold.
   *
   * They start with DMC because a pay-out holds it at the claim, so the
   * absolute balance is opening plus earnings. Measuring the movement is what
   * these tests are actually about.
   */
  const CAPTAIN_OPENING = rupeesToPaise(1_000_000);
  const captainDmc = async (id: Types.ObjectId): Promise<number> =>
    ((await Captain.findById(id).lean())?.dmcBalancePaise ?? -1) - CAPTAIN_OPENING;

  // =========================================================================
  // What the party pays
  // =========================================================================

  it('charges the party the amount plus one rate, and nothing else', async () => {
    await makeTask(10_000);

    // 10,000 + 7% = 10,700. One charge, not two stacked cuts.
    expect(paiseToRupees(OPENING - (await partyDmc()))).toBe(10_700);
  });

  it('records both halves of that charge on the task', async () => {
    const task = await makeTask(10_000);

    // Stored so a dispute can be answered from the row, and derived from one
    // charge so they always add back to it.
    expect(paiseToRupees(task.commissionPaise ?? 0)).toBe(500);
    expect(paiseToRupees(task.adminCommissionPaise ?? 0)).toBe(200);
    expect((task.commissionPaise ?? 0) + (task.adminCommissionPaise ?? 0)).toBe(rupeesToPaise(700));
  });

  it('does not reprice a task that already exists', async () => {
    // The captain has to exist before the task, or routing has nobody to
    // offer it to and the claim is refused.
    const captain = await makeCaptain();
    const task = await makeTask(10_000);
    await updateConfig(
      { payOutPartyCommissionPercentage: 20, payOutCaptainCommissionPercentage: 15 },
      new Types.ObjectId(),
    );

    // What somebody was already quoted is not rewritten under them.
    await carryOut(String(task._id), captain);
    expect(paiseToRupees(await captainDmc(captain.id))).toBe(10_500);
  });

  // =========================================================================
  // When the pool receives it
  // =========================================================================

  it('gives the pool nothing while the task is merely created', async () => {
    await makeTask(10_000);

    // The party has been billed, but nobody has earned anything. Crediting the
    // pool here would mean a cancelled task had to claw it back.
    expect(await poolBalance()).toBe(0);
  });

  it('funds the pool and pays the captain out of it, on completion', async () => {
    const captain = await makeCaptain();
    const task = await makeTask(10_000);
    await carryOut(String(task._id), captain);

    // 700 in, 500 out to the captain, 200 left as the platform's.
    expect(paiseToRupees(await poolBalance())).toBe(200);
    // The captain gets what they laid out back, plus their share.
    expect(paiseToRupees(await captainDmc(captain.id))).toBe(10_500);
  });

  it('gives the party everything back when the task is cancelled', async () => {
    const task = await makeTask(10_000);
    const { requestCancellation } = await import('../../services/workflow.service');
    await requestCancellation(String(task._id), 'Changed our mind', partyActor);

    // The commission goes back too. It was billed, never earned.
    expect(await partyDmc()).toBe(OPENING);
    expect(await poolBalance()).toBe(0);
  });

  // =========================================================================
  // The three always add up
  // =========================================================================

  it('never lets the captain be paid more than the party was charged', async () => {
    // A setting nobody should make, but one somebody will.
    await updateConfig(
      { payOutPartyCommissionPercentage: 2, payOutCaptainCommissionPercentage: 5 },
      new Types.ObjectId(),
    );
    const captain = await makeCaptain();
    const task = await makeTask(10_000);

    expect(paiseToRupees(OPENING - (await partyDmc()))).toBe(10_200);
    await carryOut(String(task._id), captain);

    // Capped at what arrived. Uncapped, this would pay a fee out of a pool
    // that only ever received 200 — DMC from nowhere.
    expect(paiseToRupees(await captainDmc(captain.id))).toBe(10_200);
    expect(await poolBalance()).toBe(0);
  });

  it('conserves every paise across the whole task', async () => {
    const captain = await makeCaptain();
    const before = (await partyDmc()) + (await captainDmc(captain.id)) + (await poolBalance());

    const task = await makeTask(10_000);
    await carryOut(String(task._id), captain);

    const after = (await partyDmc()) + (await captainDmc(captain.id)) + (await poolBalance());
    expect(after).toBe(before);
  });

  it('loses nothing to rounding on an awkward amount', async () => {
    await updateConfig(
      { payOutPartyCommissionPercentage: 7.5, payOutCaptainCommissionPercentage: 5.5 },
      new Types.ObjectId(),
    );
    const captain = await makeCaptain();
    const task = await createTask(
      {
        partyId,
        createdBy: partyId,
        customerName: 'Customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: 1_234_567,
      },
      partyActor,
    );

    const charged = OPENING - (await partyDmc());
    await carryOut(String(task._id), captain);

    // Whatever the rounding did, the party's charge and what it turned into
    // are the same number.
    const captainGot = await captainDmc(captain.id);
    const platformGot = await poolBalance();
    expect(captainGot + platformGot).toBe(charged);
  });

  // =========================================================================
  // A rate of nothing
  // =========================================================================

  it('charges nothing when the rates are zero', async () => {
    await updateConfig(
      { payOutPartyCommissionPercentage: 0, payOutCaptainCommissionPercentage: 0 },
      new Types.ObjectId(),
    );
    const captain = await makeCaptain();
    const task = await makeTask(10_000);

    expect(paiseToRupees(OPENING - (await partyDmc()))).toBe(10_000);
    await carryOut(String(task._id), captain);
    expect(paiseToRupees(await captainDmc(captain.id))).toBe(10_000);
    expect(await poolBalance()).toBe(0);
  });

  it('lets the platform take the whole charge, paying the captain nothing', async () => {
    await updateConfig(
      { payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 0 },
      new Types.ObjectId(),
    );
    const captain = await makeCaptain();
    const task = await makeTask(10_000);
    await carryOut(String(task._id), captain);

    // The captain is still made whole on what they laid out — that is a
    // reimbursement, not a fee, and it is never the platform's to keep.
    expect(paiseToRupees(await captainDmc(captain.id))).toBe(10_000);
    expect(paiseToRupees(await poolBalance())).toBe(700);
  });

  it('keeps the task’s stored rates for the ledger', async () => {
    const task = await makeTask(10_000);
    const stored = await Task.findById(task._id).lean();

    expect(stored?.partyCommissionRate).toBe(7);
    expect(stored?.captainCommissionRate).toBe(5);
    expect(paiseToRupees(stored?.partyCommissionPaise ?? 0)).toBe(700);
  });
});
