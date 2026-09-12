/**
 * PRESSING PAY MUST NOT REACH AN ADMINISTRATOR
 *
 * The defect these guard against: opening a payment request put it straight into
 * PENDING, and every admin surface filters on PENDING — so an administrator saw
 * an approval waiting the instant a captain pressed Pay, before any money had
 * moved and before there was anything to verify.
 *
 * The fix is a status ahead of PENDING rather than an extra condition on each
 * query, so these tests check the two things that follow from it: a draft is
 * invisible everywhere an administrator looks, and submitting the transaction
 * reference is what makes it visible.
 *
 * They also check the half that must NOT have changed — approval still credits
 * exactly as before, once.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { Captain, User, DmcPurchase, CaptainLimitPurchase, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { requestDeposit, markDepositPaid, approveDeposit } from '../../services/dmcPurchase.service';
import { requestLimitPurchase, markLimitPurchasePaid } from '../../services/captainLimitPurchase.service';
import { rupeesToPaise } from '../../utils/money';

const app = createApp();
const P = '/api/v1';

describeIntegration('Pay does not queue anything for an administrator', () => {
  let captainId: Types.ObjectId;
  let captainActor: { userId: string; role: 'CAPTAIN' };
  let admin: { userId: string; role: 'ADMIN' };

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();

    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique.slice(-8)}@draft.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Draft Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${unique.slice(-6)}`,
      displayName: 'Draft Captain',
      collateralBalancePaise: rupeesToPaise(10_000),
      dmcBalancePaise: 0,
      status: 'ACTIVE',
    });
    captainId = captain._id;
    captainActor = { userId: String(user._id), role: 'CAPTAIN' };
    admin = { userId: String(new Types.ObjectId()), role: 'ADMIN' };
  });

  /** The admin review queue, as an administrator really loads it. */
  const reviewQueueKinds = async (): Promise<string[]> => {
    const adminEmail = `admin-${new Types.ObjectId().toHexString().slice(-8)}@draft.test`;
    await User.create({
      email: adminEmail,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Admin',
      role: 'ADMIN',
    });
    const agent = request.agent(app);
    const s1 = await agent.post(`${P}/auth/login`).send({ email: adminEmail, password: 'Demo@12345' });
    await agent
      .post(`${P}/auth/verify-otp`)
      .send({ challengeId: s1.body?.data?.challengeId, otp: s1.body?.data?.devOtp });

    const res = await agent.get(`${P}/admin/review-queue?page=1&limit=50`).expect(200);
    return (res.body.data.items as { kind: string }[]).map((i) => i.kind);
  };

  // ====================================================================== 1 ==
  it('1. opens a deposit as a draft, not as something awaiting approval', async () => {
    const req = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    expect(req.status).toBe('AWAITING_PAYMENT');
    expect(req.status).not.toBe('PENDING');
  });

  // ====================================================================== 2 ==
  it('2. keeps a draft deposit out of the admin pending list', async () => {
    await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    // The filter every admin surface uses. A draft must not match it.
    expect(await DmcPurchase.countDocuments({ status: 'PENDING' })).toBe(0);
  });

  // ====================================================================== 3 ==
  it('3. keeps a draft deposit out of the review queue', async () => {
    await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    expect(await reviewQueueKinds()).not.toContain('CAPTAIN_DEPOSIT_PENDING');
  });

  // ====================================================================== 4 ==
  it('4. shows it to an administrator only once the reference is submitted', async () => {
    const req = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    expect(await reviewQueueKinds()).not.toContain('CAPTAIN_DEPOSIT_PENDING');

    await markDepositPaid(String(req._id), captainId, { providerReference: '0xHASHPAID' }, captainActor);

    expect((await DmcPurchase.findById(req._id).lean())?.status).toBe('PENDING');
    expect(await reviewQueueKinds()).toContain('CAPTAIN_DEPOSIT_PENDING');
    expect(await DmcPurchase.countDocuments({ status: 'PENDING' })).toBe(1);
  });

  // ====================================================================== 5 ==
  it('5. does the same for a current-limit purchase', async () => {
    const req = await requestLimitPurchase(captainId, rupeesToPaise(3_000), captainActor);
    expect(req.status).toBe('AWAITING_PAYMENT');
    expect(await CaptainLimitPurchase.countDocuments({ status: 'PENDING' })).toBe(0);
    expect(await reviewQueueKinds()).not.toContain('CAPTAIN_LIMIT_PURCHASE_PENDING');

    await markLimitPurchasePaid(String(req._id), captainId, { providerReference: '0xLIMPAID' }, captainActor);

    expect((await CaptainLimitPurchase.findById(req._id).lean())?.status).toBe('PENDING');
    expect(await reviewQueueKinds()).toContain('CAPTAIN_LIMIT_PURCHASE_PENDING');
  });

  // ====================================================================== 6 ==
  it('6. credits nothing while a draft sits there', async () => {
    const before = await Captain.findById(captainId).lean();
    await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    await requestLimitPurchase(captainId, rupeesToPaise(3_000), captainActor);

    const after = await Captain.findById(captainId).lean();
    expect(after?.dmcBalancePaise).toBe(before?.dmcBalancePaise);
    expect(after?.collateralBalancePaise).toBe(before?.collateralBalancePaise);
    expect(after?.creditLimitPaise ?? null).toBe(before?.creditLimitPaise ?? null);
  });

  // ====================================================================== 7 ==
  it('7. refuses to approve a draft — there is nothing to verify yet', async () => {
    const req = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    await expect(approveDeposit(String(req._id), admin)).rejects.toThrow();

    // And it is still a draft afterwards, not half-decided.
    expect((await DmcPurchase.findById(req._id).lean())?.status).toBe('AWAITING_PAYMENT');
    const captain = await Captain.findById(captainId).lean();
    expect(captain?.collateralBalancePaise).toBe(rupeesToPaise(10_000));
  });

  // ====================================================================== 8 ==
  it('8. still approves and credits normally after a real submission', async () => {
    const req = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    await markDepositPaid(String(req._id), captainId, { providerReference: '0xREAL' }, captainActor);

    await approveDeposit(String(req._id), admin);

    const captain = await Captain.findById(captainId).lean();
    // The existing 50/50 split, untouched by any of this.
    expect(captain?.collateralBalancePaise).toBe(rupeesToPaise(12_000));
    expect(captain?.dmcBalancePaise).toBe(rupeesToPaise(2_000));
  });

  // ====================================================================== 9 ==
  it('9. cannot be submitted twice', async () => {
    const req = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);
    await markDepositPaid(String(req._id), captainId, { providerReference: '0xFIRST' }, captainActor);

    // It is PENDING now and in front of an administrator; a second submission
    // would rewrite the reference they are checking against.
    await expect(
      markDepositPaid(String(req._id), captainId, { providerReference: '0xSECOND' }, captainActor),
    ).rejects.toThrow();

    expect((await DmcPurchase.findById(req._id).lean())?.proofReference).toBe('0xFIRST');
  });

  // ===================================================================== 10 ==
  it('10. keeps the draft on the captain’s own screen, so they can go back and pay', async () => {
    const req = await requestDeposit(captainId, rupeesToPaise(4_000), captainActor);

    // Invisible to an administrator, but not lost: the captain still has the
    // address and the quote they were given.
    const own = await DmcPurchase.findOne({ captainId }).lean();
    expect(String(own?._id)).toBe(String(req._id));
    expect(own?.depositAddress).toBeTruthy();
    expect(own?.usdtAmountMicros).toBeTruthy();
  });
});
