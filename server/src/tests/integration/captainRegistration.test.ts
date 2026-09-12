/**
 * CAPTAIN REGISTRATION, THROUGH THE REAL HTTP PATH
 *
 * Everything here goes through supertest against the mounted application —
 * validation, controller, service — because the things most likely to be wrong
 * in this feature are at exactly those seams. A service-level test would
 * construct its own arguments and so could not see a confirm-password check that
 * never runs, a code accepted for the wrong purpose, or a route that quietly
 * hands out a session.
 *
 * The properties being defended, in order of how expensive they would be to get
 * wrong:
 *
 *   1. Registering creates no account. Not an inactive one, not a placeholder —
 *      nothing a query elsewhere would have to remember to exclude.
 *   2. A code issued for one purpose cannot complete another. Registration,
 *      sign-in and password reset each have their own.
 *   3. Only approval creates a captain, and the captain it creates owns nothing:
 *      every figure zero, no collateral, and therefore no capacity to claim work
 *      until they post security in the ordinary way.
 *   4. A rejection leaves nothing behind that can sign in, and does not bar the
 *      address forever.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Captain, CaptainRegistration, Session, OtpToken, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';

const app = createApp();
const P = '/api/v1';

/** A complete, valid application. Individual tests override one field at a time. */
const validForm = (email: string) => ({
  name: 'Ravi',
  fullName: 'Ravi Kumar Sharma',
  mobile: '9876543210',
  email,
  upiId: 'ravi@okaxis',
  password: 'Demo@12345',
  c_password: 'Demo@12345',
});

