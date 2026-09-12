/**
 * A WITHDRAWAL SPENDS THE CAPTAIN'S OWN EARNINGS FIRST
 *
 * Current Limit subtracts the commission a captain has earned, because profit
 * sitting in the balance is not capacity: hold 8,150 of which 150 is fee and
 * you may take on 8,000, not 8,150. That rule is right and these tests keep it.
 *
 * What was wrong is what happened when the captain took the fee home.
 * `commissionEarnedTotalPaise` was only ever incremented — by the commission
 * credit, and by nothing else. A withdrawal reduced the balance and left the
 * counter alone, so the same fee went on being subtracted from capacity after
 * it had already left:
 *
 *     Available DMC 2,461 · retained fee 361 · Current Limit 2,100
 *     withdraw 1,000
 *     Available DMC 1,461 · retained fee 361 · Current Limit 1,100   <- wrong
 *                                              should be   1,461
 *
 * The captain was charged for the same 361 twice: once while it sat in their
 * balance, and again after they had spent it. A withdrawal now consumes the
 * counter it is drawing from, capped at what is retained, so the second charge
 * cannot happen.
 *
 * Two invariants hold throughout, and every case below checks at least one:
 *
 *   - Current Limit never exceeds Available DMC.
 *   - Where the approved ceiling is not binding, Current Limit equals
 *     Available DMC once the retained fee has been spent.
 *
 * A refused withdrawal gives the fee back with the money, because otherwise
 * the opposite error appears: the captain keeps capacity for profit they never
 * actually withdrew.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { Captain, DmcRedemption, PlatformAccount } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import {
  requestRedemption, rejectRedemption, markRedemptionPaid, payCommissionToCaptain,
} from '../../services/captainBalance.service';
import { currentLimitPaise } from '../../services/captainCapacity.service';
import { rupeesToPaise } from '../../utils/money';

type Actor = { userId: string; role: 'ADMIN' | 'CAPTAIN' };

const UPI = { method: 'UPI' as const, upiId: 'cap@upi' };

describeIntegration('a withdrawal spends retained commission before capital', () => {
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

  /**
   * A captain with a stated balance, retained fee and ceiling.
   *
   * The fee is credited through the real path rather than written directly, so
   * the counter is set the way production sets it — and the pool is funded
   * first, because a credit the pool cannot cover pays nothing at all.
   */
  async function makeCaptain(opts: {
    capital: number;
    fee?: number;
    ceiling?: number | null;
    collateral?: number;
  }): Promise<Types.ObjectId> {
    const unique = new Types.ObjectId().toHexString();
    const captain = await Captain.create({
      userId: new Types.ObjectId(),
      captainCode: `CAP-${unique.slice(-6)}`,
      displayName: 'Withdrawing Captain',
      collateralBalancePaise: rupeesToPaise(opts.collateral ?? 1_000_000),
      dmcBalancePaise: rupeesToPaise(opts.capital),
      ...(opts.ceiling === undefined ? {} : { creditLimitPaise: opts.ceiling === null ? null : rupeesToPaise(opts.ceiling) }),
      status: 'ACTIVE',
      isOnline: true,
    });

    if (opts.fee) {
      await PlatformAccount.findOneAndUpdate(
        { key: 'GLOBAL' },
        { $inc: { poolBalancePaise: rupeesToPaise(opts.fee), poolFundedTotalPaise: rupeesToPaise(opts.fee) } },
        { upsert: true, new: true },
      );
      const paid = await payCommissionToCaptain(captain._id, rupeesToPaise(opts.fee));
      expect(paid).toBe(true);
    }
    return captain._id;
  }

  const read = async (): Promise<{ dmc: number; fee: number; limit: number }> => {
    const c = await Captain.findById(captainId).lean();
    const doc = c as unknown as Parameters<typeof currentLimitPaise>[0];
    return {
      dmc: (c as unknown as { dmcBalancePaise: number }).dmcBalancePaise,
      fee: (c as unknown as { commissionEarnedTotalPaise: number }).commissionEarnedTotalPaise,
      limit: currentLimitPaise(doc),
    };
  };

  const withdraw = async (rupees: number): Promise<string> => {
    const r = await requestRedemption(captainId, rupeesToPaise(rupees), UPI, captainActor);
    return String(r._id);
  };

  // =========================================================================
  // The reported case, exactly
  // =========================================================================
  describe('the reported case', () => {
    beforeEach(async () => {
      // Capital 2,100 plus a 361 fee gives a balance of 2,461.
      captainId = await makeCaptain({ capital: 2_100, fee: 361, ceiling: 10_000 });
    });

    it('starts where the report says it does', async () => {
      const before = await read();
      expect(before.dmc).toBe(rupeesToPaise(2_461));
      expect(before.fee).toBe(rupeesToPaise(361));
      expect(before.limit).toBe(rupeesToPaise(2_100));
    });

    it('leaves Current Limit equal to Available DMC after withdrawing 1,000', async () => {
      await withdraw(1_000);
      const after = await read();
      expect(after.dmc).toBe(rupeesToPaise(1_461));
      expect(after.fee).toBe(0);
      expect(after.limit).toBe(rupeesToPaise(1_461));
    });

    it('does not subtract the same fee a second time', async () => {
      const before = await read();
      await withdraw(1_000);
      const after = await read();
      // Capacity falls by the withdrawal and by nothing more.
      expect(before.limit - after.limit).toBeLessThanOrEqual(rupeesToPaise(1_000));
    });
  });

  // =========================================================================
  // How much of the fee a withdrawal eats
  // =========================================================================
  describe('consuming the retained fee', () => {
    it('takes only part of it when the withdrawal is smaller', async () => {
      captainId = await makeCaptain({ capital: 5_000, fee: 1_000, ceiling: 100_000 });
      await withdraw(400);
      const after = await read();
      expect(after.fee).toBe(rupeesToPaise(600));
      expect(after.dmc).toBe(rupeesToPaise(5_600));
      expect(after.limit).toBe(rupeesToPaise(5_000));
    });

    it('takes all of it when the withdrawal matches it exactly', async () => {
      captainId = await makeCaptain({ capital: 5_000, fee: 1_000, ceiling: 100_000 });
      await withdraw(1_000);
      const after = await read();
      expect(after.fee).toBe(0);
      expect(after.limit).toBe(after.dmc);
      expect(after.limit).toBe(rupeesToPaise(5_000));
    });

    it('never takes more fee than was retained', async () => {
      captainId = await makeCaptain({ capital: 5_000, fee: 1_000, ceiling: 100_000 });
      await withdraw(3_000);
      const after = await read();
      expect(after.fee).toBe(0);
      expect(after.dmc).toBe(rupeesToPaise(3_000));
      expect(after.limit).toBe(rupeesToPaise(3_000));
    });

    it('leaves the counter alone for a captain who has earned nothing', async () => {
      captainId = await makeCaptain({ capital: 5_000, ceiling: 100_000 });
      await withdraw(1_000);
      const after = await read();
      expect(after.fee).toBe(0);
      expect(after.limit).toBe(rupeesToPaise(4_000));
    });

    it('spends it down across several withdrawals', async () => {
      captainId = await makeCaptain({ capital: 5_000, fee: 900, ceiling: 100_000 });
      await withdraw(300);
      expect((await read()).fee).toBe(rupeesToPaise(600));
      await withdraw(300);
      expect((await read()).fee).toBe(rupeesToPaise(300));
      await withdraw(300);
      expect((await read()).fee).toBe(0);
      const after = await read();
      expect(after.dmc).toBe(rupeesToPaise(5_000));
      expect(after.limit).toBe(rupeesToPaise(5_000));
    });

    it('starts subtracting again when new commission is earned afterwards', async () => {
      captainId = await makeCaptain({ capital: 5_000, fee: 400, ceiling: 100_000 });
      await withdraw(400);
      expect((await read()).fee).toBe(0);

      await PlatformAccount.findOneAndUpdate(
        { key: 'GLOBAL' },
        { $inc: { poolBalancePaise: rupeesToPaise(250), poolFundedTotalPaise: rupeesToPaise(250) } },
        { upsert: true },
      );
      await payCommissionToCaptain(captainId, rupeesToPaise(250));

      const after = await read();
      expect(after.fee).toBe(rupeesToPaise(250));
      // The new fee is retained, so it is not capacity.
      expect(after.limit).toBe(after.dmc - rupeesToPaise(250));
    });
  });

  // =========================================================================
  // The regression this must not break
  // =========================================================================
  describe('retained commission is still not capacity', () => {
    it('refuses 8,100 against 8,150 of which 150 is retained fee', async () => {
      captainId = await makeCaptain({ capital: 8_000, fee: 150, ceiling: 100_000 });
      const now = await read();
      expect(now.dmc).toBe(rupeesToPaise(8_150));
      expect(now.limit).toBe(rupeesToPaise(8_000));
      expect(rupeesToPaise(8_100) > now.limit).toBe(true);
    });

    it('still refuses it after an unrelated small withdrawal', async () => {
      captainId = await makeCaptain({ capital: 8_000, fee: 150, ceiling: 100_000 });
      await withdraw(50);
      const now = await read();
      // 50 of the fee went; 100 is still retained and still not capacity.
      expect(now.fee).toBe(rupeesToPaise(100));
      expect(now.limit).toBe(now.dmc - rupeesToPaise(100));
      expect(rupeesToPaise(8_100) > now.limit).toBe(true);
    });
  });

  // =========================================================================
  // The approved ceiling still binds when it is the smaller of the two
  // =========================================================================
  describe('the approved ceiling', () => {
    it('binds when it is below the balance, and a withdrawal does not lift it', async () => {
      captainId = await makeCaptain({ capital: 10_000, ceiling: 6_000 });
      expect((await read()).limit).toBe(rupeesToPaise(6_000));
      await withdraw(1_000);
      expect((await read()).limit).toBe(rupeesToPaise(6_000));
    });

    it('stops binding once the balance falls below it', async () => {
      captainId = await makeCaptain({ capital: 10_000, ceiling: 8_000 });
      await withdraw(3_000);
      const after = await read();
      expect(after.dmc).toBe(rupeesToPaise(7_000));
      expect(after.limit).toBe(rupeesToPaise(7_000));
    });

    it('falls back to the posted collateral when admin has approved nothing', async () => {
      captainId = await makeCaptain({ capital: 10_000, ceiling: null, collateral: 4_000 });
      expect((await read()).limit).toBe(rupeesToPaise(4_000));
    });
  });

  // =========================================================================
  // Current Limit never exceeds Available DMC
  // =========================================================================
  describe('the invariant', () => {
    it.each([
      ['fee smaller than the withdrawal', 5_000, 400, 1_000],
      ['fee larger than the withdrawal', 5_000, 2_000, 500],
      ['fee equal to the withdrawal', 5_000, 750, 750],
      ['no fee at all', 5_000, 0, 2_500],
      ['withdrawing the whole balance', 1_000, 200, 1_200],
    ])('holds when %s', async (_label, capital, fee, take) => {
      captainId = await makeCaptain({ capital, fee, ceiling: 1_000_000 });
      await withdraw(take);
      const after = await read();
      expect(after.limit).toBeLessThanOrEqual(after.dmc);
      expect(after.limit).toBeGreaterThanOrEqual(0);
      expect(after.fee).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // A refused withdrawal puts the fee back
  // =========================================================================
  describe('when the withdrawal is refused', () => {
    it('restores both the money and the retained fee', async () => {
      captainId = await makeCaptain({ capital: 2_100, fee: 361, ceiling: 10_000 });
      const before = await read();
      const id = await withdraw(1_000);
      await rejectRedemption(id, 'wrong account details', admin);

      const after = await read();
      expect(after).toEqual(before);
    });

    it('records what it consumed on the request', async () => {
      captainId = await makeCaptain({ capital: 5_000, fee: 400, ceiling: 100_000 });
      const id = await withdraw(1_000);
      const row = await DmcRedemption.findById(id).lean();
      expect((row as unknown as { commissionConsumedPaise: number }).commissionConsumedPaise)
        .toBe(rupeesToPaise(400));
    });

    it('records zero when there was no fee to consume', async () => {
      captainId = await makeCaptain({ capital: 5_000, ceiling: 100_000 });
      const id = await withdraw(1_000);
      const row = await DmcRedemption.findById(id).lean();
      expect((row as unknown as { commissionConsumedPaise: number }).commissionConsumedPaise).toBe(0);
    });

    it('keeps the fee spent once the withdrawal is actually paid', async () => {
      captainId = await makeCaptain({ capital: 2_100, fee: 361, ceiling: 10_000 });
      const id = await withdraw(1_000);
      await markRedemptionPaid(id, { reference: 'NEFT-1' }, admin);
      const after = await read();
      // Paid means gone: the money left and so did the fee it was drawn from.
      expect(after.dmc).toBe(rupeesToPaise(1_461));
      expect(after.fee).toBe(0);
      expect(after.limit).toBe(rupeesToPaise(1_461));
    });
  });

  // =========================================================================
  // Races
  // =========================================================================
  describe('under contention', () => {
    it('never drives the balance or the counter negative on concurrent withdrawals', async () => {
      captainId = await makeCaptain({ capital: 2_000, fee: 500, ceiling: 100_000 });
      // Balance 2,500. Three withdrawals of 1,000 cannot all fit.
      const settled = await Promise.allSettled([withdraw(1_000), withdraw(1_000), withdraw(1_000)]);
      const won = settled.filter((s) => s.status === 'fulfilled').length;
      expect(won).toBe(2);

      const after = await read();
      expect(after.dmc).toBe(rupeesToPaise(500));
      expect(after.fee).toBe(0);
      expect(after.limit).toBeLessThanOrEqual(after.dmc);
    });

    it('keeps the counter consistent when a withdrawal races a commission credit', async () => {
      captainId = await makeCaptain({ capital: 5_000, fee: 300, ceiling: 100_000 });
      await PlatformAccount.findOneAndUpdate(
        { key: 'GLOBAL' },
        { $inc: { poolBalancePaise: rupeesToPaise(200), poolFundedTotalPaise: rupeesToPaise(200) } },
        { upsert: true },
      );

      await Promise.allSettled([
        withdraw(500),
        payCommissionToCaptain(captainId, rupeesToPaise(200)),
      ]);

      const after = await read();
      // Whichever order the two landed in, neither figure may go negative and
      // the retained fee can never exceed the balance holding it.
      expect(after.dmc).toBeGreaterThanOrEqual(0);
      expect(after.fee).toBeGreaterThanOrEqual(0);
      expect(after.fee).toBeLessThanOrEqual(after.dmc);
      expect(after.limit).toBeLessThanOrEqual(after.dmc);
    });

    it('refuses a withdrawal larger than the balance', async () => {
      captainId = await makeCaptain({ capital: 1_000, fee: 100, ceiling: 100_000 });
      await expect(withdraw(5_000)).rejects.toThrow();
      const after = await read();
      expect(after.dmc).toBe(rupeesToPaise(1_100));
      expect(after.fee).toBe(rupeesToPaise(100));
    });

    it('leaves nothing consumed by a refused withdrawal', async () => {
      captainId = await makeCaptain({ capital: 1_000, fee: 100, ceiling: 100_000 });
      const before = await read();
      await expect(withdraw(5_000)).rejects.toThrow();
      expect(await read()).toEqual(before);
    });
  });
});
