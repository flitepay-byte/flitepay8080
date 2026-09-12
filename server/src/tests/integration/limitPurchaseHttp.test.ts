/**
 * THE CAPACITY PURCHASE ROUTE, THROUGH THE REAL HTTP PATH
 *
 * These go through supertest against the mounted application — validation,
 * controller, service — rather than calling the service directly, and that
 * distinction is the entire reason the file exists.
 *
 * The feature shipped with thirty-eight passing service-level tests and a
 * defect that made it unusable. `rupeeAmountSchema` is a *transform*: it runs
 * `rupeesToPaise` itself and hands the controller paise. The controller
 * converted a second time, so a ₹200 request reached the service as 2,000,000
 * paise — ₹20,000 — and was refused against a ₹10,000 collateral. Every amount
 * above ₹100 failed. Not one of those thirty-eight tests could see it, because
 * every one of them called the service with a figure it had converted by hand,
 * which is precisely the step that was wrong.
 *
 * So the assertions below are deliberately on the *number that reaches storage*,
 * not merely on whether the request succeeded. A test that only checked for a
 * 201 would have passed against the broken code for any amount under ₹100, and
 * gone on passing if somebody reintroduced the conversion tomorrow.
 *
 * The other half of the point: a captain holding ₹242 of DMC must still be able
 * to buy ₹200 of capacity. Available DMC is not a prerequisite here — this is a
 * purchase of new DMC, capped by the security already posted and by nothing
 * else. That is easy to get wrong and impossible to see from a service test
 * that constructs its own arguments.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Captain, CaptainLimitPurchase, Session, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { signAccessToken, ACCESS_COOKIE } from '../../services/token.service';
import { currentLimitPaise } from '../../services/captainCapacity.service';
import { approveLimitPurchase } from '../../services/captainLimitPurchase.service';
import { rupeesToPaise } from '../../utils/money';

const app = createApp();

describeIntegration('POST /captain/limit-purchase, over HTTP', () => {
  let captainId: Types.ObjectId;
  let cookie = '';
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
      email: `cap-${unique}@http.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'HTTP Captain',
      role: 'CAPTAIN',
    });

    /**
     * The reported captain, exactly: plenty of security posted, almost no DMC
     * left, and therefore no room at all to take work on.
     */
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${unique.slice(-6)}`,
      displayName: 'HTTP Captain',
      collateralBalancePaise: rupeesToPaise(10_000),
      dmcBalancePaise: rupeesToPaise(242),
      commissionEarnedTotalPaise: rupeesToPaise(342),
      status: 'ACTIVE',
      isOnline: true,
    });
    captainId = captain._id;

    const sid = new Types.ObjectId().toHexString();
    await Session.create({
      sessionId: sid,
      userId: user._id,
      refreshTokenHash: `http-${sid}`,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const token = signAccessToken({
      sub: String(user._id),
      role: 'CAPTAIN',
      email: user.email,
      sid,
      captainId: String(captain._id),
    });
    cookie = `${ACCESS_COOKIE}=${token}`;
    admin = { userId: String(new Types.ObjectId()), role: 'ADMIN' };
  });

  /** The route as a client actually calls it: multipart, because it takes a receipt. */
  const post = (amount: string, reference = 'UTR-HTTP-200') =>
    request(app)
      .post('/api/v1/captain/limit-purchase')
      .set('Cookie', cookie)
      .field('amount', amount)
      .field('providerReference', reference);

  const captainNow = async () => {
    const c = await Captain.findById(captainId).lean();
    const r = c as unknown as {
      dmcBalancePaise: number; collateralBalancePaise: number; creditLimitPaise: number | null;
    };
    return {
      dmc: r.dmcBalancePaise,
      collateral: r.collateralBalancePaise,
      ceiling: r.creditLimitPaise,
      limit: currentLimitPaise(c as unknown as Parameters<typeof currentLimitPaise>[0]),
    };
  };

  // =========================================================================
  // The bug itself
  // =========================================================================
  describe('the amount that reaches storage', () => {
    it('accepts a ₹200 request', async () => {
      const res = await post('200');
      expect(res.status).toBe(201);
    });

    it('stores 20,000 paise for ₹200 — not 2,000,000', async () => {
      await post('200').expect(201);
      const row = await CaptainLimitPurchase.findOne({ captainId }).lean();
      // The assertion that catches a double conversion. `rupeeAmountSchema`
      // has already turned 200 into 20,000 paise; converting again gives
      // 2,000,000, which is the ₹20,000 the broken build was refusing.
      expect(row?.amountPaise).toBe(20_000);
      expect(row?.amountPaise).not.toBe(2_000_000);
    });

    it.each([
      ['200', 20_000],
      ['500', 50_000],
      ['250', 25_000],
      ['1000', 100_000],
      ['0.01', 1],
      ['1234.56', 123_456],
    ])('stores ₹%s as %s paise', async (amount, expected) => {
      await post(amount, `UTR-AMT-${amount}`).expect(201);
      const row = await CaptainLimitPurchase.findOne({ captainId }).lean();
      expect(row?.amountPaise).toBe(expected);
    });

    it('reports the request back at the rupee figure the captain typed', async () => {
      const res = await post('200').expect(201);
      expect((res.body as { data: { amount: number } }).data.amount).toBe(200);
    });
  });

  // =========================================================================
  // Available DMC is not a prerequisite
  // =========================================================================
  describe('a captain with almost no DMC', () => {
    it('may still buy capacity, because the cap is the security they posted', async () => {
      // ₹242 of DMC and no room to work with at all.
      const before = await captainNow();
      expect(before.dmc).toBe(rupeesToPaise(242));
      expect(before.limit).toBe(0);

      await post('200').expect(201);
    });

    it('is refused nothing on account of its balance', async () => {
      // Well above the ₹242 they hold, and well under the ₹10,000 they posted.
      await post('5000', 'UTR-BIG-5000').expect(201);
      const row = await CaptainLimitPurchase.findOne({ captainId }).lean();
      expect(row?.amountPaise).toBe(rupeesToPaise(5_000));
    });
  });

  // =========================================================================
  // The boundary
  // =========================================================================
  describe('the cap', () => {
    it('accepts exactly the collateral', async () => {
      await post('10000', 'UTR-EXACT-10000').expect(201);
      const row = await CaptainLimitPurchase.findOne({ captainId }).lean();
      expect(row?.amountPaise).toBe(rupeesToPaise(10_000));
    });

    it('refuses a rupee more', async () => {
      const res = await post('10001', 'UTR-OVER-10001');
      expect(res.status).toBe(422);
      expect(await CaptainLimitPurchase.countDocuments({ captainId })).toBe(0);
    });

    it('reports the cap and the request in the same units', async () => {
      const res = await post('10001', 'UTR-OVER-10001');
      const details = (res.body as { details: { maxPurchasePaise: number; requestedPaise: number } })
        .details;
      // Both in paise, and the requested figure is the one the captain typed —
      // a hundred times larger here would be the bug returning.
      expect(details.maxPurchasePaise).toBe(rupeesToPaise(10_000));
      expect(details.requestedPaise).toBe(rupeesToPaise(10_001));
    });

    it('refuses zero at the validator', async () => {
      const res = await post('0', 'UTR-ZERO-000');
      expect(res.status).toBe(400);
    });

    it('refuses a negative amount at the validator', async () => {
      const res = await post('-200', 'UTR-NEG-0200');
      expect(res.status).toBe(400);
    });

    it('refuses a reference that is too short', async () => {
      const res = await post('200', 'ab');
      expect(res.status).toBe(400);
      expect(await CaptainLimitPurchase.countDocuments({ captainId })).toBe(0);
    });
  });

  // =========================================================================
  // Submitting moves nothing
  // =========================================================================
  describe('after submitting', () => {
    it('leaves the request pending', async () => {
      await post('200').expect(201);
      const row = await CaptainLimitPurchase.findOne({ captainId }).lean();
      expect(row?.status).toBe('PENDING');
      expect(row?.creditedPaise ?? null).toBeNull();
    });

    it('changes no balance, ceiling or limit', async () => {
      const before = await captainNow();
      await post('200').expect(201);
      expect(await captainNow()).toEqual(before);
    });

    it('refuses a second open request', async () => {
      await post('200').expect(201);
      const res = await post('300', 'UTR-SECOND-300');
      expect(res.status).toBe(409);
    });

    it('reports the cap on the options endpoint in rupees', async () => {
      const res = await request(app)
        .get('/api/v1/captain/limit-purchase/options')
        .set('Cookie', cookie)
        .expect(200);
      expect((res.body as { data: { maxPurchase: number; collateral: number } }).data).toMatchObject({
        collateral: 10_000,
        maxPurchase: 10_000,
      });
    });
  });

  // =========================================================================
  // And what approval then does with it
  // =========================================================================
  describe('once admin approves', () => {
    it('adds exactly the requested rupees to the balance and the ceiling', async () => {
      const before = await captainNow();
      await post('200').expect(201);
      const row = await CaptainLimitPurchase.findOne({ captainId }).lean();

      await approveLimitPurchase(String(row?._id), admin);
      const after = await captainNow();

      // 20,000 paise, which is ₹200 — the figure the captain asked for.
      expect(after.dmc - before.dmc).toBe(20_000);
      expect(after.ceiling).toBe(before.collateral + 20_000);
      expect(after.collateral).toBe(before.collateral);
    });

    it('leaves retained commission out of capacity, as before', async () => {
      await post('200').expect(201);
      const row = await CaptainLimitPurchase.findOne({ captainId }).lean();
      await approveLimitPurchase(String(row?._id), admin);

      const after = await captainNow();
      // Balance 442, of which 342 is fee still retained, so capacity is 100.
      expect(after.dmc).toBe(rupeesToPaise(442));
      expect(after.limit).toBe(rupeesToPaise(100));
    });
  });

  // =========================================================================
  // Authorisation, through the same door
  // =========================================================================
  describe('the route itself', () => {
    it('refuses an anonymous caller', async () => {
      const res = await request(app)
        .post('/api/v1/captain/limit-purchase')
        .field('amount', '200')
        .field('providerReference', 'UTR-ANON-200');
      expect(res.status).toBe(401);
    });

    it('resolves rather than 404ing', async () => {
      const res = await request(app).post('/api/v1/captain/limit-purchase');
      expect((res.body as { message?: string }).message ?? '').not.toContain('does not exist');
    });
  });
});