describeIntegration('Captain registration, over HTTP', () => {
  let email = '';

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    email = `cap-${new Types.ObjectId().toHexString().slice(-10)}@apply.test`;
  });

  const submit = (body: Record<string, unknown>) => request(app).post(`${P}/auth/captain/register`).send(body);

  /** Register and confirm the address, leaving an application an admin can decide. */
  const applyAndVerify = async (addr = email) => {
    const step1 = await submit(validForm(addr)).expect(201);
    const { challengeId, devOtp, registrationId } = step1.body.data as {
      challengeId: string;
      devOtp: string;
      registrationId: string;
    };
    await request(app)
      .post(`${P}/auth/captain/register/verify`)
      .send({ challengeId, otp: devOtp })
      .expect(200);
    return { registrationId, challengeId, devOtp };
  };

  /** An admin agent, signed in the ordinary way. */
  const adminAgent = async () => {
    const adminEmail = `admin-${new Types.ObjectId().toHexString().slice(-8)}@apply.test`;
    await User.create({
      email: adminEmail,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Admin',
      role: 'ADMIN',
    });
    const agent = request.agent(app);
    const s1 = await agent.post(`${P}/auth/login`).send({ email: adminEmail, password: 'Demo@12345' });
    const s2 = await agent
      .post(`${P}/auth/verify-otp`)
      .send({ challengeId: s1.body?.data?.challengeId, otp: s1.body?.data?.devOtp });
    return { agent, csrfToken: (s2.body?.data?.csrfToken as string) ?? '' };
  };

  // =========================================================================
  // Submitting
  // =========================================================================
  describe('submitting an application', () => {
    it('is accepted and returns a challenge', async () => {
      const res = await submit(validForm(email)).expect(201);
      expect(res.body.data.step).toBe('OTP_REQUIRED');
      expect(res.body.data.challengeId).toEqual(expect.any(String));
    });

    it('creates no user and no captain', async () => {
      await submit(validForm(email)).expect(201);
      expect(await User.countDocuments({ email })).toBe(0);
      expect(await Captain.countDocuments()).toBe(0);
    });

    it('issues no session cookie', async () => {
      const res = await submit(validForm(email)).expect(201);
      const cookies = res.headers['set-cookie'] ?? [];
      expect(cookies).toHaveLength(0);
    });

    it('leaves the application waiting on the email step', async () => {
      await submit(validForm(email)).expect(201);
      const row = await CaptainRegistration.findOne({ email }).lean();
      expect(row?.status).toBe('PENDING_EMAIL');
      expect(row?.emailVerifiedAt ?? null).toBeNull();
    });

    it('never stores the password in the clear', async () => {
      await submit(validForm(email)).expect(201);
      const row = await CaptainRegistration.findOne({ email }).select('+passwordHash').lean();
      expect(row?.passwordHash).not.toBe('Demo@12345');
      expect(row?.passwordHash).toMatch(/^\$2[aby]\$/);
    });

    it('refuses an email that already has an account', async () => {
      await User.create({
        email,
        passwordHash: await hashPassword('Demo@12345'),
        name: 'Existing',
        role: 'CAPTAIN',
      });
      const res = await submit(validForm(email));
      expect(res.status).toBe(409);
      expect(await CaptainRegistration.countDocuments({ email })).toBe(0);
    });

    it('refuses a second open application for the same email', async () => {
      await submit(validForm(email)).expect(201);
      const res = await submit(validForm(email));
      expect(res.status).toBe(409);
      expect(await CaptainRegistration.countDocuments({ email })).toBe(1);
    });

    it.each([
      ['mismatched passwords', { c_password: 'Different@123' }],
      ['a malformed UPI id', { upiId: 'not-a-upi' }],
      ['a mobile that is too short', { mobile: '12345' }],
      ['a mobile that cannot start with 1', { mobile: '1234567890' }],
      ['a short password', { password: 'abc', c_password: 'abc' }],
      ['a malformed email', { email: 'not-an-email' }],
      ['a missing name', { name: '' }],
    ])('refuses %s', async (_label, patch) => {
      const res = await submit({ ...validForm(email), ...patch });
      expect(res.status).toBe(400);
      expect(await CaptainRegistration.countDocuments()).toBe(0);
    });

    it('accepts a mobile written with +91 and stores the ten digits', async () => {
      await submit({ ...validForm(email), mobile: '+91 9876543210' }).expect(201);
      const row = await CaptainRegistration.findOne({ email }).lean();
      expect(row?.mobile).toBe('9876543210');
    });
  });

  // =========================================================================
  // Confirming the address
  // =========================================================================
  describe('confirming the email', () => {
    it('moves the application to waiting on admin', async () => {
      const { registrationId } = await applyAndVerify();
      const row = await CaptainRegistration.findById(registrationId).lean();
      expect(row?.status).toBe('PENDING_APPROVAL');
      expect(row?.emailVerifiedAt).toBeTruthy();
    });

    it('still creates no account', async () => {
      await applyAndVerify();
      expect(await User.countDocuments({ email })).toBe(0);
      expect(await Captain.countDocuments()).toBe(0);
    });

    it('refuses a wrong code and leaves the application where it was', async () => {
      const step1 = await submit(validForm(email)).expect(201);
      const { challengeId } = step1.body.data as { challengeId: string };
      const res = await request(app)
        .post(`${P}/auth/captain/register/verify`)
        .send({ challengeId, otp: '000000' });
      expect(res.status).toBe(400);
      const row = await CaptainRegistration.findOne({ email }).lean();
      expect(row?.status).toBe('PENDING_EMAIL');
    });

    it('will not accept a sign-in code in place of a registration code', async () => {
      // A real, correct code — issued for a different purpose.
      const other = `other-${new Types.ObjectId().toHexString().slice(-8)}@apply.test`;
      await User.create({
        email: other,
        passwordHash: await hashPassword('Demo@12345'),
        name: 'Somebody',
        role: 'ADMIN',
      });
      const login = await request(app).post(`${P}/auth/login`).send({ email: other, password: 'Demo@12345' });

      await submit(validForm(email)).expect(201);
      const res = await request(app)
        .post(`${P}/auth/captain/register/verify`)
        .send({ challengeId: login.body.data.challengeId, otp: login.body.data.devOtp });

      expect(res.status).toBe(404);
      expect((await CaptainRegistration.findOne({ email }).lean())?.status).toBe('PENDING_EMAIL');
    });

    it('will not let a registration code sign anybody in', async () => {
      const step1 = await submit(validForm(email)).expect(201);
      const { challengeId, devOtp } = step1.body.data as { challengeId: string; devOtp: string };

      const res = await request(app).post(`${P}/auth/verify-otp`).send({ challengeId, otp: devOtp });
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('OTP_WRONG_PURPOSE');
      expect(await Session.countDocuments()).toBe(0);
    });
  });

  // =========================================================================
  // The resend destination
  // =========================================================================
  describe('resending the code', () => {
    it('ignores an email supplied by the caller', async () => {
      const step1 = await submit(validForm(email)).expect(201);
      const { challengeId } = step1.body.data as { challengeId: string };

      // Step past the resend cooldown rather than waiting it out. The cooldown
      // itself is real and is asserted separately below; what this test is about
      // is where the second code goes.
      await OtpToken.updateOne({ challengeId }, { $set: { lastSentAt: new Date(Date.now() - 3_600_000) } });

      await request(app)
        .post(`${P}/auth/captain/register/resend`)
        .send({ challengeId, email: 'attacker@elsewhere.test' })
        .expect(200);

      // The address on the challenge is still the applicant's. Were the
      // destination taken from the request, holding a challenge id would be
      // enough to have the next code mailed anywhere.
      const token = await OtpToken.findOne({ challengeId }).lean();
      expect(token?.email).toBe(email);
      expect(token?.email).not.toBe('attacker@elsewhere.test');
    });

    /**
     * The route where this actually mattered.
     *
     * `/auth/resend-otp` has always taken an `email` field, and it used to be
     * the address the new code was mailed to — so a challenge id was enough to
     * have somebody else's sign-in code delivered to an inbox of your choosing.
     * The registration route above cannot be attacked this way because its
     * schema does not carry an email at all and Zod drops what it does not
     * declare; this one does carry it, which is exactly why it needed fixing
     * rather than merely being left undeclared.
     */
    it('will not redirect a sign-in code to an address the caller names', async () => {
      const addr = `victim-${new Types.ObjectId().toHexString().slice(-8)}@apply.test`;
      await User.create({
        email: addr,
        passwordHash: await hashPassword('Demo@12345'),
        name: 'Victim',
        role: 'ADMIN',
      });

      const login = await request(app).post(`${P}/auth/login`).send({ email: addr, password: 'Demo@12345' });
      const challengeId = login.body.data.challengeId as string;
      await OtpToken.updateOne({ challengeId }, { $set: { lastSentAt: new Date(Date.now() - 3_600_000) } });

      await request(app)
        .post(`${P}/auth/resend-otp`)
        .send({ challengeId, email: 'attacker@elsewhere.test' })
        .expect(200);

      const token = await OtpToken.findOne({ challengeId }).lean();
      expect(token?.email).toBe(addr);
      expect(token?.email).not.toBe('attacker@elsewhere.test');
    });

    it('holds a resend back until the cooldown has passed', async () => {
      const step1 = await submit(validForm(email)).expect(201);
      const { challengeId } = step1.body.data as { challengeId: string };

      const res = await request(app).post(`${P}/auth/captain/register/resend`).send({ challengeId });
      expect(res.status).toBe(429);
      expect(res.body.errorCode).toBe('OTP_RESEND_COOLDOWN');
    });

    it('refuses once the address is already confirmed', async () => {
      const { challengeId } = await applyAndVerify();
      const res = await request(app).post(`${P}/auth/captain/register/resend`).send({ challengeId });
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // The administrator's decision
  // =========================================================================
  describe('approval', () => {
    it('creates a captain who owns nothing', async () => {
      const { registrationId } = await applyAndVerify();
      const { agent, csrfToken } = await adminAgent();

      await agent
        .post(`${P}/admin/captain-registrations/${registrationId}/approve`)
        .set('x-csrf-token', csrfToken)
        .expect(200);

      const captain = await Captain.findOne().lean();
      expect(captain).toBeTruthy();
      expect(captain?.dmcBalancePaise).toBe(0);
      expect(captain?.collateralBalancePaise).toBe(0);
      expect(captain?.lockedAmountPaise).toBe(0);
      expect(captain?.commissionEarnedTotalPaise).toBe(0);
      expect(captain?.creditLimitPaise ?? null).toBeNull();
      expect(captain?.isOnline).toBe(false);
      expect(captain?.status).toBe('ACTIVE');
    });

    it('uses the names as specified — display name on the captain, legal name on the account', async () => {
      const { registrationId } = await applyAndVerify();
      const { agent, csrfToken } = await adminAgent();
      await agent
        .post(`${P}/admin/captain-registrations/${registrationId}/approve`)
        .set('x-csrf-token', csrfToken)
        .expect(200);

      expect((await Captain.findOne().lean())?.displayName).toBe('Ravi');
      const user = await User.findOne({ email }).lean();
      expect(user?.name).toBe('Ravi Kumar Sharma');
      expect(user?.phone).toBe('9876543210');
      expect(user?.role).toBe('CAPTAIN');
      expect(user?.status).toBe('ACTIVE');
    });

    it('gives out captain codes from a counter, not a literal', async () => {
      const first = await applyAndVerify();
      const secondEmail = `two-${new Types.ObjectId().toHexString().slice(-8)}@apply.test`;
      const second = await applyAndVerify(secondEmail);
      const { agent, csrfToken } = await adminAgent();

      for (const id of [first.registrationId, second.registrationId]) {
        await agent
          .post(`${P}/admin/captain-registrations/${id}/approve`)
          .set('x-csrf-token', csrfToken)
          .expect(200);
      }

      const codes = (await Captain.find().lean()).map((c) => c.captainCode).sort();
      expect(codes).toEqual(['CAP-001', 'CAP-002']);
    });

    it('lets the captain sign in afterwards, with the password they chose', async () => {
      const { registrationId } = await applyAndVerify();
      const { agent, csrfToken } = await adminAgent();
      await agent
        .post(`${P}/admin/captain-registrations/${registrationId}/approve`)
        .set('x-csrf-token', csrfToken)
        .expect(200);

      const s1 = await request(app).post(`${P}/auth/login`).send({ email, password: 'Demo@12345' });
      expect(s1.status).toBe(201);
      const s2 = await request(app)
        .post(`${P}/auth/verify-otp`)
        .send({ challengeId: s1.body.data.challengeId, otp: s1.body.data.devOtp });
      expect(s2.status).toBe(200);
      expect(s2.body.data.user.role).toBe('CAPTAIN');
    });

    /**
     * Found by running the flow against a database seeded before the captain
     * counter existed.
     *
     * That seed wrote `CAP-001` as a literal and never touched a counter, so the
     * counter sat at zero while the code was already taken. The first approval
     * drew CAP-001, collided on the unique index while creating the captain —
     * and left behind the account it had already created, because `Captain.userId`
     * is required and so the account has to be written first. The applicant was
     * still shown as waiting for a decision, and could sign in.
     */
    it('skips a captain code that is already taken', async () => {
      // Exactly the situation an older database is in: a captain holding CAP-001
      // with the counter still at zero.
      const strayUser = await User.create({
        email: `seeded-${new Types.ObjectId().toHexString().slice(-8)}@apply.test`,
        passwordHash: await hashPassword('Demo@12345'),
        name: 'Seeded Captain',
        role: 'CAPTAIN',
      });
      await Captain.create({
        userId: strayUser._id,
        captainCode: 'CAP-001',
        displayName: 'Seeded Captain',
      });

      const { registrationId } = await applyAndVerify();
      const { agent, csrfToken } = await adminAgent();
      await agent
        .post(`${P}/admin/captain-registrations/${registrationId}/approve`)
        .set('x-csrf-token', csrfToken)
        .expect(200);

      const created = await Captain.findOne({ displayName: 'Ravi' }).lean();
      expect(created?.captainCode).toBe('CAP-002');
    });

    /**
     * The other half of the same defect, and the half that mattered.
     *
     * `Captain.userId` is required, so the account is necessarily written before
     * the profile. When the profile then failed, the account survived — a working
     * sign-in belonging to a captain who had never been created, while the
     * application still showed as waiting for a decision.
     *
     * The profile write is made to fail directly rather than through a code
     * collision, because the allocator above now prevents that particular
     * collision — and a test that can only reach this path through a bug that has
     * been fixed is a test that no longer reaches it at all.
     */
    it('leaves no account behind when the captain cannot be created', async () => {
      const { registrationId } = await applyAndVerify();
      const { agent, csrfToken } = await adminAgent();

      const failing = jest
        .spyOn(Captain, 'create')
        .mockRejectedValueOnce(new Error('captain could not be written'));

      try {
        const res = await agent
          .post(`${P}/admin/captain-registrations/${registrationId}/approve`)
          .set('x-csrf-token', csrfToken);
        expect(res.status).toBeGreaterThanOrEqual(400);
      } finally {
        failing.mockRestore();
      }

      // No captain, and — the point of the test — no account either.
      expect(await Captain.countDocuments()).toBe(0);
      expect(await User.countDocuments({ email })).toBe(0);

      const login = await request(app).post(`${P}/auth/login`).send({ email, password: 'Demo@12345' });
      expect(login.status).toBe(401);

      // And the application is decidable again rather than stuck on APPROVED.
      expect((await CaptainRegistration.findById(registrationId).lean())?.status).toBe('PENDING_APPROVAL');
    });

    it('refuses to approve an applicant who has not confirmed their email', async () => {
      await submit(validForm(email)).expect(201);
      const row = await CaptainRegistration.findOne({ email }).lean();
      const { agent, csrfToken } = await adminAgent();

      const res = await agent
        .post(`${P}/admin/captain-registrations/${String(row?._id)}/approve`)
        .set('x-csrf-token', csrfToken);

      expect(res.status).toBe(400);
      expect(await Captain.countDocuments()).toBe(0);
    });

    it('cannot be approved twice', async () => {
      const { registrationId } = await applyAndVerify();
      const { agent, csrfToken } = await adminAgent();
      const url = `${P}/admin/captain-registrations/${registrationId}/approve`;

      await agent.post(url).set('x-csrf-token', csrfToken).expect(200);
      const second = await agent.post(url).set('x-csrf-token', csrfToken);

      expect(second.status).toBe(409);
      expect(await Captain.countDocuments()).toBe(1);
      expect(await User.countDocuments({ email })).toBe(1);
    });
  });

  describe('rejection', () => {
    it('creates nothing and records the reason', async () => {
      const { registrationId } = await applyAndVerify();
      const { agent, csrfToken } = await adminAgent();

      await agent
        .post(`${P}/admin/captain-registrations/${registrationId}/reject`)
        .set('x-csrf-token', csrfToken)
        .send({ reason: 'Could not verify the UPI merchant' })
        .expect(200);

      expect(await Captain.countDocuments()).toBe(0);
      expect(await User.countDocuments({ email })).toBe(0);
      const row = await CaptainRegistration.findById(registrationId).lean();
      expect(row?.status).toBe('REJECTED');
      expect(row?.rejectionReason).toBe('Could not verify the UPI merchant');
    });

    it('leaves nothing that can sign in', async () => {
      const { registrationId } = await applyAndVerify();
      const { agent, csrfToken } = await adminAgent();
      await agent
        .post(`${P}/admin/captain-registrations/${registrationId}/reject`)
        .set('x-csrf-token', csrfToken)
        .send({ reason: 'Not verified' })
        .expect(200);

      const res = await request(app).post(`${P}/auth/login`).send({ email, password: 'Demo@12345' });
      expect(res.status).toBe(401);
    });

    it('does not bar the address forever — they may apply again', async () => {
      const { registrationId } = await applyAndVerify();
      const { agent, csrfToken } = await adminAgent();
      await agent
        .post(`${P}/admin/captain-registrations/${registrationId}/reject`)
        .set('x-csrf-token', csrfToken)
        .send({ reason: 'Try again with a working UPI id' })
        .expect(200);

      // The uniqueness index covers live applications only, precisely so that a
      // rejection is not a permanent ban on an email address.
      await submit(validForm(email)).expect(201);
      expect(await CaptainRegistration.countDocuments({ email })).toBe(2);
    });

    it('requires a reason', async () => {
      const { registrationId } = await applyAndVerify();
      const { agent, csrfToken } = await adminAgent();
      const res = await agent
        .post(`${P}/admin/captain-registrations/${registrationId}/reject`)
        .set('x-csrf-token', csrfToken)
        .send({ reason: '' });
      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // The admin review queue
  // =========================================================================
  describe('the review queue', () => {
    const queueKinds = async (agent: ReturnType<typeof request.agent>): Promise<string[]> => {
      const res = await agent.get(`${P}/admin/review-queue?page=1&limit=50`).expect(200);
      return (res.body.data.items as { kind: string }[]).map((i) => i.kind);
    };

    it('does not show an applicant who has not confirmed their email', async () => {
      await submit(validForm(email)).expect(201);
      const { agent } = await adminAgent();
      expect(await queueKinds(agent)).not.toContain('CAPTAIN_REGISTRATION_PENDING');
    });

    it('shows one that is waiting on a decision', async () => {
      await applyAndVerify();
      const { agent } = await adminAgent();
      expect(await queueKinds(agent)).toContain('CAPTAIN_REGISTRATION_PENDING');
    });

    it('stops showing it once decided', async () => {
      const { registrationId } = await applyAndVerify();
      const { agent, csrfToken } = await adminAgent();
      await agent
        .post(`${P}/admin/captain-registrations/${registrationId}/approve`)
        .set('x-csrf-token', csrfToken)
        .expect(200);
      expect(await queueKinds(agent)).not.toContain('CAPTAIN_REGISTRATION_PENDING');
    });
  });

  // =========================================================================
  // Forgotten password
  // =========================================================================
  describe('forgotten password', () => {
    const makeUser = async () => {
      const addr = `reset-${new Types.ObjectId().toHexString().slice(-8)}@apply.test`;
      await User.create({
        email: addr,
        passwordHash: await hashPassword('Demo@12345'),
        name: 'Reset Me',
        role: 'CAPTAIN',
      });
      return addr;
    };

    it('answers the same way for an address that has no account', async () => {
      const res = await request(app)
        .post(`${P}/auth/forgot-password`)
        .send({ email: 'nobody@apply.test' });
      expect(res.status).toBe(200);
      // No challenge to work with, and nothing that distinguishes this from a
      // code having been sent — otherwise this endpoint would answer "does this
      // address have an account?" for anyone who asked.
      expect(res.body.data.challengeId).toBeUndefined();
      expect(res.body.data.maskedEmail).toBe('n***@apply.test');
    });

    it('changes the password and lets the new one sign in', async () => {
      const addr = await makeUser();
      const step1 = await request(app).post(`${P}/auth/forgot-password`).send({ email: addr }).expect(200);

      await request(app)
        .post(`${P}/auth/reset-password`)
        .send({
          challengeId: step1.body.data.challengeId,
          otp: step1.body.data.devOtp,
          password: 'NewPass@2026',
          c_password: 'NewPass@2026',
        })
        .expect(200);

      const oldWay = await request(app).post(`${P}/auth/login`).send({ email: addr, password: 'Demo@12345' });
      expect(oldWay.status).toBe(401);

      const newWay = await request(app).post(`${P}/auth/login`).send({ email: addr, password: 'NewPass@2026' });
      expect(newWay.status).toBe(201);
    });

    it('ends every session that was already open', async () => {
      const addr = await makeUser();
      const agent = request.agent(app);
      const s1 = await agent.post(`${P}/auth/login`).send({ email: addr, password: 'Demo@12345' });
      await agent.post(`${P}/auth/verify-otp`).send({ challengeId: s1.body.data.challengeId, otp: s1.body.data.devOtp });
      expect(await Session.countDocuments()).toBeGreaterThan(0);

      const step1 = await request(app).post(`${P}/auth/forgot-password`).send({ email: addr }).expect(200);
      await request(app)
        .post(`${P}/auth/reset-password`)
        .send({
          challengeId: step1.body.data.challengeId,
          otp: step1.body.data.devOtp,
          password: 'NewPass@2026',
          c_password: 'NewPass@2026',
        })
        .expect(200);

      // Somebody resetting a password may be doing it because another person
      // has been using the account.
      expect(await Session.countDocuments()).toBe(0);
    });

    it('refuses mismatched passwords', async () => {
      const addr = await makeUser();
      const step1 = await request(app).post(`${P}/auth/forgot-password`).send({ email: addr }).expect(200);
      const res = await request(app).post(`${P}/auth/reset-password`).send({
        challengeId: step1.body.data.challengeId,
        otp: step1.body.data.devOtp,
        password: 'NewPass@2026',
        c_password: 'Different@2026',
      });
      expect(res.status).toBe(400);
    });

    it('will not accept a reset code as a sign-in code', async () => {
      const addr = await makeUser();
      const step1 = await request(app).post(`${P}/auth/forgot-password`).send({ email: addr }).expect(200);

      const res = await request(app)
        .post(`${P}/auth/verify-otp`)
        .send({ challengeId: step1.body.data.challengeId, otp: step1.body.data.devOtp });

      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('OTP_WRONG_PURPOSE');
    });
  });
});
