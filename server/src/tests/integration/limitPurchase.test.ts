/**
 * BUYING CAPACITY, AND WHAT THAT IS NOT
 *
 * A captain has two ways to get more room to work with, and they are
 * deliberately different things:
 *
 *   - Posting security. Half becomes collateral they cannot spend, half
 *     becomes DMC they can. ₹10,000 posted is ₹5,000 and ₹5,000.
 *   - Buying capacity. The whole approved amount becomes DMC *and* raises the
 *     approved ceiling by the same figure. No collateral is posted, because no
 *     security was sent.
 *
 * The second needs both halves or it does nothing at all. Current Limit is
 * `min(approved ceiling, available DMC − retained commission)`, so raising only
 * the ceiling leaves a captain whose capital binds exactly where they were, and
 * raising only the balance leaves one whose ceiling binds exactly where they
 * were. These tests pin the pair.
 *
 * The cap is the collateral already posted: capacity bought against nothing
 * would be capacity with no security behind it.
 *
 * And nothing — nothing — moves before admin approves. A request is a claim
 * that money was sent, and a claim is not money. Pending moves nothing,
 * rejected moves nothing, and an approval that arrives twice moves things once.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { Captain, CaptainLimitPurchase, PlatformAccount } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import {
  requestLimitPurchase, approveLimitPurchase, rejectLimitPurchase, limitPurchaseAllowance, markLimitPurchasePaid } from '../../services/captainLimitPurchase.service';
import { requestRedemption, payCommissionToCaptain } from '../../services/captainBalance.service';
import { requestDeposit, approveDeposit, markDepositPaid } from '../../services/dmcPurchase.service';
import { currentLimitPaise } from '../../services/captainCapacity.service';
import { rupeesToPaise } from '../../utils/money';

type Actor = { userId: string; role: 'ADMIN' | 'CAPTAIN' };

describeIntegration('a captain buying capacity', () => {
  let captainId: Types.ObjectId;
  let captainActor: Actor;
  let admin: Actor;

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    captainActor = { userId: String(new Types.ObjectId()), role: 'CAPTAIN' };
    admin = { userId: String(new Types.ObjectId()), role: 'ADMIN' };
  });

  async function makeCaptain(opts: {
    collateral: number;
    capital: number;
    fee?: number;
    ceiling?: number | null;
  }): Promise<Types.ObjectId> {
    const unique = new Types.ObjectId().toHexString();
    const captain = await Captain.create({
      userId: new Types.ObjectId(),
      captainCode: `CAP-${unique.slice(-6)}`,
      displayName: 'Buying Captain',
      collateralBalancePaise: rupeesToPaise(opts.collateral),
      dmcBalancePaise: rupeesToPaise(opts.capital),
      ...(opts.ceiling === undefined
        ? {}
        : { creditLimitPaise: opts.ceiling === null ? null : rupeesToPaise(opts.ceiling) }),
      status: 'ACTIVE',
      isOnline: true,
    });
    if (opts.fee) {
      await PlatformAccount.findOneAndUpdate(
        { key: 'GLOBAL' },
        { $inc: { poolBalancePaise: rupeesToPaise(opts.fee), poolFundedTotalPaise: rupeesToPaise(opts.fee) } },
        { upsert: true },
      );
      await payCommissionToCaptain(captain._id, rupeesToPaise(opts.fee));
    }
    return captain._id;
  }

  const read = async (): Promise<{
    dmc: number; collateral: number; ceiling: number | null; fee: number; limit: number;
  }> => {
    const c = await Captain.findById(captainId).lean();
    const r = c as unknown as {
      dmcBalancePaise: number; collateralBalancePaise: number;
      creditLimitPaise: number | null; commissionEarnedTotalPaise: number;
    };
    return {
      dmc: r.dmcBalancePaise,
      collateral: r.collateralBalancePaise,
      ceiling: r.creditLimitPaise,
      fee: r.commissionEarnedTotalPaise,
      limit: currentLimitPaise(c as unknown as Parameters<typeof currentLimitPaise>[0]),
    };
  };

  /**
   * Open a purchase and submit it, which is what these tests mean by "buy".
   *
   * The submission step is not incidental. A request now opens as a draft that
   * no administrator can see or act on, and reporting the transaction is what
   * puts it in front of them — so a helper that stopped at the draft would be
   * setting up a state none of the assertions below are about.
   */
  const buy = async (rupees: number): Promise<string> => {
    const r = await requestLimitPurchase(captainId, rupeesToPaise(rupees), captainActor);
    await markLimitPurchasePaid(
      String(r._id),
      captainId,
      { providerReference: `0xTX-${String(r._id).slice(-8)}` },
      captainActor,
    );
    return String(r._id);
  };

  // =========================================================================
  // The worked example
  // =========================================================================
  describe('the worked example', () => {
    beforeEach(async () => {
      // Collateral 5,000; capital 2,100 with no fee, so Current Limit is 2,100.
      captainId = await makeCaptain({ collateral: 5_000, capital: 2_100, ceiling: null });
    });

    it('starts at Current Limit 2,100', async () => {
      const before = await read();
      expect(before.collateral).toBe(rupeesToPaise(5_000));
      expect(before.limit).toBe(rupeesToPaise(2_100));
    });

    it('reaches 5,100 after a 3,000 purchase is approved', async () => {
      const id = await buy(3_000);
      await approveLimitPurchase(id, admin);
      const after = await read();
      expect(after.limit).toBe(rupeesToPaise(5_100));
    });

    it('leaves the collateral exactly where it was', async () => {
      const id = await buy(3_000);
      await approveLimitPurchase(id, admin);
      expect((await read()).collateral).toBe(rupeesToPaise(5_000));
    });

    it('raises the balance and the ceiling by the same amount', async () => {
      const before = await read();
      const id = await buy(3_000);
      await approveLimitPurchase(id, admin);
      const after = await read();
      expect(after.dmc - before.dmc).toBe(rupeesToPaise(3_000));
      // The ceiling was null (meaning "the collateral"), so it resolves to
      // 5,000 and then rises by the purchase.
      expect(after.ceiling).toBe(rupeesToPaise(8_000));
    });
  });

  // =========================================================================
  // Nothing moves before approval
  // =========================================================================
  describe('before admin decides', () => {
    beforeEach(async () => {
      captainId = await makeCaptain({ collateral: 5_000, capital: 2_100, ceiling: null });
    });

    it('moves nothing when the request is made', async () => {
      const before = await read();
      await buy(3_000);
      expect(await read()).toEqual(before);
    });

    it('moves nothing while it is pending', async () => {
      const before = await read();
      const id = await buy(3_000);
      expect((await CaptainLimitPurchase.findById(id).lean())?.status).toBe('PENDING');
      expect(await read()).toEqual(before);
    });

    it('moves nothing when it is rejected', async () => {
      const before = await read();
      const id = await buy(3_000);
      await rejectLimitPurchase(id, 'no money found', admin);
      expect(await read()).toEqual(before);
    });

    it('credits nothing on a pending row', async () => {
      const id = await buy(3_000);
      expect((await CaptainLimitPurchase.findById(id).lean())?.creditedPaise ?? null).toBeNull();
    });

    it('records what it credited once approved', async () => {
      const id = await buy(3_000);
      await approveLimitPurchase(id, admin);
      expect((await CaptainLimitPurchase.findById(id).lean())?.creditedPaise).toBe(rupeesToPaise(3_000));
    });
  });

  // =========================================================================
  // The cap
  // =========================================================================
  describe('the maximum', () => {
    beforeEach(async () => {
      captainId = await makeCaptain({ collateral: 5_000, capital: 1_000, ceiling: null });
    });

    it('allows exactly the collateral', async () => {
      await expect(buy(5_000)).resolves.toBeTruthy();
    });

    it('refuses a single rupee more', async () => {
      await expect(buy(5_001)).rejects.toThrow(/at most as much capacity as the security/i);
    });

    it('allows less than the collateral', async () => {
      await expect(buy(100)).resolves.toBeTruthy();
    });

    it('refuses zero', async () => {
      await expect(requestLimitPurchase(captainId, 0, captainActor)).rejects.toThrow();
    });

    it('refuses a negative amount', async () => {
      await expect(requestLimitPurchase(captainId, -100, captainActor)).rejects.toThrow();
    });

    it('refuses a fractional paise', async () => {
      await expect(requestLimitPurchase(captainId, 100.5, captainActor)).rejects.toThrow();
    });

    it('reports the same maximum the request is judged against', async () => {
      const allowance = await limitPurchaseAllowance(captainId);
      expect(allowance.maxPurchasePaise).toBe(rupeesToPaise(5_000));
      expect(allowance.collateralPaise).toBe(rupeesToPaise(5_000));
      expect(allowance.hasPending).toBe(false);
    });

    it('says when one is already pending', async () => {
      await buy(1_000);
      expect((await limitPurchaseAllowance(captainId)).hasPending).toBe(true);
    });

    it('allows only one open request at a time', async () => {
      await buy(1_000);
      await expect(buy(1_000)).rejects.toThrow(/already have a capacity purchase/i);
    });

    it('accepts a new one once the previous is decided', async () => {
      const first = await buy(1_000);
      await rejectLimitPurchase(first, 'not found', admin);
      await expect(buy(1_000)).resolves.toBeTruthy();
    });

    it('refuses a suspended captain', async () => {
      await Captain.updateOne({ _id: captainId }, { $set: { status: 'SUSPENDED' } });
      await expect(buy(1_000)).rejects.toThrow(/suspended/i);
    });

    it('records the cap the request was judged against', async () => {
      const id = await buy(1_000);
      expect((await CaptainLimitPurchase.findById(id).lean())?.collateralAtRequestPaise)
        .toBe(rupeesToPaise(5_000));
    });
  });

  // =========================================================================
  // Approval is applied once
  // =========================================================================
  describe('approval happens once', () => {
    beforeEach(async () => {
      captainId = await makeCaptain({ collateral: 5_000, capital: 2_000, ceiling: null });
    });

    it('refuses a second approval', async () => {
      const id = await buy(1_000);
      await approveLimitPurchase(id, admin);
      const after = await read();
      await expect(approveLimitPurchase(id, admin)).rejects.toThrow(/no longer pending/i);
      expect(await read()).toEqual(after);
    });

    it('credits once when two approvals race', async () => {
      const id = await buy(1_000);
      const settled = await Promise.allSettled([
        approveLimitPurchase(id, admin),
        approveLimitPurchase(id, admin),
      ]);
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      expect((await read()).dmc).toBe(rupeesToPaise(3_000));
    });

    it('credits once when five approvals race', async () => {
      const id = await buy(1_000);
      const settled = await Promise.allSettled(
        Array.from({ length: 5 }, () => approveLimitPurchase(id, admin)),
      );
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      expect((await read()).dmc).toBe(rupeesToPaise(3_000));
    });

    it('lets exactly one of a racing approve and reject take effect', async () => {
      const id = await buy(1_000);
      const settled = await Promise.allSettled([
        approveLimitPurchase(id, admin),
        rejectLimitPurchase(id, 'no money found', admin),
      ]);
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      const after = await read();
      expect([rupeesToPaise(2_000), rupeesToPaise(3_000)]).toContain(after.dmc);
    });

    it('cannot be approved after it was rejected', async () => {
      const id = await buy(1_000);
      await rejectLimitPurchase(id, 'no money found', admin);
      const after = await read();
      await expect(approveLimitPurchase(id, admin)).rejects.toThrow();
      expect(await read()).toEqual(after);
    });

    it('cannot be rejected after it was approved', async () => {
      const id = await buy(1_000);
      await approveLimitPurchase(id, admin);
      const after = await read();
      await expect(rejectLimitPurchase(id, 'second thoughts', admin)).rejects.toThrow();
      expect(await read()).toEqual(after);
    });

    it('insists on a reason to reject', async () => {
      const id = await buy(1_000);
      await expect(rejectLimitPurchase(id, '   ', admin)).rejects.toThrow(/reason is required/i);
    });
  });

  // =========================================================================
  // How it differs from posting security
  // =========================================================================
  describe('against a security deposit', () => {
    it('splits a deposit in half, and does not split a purchase at all', async () => {
      captainId = await makeCaptain({ collateral: 0, capital: 0, ceiling: null });

      // Post 10,000 of security: half and half.
      const deposit = await requestDeposit(
        captainId, rupeesToPaise(10_000), captainActor,
      );
      await markDepositPaid(
        String(deposit._id),
        captainId,
        { providerReference: `0xDEP-${String(deposit._id).slice(-8)}` },
        captainActor,
      );
      await approveDeposit(String(deposit._id), admin);
      const posted = await read();
      expect(posted.collateral).toBe(rupeesToPaise(5_000));
      expect(posted.dmc).toBe(rupeesToPaise(5_000));
      expect(posted.limit).toBe(rupeesToPaise(5_000));

      // Now buy 2,000 of capacity: all of it, and no collateral.
      const id = await buy(2_000);
      await approveLimitPurchase(id, admin);
      const bought = await read();
      expect(bought.collateral).toBe(rupeesToPaise(5_000));
      expect(bought.dmc).toBe(rupeesToPaise(7_000));
      expect(bought.limit).toBe(rupeesToPaise(7_000));
    });

    it('lets a later security deposit raise the cap for a further purchase', async () => {
      captainId = await makeCaptain({ collateral: 1_000, capital: 1_000, ceiling: null });
      await expect(buy(2_000)).rejects.toThrow();

      const deposit = await requestDeposit(
        captainId, rupeesToPaise(4_000), captainActor,
      );
      await markDepositPaid(
        String(deposit._id),
        captainId,
        { providerReference: `0xDEP-${String(deposit._id).slice(-8)}` },
        captainActor,
      );
      await approveDeposit(String(deposit._id), admin);
      // Collateral is now 3,000, so 2,000 fits.
      expect((await read()).collateral).toBe(rupeesToPaise(3_000));
      await expect(buy(2_000)).resolves.toBeTruthy();
    });
  });

  // =========================================================================
  // Interaction with the rest of the model
  // =========================================================================
  describe('alongside everything else', () => {
    it('does not make retained commission into capacity', async () => {
      // 8,000 of capital plus 150 of retained fee, then buy 1,000.
      captainId = await makeCaptain({ collateral: 20_000, capital: 8_000, fee: 150, ceiling: null });
      const id = await buy(1_000);
      await approveLimitPurchase(id, admin);
      const after = await read();
      expect(after.dmc).toBe(rupeesToPaise(9_150));
      expect(after.fee).toBe(rupeesToPaise(150));
      // The fee is still retained, so it is still not capacity.
      expect(after.limit).toBe(rupeesToPaise(9_000));
    });

    it('leaves the withdrawal fix working afterwards', async () => {
      captainId = await makeCaptain({ collateral: 20_000, capital: 2_100, fee: 361, ceiling: null });
      const id = await buy(1_000);
      await approveLimitPurchase(id, admin);
      // Balance 3,461, fee 361 still retained.
      expect((await read()).limit).toBe(rupeesToPaise(3_100));

      await requestRedemption(captainId, rupeesToPaise(1_000), { method: 'UPI', upiId: 'c@upi' }, captainActor);
      const after = await read();
      // The withdrawal spent the fee first, so nothing is subtracted twice.
      expect(after.dmc).toBe(rupeesToPaise(2_461));
      expect(after.fee).toBe(0);
      expect(after.limit).toBe(rupeesToPaise(2_461));
    });

    it('survives a purchase approval racing a withdrawal', async () => {
      captainId = await makeCaptain({ collateral: 20_000, capital: 5_000, fee: 200, ceiling: null });
      const id = await buy(2_000);
      await Promise.allSettled([
        approveLimitPurchase(id, admin),
        requestRedemption(captainId, rupeesToPaise(1_000), { method: 'UPI', upiId: 'c@upi' }, captainActor),
      ]);
      const after = await read();
      expect(after.dmc).toBeGreaterThanOrEqual(0);
      expect(after.fee).toBeGreaterThanOrEqual(0);
      expect(after.limit).toBeLessThanOrEqual(after.dmc);
      expect(after.collateral).toBe(rupeesToPaise(20_000));
    });

    it('survives a purchase approval racing a commission credit', async () => {
      captainId = await makeCaptain({ collateral: 20_000, capital: 5_000, ceiling: null });
      await PlatformAccount.findOneAndUpdate(
        { key: 'GLOBAL' },
        { $inc: { poolBalancePaise: rupeesToPaise(300), poolFundedTotalPaise: rupeesToPaise(300) } },
        { upsert: true },
      );
      const id = await buy(2_000);
      await Promise.allSettled([
        approveLimitPurchase(id, admin),
        payCommissionToCaptain(captainId, rupeesToPaise(300)),
      ]);
      const after = await read();
      // Both landed or one did; neither may be lost or applied twice.
      expect(after.dmc).toBe(rupeesToPaise(7_300));
      expect(after.fee).toBe(rupeesToPaise(300));
    });

    it('survives a purchase approval racing a security approval', async () => {
      captainId = await makeCaptain({ collateral: 4_000, capital: 1_000, ceiling: null });
      const purchase = await buy(2_000);
      const deposit = await requestDeposit(
        captainId, rupeesToPaise(4_000), captainActor,
      );
      await markDepositPaid(
        String(deposit._id),
        captainId,
        { providerReference: `0xRACE-${String(deposit._id).slice(-8)}` },
        captainActor,
      );
      await Promise.allSettled([
        approveLimitPurchase(purchase, admin),
        approveDeposit(String(deposit._id), admin),
      ]);
      const after = await read();
      // Purchase: +2,000 DMC. Deposit: +2,000 collateral and +2,000 DMC.
      expect(after.dmc).toBe(rupeesToPaise(5_000));
      expect(after.collateral).toBe(rupeesToPaise(6_000));
      expect(after.limit).toBeLessThanOrEqual(after.dmc);
    });

    it('keeps the approved ceiling binding when it is the smaller figure', async () => {
      // Ceiling set well below the balance; buying lifts both, so the ceiling
      // stays the binding term but moves with the purchase.
      captainId = await makeCaptain({ collateral: 20_000, capital: 10_000, ceiling: 3_000 });
      expect((await read()).limit).toBe(rupeesToPaise(3_000));
      const id = await buy(2_000);
      await approveLimitPurchase(id, admin);
      const after = await read();
      expect(after.ceiling).toBe(rupeesToPaise(5_000));
      expect(after.limit).toBe(rupeesToPaise(5_000));
    });

    it('never lets Current Limit exceed Available DMC', async () => {
      captainId = await makeCaptain({ collateral: 20_000, capital: 500, fee: 100, ceiling: null });
      const id = await buy(2_000);
      await approveLimitPurchase(id, admin);
      const after = await read();
      expect(after.limit).toBeLessThanOrEqual(after.dmc);
    });
  });

  // =========================================================================
  // Two requests at once
  // =========================================================================
  describe('two requests at once', () => {
    it('lets only one open request exist', async () => {
      captainId = await makeCaptain({ collateral: 5_000, capital: 1_000, ceiling: null });
      const settled = await Promise.allSettled([buy(1_000), buy(1_000)]);
      const won = settled.filter((s) => s.status === 'fulfilled').length;
      expect(won).toBeGreaterThanOrEqual(1);
      expect(await CaptainLimitPurchase.countDocuments({ captainId, status: 'PENDING' }))
        .toBeLessThanOrEqual(2);
      // Whatever raced, nothing was credited.
      expect((await read()).dmc).toBe(rupeesToPaise(1_000));
    });
  });
});
