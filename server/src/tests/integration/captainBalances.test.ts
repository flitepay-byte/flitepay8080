/**
 * The captain's three balances, and the only ways money moves between them.
 *
 * These are the paths where the new model can lose or invent DMC, so each test
 * checks a conservation statement rather than a single number: after the move,
 * how much exists in total, and is it the amount that should exist. A test that
 * only asserted "the wallet went down by 500" would pass just as happily if the
 * 500 went nowhere.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Captain, DmcRedemption, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { requestDeposit, approveDeposit } from '../../services/dmcPurchase.service';
import { fundPlatformPool, getPlatformAccount } from '../../services/platformAccount.service';
import {
  payCommissionToCaptain,
  requestRedemption,
  markRedemptionPaid,
  rejectRedemption,
  listPendingRedemptions,
  listRedemptionsForCaptain,
} from '../../services/captainBalance.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('a captain’s balances', () => {
  let adminActor: { userId: string; role: 'ADMIN' };

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    const admin = await User.create({
      email: `admin-${new Types.ObjectId().toHexString()}@balances.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Admin',
      role: 'ADMIN',
    });
    adminActor = { userId: String(admin._id), role: 'ADMIN' };
  });

  interface CaptainRef {
    id: Types.ObjectId;
    actor: { userId: string; role: 'CAPTAIN' };
  }

  async function makeCaptain(): Promise<CaptainRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@balances.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Balance Captain',
      isOnline: true,
      status: 'ACTIVE',
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  /** The deposit path is the only way to get working capital in, so use it. */
  async function fundCapital(captain: CaptainRef, rupees: number): Promise<void> {
    const req = await requestDeposit(
      captain.id,
      rupeesToPaise(rupees),
      captain.actor,
    );
    await approveDeposit(String(req._id), adminActor);
  }

  async function balances(id: Types.ObjectId): Promise<{
    collateral: number;
    dmc: number;
  }> {
    const c = await Captain.findById(id).lean();
    return {
      collateral: c?.collateralBalancePaise ?? -1,
      dmc: c?.dmcBalancePaise ?? -1,
    };
  }

  /**
   * Everything that exists anywhere: the captain's three balances, the pool,
   * and whatever is held against an unsettled redemption. Collateral is in the
   * total because it was posted with real money — the sum only stays constant
   * if nothing is created or destroyed by the move under test.
   */
  async function totalInSystem(captainId: Types.ObjectId): Promise<number> {
    const b = await balances(captainId);
    const pool = (await getPlatformAccount()).poolBalancePaise;
    const held = (await DmcRedemption.find({ status: 'PENDING' }).lean())
      .reduce((sum, r) => sum + r.amountPaise, 0);
    return b.collateral + b.dmc + pool + held;
  }

  // =========================================================================
  // Commission: pool to the captain's balance
  // =========================================================================

  it('pays commission out of the funded pool, creating nothing', async () => {
    const captain = await makeCaptain();
    await fundPlatformPool(rupeesToPaise(10_000));
    const before = await totalInSystem(captain.id);

    const paid = await payCommissionToCaptain(captain.id, rupeesToPaise(250));
    expect(paid).toBe(true);

    const after = await balances(captain.id);
    // Straight into spendable DMC — there is no separate wallet any more.
    expect(paiseToRupees(after.dmc)).toBe(250);
    expect(paiseToRupees((await getPlatformAccount()).poolBalancePaise)).toBe(9_750);
    // The commission moved. It did not appear.
    expect(await totalInSystem(captain.id)).toBe(before);
  });

  it('pays nothing at all when the pool is short', async () => {
    const captain = await makeCaptain();
    await fundPlatformPool(rupeesToPaise(100));

    const paid = await payCommissionToCaptain(captain.id, rupeesToPaise(101));
    expect(paid).toBe(false);

    // Neither half of the transfer happened — a captain credited from an empty
    // pool is exactly the invention of DMC the pool exists to prevent.
    expect((await balances(captain.id)).dmc).toBe(0);
    expect(paiseToRupees((await getPlatformAccount()).poolBalancePaise)).toBe(100);
  });

  it('cannot be raced into overdrawing the pool', async () => {
    const captain = await makeCaptain();
    await fundPlatformPool(rupeesToPaise(1_000));

    // Ten claims of ₹200 against ₹1,000: five can be paid, five cannot.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => payCommissionToCaptain(captain.id, rupeesToPaise(200))),
    );
    expect(results.filter(Boolean)).toHaveLength(5);

    const pool = (await getPlatformAccount()).poolBalancePaise;
    expect(pool).toBe(0);
    expect(pool).toBeGreaterThanOrEqual(0);
    expect(paiseToRupees((await balances(captain.id)).dmc)).toBe(1_000);
  });

  // =========================================================================
  // Redemption: working capital to rupees
  // =========================================================================

  const upi = { method: 'UPI' as const, upiId: 'captain@upi' };

  it('takes the DMC out of reach the moment it is requested', async () => {
    const captain = await makeCaptain();
    await fundCapital(captain, 20_000);

    const request = await requestRedemption(captain.id, rupeesToPaise(4_000), upi, captain.actor);
    expect(request.status).toBe('PENDING');

    const after = await balances(captain.id);
    // Not spendable, but not gone: it is held against the request.
    expect(paiseToRupees(after.dmc)).toBe(6_000);
  });

  it('refuses to redeem more than the captain has', async () => {
    const captain = await makeCaptain();
    await fundCapital(captain, 20_000);

    await expect(requestRedemption(captain.id, rupeesToPaise(10_001), upi, captain.actor)).rejects.toThrow();
    expect(paiseToRupees((await balances(captain.id)).dmc)).toBe(10_000);
    expect(await DmcRedemption.countDocuments({})).toBe(0);
  });

  it('cannot be raced into holding the same DMC twice', async () => {
    const captain = await makeCaptain();
    await fundCapital(captain, 20_000);

    const settled = await Promise.allSettled([
      requestRedemption(captain.id, rupeesToPaise(10_000), upi, captain.actor),
      requestRedemption(captain.id, rupeesToPaise(10_000), upi, captain.actor),
      requestRedemption(captain.id, rupeesToPaise(10_000), upi, captain.actor),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);

    expect((await balances(captain.id)).dmc).toBe(0);
    expect(await DmcRedemption.countDocuments({})).toBe(1);
  });

  it('destroys the DMC once admin has actually paid', async () => {
    const captain = await makeCaptain();
    await fundCapital(captain, 20_000);
    const request = await requestRedemption(captain.id, rupeesToPaise(4_000), upi, captain.actor);
    const beforePayment = await totalInSystem(captain.id);

    const paid = await markRedemptionPaid(String(request._id), { reference: 'NEFT-88213', notes: 'Sent' }, adminActor);
    expect(paid.status).toBe('PAID');
    expect(paid.paymentReference).toBe('NEFT-88213');

    // The rupees left, so the DMC standing for them had to leave too. This is
    // the one place in the whole system where DMC is destroyed.
    expect(await totalInSystem(captain.id)).toBe(beforePayment - rupeesToPaise(4_000));
    expect(paiseToRupees((await balances(captain.id)).dmc)).toBe(6_000);
  });

  it('gives every paise back when admin rejects it', async () => {
    const captain = await makeCaptain();
    await fundCapital(captain, 20_000);
    const before = await totalInSystem(captain.id);
    const request = await requestRedemption(captain.id, rupeesToPaise(4_000), upi, captain.actor);

    const rejected = await rejectRedemption(String(request._id), 'Bank details do not match the captain', adminActor);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('Bank details do not match the captain');

    expect(paiseToRupees((await balances(captain.id)).dmc)).toBe(10_000);
    // No money was sent, so nothing may have been destroyed.
    expect(await totalInSystem(captain.id)).toBe(before);
  });

  it('pays once when two admins press pay at the same moment', async () => {
    const captain = await makeCaptain();
    await fundCapital(captain, 20_000);
    const request = await requestRedemption(captain.id, rupeesToPaise(4_000), upi, captain.actor);

    const settled = await Promise.allSettled([
      markRedemptionPaid(String(request._id), { reference: 'A-1' }, adminActor),
      markRedemptionPaid(String(request._id), { reference: 'A-2' }, adminActor),
      markRedemptionPaid(String(request._id), { reference: 'A-3' }, adminActor),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(paiseToRupees((await balances(captain.id)).dmc)).toBe(6_000);
  });

  it('cannot be paid and rejected at the same time', async () => {
    const captain = await makeCaptain();
    await fundCapital(captain, 20_000);
    const request = await requestRedemption(captain.id, rupeesToPaise(4_000), upi, captain.actor);

    const settled = await Promise.allSettled([
      markRedemptionPaid(String(request._id), { reference: 'A-1' }, adminActor),
      rejectRedemption(String(request._id), 'Changed my mind', adminActor),
      markRedemptionPaid(String(request._id), { reference: 'A-2' }, adminActor),
      rejectRedemption(String(request._id), 'Changed my mind again', adminActor),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);

    const decided = await DmcRedemption.findById(request._id).lean();
    const after = await balances(captain.id);
    // Whichever won, the balance has to agree with it: refunded if rejected,
    // still held-and-burned if paid. It can never be both.
    expect(paiseToRupees(after.dmc)).toBe(decided?.status === 'REJECTED' ? 10_000 : 6_000);
  });

  it('cannot be decided twice in sequence either', async () => {
    const captain = await makeCaptain();
    await fundCapital(captain, 20_000);
    const request = await requestRedemption(captain.id, rupeesToPaise(4_000), upi, captain.actor);

    await rejectRedemption(String(request._id), 'Details missing', adminActor);
    await expect(markRedemptionPaid(String(request._id), { reference: 'X-1' }, adminActor)).rejects.toThrow();
    // A refund that happened once must not happen again.
    expect(paiseToRupees((await balances(captain.id)).dmc)).toBe(10_000);
  });

  it('needs a payment reference before it can be marked paid', async () => {
    const captain = await makeCaptain();
    await fundCapital(captain, 20_000);
    const request = await requestRedemption(captain.id, rupeesToPaise(4_000), upi, captain.actor);

    await expect(markRedemptionPaid(String(request._id), { reference: '   ' }, adminActor)).rejects.toThrow();
    expect((await DmcRedemption.findById(request._id).lean())?.status).toBe('PENDING');
  });

  it('needs somewhere to send the money', async () => {
    const captain = await makeCaptain();
    await fundCapital(captain, 20_000);

    await expect(
      requestRedemption(captain.id, rupeesToPaise(1_000), { method: 'UPI' }, captain.actor),
    ).rejects.toThrow();
    await expect(
      requestRedemption(captain.id, rupeesToPaise(1_000), { method: 'BANK', accountName: 'A' }, captain.actor),
    ).rejects.toThrow();

    // A rejected request must not have held anything.
    expect(paiseToRupees((await balances(captain.id)).dmc)).toBe(10_000);
  });

  it('takes full bank details when that is how the captain wants paying', async () => {
    const captain = await makeCaptain();
    await fundCapital(captain, 20_000);

    const request = await requestRedemption(
      captain.id,
      rupeesToPaise(1_000),
      { method: 'BANK', accountName: 'Captain Singh', accountNumber: '000123456789', ifsc: 'hdfc0000123' },
      captain.actor,
    );
    expect(request.payoutMethod).toBe('BANK');
    expect(request.payoutAccountName).toBe('Captain Singh');
    expect(request.payoutIfsc).toBe('HDFC0000123');
  });

  it('shows admin what is waiting, oldest first', async () => {
    const first = await makeCaptain();
    const second = await makeCaptain();
    await fundCapital(first, 20_000);
    await fundCapital(second, 20_000);

    const a = await requestRedemption(first.id, rupeesToPaise(1_000), upi, first.actor);
    const b = await requestRedemption(second.id, rupeesToPaise(2_000), upi, second.actor);
    await rejectRedemption(String(a._id), 'Not this time', adminActor);

    const pending = await listPendingRedemptions();
    expect(pending).toHaveLength(1);
    expect(String(pending[0]?._id)).toBe(String(b._id));

    // And the captain still sees their own decided request in their history.
    const mine = await listRedemptionsForCaptain(first.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.status).toBe('REJECTED');
  });

  // =========================================================================
  // The whole round trip
  // =========================================================================

  it('conserves every paise from deposit through commission to cash-out', async () => {
    const captain = await makeCaptain();

    // ₹20,000 of real money in: ₹10,000 security, ₹10,000 capital.
    await fundCapital(captain, 20_000);
    // ₹5,000 of the platform's real money funds the commission pool.
    await fundPlatformPool(rupeesToPaise(5_000));
    const mintedByRealMoney = rupeesToPaise(20_000 + 5_000);
    expect(await totalInSystem(captain.id)).toBe(mintedByRealMoney);

    // Commission earned. It lands straight in spendable DMC — a transfer out
    // of the pool, so nothing is created.
    await payCommissionToCaptain(captain.id, rupeesToPaise(1_200));
    expect(await totalInSystem(captain.id)).toBe(mintedByRealMoney);

    // One cash-out paid, one rejected.
    const paidOut = await requestRedemption(captain.id, rupeesToPaise(3_000), upi, captain.actor);
    const refused = await requestRedemption(captain.id, rupeesToPaise(2_000), upi, captain.actor);
    await markRedemptionPaid(String(paidOut._id), { reference: 'NEFT-1' }, adminActor);
    await rejectRedemption(String(refused._id), 'Asked to cancel', adminActor);

    // Exactly the paid one is gone, and nothing else moved.
    expect(await totalInSystem(captain.id)).toBe(mintedByRealMoney - rupeesToPaise(3_000));
    const final = await balances(captain.id);
    expect(paiseToRupees(final.collateral)).toBe(10_000);
    expect(paiseToRupees(final.dmc)).toBe(8_200); // 10,000 + 1,200 − 3,000
  });
});
