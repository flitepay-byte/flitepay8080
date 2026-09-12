/**
 * USDT PAYMENTS — the fifteen things that matter.
 *
 * Two conversion rates that must never be substituted for one another, a figure
 * computed for the payer rather than typed by them, an address book an
 * administrator owns, and a snapshot on every request so that changing any of it
 * afterwards cannot alter what somebody was already told to pay.
 *
 * The financial rule underneath all of it is the one this system has always had
 * and which these tests re-check at each step: nothing is credited until an
 * administrator approves. Not when the request is opened, not when the payer says
 * they have paid, not twice, and not at all if it is rejected.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import {
  Captain,
  User,
  Party,
  SystemConfig,
  DmcPurchase,
  CaptainLimitPurchase,
  PartyTopUpRequest,
  hashPassword,
} from '../../models';
import { ensureSystemConfig, invalidateConfigCache } from '../../services/systemConfig.service';
import {
  quote,
  conversionRatePaise,
  activeDepositAddresses,
  listDepositAddresses,
  depositAddressQr,

  USDT_NETWORK,
} from '../../services/usdtDeposit.service';
import { addDepositAddress, setDepositAddressActive } from '../../services/systemConfig.service';
import { dmcPaiseToUsdtMicros } from '../../utils/money';
import { requestDeposit, markDepositPaid, approveDeposit, rejectDeposit } from '../../services/dmcPurchase.service';
import {
  requestLimitPurchase,
  markLimitPurchasePaid,
  approveLimitPurchase,
} from '../../services/captainLimitPurchase.service';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('USDT payments', () => {
  let captainId: Types.ObjectId;
  let captainActor: { userId: string; role: 'CAPTAIN' };
  let admin: { userId: string; role: 'ADMIN' };

  beforeAll(async () => {
    await setupDatabase();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await invalidateConfigCache();
    await ensureSystemConfig();

    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique.slice(-8)}@usdt.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'USDT Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${unique.slice(-6)}`,
      displayName: 'USDT Captain',
      collateralBalancePaise: rupeesToPaise(10_000),
      dmcBalancePaise: 0,
      status: 'ACTIVE',
    });
    captainId = captain._id;
    captainActor = { userId: String(user._id), role: 'CAPTAIN' };
    admin = { userId: String(new Types.ObjectId()), role: 'ADMIN' };
  });

  const setRates = async (captainDmcPerUsdt: number, partyDmcPerUsdt: number): Promise<void> => {
    await SystemConfig.updateOne(
      { key: 'GLOBAL' },
      {
        $set: {
          captainDmcPaisePerUsdt: rupeesToPaise(captainDmcPerUsdt),
          partyDmcPaisePerUsdt: rupeesToPaise(partyDmcPerUsdt),
        },
      },
    );
    await invalidateConfigCache();
  };

  const captainNow = async () => {
    const c = await Captain.findById(captainId).lean();
    return {
      dmc: c?.dmcBalancePaise ?? -1,
      collateral: c?.collateralBalancePaise ?? -1,
      ceiling: c?.creditLimitPaise ?? null,
    };
  };

  // ===================================================================== 1 ==
  it('1. loads the captain conversion rate', async () => {
    await setRates(9.59, 10.2);
    // 9.59 DMC per USDT is 959 paise per USDT.
    expect(await conversionRatePaise('CAPTAIN')).toBe(959);
  });

  // ===================================================================== 2 ==
  it('2. loads the party conversion rate', async () => {
    await setRates(9.59, 10.2);
    expect(await conversionRatePaise('PARTY')).toBe(1020);
  });

  // ===================================================================== 3 ==
  it('3. keeps the two rates independent', async () => {
    await setRates(9.59, 10.2);

    // Move only the captain's.
    await SystemConfig.updateOne({ key: 'GLOBAL' }, { $set: { captainDmcPaisePerUsdt: rupeesToPaise(7.5) } });
    await invalidateConfigCache();

    expect(await conversionRatePaise('CAPTAIN')).toBe(750);
    // The party's is exactly where it was. One rate is not derived from the
    // other and changing one says nothing about the other.
    expect(await conversionRatePaise('PARTY')).toBe(1020);
  });

  // ===================================================================== 4 ==
  it('4. converts DMC to USDT at the right rate for each side', async () => {
    await setRates(9.59, 10.2);

    // 2000 DMC at 9.59 -> 2000 / 9.59 = 208.550574 USDT
    const captainQuote = await quote('CAPTAIN', rupeesToPaise(2_000));
    expect(captainQuote.usdtAmountMicros).toBe(208_550_574);

    // The same 2000 DMC costs a party less, because their rate is higher.
    const partyQuote = await quote('PARTY', rupeesToPaise(2_000));
    expect(partyQuote.usdtAmountMicros).toBe(196_078_431);
    expect(partyQuote.usdtAmountMicros).not.toBe(captainQuote.usdtAmountMicros);
  });

  // ===================================================================== 5 ==
  it('5. rounds to the micro, half-up, and stays integral', async () => {
    // 1 DMC at 3 DMC/USDT is 0.333333... USDT — rounds to 333333 micros.
    expect(dmcPaiseToUsdtMicros(rupeesToPaise(1), rupeesToPaise(3))).toBe(333_333);
    // 2 DMC at 3 is 0.666666... — rounds up to 666667.
    expect(dmcPaiseToUsdtMicros(rupeesToPaise(2), rupeesToPaise(3))).toBe(666_667);
    // An exact multiple stays exact.
    expect(dmcPaiseToUsdtMicros(rupeesToPaise(100), rupeesToPaise(10))).toBe(10_000_000);
    for (const dmc of [1, 7, 999, 1234.56]) {
      expect(Number.isSafeInteger(dmcPaiseToUsdtMicros(rupeesToPaise(dmc), 959))).toBe(true);
    }
  });

  // ===================================================================== 6 ==
  it('6. saves and loads multiple USDT addresses, and retires without deleting', async () => {
    await addDepositAddress('TRON_ADDR_A', 'Wallet A', admin);
    await addDepositAddress('TRON_ADDR_B', 'Wallet B', admin);

    expect(await activeDepositAddresses()).toEqual(
      expect.arrayContaining(['TRON_ADDR_A', 'TRON_ADDR_B']),
    );

    await setDepositAddressActive('TRON_ADDR_A', false, admin);
    expect(await activeDepositAddresses()).not.toContain('TRON_ADDR_A');
    // Retired, not deleted: requests already pointing at it still have to be
    // able to name it.
    expect((await listDepositAddresses()).map((a) => a.address)).toContain('TRON_ADDR_A');
  });

  // ===================================================================== 7 ==
  it('7. assigns an address from the active pool and keeps it on the request', async () => {
    await SystemConfig.updateOne({ key: 'GLOBAL' }, { $set: { usdtDepositAddresses: [] } });
    await invalidateConfigCache();
    await addDepositAddress('TRON_ONLY_ONE', 'Sole wallet', admin);

    const request = await requestDeposit(captainId, rupeesToPaise(1_000), captainActor);

    const stored = await DmcPurchase.findById(request._id).lean();
    expect(stored?.depositAddress).toBe('TRON_ONLY_ONE');
    expect(stored?.depositNetwork).toBe(USDT_NETWORK);

    // Retiring it afterwards does not move the request's address: the payment is
    // still expected where the captain was told to send it.
    await setDepositAddressActive('TRON_ONLY_ONE', false, admin);
    expect((await DmcPurchase.findById(request._id).lean())?.depositAddress).toBe('TRON_ONLY_ONE');
  });

  // ===================================================================== 8 ==
  it('8. generates a QR for the address the request actually holds', async () => {
    const request = await requestDeposit(captainId, rupeesToPaise(1_000), captainActor);
    const stored = await DmcPurchase.findById(request._id).lean();

    const qr = await depositAddressQr(stored?.depositAddress as string);
    expect(qr.startsWith('data:image/png;base64,')).toBe(true);

    // The same address gives the same image; a different one does not. That is
    // what makes this the request's QR rather than merely a QR.
    expect(await depositAddressQr(stored?.depositAddress as string)).toBe(qr);
    const other = await depositAddressQr('SOMETHING_ELSE');
    expect(other).not.toBe(qr);
  });

  // ===================================================================== 9 ==
  it('9. opens a draft that credits nothing and no administrator can see', async () => {
    await setRates(9.59, 10.2);
    const before = await captainNow();

    const request = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);

    // Pressing Pay quotes and assigns; it does not ask anybody to approve
    // anything. The request reaches an administrator when the captain reports
    // the transfer — see payDoesNotQueueForAdmin.test.ts.
    expect(request.status).toBe('AWAITING_PAYMENT');
    expect(request.usdtAmountMicros).toBe(dmcPaiseToUsdtMicros(rupeesToPaise(4_000), 959));
    // Not a rupee has moved, in any of the three places it could have.
    expect(await captainNow()).toEqual(before);
  });

  // ==================================================================== 10 ==
  it('10. accepts the transaction reference and proof, and still credits nothing', async () => {
    const before = await captainNow();
    const request = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);

    const paid = await markDepositPaid(
      String(request._id),
      captainId,
      {
        providerReference: '0xTRC20TXHASHabcdef',
        notes: 'sent from wallet A',
        receipt: { url: 'https://example.test/p.png', fileName: 'p.png', mimeType: 'image/png' },
      },
      captainActor,
    );

    expect(paid.proofReference).toBe('0xTRC20TXHASHabcdef');
    expect(paid.proofReceiptUrl).toBe('https://example.test/p.png');
    expect(paid.markedPaidAt).toBeTruthy();
    // Still PENDING, and still nothing credited — saying you paid is not proof
    // that you did.
    expect(paid.status).toBe('PENDING');
    expect(await captainNow()).toEqual(before);
  });

  // ==================================================================== 11 ==
  it('11. credits the 50/50 security split only on approval', async () => {
    const before = await captainNow();
    const request = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    await markDepositPaid(String(request._id), captainId, { providerReference: '0xHASH1' }, captainActor);

    await approveDeposit(String(request._id), admin);

    const after = await captainNow();
    // 4,000 of security: half locked as collateral, half spendable — the
    // existing rule, unchanged.
    expect(after.collateral - before.collateral).toBe(rupeesToPaise(2_000));
    expect(after.dmc - before.dmc).toBe(rupeesToPaise(2_000));
  });

  // ==================================================================== 12 ==
  it('12. credits nothing when a request is rejected', async () => {
    const before = await captainNow();
    const request = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    await markDepositPaid(String(request._id), captainId, { providerReference: '0xHASH2' }, captainActor);

    await rejectDeposit(String(request._id), 'No such transaction on chain', admin);

    expect((await DmcPurchase.findById(request._id).lean())?.status).toBe('REJECTED');
    expect(await captainNow()).toEqual(before);
  });

  // ==================================================================== 13 ==
  it('13. cannot be approved twice', async () => {
    const before = await captainNow();
    const request = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    await markDepositPaid(String(request._id), captainId, { providerReference: '0xHASH3' }, captainActor);

    await approveDeposit(String(request._id), admin);
    await expect(approveDeposit(String(request._id), admin)).rejects.toThrow();

    const after = await captainNow();
    // Exactly one credit, not two.
    expect(after.collateral - before.collateral).toBe(rupeesToPaise(2_000));
    expect(after.dmc - before.dmc).toBe(rupeesToPaise(2_000));
  });

  // ==================================================================== 14 ==
  it('14. leaves an open request untouched when the rate changes', async () => {
    await setRates(9.59, 10.2);
    const request = await requestDeposit(captainId, rupeesToPaise(2_000), captainActor);
    const quoted = request.usdtAmountMicros;
    expect(quoted).toBe(208_550_574);

    // An administrator halves the captain rate afterwards.
    await setRates(4.5, 10.2);

    const reread = await DmcPurchase.findById(request._id).lean();
    // The snapshot is what governs. Somebody already told to send 208.550574
    // USDT is not silently asked for a different figure.
    expect(reread?.usdtAmountMicros).toBe(quoted);
    expect(reread?.dmcPaisePerUsdt).toBe(959);

    // A new request, of course, uses the new rate.
    const next = await requestDeposit(captainId, rupeesToPaise(2_000), captainActor);
    expect(next.dmcPaisePerUsdt).toBe(450);
    expect(next.usdtAmountMicros).not.toBe(quoted);
  });

  // ==================================================================== 15 ==
  it('15. runs both captain flows end to end, at the captain rate', async () => {
    await setRates(9.59, 10.2);

    // --- security deposit -------------------------------------------------
    const security = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    expect(security.dmcPaisePerUsdt).toBe(959);
    expect(security.depositAddress).toBeTruthy();
    await markDepositPaid(String(security._id), captainId, { providerReference: '0xSEC' }, captainActor);
    await approveDeposit(String(security._id), admin);

    const afterSecurity = await captainNow();
    expect(afterSecurity.collateral).toBe(rupeesToPaise(12_000));
    expect(afterSecurity.dmc).toBe(rupeesToPaise(2_000));

    // --- current-limit purchase -------------------------------------------
    const limit = await requestLimitPurchase(captainId, rupeesToPaise(3_000), captainActor);
    expect(limit.dmcPaisePerUsdt).toBe(959);
    expect(limit.usdtAmountMicros).toBe(dmcPaiseToUsdtMicros(rupeesToPaise(3_000), 959));
    expect(limit.depositAddress).toBeTruthy();

    const beforeApproval = await captainNow();
    await markLimitPurchasePaid(String(limit._id), captainId, { providerReference: '0xLIM' }, captainActor);
    // Marking paid moved nothing.
    expect(await captainNow()).toEqual(beforeApproval);

    await approveLimitPurchase(String(limit._id), admin);

    const afterLimit = await captainNow();
    // The purchase adds to spendable DMC and to the ceiling, and leaves the
    // collateral exactly where it was — the existing rule, unchanged.
    expect(afterLimit.dmc - beforeApproval.dmc).toBe(rupeesToPaise(3_000));
    expect(afterLimit.collateral).toBe(beforeApproval.collateral);
    expect(afterLimit.ceiling).toBe(beforeApproval.collateral + rupeesToPaise(3_000));

    // And a party request alongside all of that still uses the party rate.
    const partyUser = await User.create({
      email: `party-${new Types.ObjectId().toHexString().slice(-8)}@usdt.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${new Types.ObjectId().toHexString().slice(-3)}`,
      companyName: 'Rate Test Co',
      contactEmail: partyUser.email,
    });
    const { requestTopUp } = await import('../../services/partyTopUp.service');
    const topUp = await requestTopUp(party._id, rupeesToPaise(2_000), {
      userId: String(partyUser._id),
      role: 'PARTY',
    });
    const storedTopUp = await PartyTopUpRequest.findById(topUp._id).lean();
    expect(storedTopUp?.dmcPaisePerUsdt).toBe(1020);
    expect(storedTopUp?.dmcPaisePerUsdt).not.toBe(959);
    expect(await CaptainLimitPurchase.countDocuments({ captainId })).toBe(1);
  });
});
