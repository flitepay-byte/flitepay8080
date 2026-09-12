/**
 * A captain's collateral is their own security money.
 *
 * They post it by buying DMC and they get it back the same way. Admin has no
 * business writing that number — the lever that belongs to admin is the claim
 * ceiling, which changes what a captain may take on and moves nothing.
 *
 * There used to be an admin endpoint that credited and debited the collateral
 * directly. These tests exist so it does not come back, and so the ceiling
 * route that replaced it stays honest about leaving the money alone.
 */
// Imported first, exactly as index.ts does and for the same reason: building
// the app constructs Redis-backed rate limiters at module load, and with no
// Redis reachable their script load rejects with nothing observing it. The
// real entrypoint installs these handlers before that can happen; a test that
// builds the app has to do the same or the rejection fails the suite.
import '../../globalErrorHandlers';
import request from 'supertest';
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { createApp } from '../../app';
import { User, Captain, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { env } from '../../config/env';
import { rupeesToPaise } from '../../utils/money';

const P = env.API_PREFIX;

describeIntegration('a captain collateral is theirs alone', () => {
  const app = createApp();
  const COLLATERAL = rupeesToPaise(50_000);

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);
  beforeEach(clearCollections);

  interface Fixture {
    captainId: Types.ObjectId;
    agent: ReturnType<typeof request.agent>;
    csrfToken: string;
  }

  /** Signs admin in the way a browser does: password, OTP, then cookies. */
  async function setup(): Promise<Fixture> {
    const password = await hashPassword('Demo@12345');
    const unique = new Types.ObjectId().toHexString();

    const captainUser = await User.create({
      email: `cap-${unique}@collateral.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Collateral Captain',
      collateralBalancePaise: COLLATERAL,
      lockedAmountPaise: 0,
      isOnline: true,
      status: 'ACTIVE',
    });

    const adminEmail = `admin-${unique}@collateral.test`;
    await User.create({ email: adminEmail, passwordHash: password, name: 'Admin', role: 'ADMIN' });

    const agent = request.agent(app);
    const step1 = await agent.post(`${P}/auth/login`).send({ email: adminEmail, password: 'Demo@12345' });
    const step2 = await agent
      .post(`${P}/auth/verify-otp`)
      .send({ challengeId: step1.body?.data?.challengeId, otp: step1.body?.data?.devOtp });

    return { captainId: captain._id, agent, csrfToken: step2.body?.data?.csrfToken ?? '' };
  }

  async function collateralOf(id: Types.ObjectId): Promise<number> {
    return (await Captain.findById(id).lean())?.collateralBalancePaise ?? -1;
  }

  it('offers admin no route to credit or debit it', async () => {
    const f = await setup();

    for (const direction of ['CREDIT', 'DEBIT'] as const) {
      const res = await f.agent
        .post(`${P}/admin/captains/${f.captainId}/collateral`)
        .set('x-csrf-token', f.csrfToken)
        .send({ amount: 10_000, direction, note: 'trying it on' });

      // 404 because the route is gone, which is the point — not a 403 from a
      // guard that someone could later relax.
      expect(res.status).toBe(404);
    }

    expect(await collateralOf(f.captainId)).toBe(COLLATERAL);
  });

  it('lets admin set the claim ceiling instead, without touching the money', async () => {
    const f = await setup();

    const res = await f.agent
      .patch(`${P}/admin/captains/${f.captainId}/profile`)
      .set('x-csrf-token', f.csrfToken)
      .send({ creditLimit: 80_000 });

    expect(res.status).toBe(200);
    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.creditLimitPaise).toBe(rupeesToPaise(80_000));
    expect(captain?.collateralBalancePaise).toBe(COLLATERAL);
  });

  it('leaves the money alone even when the ceiling is cut to zero', async () => {
    const f = await setup();

    await f.agent
      .patch(`${P}/admin/captains/${f.captainId}/profile`)
      .set('x-csrf-token', f.csrfToken)
      .send({ creditLimit: 0 });

    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.creditLimitPaise).toBe(0);
    expect(captain?.collateralBalancePaise).toBe(COLLATERAL);
  });

  it('leaves the money alone when the ceiling is cleared again', async () => {
    const f = await setup();

    await f.agent
      .patch(`${P}/admin/captains/${f.captainId}/profile`)
      .set('x-csrf-token', f.csrfToken)
      .send({ creditLimit: 20_000 });
    await f.agent
      .patch(`${P}/admin/captains/${f.captainId}/profile`)
      .set('x-csrf-token', f.csrfToken)
      .send({ creditLimit: null });

    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.creditLimitPaise).toBeNull();
    expect(captain?.collateralBalancePaise).toBe(COLLATERAL);
  });

  it('refuses a negative ceiling', async () => {
    const f = await setup();
    const res = await f.agent
      .patch(`${P}/admin/captains/${f.captainId}/profile`)
      .set('x-csrf-token', f.csrfToken)
      .send({ creditLimit: -1 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await collateralOf(f.captainId)).toBe(COLLATERAL);
  });

  it('no admin profile field can reach the collateral at all', async () => {
    const f = await setup();

    // Everything the profile route accepts, plus a hopeful attempt at the
    // collateral itself under each name it goes by.
    const res = await f.agent
      .patch(`${P}/admin/captains/${f.captainId}/profile`)
      .set('x-csrf-token', f.csrfToken)
      .send({
        displayName: 'Renamed',
        creditLimit: 60_000,
        collateralBalance: 999_999,
        collateralBalancePaise: 999_999,
      });

    expect(res.status).toBe(200);
    expect(await collateralOf(f.captainId)).toBe(COLLATERAL);
  });
});
