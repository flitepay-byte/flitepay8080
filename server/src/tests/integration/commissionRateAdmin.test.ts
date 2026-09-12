/**
 * Which profile may set which rate.
 *
 * The client was specific about this and it is worth enforcing rather than
 * trusting: a party's profile decides what that party is charged, a captain's
 * profile decides what that captain is paid, and neither may reach the other's
 * half. The two halves belong to two different bargains with two different
 * people, and a screen that can set both invites someone to read a margin off
 * a page that was never meant to state one.
 *
 * These tests drive the real admin endpoints through a real admin session.
 */
import '../../globalErrorHandlers';
import request from 'supertest';
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { createApp } from '../../app';
import { User, Party, Captain, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { env } from '../../config/env';

const P = env.API_PREFIX;

describeIntegration('admin sets each side’s rate on its own profile', () => {
  const app = createApp();

  interface Fixture {
    partyId: Types.ObjectId;
    captainId: Types.ObjectId;
    agent: ReturnType<typeof request.agent>;
    csrfToken: string;
  }

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
  });

  async function setup(): Promise<Fixture> {
    const password = await hashPassword('Demo@12345');
    const unique = new Types.ObjectId().toHexString();

    const partyUser = await User.create({
      email: `party-${unique}@rate.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Rate Ltd',
      contactEmail: partyUser.email,
    });

    const captainUser = await User.create({
      email: `cap-${unique}@rate.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Rate Captain',
      collateralBalancePaise: 0,
      status: 'ACTIVE',
    });

    const adminEmail = `admin-${unique}@rate.test`;
    await User.create({ email: adminEmail, passwordHash: password, name: 'Admin', role: 'ADMIN' });

    const agent = request.agent(app);
    const step1 = await agent.post(`${P}/auth/login`).send({ email: adminEmail, password: 'Demo@12345' });
    const step2 = await agent
      .post(`${P}/auth/verify-otp`)
      .send({ challengeId: step1.body?.data?.challengeId, otp: step1.body?.data?.devOtp });

    return {
      partyId: party._id,
      captainId: captain._id,
      agent,
      csrfToken: step2.body?.data?.csrfToken ?? '',
    };
  }

  const patchParty = (f: Fixture, body: Record<string, unknown>) =>
    f.agent.patch(`${P}/admin/parties/${f.partyId}/limits`).set('x-csrf-token', f.csrfToken).send(body);

  const patchCaptain = (f: Fixture, body: Record<string, unknown>) =>
    f.agent.patch(`${P}/admin/captains/${f.captainId}/profile`).set('x-csrf-token', f.csrfToken).send(body);

  it('sets a party’s charge, both directions independently', async () => {
    const f = await setup();

    const res = await patchParty(f, {
      payInPartyCommissionPercentage: 5,
      payOutPartyCommissionPercentage: 2,
    });

    expect(res.status).toBe(200);
    const party = await Party.findById(f.partyId).lean();
    expect(party?.payInPartyCommissionPercentage).toBe(5);
    expect(party?.payOutPartyCommissionPercentage).toBe(2);
  });

  it('sets a captain’s pay, both directions independently', async () => {
    const f = await setup();

    const res = await patchCaptain(f, {
      payInCaptainCommissionPercentage: 2,
      payOutCaptainCommissionPercentage: 0.5,
    });

    expect(res.status).toBe(200);
    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.payInCaptainCommissionPercentage).toBe(2);
    expect(captain?.payOutCaptainCommissionPercentage).toBe(0.5);
  });

  it('keeps zero as a set rate rather than an absent one', async () => {
    const f = await setup();

    await patchParty(f, { payInPartyCommissionPercentage: 0 });

    // Stored as 0, not as null — the difference between "charged nothing" and
    // "nobody decided", which the pricing code turns on.
    expect((await Party.findById(f.partyId).lean())?.payInPartyCommissionPercentage).toBe(0);
  });

  it('clears a rate back to the system default with null', async () => {
    const f = await setup();
    await patchCaptain(f, { payOutCaptainCommissionPercentage: 4 });

    await patchCaptain(f, { payOutCaptainCommissionPercentage: null });

    expect((await Captain.findById(f.captainId).lean())?.payOutCaptainCommissionPercentage).toBeNull();
  });

  it('will not let a captain’s profile set what a party is charged', async () => {
    const f = await setup();

    const res = await patchCaptain(f, { payInPartyCommissionPercentage: 9 });

    // Rejected as an unknown field rather than quietly ignored, so nobody
    // builds a screen against a setting that never lands.
    expect(res.status).toBe(400);
    const captain = await Captain.findById(f.captainId).lean();
    expect((captain as Record<string, unknown>)['payInPartyCommissionPercentage']).toBeUndefined();
  });

  it('will not let a party’s profile set what a captain is paid', async () => {
    const f = await setup();

    const res = await patchParty(f, { payInCaptainCommissionPercentage: 9 });

    expect(res.status).toBe(400);
    const party = await Party.findById(f.partyId).lean();
    expect((party as Record<string, unknown>)['payInCaptainCommissionPercentage']).toBeUndefined();
  });

  it('refuses a rate outside nought to a hundred percent', async () => {
    const f = await setup();

    expect((await patchParty(f, { payInPartyCommissionPercentage: 101 })).status).toBe(400);
    expect((await patchParty(f, { payInPartyCommissionPercentage: -1 })).status).toBe(400);
    expect((await Party.findById(f.partyId).lean())?.payInPartyCommissionPercentage).toBeNull();
  });

  it('shows each account its own rates and not the other’s', async () => {
    const f = await setup();
    await patchParty(f, { payInPartyCommissionPercentage: 5 });
    await patchCaptain(f, { payInCaptainCommissionPercentage: 2 });

    const party = await f.agent.get(`${P}/admin/parties/${f.partyId}`);
    const captain = await f.agent.get(`${P}/admin/captains/${f.captainId}`);

    // Both use the same neutral field name, and each carries only its own
    // side's number — the party's 5 is a charge, the captain's 2 is a payment,
    // and neither row can be read for the other's half.
    expect(party.body.data.payInCommissionPercentage).toBe(5);
    expect(captain.body.data.payInCommissionPercentage).toBe(2);
    expect(party.body.data.payInCaptainCommissionPercentage).toBeUndefined();
    expect(captain.body.data.payInPartyCommissionPercentage).toBeUndefined();
  });

  it('leaves a rate alone when the request does not mention it', async () => {
    const f = await setup();
    await patchCaptain(f, {
      payInCaptainCommissionPercentage: 2,
      payOutCaptainCommissionPercentage: 3,
    });

    // A limit change must not wipe a commission agreement that was not part of
    // the request — both fields live on the one endpoint.
    await patchCaptain(f, { creditLimitAdd: 1_000 });

    const captain = await Captain.findById(f.captainId).lean();
    expect(captain?.payInCaptainCommissionPercentage).toBe(2);
    expect(captain?.payOutCaptainCommissionPercentage).toBe(3);
  });
});
