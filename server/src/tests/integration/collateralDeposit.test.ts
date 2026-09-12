/**
 * A captain posting security money to raise their collateral.
 *
 * The rule these tests hold is the one that matters: **submitting a deposit
 * credits nothing.** The money is real and it moves outside the system, so the
 * side that receives it — admin — is the side that confirms it arrived. It
 * used to be an instant self-service credit, which let a captain raise their
 * own collateral, and therefore their claim limit, without anyone checking
 * that a rupee had moved.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Captain, DmcPurchase, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { requestDeposit, approveDeposit, rejectDeposit, markDepositPaid } from '../../services/dmcPurchase.service';
import { getCollateral } from '../../services/collateral.service';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('a captain posting security money', () => {
  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);
  beforeEach(clearCollections);

  const OPENING = rupeesToPaise(50_000);
  const DEPOSIT = rupeesToPaise(20_000);

  interface Fixture {
    captainId: Types.ObjectId;
    captainActor: { userId: string; role: 'CAPTAIN' };
    adminActor: { userId: string; role: 'ADMIN' };
  }

  async function setup(): Promise<Fixture> {
    const password = await hashPassword('Demo@12345');
    const unique = new Types.ObjectId().toHexString();

    const captainUser = await User.create({
      email: `cap-${unique}@deposit.test`, passwordHash: password, name: 'Deposit Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Deposit Captain',
      collateralBalancePaise: OPENING,
      lockedAmountPaise: 0,
      isOnline: true,
      status: 'ACTIVE',
    });
    const adminUser = await User.create({
      email: `admin-${unique}@deposit.test`, passwordHash: password, name: 'Admin', role: 'ADMIN',
    });

    return {
      captainId: captain._id,
      captainActor: { userId: String(captainUser._id), role: 'CAPTAIN' },
      adminActor: { userId: String(adminUser._id), role: 'ADMIN' },
    };
  }


  /**
   * A deposit as the application really produces one: opened, then submitted
   * with the transaction reference.
   *
   * Opening alone leaves a draft that no administrator can see or approve, which
   * is deliberate — so a test about what approval does has to get past that step
   * the same way a captain does.
   */
  async function submittedDeposit(f: Fixture, amountPaise = DEPOSIT) {
    const request = await requestDeposit(f.captainId, amountPaise, f.captainActor);
    return markDepositPaid(
      String(request._id),
      f.captainId,
      { providerReference: `0xDEP-${String(request._id).slice(-8)}` },
      f.captainActor,
    );
  }

  async function collateralOf(id: Types.ObjectId): Promise<number> {
    return (await Captain.findById(id).lean())?.collateralBalancePaise ?? -1;
  }

  it('credits nothing when the deposit is submitted', async () => {
    const f = await setup();
    const request = await submittedDeposit(f);

    expect(request.status).toBe('PENDING');
    expect(await collateralOf(f.captainId)).toBe(OPENING);
  });

  it('does not raise the claim limit while it is pending', async () => {
    const f = await setup();
    await submittedDeposit(f);

    // The whole point of the handshake: an unconfirmed deposit buys no extra
    // capacity to claim work.
    const view = await getCollateral(f.captainId);
    expect(view.availableLimitPaise).toBe(OPENING);
  });

  it('splits the deposit between security and working capital once admin confirms it', async () => {
    const f = await setup();
    const request = await submittedDeposit(f);

    const approved = await approveDeposit(String(request._id), f.adminActor);
    expect(approved.status).toBe('APPROVED');

    // At the default split, half is locked as security and half becomes DMC
    // the captain can trade with immediately.
    const locked = DEPOSIT / 2;
    expect(await collateralOf(f.captainId)).toBe(OPENING + locked);
    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.dmcBalancePaise).toBe(DEPOSIT - locked);

    // Whatever the split, the two halves account for the whole deposit.
    expect((await collateralOf(f.captainId)) - OPENING + (captain?.dmcBalancePaise ?? 0)).toBe(DEPOSIT);

    const view = await getCollateral(f.captainId);
    expect(view.availableLimitPaise).toBe(OPENING + locked);
  });

  it('credits nothing when admin rejects it', async () => {
    const f = await setup();
    const request = await submittedDeposit(f);

    const rejected = await rejectDeposit(String(request._id), 'No matching credit found', f.adminActor);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('No matching credit found');
    expect(await collateralOf(f.captainId)).toBe(OPENING);
  });

  it('credits once when two admins confirm the same deposit at the same moment', async () => {
    const f = await setup();
    const request = await submittedDeposit(f);

    const settled = await Promise.allSettled([
      approveDeposit(String(request._id), f.adminActor),
      approveDeposit(String(request._id), f.adminActor),
      approveDeposit(String(request._id), f.adminActor),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    // Both halves land exactly once — a second approval must not credit
    // either the security or the working capital again.
    expect(await collateralOf(f.captainId)).toBe(OPENING + DEPOSIT / 2);
    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.dmcBalancePaise).toBe(DEPOSIT / 2);
  });

  it('cannot be approved after it was rejected', async () => {
    const f = await setup();
    const request = await submittedDeposit(f);
    await rejectDeposit(String(request._id), 'No matching credit found', f.adminActor);

    await expect(approveDeposit(String(request._id), f.adminActor)).rejects.toThrow();
    expect(await collateralOf(f.captainId)).toBe(OPENING);
  });

  it('cannot be approved twice in sequence either', async () => {
    const f = await setup();
    const request = await submittedDeposit(f);
    await approveDeposit(String(request._id), f.adminActor);

    await expect(approveDeposit(String(request._id), f.adminActor)).rejects.toThrow();
    expect(await collateralOf(f.captainId)).toBe(OPENING + DEPOSIT / 2);
    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.dmcBalancePaise).toBe(DEPOSIT / 2);
  });

  it('never turns a deposit into earnings', async () => {
    const f = await setup();
    const request = await submittedDeposit(f);
    await approveDeposit(String(request._id), f.adminActor);

    const captain = await Captain.findById(f.captainId).lean();
    // A deposit buys security and spendable DMC, and nothing else. The money
    // is all still there, just in the two places it is allowed to be.
    expect((captain?.collateralBalancePaise ?? 0) + (captain?.dmcBalancePaise ?? 0)).toBe(OPENING + DEPOSIT);
  });

  it('refuses a deposit of zero or less', async () => {
    const f = await setup();
    await expect(requestDeposit(f.captainId, 0, f.captainActor)).rejects.toThrow();
    await expect(requestDeposit(f.captainId, -100, f.captainActor)).rejects.toThrow();
    expect(await DmcPurchase.countDocuments({})).toBe(0);
  });

  /**
   * Rewritten when payment moved to USDT, because the old expectation described
   * a flow that no longer exists: the reference used to be supplied when the
   * request was created, which asked the captain for a transaction they had not
   * made yet. It now arrives when they say they have paid.
   */
  it('keeps the captain’s own reference for admin to check against', async () => {
    const f = await setup();
    const request = await requestDeposit(f.captainId, DEPOSIT, f.captainActor);

    // Nothing to check against yet — they have been quoted, not charged.
    expect(request.proofReference ?? null).toBeNull();
    expect(request.markedPaidAt ?? null).toBeNull();

    const paid = await markDepositPaid(
      String(request._id),
      f.captainId,
      { providerReference: 'UTR12345678', notes: 'Bank transfer' },
      f.captainActor,
    );

    expect(paid.proofReference).toBe('UTR12345678');
    expect(paid.proofNotes).toBe('Bank transfer');
    expect(paid.markedPaidAt).toBeTruthy();
    // And still nothing decided: the reference is evidence, not approval.
    expect(paid.status).toBe('PENDING');
  });
});
