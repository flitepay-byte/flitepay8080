/**
 * Phase 1 of the new model: the accounts the rest of it will stand on.
 *
 * Three things change at the foundation, and each one is a place the old model
 * had a single number where the new one needs two:
 *
 *   - A security deposit is no longer credited whole to collateral. Part is
 *     locked as security, part becomes the captain's usable DMC.
 *   - A captain's commission is no longer the same pot as their capital. It
 *     lands in a wallet they convert on their own terms.
 *   - Commission is no longer conjured when earned. It is paid out of a pool
 *     admin funds with real money, so the platform's cost is a balance that
 *     visibly goes down rather than DMC appearing from nowhere.
 *
 * That last one is why these tests exist at all: the previous model was proven
 * to conserve DMC to the paise, and the new one only keeps that property if
 * every commission has a funded source. These assertions are what stop it
 * being quietly lost.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Captain, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig, getConfig } from '../../services/systemConfig.service';
import { requestDeposit, approveDeposit, rejectDeposit } from '../../services/dmcPurchase.service';
import { fundPlatformPool, payCommissionFromPool, getPlatformAccount } from '../../services/platformAccount.service';
import { commissionFor } from '../../services/commission.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('the new model’s accounting foundation', () => {
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
    const admin = await User.create({
      email: `admin-${new Types.ObjectId().toHexString()}@newmodel.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'A',
      role: 'ADMIN',
    });
    adminActor = { userId: String(admin._id), role: 'ADMIN' };
  });

  async function makeCaptain(): Promise<{ id: Types.ObjectId; actor: { userId: string; role: 'CAPTAIN' } }> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@newmodel.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'C',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'New Model Captain',
      collateralBalancePaise: 0,
      lockedAmountPaise: 0,
      dmcBalancePaise: 0,
      isOnline: true,
      status: 'ACTIVE',
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  const deposit = async (
    captain: { id: Types.ObjectId; actor: { userId: string; role: 'CAPTAIN' } },
    rupees: number,
  ): Promise<void> => {
    const req = await requestDeposit(
      captain.id,
      rupeesToPaise(rupees),
      captain.actor,
    );
    await approveDeposit(String(req._id), adminActor);
  };

  // ------------------------------------------------------------ the split

  it('splits a security deposit into locked collateral and usable DMC', async () => {
    const captain = await makeCaptain();
    await deposit(captain, 20_000);

    const after = await Captain.findById(captain.id).lean();
    // The worked example from the specification, exactly.
    expect(paiseToRupees(after?.collateralBalancePaise ?? 0)).toBe(10_000);
    expect(paiseToRupees(after?.dmcBalancePaise ?? 0)).toBe(10_000);
  });

  it('a captain starts with nothing usable at all', async () => {
    const captain = await makeCaptain();
    const before = await Captain.findById(captain.id).lean();
    expect(before?.dmcBalancePaise).toBe(0);
    expect(before?.collateralBalancePaise).toBe(0);
  });

  it('honours a changed lock percentage', async () => {
    await updateConfig({ collateralLockPercentage: 70 }, adminId);
    const captain = await makeCaptain();
    await deposit(captain, 20_000);

    const after = await Captain.findById(captain.id).lean();
    expect(paiseToRupees(after?.collateralBalancePaise ?? 0)).toBe(14_000);
    expect(paiseToRupees(after?.dmcBalancePaise ?? 0)).toBe(6_000);
  });

  it('never loses a paise to rounding, whatever the split', async () => {
    // An amount and a percentage chosen so the split cannot land on a whole
    // paise. The two halves must still add back to exactly what was posted —
    // computing each independently would drop the remainder on every deposit.
    await updateConfig({ collateralLockPercentage: 33 }, adminId);
    const captain = await makeCaptain();
    const odd = 1_234_567; // paise
    const req = await requestDeposit(captain.id, odd, captain.actor);
    await approveDeposit(String(req._id), adminActor);

    const after = await Captain.findById(captain.id).lean();
    expect((after?.collateralBalancePaise ?? 0) + (after?.dmcBalancePaise ?? 0)).toBe(odd);
  });

  it('gives everything to collateral at 100 and nothing at 0', async () => {
    await updateConfig({ collateralLockPercentage: 100 }, adminId);
    const allLocked = await makeCaptain();
    await deposit(allLocked, 5_000);
    const a = await Captain.findById(allLocked.id).lean();
    expect(paiseToRupees(a?.collateralBalancePaise ?? 0)).toBe(5_000);
    expect(a?.dmcBalancePaise).toBe(0);

    await updateConfig({ collateralLockPercentage: 0 }, adminId);
    const allUsable = await makeCaptain();
    await deposit(allUsable, 5_000);
    const b = await Captain.findById(allUsable.id).lean();
    expect(b?.collateralBalancePaise).toBe(0);
    expect(paiseToRupees(b?.dmcBalancePaise ?? 0)).toBe(5_000);
  });

  it('moves nothing when a deposit is rejected', async () => {
    const captain = await makeCaptain();
    const req = await requestDeposit(captain.id, rupeesToPaise(9_000), captain.actor);
    await rejectDeposit(String(req._id), 'Payment never arrived in the account', adminActor);

    const after = await Captain.findById(captain.id).lean();
    expect(after?.collateralBalancePaise).toBe(0);
    expect(after?.dmcBalancePaise).toBe(0);
  });

  // ------------------------------------------------------- the funding pool

  it('mints pool DMC only when admin funds it', async () => {
    const before = await getPlatformAccount();
    expect(before.poolBalancePaise).toBe(0);

    await fundPlatformPool(rupeesToPaise(50_000));
    const after = await getPlatformAccount();
    expect(paiseToRupees(after.poolBalancePaise)).toBe(50_000);
    expect(paiseToRupees(after.poolFundedTotalPaise)).toBe(50_000);
  });

  it('pays a commission out of the pool and shows the drain', async () => {
    await fundPlatformPool(rupeesToPaise(1_000));
    const paid = await payCommissionFromPool(rupeesToPaise(250));
    expect(paid).toBe(true);

    const after = await getPlatformAccount();
    expect(paiseToRupees(after.poolBalancePaise)).toBe(750);
    // Funding is cumulative, so spend can be read as funded minus remaining.
    expect(paiseToRupees(after.poolFundedTotalPaise)).toBe(1_000);
  });

  it('refuses a commission the pool cannot fund, rather than going negative', async () => {
    await fundPlatformPool(rupeesToPaise(100));
    const paid = await payCommissionFromPool(rupeesToPaise(101));
    expect(paid).toBe(false);

    const after = await getPlatformAccount();
    // This is the whole reason the pool exists: no commission may create DMC.
    expect(paiseToRupees(after.poolBalancePaise)).toBe(100);
    expect(after.poolBalancePaise).toBeGreaterThanOrEqual(0);
  });

  it('refuses to fund a non-positive or fractional amount', async () => {
    await expect(fundPlatformPool(0)).rejects.toThrow();
    await expect(fundPlatformPool(-500)).rejects.toThrow();
    await expect(fundPlatformPool(10.5)).rejects.toThrow();
  });

  // ------------------------------------------------ charge, pay, remainder

  it('charges the party, pays the captain out of it, and leaves the rest', async () => {
    await updateConfig(
      {
        payOutPartyCommissionPercentage: 7,
        payOutCaptainCommissionPercentage: 5,
      },
      adminId,
    );
    const config = await getConfig();
    const split = commissionFor('PAY_OUT', rupeesToPaise(10_000), config);

    // The worked example from the specification: 7 in, 5 out, 2 left.
    expect(paiseToRupees(split.partyPaise)).toBe(700);
    expect(paiseToRupees(split.captainPaise)).toBe(500);
    expect(paiseToRupees(split.platformPaise)).toBe(200);
  });

  it('gives the two directions their own rates', async () => {
    await updateConfig(
      {
        payInPartyCommissionPercentage: 3,
        payInCaptainCommissionPercentage: 2,
        payOutPartyCommissionPercentage: 7,
        payOutCaptainCommissionPercentage: 5,
      },
      adminId,
    );
    const config = await getConfig();
    const amount = rupeesToPaise(10_000);

    expect(paiseToRupees(commissionFor('PAY_IN', amount, config).partyPaise)).toBe(300);
    expect(paiseToRupees(commissionFor('PAY_IN', amount, config).captainPaise)).toBe(200);
    expect(paiseToRupees(commissionFor('PAY_OUT', amount, config).partyPaise)).toBe(700);
    expect(paiseToRupees(commissionFor('PAY_OUT', amount, config).captainPaise)).toBe(500);
  });

  it('never promises the captain more than the party was charged', async () => {
    // A setting nobody should make, but one somebody will. Uncapped, this
    // would pay a fee out of a pool that only ever received 2% — DMC from
    // nowhere, which is the exact failure the pool exists to prevent.
    await updateConfig(
      {
        payOutPartyCommissionPercentage: 2,
        payOutCaptainCommissionPercentage: 5,
      },
      adminId,
    );
    const config = await getConfig();
    const split = commissionFor('PAY_OUT', rupeesToPaise(10_000), config);

    expect(paiseToRupees(split.partyPaise)).toBe(200);
    expect(paiseToRupees(split.captainPaise)).toBe(200);
    expect(split.platformPaise).toBe(0);
  });

  it('always adds back to exactly what the party was charged', async () => {
    // An amount and rates chosen so both shares round. The three figures must
    // still sum, because the platform's is a subtraction rather than its own
    // percentage — computing it independently would drop a paise per payment.
    await updateConfig(
      {
        payOutPartyCommissionPercentage: 7.5,
        payOutCaptainCommissionPercentage: 5.5,
      },
      adminId,
    );
    const config = await getConfig();
    const split = commissionFor('PAY_OUT', 1_234_567, config);

    expect(split.captainPaise + split.platformPaise).toBe(split.partyPaise);
  });

  it('allows a rate of nothing at all', async () => {
    await updateConfig(
      { payInPartyCommissionPercentage: 0, payInCaptainCommissionPercentage: 0 },
      adminId,
    );
    const config = await getConfig();
    const split = commissionFor('PAY_IN', rupeesToPaise(10_000), config);

    expect(split.partyPaise).toBe(0);
    expect(split.captainPaise).toBe(0);
    expect(split.platformPaise).toBe(0);
  });

  it('records the rates that applied, so a dispute can be settled', async () => {
    await updateConfig(
      { payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 5 },
      adminId,
    );
    const config = await getConfig();
    const split = commissionFor('PAY_OUT', rupeesToPaise(10_000), config);

    expect(split.partyRate).toBe(7);
    expect(split.captainRate).toBe(5);
    expect(split.configVersion).toBe(config.version);
  });

  // ------------------------------------------------- a deposit is not profit

  it('a deposit lands only in security and spendable DMC', async () => {
    const captain = await makeCaptain();
    await deposit(captain, 20_000);

    // Half security, half spendable — and every paise of it accounted for in
    // those two places. A deposit is money paid in, never profit made, and
    // there is nowhere else for it to go.
    const after = await Captain.findById(captain.id).lean();
    expect(paiseToRupees(after?.collateralBalancePaise ?? 0)).toBe(10_000);
    expect(paiseToRupees(after?.dmcBalancePaise ?? 0)).toBe(10_000);
    expect((after?.collateralBalancePaise ?? 0) + (after?.dmcBalancePaise ?? 0)).toBe(
      rupeesToPaise(20_000),
    );
  });

  it('refuses to drive either balance negative', async () => {
    const captain = await makeCaptain();
    await deposit(captain, 1_000);

    for (const field of ['collateralBalancePaise', 'dmcBalancePaise'] as const) {
      await expect(
        Captain.findByIdAndUpdate(captain.id, { $set: { [field]: -1 } }, { runValidators: true }),
      ).rejects.toThrow();
    }
  });

  it('reserves nothing and earns nobody anything', async () => {
    const captain = await makeCaptain();
    await deposit(captain, 20_000);

    // Paying money in is not doing work. Nothing is locked, because the
    // captain is holding no task; and the pool is untouched, because the
    // platform earns only when a party is actually charged.
    const after = await Captain.findById(captain.id).lean();
    expect(after?.lockedAmountPaise).toBe(0);
    const platform = await getPlatformAccount();
    expect(platform.poolBalancePaise).toBe(0);
  });
});
