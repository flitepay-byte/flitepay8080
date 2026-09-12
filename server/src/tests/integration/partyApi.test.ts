/**
 * The party API, exercised the way a party's server actually calls it.
 *
 * These tests sign real requests rather than reaching into the services,
 * because the signing scheme is the product here: a party integrating against
 * us will get it wrong in exactly the ways tested below, and every one of them
 * has to fail closed. An endpoint that accepts an unsigned call, or a call
 * whose body was changed in flight, is not a payment API — it is a public
 * button that moves other people's money.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Transaction, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { fundPlatformPool } from '../../services/platformAccount.service';
import { issueApiKey, computeSignature, signingPayload } from '../../services/apiKey.service';
import { gatewayWebhookSignature } from '../../services/upiGateway.service';
import { GATEWAY_SIGNATURE_HEADER } from '../../controllers/gateway.controller';
import { createApp } from '../../app';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('the party API', () => {
  const app = createApp();
  const BASE = '/api/v1/api';

  let partyId: Types.ObjectId;
  let keyId: string;
  let secret: string;

  const OPENING = rupeesToPaise(100_000);

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    await updateConfig(
      {
        // The party is charged, the captain is paid out of it, and what is
        // left is the platform's. Different figures so a mix-up shows.
        payInPartyCommissionPercentage: 3,
        payInCaptainCommissionPercentage: 1,
        payOutPartyCommissionPercentage: 7,
        payOutCaptainCommissionPercentage: 5,
      },
      new Types.ObjectId(),
    );
    await fundPlatformPool(rupeesToPaise(50_000));

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');

    const partyUser = await User.create({
      email: `party-${unique}@api.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'API Commerce',
      contactEmail: partyUser.email,
      dmcBalancePaise: OPENING,
    });
    partyId = party._id;

    const issued = await issueApiKey(party._id, 'Production', {
      userId: String(partyUser._id),
      role: 'PARTY',
    });
    keyId = issued.keyId;
    secret = issued.secret;
  });

  async function makeCaptain(capitalRupees = 50_000): Promise<Types.ObjectId> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@api.test`, passwordHash: await hashPassword('Demo@12345'), name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'API Captain',
      // Security as well as capital, because a deposit splits into both and a
      // captain needs the security: a pay-in is work, and work has to fit
      // under the task limit that security buys. A fixture with capital and no
      // security is a captain who could never take anything.
      collateralBalancePaise: rupeesToPaise(capitalRupees),
      dmcBalancePaise: rupeesToPaise(capitalRupees),
      isOnline: true,
      status: 'ACTIVE',
    });
    return captain._id;
  }

  /**
   * Sign and send, exactly as a party's SDK would. Written once here so the
   * tests below differ only in the thing they are actually testing.
   */
  function call(method: 'get' | 'post', path: string, body?: unknown, overrides: {
    keyId?: string;
    secret?: string;
    timestamp?: string;
    signature?: string;
    bodyOverride?: string;
  } = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
    const fullPath = `${BASE}${path}`;
    const signature =
      overrides.signature ??
      computeSignature(
        overrides.secret ?? secret,
        signingPayload(timestamp, method, fullPath, raw),
      );

    const req = request(app)[method](fullPath)
      .set('x-otdms-key', overrides.keyId ?? keyId)
      .set('x-otdms-timestamp', timestamp)
      .set('x-otdms-signature', signature);

    if (body !== undefined) {
      return req.set('content-type', 'application/json').send(overrides.bodyOverride ?? raw);
    }
    return req;
  }

  // =========================================================================
  // Authentication
  // =========================================================================

  it('refuses a request with no signature at all', async () => {
    const res = await request(app).get(`${BASE}/balance`);
    expect(res.status).toBe(401);
  });

  it('refuses a signature made with the wrong secret', async () => {
    const res = await call('get', '/balance', undefined, { secret: 'not-the-secret' });
    expect(res.status).toBe(401);
  });

  it('refuses a body that changed after it was signed', async () => {
    const captainId = await makeCaptain();
    const honest = { reference: 'TAMPER-1', amount: 100 };
    // Signed for ₹100, sent as ₹100,000 — the attack the signature exists for.
    const res = await call('post', '/payin', honest, {
      bodyOverride: JSON.stringify({ reference: 'TAMPER-1', amount: 100_000 }),
    });

    expect(res.status).toBe(401);
    expect(await Transaction.countDocuments({})).toBe(0);
    // And nobody's capital was touched on the way to being refused.
    const captain = await Captain.findById(captainId).lean();
    expect(paiseToRupees(captain?.dmcBalancePaise ?? 0)).toBe(50_000);
  });

  it('refuses a replayed request from outside the window', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3_600);
    const res = await call('get', '/balance', undefined, { timestamp: stale });
    expect(res.status).toBe(401);
  });

  it('refuses a key that has been revoked', async () => {
    const { revokeApiKey } = await import('../../services/apiKey.service');
    await revokeApiKey(keyId, partyId, { userId: String(new Types.ObjectId()), role: 'PARTY' });

    const res = await call('get', '/balance');
    expect(res.status).toBe(401);
  });

  it('will not let one party sign for another’s data', async () => {
    // A second party with its own key. Its signature is valid — for itself.
    const otherUser = await User.create({
      email: `other-${new Types.ObjectId().toHexString()}@api.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Other',
      role: 'PARTY',
    });
    const otherParty = await Party.create({
      userId: otherUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Other Commerce',
      contactEmail: otherUser.email,
      dmcBalancePaise: rupeesToPaise(5),
    });
    const otherKey = await issueApiKey(otherParty._id, 'Theirs', {
      userId: String(otherUser._id),
      role: 'PARTY',
    });

    await makeCaptain();
    await call('post', '/payin', { reference: 'MINE-1', amount: 100 });

    // Their key, my reference: scoped in the query, so it simply does not exist.
    const res = await call('get', '/transactions/MINE-1', undefined, {
      keyId: otherKey.keyId,
      secret: otherKey.secret,
    });
    expect(res.status).toBe(404);
  });

  // =========================================================================
  // Pay-in
  // =========================================================================

  it('returns a QR the customer can scan', async () => {
    await makeCaptain();
    const res = await call('post', '/payin', { reference: 'ORDER-1', amount: 1_000 });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('AWAITING_CUSTOMER');
    expect(res.body.data.amount).toBe(1_000);
    expect(String(res.body.data.qr.payload)).toContain('upi://pay');
    // The simulation must be unmistakable in what the customer would scan.
    expect(String(res.body.data.qr.payload)).toContain('otdms-simulation');
  });

  it('never tells the party who the captain is', async () => {
    await makeCaptain();
    const res = await call('post', '/payin', { reference: 'ORDER-2', amount: 1_000 });

    const serialised = JSON.stringify(res.body);
    const captain = await Captain.findOne().lean();
    expect(serialised).not.toContain(String(captain?._id));
    expect(serialised).not.toContain(captain?.captainCode ?? 'CAP-');
    expect(res.body.data).not.toHaveProperty('captainId');
  });

  it('says plainly when no captain can take the payment', async () => {
    // Nobody online with any capital at all.
    const res = await call('post', '/payin', { reference: 'ORDER-3', amount: 1_000 });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('NO_CAPTAIN_AVAILABLE');
  });

  it('credits the party exactly what the customer paid, once the gateway says so', async () => {
    const captainId = await makeCaptain();
    const create = await call('post', '/payin', { reference: 'ORDER-4', amount: 1_000 });
    const transaction = await Transaction.findOne({ partyReference: 'ORDER-4' });

    const body = JSON.stringify({
      orderId: transaction?.gatewayOrderId,
      status: 'PAID',
      reference: 'UPI-777',
    });
    const hook = await request(app)
      .post(`${BASE}/gateway/upi/webhook`)
      .set('content-type', 'application/json')
      .set(GATEWAY_SIGNATURE_HEADER, gatewayWebhookSignature(body))
      .send(body);

    expect(hook.status).toBe(200);
    expect(create.status).toBe(201);

    const party = await Party.findById(partyId).lean();
    // The customer paid 1,000 and the captain gave up 1,000 — the amount is
    // never skimmed. The party's 3% fee is charged on top, so they net 970.
    expect(paiseToRupees((party?.dmcBalancePaise ?? 0) - OPENING)).toBe(970);
    const captain = await Captain.findById(captainId).lean();
    // 50,000 less the 1,000 given up, plus the 1% share back.
    expect(paiseToRupees(captain?.dmcBalancePaise ?? 0)).toBe(49_010);
  });

  it('ignores a webhook that is not signed by the gateway', async () => {
    await makeCaptain();
    await call('post', '/payin', { reference: 'ORDER-5', amount: 1_000 });
    const transaction = await Transaction.findOne({ partyReference: 'ORDER-5' });

    const res = await request(app)
      .post(`${BASE}/gateway/upi/webhook`)
      .set('content-type', 'application/json')
      .send({ orderId: transaction?.gatewayOrderId, status: 'PAID' });

    // Without this check the endpoint is a public "credit my account" button.
    expect(res.status).toBe(401);
    const party = await Party.findById(partyId).lean();
    expect(party?.dmcBalancePaise).toBe(OPENING);
  });

  it('settles once when the gateway delivers the same webhook twice', async () => {
    await makeCaptain();
    await call('post', '/payin', { reference: 'ORDER-6', amount: 1_000 });
    const transaction = await Transaction.findOne({ partyReference: 'ORDER-6' });

    const body = JSON.stringify({ orderId: transaction?.gatewayOrderId, status: 'PAID', reference: 'UPI-DUP' });
    const send = () =>
      request(app)
        .post(`${BASE}/gateway/upi/webhook`)
        .set('content-type', 'application/json')
        .set(GATEWAY_SIGNATURE_HEADER, gatewayWebhookSignature(body))
        .send(body);

    await send();
    await send();
    await send();

    const party = await Party.findById(partyId).lean();
    expect(paiseToRupees((party?.dmcBalancePaise ?? 0) - OPENING)).toBe(970);
  });

  it('treats the same reference as the same payment', async () => {
    await makeCaptain();
    const first = await call('post', '/payin', { reference: 'ORDER-7', amount: 1_000 });
    const second = await call('post', '/payin', { reference: 'ORDER-7', amount: 1_000 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    // One payment, one captain, one QR — not two of anything.
    expect(await Transaction.countDocuments({})).toBe(1);
  });

  // =========================================================================
  // Pay-out
  // =========================================================================

  it('accepts a payout and holds the party’s balance for it', async () => {
    await makeCaptain(0);
    const res = await call('post', '/payout', {
      reference: 'PAYOUT-1',
      amount: 5_000,
      beneficiary: { name: 'Customer', upiId: 'customer@bank' },
    });

    expect(res.status).toBe(201);
    // 5,000 plus the 7% the party is charged for it.
    const party = await Party.findById(partyId).lean();
    expect(paiseToRupees(OPENING - (party?.dmcBalancePaise ?? 0))).toBe(5_350);
  });

  it('refuses a payout with nowhere to send it', async () => {
    const res = await call('post', '/payout', {
      reference: 'PAYOUT-2',
      amount: 5_000,
      beneficiary: { name: 'Customer' },
    });

    expect(res.status).toBe(400);
    const party = await Party.findById(partyId).lean();
    expect(party?.dmcBalancePaise).toBe(OPENING);
  });

  it('refuses a payout the party cannot fund', async () => {
    // Above the party's balance but inside the configured task ceiling, so it
    // is the balance that refuses it and not the amount bounds.
    const res = await call('post', '/payout', {
      reference: 'PAYOUT-3',
      amount: 150_000,
      beneficiary: { upiId: 'customer@bank' },
    });

    // 422 rather than 400: the request was well-formed, it just cannot be
    // carried out — which is what the task path has always reported.
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('INSUFFICIENT_DMC_BALANCE');
    const party = await Party.findById(partyId).lean();
    expect(party?.dmcBalancePaise).toBe(OPENING);
  });

  // =========================================================================
  // Reading
  // =========================================================================

  it('reports the balance and what is held against payouts', async () => {
    await makeCaptain(0);
    await call('post', '/payout', {
      reference: 'PAYOUT-4',
      amount: 5_000,
      beneficiary: { upiId: 'customer@bank' },
    });

    const res = await call('get', '/balance');
    expect(res.status).toBe(200);
    // Held is shown rather than netted away, so "where did my money go" has an
    // answer without opening the dashboard.
    // Available plus held adds back to what they had, which is the only way
    // the pair actually answers "where did my money go".
    expect(res.body.data.available).toBe(paiseToRupees(OPENING) - 5_350);
    expect(res.body.data.heldForPayouts).toBe(5_350);
  });

  it('returns one transaction by the party’s own reference', async () => {
    await makeCaptain();
    await call('post', '/payin', { reference: 'ORDER-8', amount: 250 });

    const res = await call('get', '/transactions/ORDER-8');
    expect(res.status).toBe(200);
    expect(res.body.data.reference).toBe('ORDER-8');
    expect(res.body.data.amount).toBe(250);
  });

  it('404s a reference that does not exist', async () => {
    const res = await call('get', '/transactions/NOPE');
    expect(res.status).toBe(404);
  });
});
