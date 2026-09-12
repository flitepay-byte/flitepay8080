/**
 * ADMIN-MANAGED API INTEGRATION — 15 focused tests.
 *
 * Two things are being defended here.
 *
 * The first is the secret. It exists in exactly one response and nowhere else:
 * not in a list, not in an audit row, not in a second fetch of the same key. A
 * test suite is the only place that can keep saying so as the surface grows.
 *
 * The second is the webhook-retry defect. A party running a staging key and a
 * live key has two callback endpoints, and a retry used to pick whichever key
 * came back from the database first — so a production retry could be delivered
 * to staging, correctly signed and entirely wrong. The rows now record the key
 * that created them.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, ApiKey, AuditLog, Transaction, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { buildIntegrationPackage } from '../../services/integrationPackage.service';
import { rupeesToPaise } from '../../utils/money';

const app = createApp();
const P = '/api/v1';

describeIntegration('Admin-managed API integration', () => {
  let partyId = '';
  let agent: ReturnType<typeof request.agent>;
  let csrf = '';

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();

    const unique = new Types.ObjectId().toHexString();
    const partyUser = await User.create({
      email: `party-${unique.slice(-8)}@int.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Chai & Co',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${unique.slice(-3)}`,
      companyName: 'Chai & Co',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(50_000),
    });
    partyId = String(party._id);

    const adminEmail = `admin-${unique.slice(-8)}@int.test`;
    await User.create({
      email: adminEmail,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Admin',
      role: 'ADMIN',
    });
    agent = request.agent(app);
    const s1 = await agent.post(`${P}/auth/login`).send({ email: adminEmail, password: 'Demo@12345' });
    const s2 = await agent
      .post(`${P}/auth/verify-otp`)
      .send({ challengeId: s1.body?.data?.challengeId, otp: s1.body?.data?.devOtp });
    csrf = (s2.body?.data?.csrfToken as string) ?? '';
  });

  const createKey = (body: Record<string, unknown> = { label: 'Production' }) =>
    agent.post(`${P}/admin/parties/${partyId}/api-keys`).set('x-csrf-token', csrf).send(body);

  // ====================================================================== 1 ==
  it('1. creates a key from the party profile', async () => {
    const res = await createKey().expect(201);
    expect(res.body.data.keyId).toMatch(/^otdms_[0-9a-f]{18}$/);
    expect(await ApiKey.countDocuments({ partyId })).toBe(1);
  });

  // ====================================================================== 2 ==
  it('2. returns the secret exactly once, on creation', async () => {
    const res = await createKey().expect(201);
    expect(typeof res.body.data.secret).toBe('string');
    expect((res.body.data.secret as string).length).toBeGreaterThanOrEqual(32);
  });

  // ====================================================================== 3 ==
  it('3. never returns the secret again, from any endpoint', async () => {
    const created = await createKey().expect(201);
    const secret = created.body.data.secret as string;

    const list = await agent.get(`${P}/admin/parties/${partyId}/api-keys`).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(secret);

    const details = await agent
      .get(`${P}/admin/parties/${partyId}/api-keys/${created.body.data.keyId}/integration`)
      .expect(200);
    expect(JSON.stringify(details.body)).not.toContain(secret);
    expect(details.body.data.credentials.secret).toBeNull();
  });

  // ====================================================================== 4 ==
  it('4. never writes the secret to the audit log or the database in the clear', async () => {
    const res = await createKey().expect(201);
    const secret = res.body.data.secret as string;

    const rows = await AuditLog.find({ targetCollection: 'ApiKey' }).lean();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(secret);

    const stored = await ApiKey.findOne({ partyId }).lean();
    expect(stored?.secretEncrypted).not.toContain(secret);
  });

  // ====================================================================== 5 ==
  it('5. lists keys with their status, callback URL and last-used', async () => {
    await createKey({ label: 'Production', callbackUrl: 'https://shop.test/otdms' }).expect(201);
    const res = await agent.get(`${P}/admin/parties/${partyId}/api-keys`).expect(200);

    const [key] = res.body.data.keys as Record<string, unknown>[];
    expect(key).toMatchObject({
      label: 'Production',
      status: 'ACTIVE',
      callbackUrl: 'https://shop.test/otdms',
      lastUsedAt: null,
    });
  });

  // ====================================================================== 6 ==
  it('6. keeps several keys for one party, each with its own callback URL', async () => {
    await createKey({ label: 'Production', callbackUrl: 'https://live.test/hook' }).expect(201);
    await createKey({ label: 'Staging', callbackUrl: 'https://staging.test/hook' }).expect(201);

    const res = await agent.get(`${P}/admin/parties/${partyId}/api-keys`).expect(200);
    const urls = (res.body.data.keys as { callbackUrl: string }[]).map((k) => k.callbackUrl).sort();
    expect(urls).toEqual(['https://live.test/hook', 'https://staging.test/hook']);
  });

  // ====================================================================== 7 ==
  it('7. edits a callback URL after the fact', async () => {
    const created = await createKey().expect(201);
    const keyId = created.body.data.keyId as string;

    await agent
      .patch(`${P}/admin/parties/${partyId}/api-keys/${keyId}/callback-url`)
      .set('x-csrf-token', csrf)
      .send({ callbackUrl: 'https://moved.test/otdms' })
      .expect(200);

    expect((await ApiKey.findOne({ keyId }).lean())?.callbackUrl).toBe('https://moved.test/otdms');
  });

  // ====================================================================== 8 ==
  it('8. revokes a key, and refuses to revoke it twice', async () => {
    const created = await createKey().expect(201);
    const keyId = created.body.data.keyId as string;
    const url = `${P}/admin/parties/${partyId}/api-keys/${keyId}`;

    await agent.delete(url).set('x-csrf-token', csrf).expect(200);
    expect((await ApiKey.findOne({ keyId }).lean())?.status).toBe('REVOKED');

    const second = await agent.delete(url).set('x-csrf-token', csrf);
    expect(second.status).toBe(404);
  });

  // ====================================================================== 9 ==
  it('9. gives every key a unique id', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await createKey({ label: `Key ${i}` }).expect(201);
      ids.add(res.body.data.keyId as string);
    }
    expect(ids.size).toBe(5);
  });

  // ===================================================================== 10 ==
  it('10. builds an integration package a developer could work from', async () => {
    const res = await createKey({ label: 'Production', callbackUrl: 'https://shop.test/otdms' }).expect(201);
    const pkg = res.body.data.integration;

    expect(pkg.api.baseUrl).toContain('/api/v1/api');
    expect(pkg.api.docsUrl).toContain('/docs');
    expect(pkg.credentials.keyId).toBe(res.body.data.keyId);
    expect(pkg.credentials.secret).toBe(res.body.data.secret);
    expect(pkg.authentication.headers.map((h: { name: string }) => h.name)).toEqual([
      'x-otdms-key',
      'x-otdms-timestamp',
      'x-otdms-signature',
    ]);
    expect(pkg.authentication.timestampWindowSeconds).toBe(300);
    expect(pkg.webhooks.callbackUrl).toBe('https://shop.test/otdms');
    expect(pkg.webhooks.events.length).toBeGreaterThanOrEqual(4);
  });

  // ===================================================================== 11 ==
  it('11. leaves the secret out of a package built later', () => {
    const withSecret = buildIntegrationPackage({
      partyName: 'X', partyCode: 'PARTY-001', keyId: 'otdms_abc', secret: 'S3CRET', baseUrl: 'https://h',
    });
    const without = buildIntegrationPackage({
      partyName: 'X', partyCode: 'PARTY-001', keyId: 'otdms_abc', baseUrl: 'https://h',
    });

    expect(withSecret.credentials.secret).toBe('S3CRET');
    expect(without.credentials.secret).toBeNull();
    // And says why, so an absent credential is not reported as a fault.
    expect(without.credentials.secretNote).toContain('issue a new key');
  });

  // ===================================================================== 12 ==
  it('12. downloads a PDF, with the secret only when it is supplied', async () => {
    const created = await createKey().expect(201);
    const keyId = created.body.data.keyId as string;

    const res = await agent
      .post(`${P}/admin/parties/${partyId}/api-keys/${keyId}/integration.pdf`)
      .set('x-csrf-token', csrf)
      .send({ secret: created.body.data.secret })
      .expect(200);

    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('.pdf');
    // A real document rather than an empty stream.
    expect(res.body.length ?? 0).toBeGreaterThan(1000);
  });

  // ===================================================================== 13 ==
  it('13. records which key created a transaction', async () => {
    const created = await createKey().expect(201);
    const keyId = created.body.data.keyId as string;

    await Transaction.create({
      partyId: new Types.ObjectId(partyId),
      partyReference: 'ORD-1',
      transactionCode: `TXN-${new Types.ObjectId().toHexString().slice(-8)}`,
      direction: 'PAY_IN',
      amountPaise: rupeesToPaise(1_000),
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 30 * 60_000),
      createdByKeyId: keyId,
      callbackUrl: 'https://live.test/hook',
    });

    expect((await Transaction.findOne({ partyReference: 'ORD-1' }).lean())?.createdByKeyId).toBe(keyId);
  });

  // ===================================================================== 14 ==
  it('14. retries a callback with the key that created it, not another live key', async () => {
    const live = await createKey({ label: 'Production', callbackUrl: 'https://live.test/hook' }).expect(201);
    const staging = await createKey({ label: 'Staging', callbackUrl: 'https://staging.test/hook' }).expect(201);
    const liveKeyId = live.body.data.keyId as string;
    const stagingKeyId = staging.body.data.keyId as string;

    const { callbackKeyFor } = await import('../../services/transactionSweep.service');

    /**
     * The decision is asserted directly rather than through a delivery.
     *
     * Which key was used only ever appears in a header on an outbound request to
     * the party's host, and that host does not exist in a test — so a test that
     * watched the attempt could only see that it failed, which it would do
     * either way. Asserting the choice is the only way to see the defect.
     */
    const chosen = await callbackKeyFor(liveKeyId, new Types.ObjectId(partyId));
    expect(chosen).toBe(liveKeyId);
    expect(chosen).not.toBe(stagingKeyId);

    // Still the creating key once it has been revoked: the party made the call
    // with it and is waiting for the answer to it.
    await agent.delete(`${P}/admin/parties/${partyId}/api-keys/${liveKeyId}`).set('x-csrf-token', csrf).expect(200);
    expect(await callbackKeyFor(liveKeyId, new Types.ObjectId(partyId))).toBe(liveKeyId);

    // Only a row with no key recorded falls back, and that is the legacy case.
    expect(await callbackKeyFor(null, new Types.ObjectId(partyId))).toBe(stagingKeyId);
  });

  // ===================================================================== 15 ==
  it('15. refuses all of this to anybody who is not an administrator', async () => {
    const anon = request(app);
    expect((await anon.get(`${P}/admin/parties/${partyId}/api-keys`)).status).toBe(401);
    expect((await anon.post(`${P}/admin/parties/${partyId}/api-keys`).send({ label: 'X' })).status).toBe(401);
  });
});
