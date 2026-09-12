/**
 * Admin grants room; they do not restate it.
 *
 * The approved limit used to be set to a total: admin typed 3,000 to mean
 * "another 2,000 on top of the 1,000 they have". That put the arithmetic on
 * the wrong side of the screen. Admin had to read the current figure, add to
 * it themselves, and type the sum — and a row that had gone stale between
 * loading the list and pressing save then quietly *cut* the ceiling, because
 * the number admin typed was computed from a figure that had since moved.
 *
 * So the request now carries the grant rather than the total. These tests pin
 * that it adds, that it adds to the right base, that two grants at once both
 * survive, and — the part that is easy to get wrong — that granting more room
 * is still not the same as handing the captain capital.
 */
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

describeIntegration('the approved limit adds rather than replaces', () => {
  const app = createApp();
  const SECURITY = rupeesToPaise(1_000);

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

  /**
   * A captain holding exactly their security and no more, with admin signed in
   * the way a browser signs in. `dmc` is stated separately from the security
   * because the two answer different questions and the last test turns on the
   * difference.
   */
  async function setup(opts: { creditLimitPaise?: number; dmcPaise?: number } = {}): Promise<Fixture> {
    const password = await hashPassword('Demo@12345');
    const unique = new Types.ObjectId().toHexString();

    const captainUser = await User.create({
      email: `cap-${unique}@limit.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Limit Captain',
      collateralBalancePaise: SECURITY,
      lockedAmountPaise: 0,
      dmcBalancePaise: opts.dmcPaise ?? rupeesToPaise(1_000_000),
      ...(opts.creditLimitPaise != null ? { creditLimitPaise: opts.creditLimitPaise } : {}),
      isOnline: true,
      status: 'ACTIVE',
    });

    const adminEmail = `admin-${unique}@limit.test`;
    await User.create({ email: adminEmail, passwordHash: password, name: 'Admin', role: 'ADMIN' });

    const agent = request.agent(app);
    const step1 = await agent.post(`${P}/auth/login`).send({ email: adminEmail, password: 'Demo@12345' });
    const step2 = await agent
      .post(`${P}/auth/verify-otp`)
      .send({ challengeId: step1.body?.data?.challengeId, otp: step1.body?.data?.devOtp });

    return { captainId: captain._id, agent, csrfToken: step2.body?.data?.csrfToken ?? '' };
  }

  const grant = (f: Fixture, body: Record<string, unknown>) =>
    f.agent.patch(`${P}/admin/captains/${f.captainId}/profile`).set('x-csrf-token', f.csrfToken).send(body);

  const ceilingOf = async (id: Types.ObjectId): Promise<number | null | undefined> =>
    (await Captain.findById(id).lean())?.creditLimitPaise;

  it('adds the grant to a limit admin has already approved', async () => {
    // The requirement in its own words: 1,000 approved, grant 2,000, read 3,000.
    const f = await setup({ creditLimitPaise: rupeesToPaise(1_000) });

    const res = await grant(f, { creditLimitAdd: 2_000 });

    expect(res.status).toBe(200);
    expect(await ceilingOf(f.captainId)).toBe(rupeesToPaise(3_000));
    expect(res.body.data.taskLimit).toBe(3_000);
  });

  it('adds the first grant to the security they posted, not to zero', async () => {
    // No override yet, so the ceiling is their collateral. Starting the sum
    // from zero here would cut a captain down on the very grant meant to
    // extend them.
    const f = await setup();

    await grant(f, { creditLimitAdd: 2_000 });

    expect(await ceilingOf(f.captainId)).toBe(rupeesToPaise(3_000));
  });

  it('keeps both grants when two land at the same moment', async () => {
    // Read-add-save loses one of these silently: both read 1,000, one writes
    // 3,000 and the other 6,000, and whichever lands second is the whole
    // answer. The captain is then short a grant nobody can see was made.
    const f = await setup({ creditLimitPaise: rupeesToPaise(1_000) });

    await Promise.all([grant(f, { creditLimitAdd: 2_000 }), grant(f, { creditLimitAdd: 5_000 })]);

    expect(await ceilingOf(f.captainId)).toBe(rupeesToPaise(8_000));
  });

  it('takes a grant back when the amount is negative', async () => {
    const f = await setup({ creditLimitPaise: rupeesToPaise(3_000) });

    await grant(f, { creditLimitAdd: -2_000 });

    expect(await ceilingOf(f.captainId)).toBe(rupeesToPaise(1_000));
  });

  it('refuses to take back more than was ever granted, and changes nothing', async () => {
    const f = await setup({ creditLimitPaise: rupeesToPaise(3_000) });

    const res = await grant(f, { creditLimitAdd: -5_000 });

    expect(res.status).toBe(400);
    expect(await ceilingOf(f.captainId)).toBe(rupeesToPaise(3_000));
  });

  it('will not take a total and a grant in the same breath', async () => {
    // They are contradictory instructions, and guessing which one admin meant
    // is how a limit ends up somewhere nobody chose.
    const f = await setup({ creditLimitPaise: rupeesToPaise(3_000) });

    const res = await grant(f, { creditLimit: 9_000, creditLimitAdd: 2_000 });

    expect(res.status).toBe(400);
    expect(await ceilingOf(f.captainId)).toBe(rupeesToPaise(3_000));
  });

  it('still lets admin put them back on their security outright', async () => {
    const f = await setup({ creditLimitPaise: rupeesToPaise(9_000) });

    await grant(f, { creditLimit: null });

    expect(await ceilingOf(f.captainId)).toBeNull();
    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.collateralBalancePaise).toBe(SECURITY);
  });

  it('moves not a rupee of their money', async () => {
    const f = await setup({ creditLimitPaise: rupeesToPaise(1_000), dmcPaise: rupeesToPaise(4_000) });

    await grant(f, { creditLimitAdd: 50_000 });

    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.collateralBalancePaise).toBe(SECURITY);
    expect(captain?.dmcBalancePaise).toBe(rupeesToPaise(4_000));
  });

  it('does not hand the captain capacity their capital cannot back', async () => {
    /**
     * The grant raises the ceiling, and the ceiling is only half of what a
     * captain may take on — the other half is their own DMC, and admin cannot
     * conjure that. A captain holding 4,000 who is granted a 51,000 ceiling
     * can still only take on 4,000.
     *
     * This is the same rule the dashboard states: capacity is capital. Without
     * it, a grant would look like money.
     */
    const f = await setup({ creditLimitPaise: rupeesToPaise(1_000), dmcPaise: rupeesToPaise(4_000) });

    const res = await grant(f, { creditLimitAdd: 50_000 });

    expect(res.body.data.taskLimit).toBe(51_000);
    expect(res.body.data.canTakeNow).toBe(4_000);
  });
});
