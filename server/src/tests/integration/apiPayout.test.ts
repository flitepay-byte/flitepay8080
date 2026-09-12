/**
 * A payout asked for through the API, carried by a task.
 *
 * A pay-in can be automated because the captain has a merchant account and the
 * gateway can mint a QR against it. A payout cannot: the person receiving the
 * money has an ordinary personal account, so somebody has to make the transfer
 * by hand. That is what a task already is, so a payout becomes one.
 *
 * Three things differ from a task a party creates by hand, and each is tested
 * here because each is a place the money can go wrong:
 *
 *   The captain is reimbursed into working DMC rather than withdrawable
 *   earnings, because that capital is what lets them take the next pay-in.
 *
 *   The proof approves itself, because there is no person at the party to
 *   audit it — they dispute afterwards instead.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { fundPlatformPool, getPlatformAccount } from '../../services/platformAccount.service';
import { createTask, claimTask } from '../../services/task.service';
import { startTask, submitProof } from '../../services/workflow.service';
import { applyCustomerConfirmation } from '../../services/customerConfirmation.service';
import { disputePayoutTask, resolvePayoutDispute } from '../../services/payoutDispute.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('a payout asked for through the API', () => {
  let partyId: Types.ObjectId;
  let partyActor: { userId: string; role: 'PARTY' };
  let adminActor: { userId: string; role: 'ADMIN' };

  const OPENING = rupeesToPaise(100_000);

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    // 7% charged to the party, 5% of it paid to the captain, 2% left for the
    // platform — the worked example from the specification.
    await updateConfig(
      {
        payOutPartyCommissionPercentage: 7,
        payOutCaptainCommissionPercentage: 5,
      },
      new Types.ObjectId(),
    );
    await fundPlatformPool(rupeesToPaise(50_000));

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');

    const partyUser = await User.create({
      email: `party-${unique}@payout.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Payout Commerce',
      contactEmail: partyUser.email,
      dmcBalancePaise: OPENING,
    });
    partyId = party._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };

    const adminUser = await User.create({
      email: `admin-${unique}@payout.test`, passwordHash: password, name: 'Admin', role: 'ADMIN',
    });
    adminActor = { userId: String(adminUser._id), role: 'ADMIN' };
  });

  interface CaptainRef {
    id: Types.ObjectId;
    actor: { userId: string; role: 'CAPTAIN' };
  }

  async function makeCaptain(collateralRupees = 100_000): Promise<CaptainRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@payout.test`, passwordHash: await hashPassword('Demo@12345'), name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Payout Captain',
      // DMC as well as security. A pay-out holds the captain's DMC at the
      // claim — they are committing to send that much real money — so a
      // fixture with security and no DMC is a captain who can claim nothing.
      collateralBalancePaise: rupeesToPaise(collateralRupees),
      dmcBalancePaise: rupeesToPaise(collateralRupees),
      isOnline: true,
      status: 'ACTIVE',
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  const makePayout = (amountRupees: number, reference: string) =>
    createTask(
      {
        partyId,
        createdBy: partyId,
        customerName: 'Shop customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: rupeesToPaise(amountRupees),
        externalRef: reference,
        origin: 'API',
      },
      partyActor,
    );

  const partyDmc = async (): Promise<number> =>
    (await Party.findById(partyId).lean())?.dmcBalancePaise ?? -1;

  /**
   * A captain opens with DMC because a pay-out holds it at the claim, so the
   * balance is opening plus whatever this test moved. `dmc` reports the
   * movement, which is what every assertion here is about.
   */
  const CAPTAIN_OPENING = rupeesToPaise(100_000);

  const captainOf = async (id: Types.ObjectId) => {
    const c = await Captain.findById(id).lean();
    return {
      dmc: (c?.dmcBalancePaise ?? -1) - CAPTAIN_OPENING,
      locked: c?.lockedAmountPaise ?? -1,
    };
  };

  /**
   * Take one all the way through, as the captain would — and then as the party
   * would.
   *
   * Proof used to be the end of it: an API payout approved itself, on the
   * grounds that a server has nobody present to audit. It no longer does. The
   * party is asked whether their customer got the money and answers through
   * their own integration, so a payout is settled here by saying yes, exactly
   * as a real one would be.
   */
  async function carryOut(taskId: string, captain: CaptainRef): Promise<void> {
    await submitProofOnly(taskId, captain);
    await confirmReceived(taskId);
  }

  /** Up to proof, and no further. Leaves the payout awaiting confirmation. */
  async function submitProofOnly(taskId: string, captain: CaptainRef): Promise<void> {
    await claimTask(taskId, captain.id, captain.actor);
    await startTask(taskId, captain.id, captain.actor);
    await submitProof(
      { taskId, captainId: captain.id, providerReference: 'NEFT-778899' },
      captain.actor,
    );
  }

  /** The party relaying that their customer confirmed the money arrived. */
  async function confirmReceived(taskId: string): Promise<void> {
    await applyCustomerConfirmation({
      taskId,
      partyId,
      received: true,
      actor: { userId: String(partyId), role: 'PARTY' },
    });
  }

  // =========================================================================
  // The money
  // =========================================================================

  it('charges the party one rate on top of the amount', async () => {
    const task = await makePayout(5_000, 'PAY-1');

    // 5,000 sent, 5,350 charged: one rate, not two stacked cuts.
    expect(paiseToRupees(OPENING - (await partyDmc()))).toBe(5_350);
    // Split into the captain's share and the platform's remainder, which
    // always add back to the charge.
    expect(paiseToRupees(task.commissionPaise ?? 0)).toBe(250);
    expect(paiseToRupees(task.adminCommissionPaise ?? 0)).toBe(100);
  });

  it('reimburses the captain into DMC and pays their fee from the pool', async () => {
    const captain = await makeCaptain();
    const task = await makePayout(5_000, 'PAY-2');
    await carryOut(String(task._id), captain);

    const after = await captainOf(captain.id);
    // The money they laid out, back as capital they can trade with, plus
    // their 5% share — one balance, so the fee funds capacity rather than
    // sitting in a second pocket they cannot spend on a pay-in.
    expect(paiseToRupees(after.dmc)).toBe(5_250);
    // The party's 350 funded the pool; 250 of it went to the captain.
    expect(paiseToRupees((await getPlatformAccount()).poolBalancePaise)).toBe(50_000 + 100);
  });

  it('charges a dashboard task exactly the same', async () => {
    const captain = await makeCaptain();
    const task = await createTask(
      {
        partyId,
        createdBy: partyId,
        customerName: 'Dashboard customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: rupeesToPaise(5_000),
      },
      partyActor,
    );

    // The same 7%. A payout is a payout, and pricing it differently because a
    // person clicked rather than a server called would be a rule nobody could
    // explain to either of them.
    expect(paiseToRupees(OPENING - (await partyDmc()))).toBe(5_350);

    // Proof, then the party's own audit — the dashboard route, unchanged.
    await submitProofOnly(String(task._id), captain);
    const { approveTask } = await import('../../services/workflow.service');
    await approveTask(String(task._id), partyActor);

    const after = await captainOf(captain.id);
    expect(paiseToRupees(after.dmc)).toBe(5_250);
  });

  it('conserves every paise across the whole payout', async () => {
    const captain = await makeCaptain();
    const before =
      (await partyDmc()) +
      (await captainOf(captain.id)).dmc +
      (await getPlatformAccount()).poolBalancePaise;

    const task = await makePayout(3_000, 'PAY-3');
    await carryOut(String(task._id), captain);

    const after =
      (await partyDmc()) +
      (await captainOf(captain.id)).dmc +
      (await getPlatformAccount()).poolBalancePaise;

    // The party's charge became the captain's share and the platform's
    // remainder. Nothing was created and nothing was lost.
    expect(after).toBe(before);
  });

  // =========================================================================
  // Auto-approval
  // =========================================================================

  it('waits on the party’s customer once proof is in', async () => {
    const captain = await makeCaptain();
    const task = await makePayout(2_000, 'PAY-4');
    await submitProofOnly(String(task._id), captain);

    const waiting = await Task.findById(task._id).lean();
    // Not COMPLETED. It used to be: the payout approved itself on proof, which
    // meant the platform decided on the customer's behalf whether their money
    // had turned up. Now the party is asked, with a deadline.
    expect(waiting?.status).toBe('AUDIT_PENDING');
    expect(waiting?.confirmationDeadline).not.toBeNull();
    expect(waiting?.providerReference).toBe('NEFT-778899');
  });

  it('completes once the party says their customer got it', async () => {
    const captain = await makeCaptain();
    const task = await makePayout(2_000, 'PAY-4b');
    await carryOut(String(task._id), captain);

    const done = await Task.findById(task._id).lean();
    expect(done?.status).toBe('COMPLETED');
    expect(done?.providerReference).toBe('NEFT-778899');
    // And the collateral it was holding is free again.
    expect((await captainOf(captain.id)).locked).toBe(0);
  });

  it('still waits for the party on a dashboard task', async () => {
    const captain = await makeCaptain();
    const task = await createTask(
      {
        partyId,
        createdBy: partyId,
        customerName: 'Dashboard customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: rupeesToPaise(2_000),
      },
      partyActor,
    );
    await submitProofOnly(String(task._id), captain);

    // Both origins wait now, and for the same reason: the platform does not
    // decide whether somebody's customer got their money. A dashboard party
    // can still answer by auditing the proof themselves, or by relaying what
    // their customer said — either way it is theirs to decide.
    expect((await Task.findById(task._id).lean())?.status).toBe('AUDIT_PENDING');
  });

  // =========================================================================
  // Disputing afterwards
  // =========================================================================

  it('lets the party object after it has settled', async () => {
    const captain = await makeCaptain();
    const task = await makePayout(2_000, 'PAY-5');
    await carryOut(String(task._id), captain);

    const settled = await Task.findById(task._id);
    const disputed = await disputePayoutTask(settled!, 'Our customer never received it', partyActor);

    expect(disputed.payoutDisputedAt).not.toBeNull();
    expect(disputed.payoutDisputeReason).toBe('Our customer never received it');
    // The payment stays settled. Reversing money on one side's word is exactly
    // what the dispute exists to avoid doing automatically.
    expect(disputed.status).toBe('COMPLETED');
    expect(paiseToRupees((await captainOf(captain.id)).dmc)).toBe(2_100);
  });

  it('records one objection however many times it is raised', async () => {
    const captain = await makeCaptain();
    const task = await makePayout(2_000, 'PAY-6');
    await carryOut(String(task._id), captain);
    const settled = await Task.findById(task._id);

    const first = await disputePayoutTask(settled!, 'Never arrived', partyActor);
    const second = await disputePayoutTask(settled!, 'Still never arrived', partyActor);

    // Asking twice has not failed at anything, and there is only one objection.
    expect(second.payoutDisputeReason).toBe(first.payoutDisputeReason);
    expect(second.payoutDisputedAt?.getTime()).toBe(first.payoutDisputedAt?.getTime());
  });

  it('cannot object to a payout that never went out', async () => {
    const task = await makePayout(2_000, 'PAY-7');
    const fresh = await Task.findById(task._id);

    // Nothing has been sent, so there is nothing to be wrong about yet.
    await expect(disputePayoutTask(fresh!, 'Nothing arrived', partyActor)).rejects.toThrow();
  });

  it('lets admin answer the objection', async () => {
    const captain = await makeCaptain();
    const task = await makePayout(2_000, 'PAY-8');
    await carryOut(String(task._id), captain);
    await disputePayoutTask((await Task.findById(task._id))!, 'Never arrived', partyActor);

    const resolved = await resolvePayoutDispute(
      String(task._id),
      'REJECTED',
      'Bank statement shows the transfer landed',
      adminActor,
    );

    expect(resolved.payoutDisputeDecision).toBe('REJECTED');
    expect(resolved.payoutDisputeResolvedAt).not.toBeNull();
    // A decision does not move money on its own — see payoutDispute.service.ts.
    expect(paiseToRupees((await captainOf(captain.id)).dmc)).toBe(2_100);
  });

  it('refuses to answer an objection nobody raised', async () => {
    const captain = await makeCaptain();
    const task = await makePayout(2_000, 'PAY-9');
    await carryOut(String(task._id), captain);

    await expect(
      resolvePayoutDispute(String(task._id), 'UPHELD', 'Nothing to answer', adminActor),
    ).rejects.toThrow();
  });

  // =========================================================================
  // The same reference twice
  // =========================================================================

  it('cannot create two payouts for one reference', async () => {
    await makePayout(2_000, 'PAY-SAME');
    await expect(makePayout(2_000, 'PAY-SAME')).rejects.toThrow();

    // One payout, one debit — a retried call must not send the money twice.
    expect(await Task.countDocuments({ externalRef: 'PAY-SAME' })).toBe(1);
    expect(paiseToRupees(OPENING - (await partyDmc()))).toBe(2_140);
  });
});
