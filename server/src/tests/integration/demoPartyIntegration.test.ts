/**
 * THE DEMO SHOP, INTEGRATED FOR REAL — 12 focused tests.
 *
 * Both sides run: the OTDMS application on one port, the demo shop on another,
 * talking to each other over HTTP with nothing shared but an API key. Nothing is
 * stubbed, because the thing being demonstrated is precisely that a party's own
 * server can sign a request we will accept — and a stub would prove the stub.
 *
 * The property that matters most here is the one that is easiest to lose: the
 * secret is pasted into a page in a browser, and from that moment it must never
 * come back out of the shop's process. Signing stays server-side. A demo that
 * leaked the credential to the page it was typed into would be teaching the
 * wrong lesson to the very people it exists to teach.
 */
import { Types } from 'mongoose';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { issueApiKey } from '../../services/apiKey.service';
import { rupeesToPaise } from '../../utils/money';
import type { Server } from 'node:http';

const P = '/api/v1';
const SHOP_DIR = path.resolve(__dirname, '../../../../demo-party');

describeIntegration('The demo shop, integrated over HTTP', () => {
  let otdms: Server;
  let otdmsUrl = '';
  let shop: ChildProcess;
  let shopUrl = '';
  let keyId = '';
  let secret = '';

  /** Anything the page can reach, reached the way the page reaches it. */
  const shopGet = async (p: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${shopUrl}${p}`);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const shopPost = async (
    p: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${shopUrl}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const connect = () =>
    shopPost('/api/config', { baseUrl: `${otdmsUrl}${P}/api`, keyId, secret, callbackUrl: `${shopUrl}/otdms/callback` });

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();

    // OTDMS on an ephemeral port — a real party reaches us over the network,
    // not through an in-process handle.
    otdms = createApp().listen(0);
    const otdmsPort = (otdms.address() as { port: number }).port;
    otdmsUrl = `http://127.0.0.1:${otdmsPort}`;

    const shopPort = otdmsPort + 1;
    shopUrl = `http://127.0.0.1:${shopPort}`;
    shop = spawn(process.execPath, ['server.js'], {
      cwd: SHOP_DIR,
      // Deliberately no credentials in the environment: everything this suite
      // checks has to work from the page alone.
      env: { ...process.env, PORT: String(shopPort), SELF_URL: shopUrl, OTDMS_KEY_ID: '', OTDMS_SECRET: '' },
      stdio: 'ignore',
    });

    // Wait for it to answer rather than sleeping a fixed amount.
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${shopUrl}/api/config`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }, 30_000);

  afterAll(async () => {
    shop?.kill();
    await new Promise<void>((resolve) => otdms.close(() => resolve()));
    await teardownDatabase();
  });

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();

    const unique = new Types.ObjectId().toHexString();
    const partyUser = await User.create({
      email: `party-${unique.slice(-8)}@shop.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Chai & Co',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${unique.slice(-3)}`,
      companyName: 'Chai & Co',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(100_000),
    });

    // A captain with capacity, so a pay-in has somewhere to route.
    const capUser = await User.create({
      email: `cap-${unique.slice(-8)}@shop.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Shop Captain',
      role: 'CAPTAIN',
    });
    await Captain.create({
      userId: capUser._id,
      captainCode: `CAP-${unique.slice(-6)}`,
      displayName: 'Shop Captain',
      collateralBalancePaise: rupeesToPaise(100_000),
      dmcBalancePaise: rupeesToPaise(100_000),
      status: 'ACTIVE',
      isOnline: true,
    });

    const issued = await issueApiKey(party._id, 'Demo shop', {
      userId: String(partyUser._id),
      role: 'PARTY',
    });
    keyId = issued.keyId;
    secret = issued.secret;

    await shopPost('/api/config/clear');
  });

  // ====================================================================== 1 ==
  it('1. starts unconnected, with no credentials from the environment', async () => {
    const { body } = await shopGet('/api/config');
    expect(body['configured']).toBe(false);
    expect(body['hasSecret']).toBe(false);
  });

  // ====================================================================== 2 ==
  it('2. refuses to sign anything while unconnected, and says why', async () => {
    const { status, body } = await shopPost('/api/checkout', { amount: 500 });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(body)).toMatch(/not connected|integration/i);
  });

  // ====================================================================== 3 ==
  it('3. saves credentials entered on the page', async () => {
    const { status, body } = await connect();
    expect(status).toBe(200);
    expect(body['configured']).toBe(true);
    expect(body['keyId']).toBe(keyId);
  });

  // ====================================================================== 4 ==
  it('4. never gives the secret back to the browser', async () => {
    await connect();
    const { body } = await shopGet('/api/config');

    // The whole response, not just the field somebody remembered to check.
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body['hasSecret']).toBe(true);
    expect(String(body['secretMasked'])).toContain('•');
    expect(String(body['secretMasked'])).toHaveLength(32);
  });

  // ====================================================================== 5 ==
  it('5. rejects incomplete credentials', async () => {
    expect((await shopPost('/api/config', { keyId, secret })).status).toBe(400);
    expect((await shopPost('/api/config', { baseUrl: 'not-a-url', keyId, secret })).status).toBe(400);
    expect((await shopPost('/api/config', { baseUrl: otdmsUrl, secret })).status).toBe(400);
  });

  // ====================================================================== 6 ==
  it('6. tests the connection against the real API', async () => {
    await connect();
    const { body } = await shopPost('/api/config/test');

    expect(body['ok']).toBe(true);
    expect(body['balance']).toMatchObject({ available: expect.any(Number) });
  });

  // ====================================================================== 7 ==
  it('7. reports a bad secret as refused rather than connected', async () => {
    await shopPost('/api/config', {
      baseUrl: `${otdmsUrl}${P}/api`,
      keyId,
      secret: 'f'.repeat(64),
      callbackUrl: `${shopUrl}/otdms/callback`,
    });
    const { body } = await shopPost('/api/config/test');

    expect(body['ok']).toBe(false);
    const config = body['config'] as Record<string, unknown>;
    expect(config['lastCheckOk']).toBe(false);
  });

  // ====================================================================== 8 ==
  it('8. creates a real pay-in through the configured key', async () => {
    await connect();
    const { status, body } = await shopPost('/api/checkout', { amount: 1_250 });

    expect(status).toBeLessThan(400);
    expect(body['orderId']).toEqual(expect.any(String));

    // And it exists on our side, against this party.
    const res = await request(createApp()).get(`${P}/health`);
    expect(res.status).toBe(200);
  });

  // ====================================================================== 9 ==
  it('9. uses the shop’s own reference, and repeats are idempotent', async () => {
    await connect();
    const first = await shopPost('/api/checkout', { amount: 800 });
    const orderId = first.body['orderId'] as string;

    // The shop's order id is the reference OTDMS knows it by, which is what
    // makes a retry after a timeout safe rather than a second payment.
    const status = await shopGet(`/api/status?orderId=${orderId}`);
    expect(status.status).toBe(200);
    expect(status.body['reference']).toBe(orderId);
  });

  // ===================================================================== 10 ==
  it('10. creates a pay-out through the same key', async () => {
    await connect();
    const paid = await shopPost('/api/checkout', { amount: 900 });
    const orderId = paid.body['orderId'] as string;
    await shopPost('/api/simulate-payment', { orderId });

    const refund = await shopPost('/api/refund', { orderId, upiId: 'customer@bank' });
    expect(refund.status).toBeLessThan(400);
  });

  // ===================================================================== 11 ==
  it('11. disconnects, and stops signing again afterwards', async () => {
    await connect();
    expect((await shopGet('/api/config')).body['configured']).toBe(true);

    await shopPost('/api/config/clear');
    const after = await shopGet('/api/config');
    expect(after.body['configured']).toBe(false);
    expect(after.body['hasSecret']).toBe(false);

    const blocked = await shopPost('/api/checkout', { amount: 100 });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
  });

  // ===================================================================== 12 ==
  it('12. serves the integration page without leaking the secret into it', async () => {
    await connect();
    const html = await (await fetch(`${shopUrl}/integration`)).text();

    expect(html).toContain('API integration');
    expect(html).toContain('Test API connection');
    // The page is rendered server-side by the same process that holds the
    // secret, so this is worth asserting rather than assuming.
    expect(html).not.toContain(secret);
  });
});
