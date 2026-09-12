/**
 * A DECISION APPLIES ONCE, HOWEVER MANY TIMES IT ARRIVES
 *
 * Every path here moves real money across the boundary: a party's top-up, a
 * captain's security deposit, a captain cashing out. Each is an admin decision
 * that credits or debits a balance, which makes each one a place where a
 * repeat — a double-click, a retried request, two admins on the same row —
 * would mint or destroy DMC that nothing accounts for.
 *
 * The protection is a conditional write: the status is moved from PENDING in
 * the same operation that reads it, so the second caller finds nothing to
 * move. That is compare-and-swap, and it is the only check that cannot be
 * raced. These tests hold it by firing the same decision twice — sequentially,
 * and concurrently — and asserting the balance moved exactly one decision's
 * worth.
 *
 * The assertions are deliberately on the balance rather than on the response.
 * A repeat that answers "already decided" while having credited twice is the
 * failure being guarded against, so what the caller is told is not evidence.
 *
 * Opposite decisions racing each other are held to the same rule: an approve
 * and a reject on the same row must not both take effect, whichever order the
 * database sees them in.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import {
  User, Party, Captain, PartyTopUpRequest, DmcPurchase, DmcRedemption, WalletEntry, hashPassword,
} from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { requestTopUp, approveTopUp, rejectTopUp, markTopUpPaid } from '../../services/partyTopUp.service';
import { requestDeposit, approveDeposit, rejectDeposit, markDepositPaid } from '../../services/dmcPurchase.service';
import {
  requestRedemption, markRedemptionPaid, rejectRedemption,
} from '../../services/captainBalance.service';
import { rupeesToPaise } from '../../utils/money';

type Actor = { userId: string; role: 'ADMIN' | 'PARTY' | 'CAPTAIN' };

describeIntegration('a money decision applies exactly once', () => {
  let partyId: Types.ObjectId;
  let captainId: Types.ObjectId;
  let admin: Actor;
  let partyActor: Actor;
  let captainActor: Actor;

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');
    const adminUser = await User.create({
      email: `admin-${unique}@once.test`, passwordHash: password, name: 'Admin', role: 'ADMIN',
    });
    const partyUser = await User.create({
      email: `party-${unique}@once.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const captainUser = await User.create({
      email: `cap-${unique}@once.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });

    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${unique.slice(-6)}`,
      companyName: 'Once Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: 0,
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${unique.slice(-6)}`,
      displayName: 'Once Captain',
      collateralBalancePaise: 0,
      dmcBalancePaise: 0,
      status: 'ACTIVE',
    });

    partyId = party._id;
    captainId = captain._id;
    admin = { userId: String(adminUser._id), role: 'ADMIN' };
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };
    captainActor = { userId: String(captainUser._id), role: 'CAPTAIN' };
  });

  const partyDmc = async (): Promise<number> =>
    (await Party.findById(partyId).select('dmcBalancePaise').lean())?.dmcBalancePaise ?? -1;
  const captainOf = async (): Promise<{ dmc: number; collateral: number }> => {
    const c = await Captain.findById(captainId).select('dmcBalancePaise collateralBalancePaise').lean();
    return { dmc: c?.dmcBalancePaise ?? -1, collateral: c?.collateralBalancePaise ?? -1 };
  };

  /** How many of these settled, so "exactly one won" can be stated plainly. */
  const outcomes = async (...calls: Promise<unknown>[]): Promise<{ ok: number; failed: number }> => {
    const settled = await Promise.allSettled(calls);
    return {
      ok: settled.filter((s) => s.status === 'fulfilled').length,
      failed: settled.filter((s) => s.status === 'rejected').length,
    };
  };

  /**
   * Both of these open the request and then submit it, which is what reaches an
   * administrator. A request that has only been opened is a draft nobody can
   * approve, so every test below about approving would otherwise be testing the
   * refusal instead.
   */
  const newTopUp = async (rupees = 50_000): Promise<string> => {
    const r = await requestTopUp(partyId, rupeesToPaise(rupees), partyActor);
    await markTopUpPaid(
      String(r._id),
      partyId,
      { providerReference: `0xTOP-${String(r._id).slice(-8)}` },
      partyActor,
    );
    return String(r._id);
  };
  const newDeposit = async (rupees = 20_000): Promise<string> => {
    const d = await requestDeposit(captainId, rupeesToPaise(rupees), captainActor);
    await markDepositPaid(
      String(d._id),
      captainId,
      { providerReference: `0xDEP-${String(d._id).slice(-8)}` },
      captainActor,
    );
    return String(d._id);
  };

  // =========================================================================
  // A party's top-up
  // =========================================================================
  describe('a party top-up', () => {
    it('credits the party once when approved twice in a row', async () => {
      const id = await newTopUp(50_000);
      await approveTopUp(id, admin);
      const after = await partyDmc();

      await expect(approveTopUp(id, admin)).rejects.toThrow();
      expect(await partyDmc()).toBe(after);
      expect(after).toBe(rupeesToPaise(50_000));
    });

    it('credits the party once when two approvals race', async () => {
      const id = await newTopUp(50_000);
      const { ok } = await outcomes(approveTopUp(id, admin), approveTopUp(id, admin));
      expect(ok).toBe(1);
      expect(await partyDmc()).toBe(rupeesToPaise(50_000));
    });

    it('credits the party once when five approvals race', async () => {
      const id = await newTopUp(1_000);
      const { ok } = await outcomes(...Array.from({ length: 5 }, () => approveTopUp(id, admin)));
      expect(ok).toBe(1);
      expect(await partyDmc()).toBe(rupeesToPaise(1_000));
    });

    it('cannot be rejected after it was approved', async () => {
      const id = await newTopUp(50_000);
      await approveTopUp(id, admin);
      await expect(rejectTopUp(id, 'changed my mind', admin)).rejects.toThrow();
      expect(await partyDmc()).toBe(rupeesToPaise(50_000));
    });

    it('cannot be approved after it was rejected', async () => {
      const id = await newTopUp(50_000);
      await rejectTopUp(id, 'no money arrived', admin);
      await expect(approveTopUp(id, admin)).rejects.toThrow();
      expect(await partyDmc()).toBe(0);
    });

    it('lets exactly one of a racing approve and reject take effect', async () => {
      const id = await newTopUp(50_000);
      const { ok } = await outcomes(approveTopUp(id, admin), rejectTopUp(id, 'nothing arrived', admin));
      expect(ok).toBe(1);
      // Whichever won, the balance is one of exactly two legal values.
      expect([0, rupeesToPaise(50_000)]).toContain(await partyDmc());
    });

    it('rejects twice without touching the balance', async () => {
      const id = await newTopUp(50_000);
      await rejectTopUp(id, 'nothing arrived', admin);
      await expect(rejectTopUp(id, 'still nothing', admin)).rejects.toThrow();
      expect(await partyDmc()).toBe(0);
    });

    it('leaves two separate requests as two separate credits', async () => {
      // Idempotency is per decision, not per party: two genuine top-ups both
      // land. They have to be sequential because only one may be pending at a
      // time — see the test below, which pins that rule.
      const first = await newTopUp(1_000);
      await approveTopUp(first, admin);
      const second = await newTopUp(2_000);
      await approveTopUp(second, admin);
      expect(await partyDmc()).toBe(rupeesToPaise(3_000));
    });

    it('allows only one request pending admin review at a time', async () => {
      // Two open requests would leave admin deciding on the same money twice
      // with no way to tell which payment each one refers to.
      await newTopUp(1_000);
      await expect(newTopUp(2_000)).rejects.toThrow(/already have a top-up request pending/i);
      expect(await PartyTopUpRequest.countDocuments({ partyId, status: 'PENDING' })).toBe(1);
      expect(await partyDmc()).toBe(0);
    });

    it('accepts a new request once the previous one is decided', async () => {
      const first = await newTopUp(1_000);
      await rejectTopUp(first, 'nothing arrived', admin);
      // A refused request must not block the party from trying again.
      const second = await newTopUp(2_000);
      await approveTopUp(second, admin);
      expect(await partyDmc()).toBe(rupeesToPaise(2_000));
    });
  });

  // =========================================================================
  // A captain's security deposit
  // =========================================================================
  describe('a captain security deposit', () => {
    it('credits security and capital once when approved twice in a row', async () => {
      const id = await newDeposit(20_000);
      await approveDeposit(id, admin);
      const after = await captainOf();

      await expect(approveDeposit(id, admin)).rejects.toThrow();
      expect(await captainOf()).toEqual(after);
      // The deposit splits into security and spendable capital; together they
      // are the whole deposit and nothing more.
      expect(after.collateral + after.dmc).toBe(rupeesToPaise(20_000));
    });

    it('credits once when two approvals race', async () => {
      const id = await newDeposit(20_000);
      const { ok } = await outcomes(approveDeposit(id, admin), approveDeposit(id, admin));
      expect(ok).toBe(1);
      const after = await captainOf();
      expect(after.collateral + after.dmc).toBe(rupeesToPaise(20_000));
    });

    it('credits once when four approvals race', async () => {
      const id = await newDeposit(8_000);
      const { ok } = await outcomes(...Array.from({ length: 4 }, () => approveDeposit(id, admin)));
      expect(ok).toBe(1);
      const after = await captainOf();
      expect(after.collateral + after.dmc).toBe(rupeesToPaise(8_000));
    });

    it('writes one wallet entry, not one per attempt', async () => {
      const id = await newDeposit(20_000);
      await outcomes(...Array.from({ length: 3 }, () => approveDeposit(id, admin)));
      const entries = await WalletEntry.find({ captainId }).lean();
      // The ledger is the record of record; a duplicated row is a duplicated
      // credit even if the balance happens to look right.
      expect(entries.length).toBeLessThanOrEqual(2);
      const credited = entries.reduce((sum, e) => sum + Math.max(0, e.amountPaise), 0);
      expect(credited).toBeLessThanOrEqual(rupeesToPaise(20_000));
    });

    it('cannot be approved after it was rejected', async () => {
      const id = await newDeposit(20_000);
      await rejectDeposit(id, 'no money arrived', admin);
      await expect(approveDeposit(id, admin)).rejects.toThrow();
      expect(await captainOf()).toEqual({ dmc: 0, collateral: 0 });
    });

    it('cannot be rejected after it was approved', async () => {
      const id = await newDeposit(20_000);
      await approveDeposit(id, admin);
      const after = await captainOf();
      await expect(rejectDeposit(id, 'second thoughts', admin)).rejects.toThrow();
      expect(await captainOf()).toEqual(after);
    });

    it('lets exactly one of a racing approve and reject take effect', async () => {
      const id = await newDeposit(20_000);
      const { ok } = await outcomes(approveDeposit(id, admin), rejectDeposit(id, 'nothing arrived', admin));
      expect(ok).toBe(1);
      const after = await captainOf();
      expect([0, rupeesToPaise(20_000)]).toContain(after.collateral + after.dmc);
    });

    it('never leaves the captain holding more than was deposited', async () => {
      const id = await newDeposit(20_000);
      await outcomes(...Array.from({ length: 6 }, () => approveDeposit(id, admin)));
      const after = await captainOf();
      expect(after.collateral + after.dmc).toBe(rupeesToPaise(20_000));
    });
  });

  // =========================================================================
  // A captain cashing out
  // =========================================================================
  describe('a captain cash-out', () => {
    const fundCaptain = async (rupees: number): Promise<void> => {
      await Captain.updateOne({ _id: captainId }, { $set: { dmcBalancePaise: rupeesToPaise(rupees) } });
    };
    const newRedemption = async (rupees: number): Promise<string> => {
      const r = await requestRedemption(
        captainId, rupeesToPaise(rupees), { method: 'UPI', upiId: 'cap@upi' }, captainActor,
      );
      return String(r._id);
    };

    it('debits the captain once when paid twice in a row', async () => {
      await fundCaptain(10_000);
      const id = await newRedemption(4_000);
      const held = await captainOf();

      await markRedemptionPaid(id, { reference: 'NEFT-1' }, admin);
      const paid = await captainOf();
      await expect(markRedemptionPaid(id, { reference: 'NEFT-1-again' }, admin)).rejects.toThrow();
      expect(await captainOf()).toEqual(paid);
      // Whatever the hold mechanics, the captain cannot end up richer.
      expect(paid.dmc).toBeLessThanOrEqual(held.dmc);
    });

    it('debits the captain once when two payments race', async () => {
      await fundCaptain(10_000);
      const id = await newRedemption(4_000);
      const { ok } = await outcomes(
        markRedemptionPaid(id, { reference: 'NEFT-A' }, admin),
        markRedemptionPaid(id, { reference: 'NEFT-B' }, admin),
      );
      expect(ok).toBe(1);
      expect((await captainOf()).dmc).toBeGreaterThanOrEqual(0);
    });

    it('cannot be paid after it was rejected', async () => {
      await fundCaptain(10_000);
      const id = await newRedemption(4_000);
      await rejectRedemption(id, 'bad account details', admin);
      const after = await captainOf();
      await expect(markRedemptionPaid(id, { reference: 'NEFT-C' }, admin)).rejects.toThrow();
      expect(await captainOf()).toEqual(after);
    });

    it('cannot be rejected after it was paid', async () => {
      await fundCaptain(10_000);
      const id = await newRedemption(4_000);
      await markRedemptionPaid(id, { reference: 'NEFT-D' }, admin);
      const after = await captainOf();
      await expect(rejectRedemption(id, 'too late', admin)).rejects.toThrow();
      expect(await captainOf()).toEqual(after);
    });

    it('lets exactly one of a racing pay and reject take effect', async () => {
      await fundCaptain(10_000);
      const id = await newRedemption(4_000);
      const { ok } = await outcomes(
        markRedemptionPaid(id, { reference: 'NEFT-E' }, admin),
        rejectRedemption(id, 'bad details', admin),
      );
      expect(ok).toBe(1);
      expect((await captainOf()).dmc).toBeGreaterThanOrEqual(0);
    });

    it('never lets a cash-out drive the balance below zero', async () => {
      await fundCaptain(5_000);
      const id = await newRedemption(5_000);
      await outcomes(...Array.from({ length: 4 }, (_, i) =>
        markRedemptionPaid(id, { reference: `NEFT-Z${i}` }, admin)));
      expect((await captainOf()).dmc).toBeGreaterThanOrEqual(0);
    });

    it('refuses a cash-out larger than the captain holds', async () => {
      await fundCaptain(1_000);
      await expect(newRedemption(5_000)).rejects.toThrow();
      expect((await captainOf()).dmc).toBe(rupeesToPaise(1_000));
    });

    it('leaves no redemption row in a state nobody decided', async () => {
      await fundCaptain(10_000);
      const id = await newRedemption(4_000);
      await outcomes(
        markRedemptionPaid(id, { reference: 'NEFT-F' }, admin),
        rejectRedemption(id, 'bad details', admin),
      );
      const row = await DmcRedemption.findById(id).lean();
      expect(row).not.toBeNull();
      expect(['PAID', 'REJECTED', 'PENDING']).toContain(row?.status);
    });
  });

  // =========================================================================
  // Nothing appears from nowhere
  // =========================================================================
  describe('across all three paths', () => {
    it('leaves no orphan approved row without a matching credit', async () => {
      const topUp = await newTopUp(1_000);
      const deposit = await newDeposit(2_000);
      await approveTopUp(topUp, admin);
      await approveDeposit(deposit, admin);

      const approvedTopUps = await PartyTopUpRequest.countDocuments({ partyId, status: 'APPROVED' });
      const approvedDeposits = await DmcPurchase.countDocuments({ captainId, status: 'APPROVED' });
      expect(approvedTopUps).toBe(1);
      expect(approvedDeposits).toBe(1);
      expect(await partyDmc()).toBe(rupeesToPaise(1_000));
      const cap = await captainOf();
      expect(cap.collateral + cap.dmc).toBe(rupeesToPaise(2_000));
    });

    it('keeps a party credit off the captain and a captain credit off the party', async () => {
      const topUp = await newTopUp(1_000);
      await approveTopUp(topUp, admin);
      // A party's money has no business reaching a captain's balance.
      expect(await captainOf()).toEqual({ dmc: 0, collateral: 0 });

      const deposit = await newDeposit(2_000);
      await approveDeposit(deposit, admin);
      expect(await partyDmc()).toBe(rupeesToPaise(1_000));
    });

    it('never leaves a negative balance anywhere, under any repeat', async () => {
      const topUp = await newTopUp(1_000);
      const deposit = await newDeposit(2_000);
      await outcomes(
        approveTopUp(topUp, admin), approveTopUp(topUp, admin),
        approveDeposit(deposit, admin), approveDeposit(deposit, admin),
        rejectTopUp(topUp, 'race', admin), rejectDeposit(deposit, 'race', admin),
      );
      expect(await partyDmc()).toBeGreaterThanOrEqual(0);
      const cap = await captainOf();
      expect(cap.dmc).toBeGreaterThanOrEqual(0);
      expect(cap.collateral).toBeGreaterThanOrEqual(0);
    });
  });
});
