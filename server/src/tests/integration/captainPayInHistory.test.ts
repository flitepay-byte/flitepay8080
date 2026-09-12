/**
 * Captain → Pay In is the customer payments they received, and nothing else.
 *
 * The tab used to be the captain asking a party for their earned DMC in
 * rupees: a request form, a list of requests, and one payment-activity row per
 * source party with a confirm-or-dispute handshake on each. None of that
 * belonged under a heading named for money coming in, and none of it is
 * reachable any more — the routes are gone, not merely hidden.
 *
 * What these tests hold is the replacement: this captain's pay-ins, all of
 * them, newest first, ten to a page, and never anybody else's.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Transaction, Session, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { signAccessToken, ACCESS_COOKIE } from '../../services/token.service';
import { rupeesToPaise } from '../../utils/money';
import type { TransactionState } from '../../types/transaction';

interface Row {
  id: string;
  code: string;
  direction: string;
  status: string;
  amount: number;
  commission: number;
}

interface Page { items: Row[]; page: number; totalPages: number; total: number }

describeIntegration('the captain’s pay-in history', () => {
  const app = createApp();

  let cookie: string;
  let captainId: Types.ObjectId;
  let partyId: Types.ObjectId;
  let seq = 0;

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');

    const partyUser = await User.create({
      email: `party-${unique}@payin.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Pay-in Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(100_000),
    });
    partyId = party._id;

    const captainUser = await User.create({
      email: `cap-${unique}@payin.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Pay-in Captain',
      collateralBalancePaise: rupeesToPaise(50_000),
      dmcBalancePaise: rupeesToPaise(50_000),
      isOnline: true,
      status: 'ACTIVE',
    });
    captainId = captain._id;

    const sid = new Types.ObjectId().toHexString();
    await Session.create({
      sessionId: sid,
      userId: captainUser._id,
      refreshTokenHash: 'test-session-not-refreshed',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    cookie = `${ACCESS_COOKIE}=${signAccessToken({
      sub: String(captainUser._id),
      role: 'CAPTAIN',
      email: captainUser.email,
      sid,
      captainId: String(captain._id),
    })}`;
  });

  async function payIn(
    amount: number,
    status: TransactionState = 'SETTLED',
    owner: Types.ObjectId | null = captainId,
  ): Promise<string> {
    seq += 1;
    const code = `PIN-HIST-${seq}`;
    await Transaction.create({
      transactionCode: code,
      partyId,
      captainId: owner,
      direction: 'PAY_IN',
      status,
      amountPaise: rupeesToPaise(amount),
      commissionPaise: rupeesToPaise(amount * 0.01),
      partyReference: `REF-${seq}`,
      expiresAt: new Date(Date.now() + 900_000),
      createdAt: new Date(Date.now() + seq * 1000),
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });
    return code;
  }

  const history = async (page = 1, limit = 10): Promise<Page> => {
    const res = await request(app)
      .get(`/api/v1/captain/pay-ins?page=${page}&limit=${limit}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body.data as Page;
  };

  // =====================================================================
  // What it lists
  // =====================================================================

  it('lists the pay-ins this captain received', async () => {
    await payIn(1_000);
    await payIn(2_500);

    const page = await history();
    expect(page.items).toHaveLength(2);
    expect(page.items.every((r) => r.direction === 'PAY_IN')).toBe(true);
  });

  it('lists the newest first', async () => {
    await payIn(100);
    await payIn(200);
    await payIn(300);

    expect((await history()).items.map((r) => r.amount)).toEqual([300, 200, 100]);
  });

  it('includes the ones that never got paid, not only the settled', async () => {
    await payIn(100, 'SETTLED');
    await payIn(200, 'EXPIRED');
    await payIn(300, 'AWAITING_CUSTOMER');
    await payIn(400, 'DISPUTED');

    // An expired or disputed payment is exactly what a captain opens their
    // history to find. Listing only the settled ones would show them only the
    // things that already went right.
    const page = await history();
    expect(page.items).toHaveLength(4);
    expect(page.items.map((r) => r.status).sort()).toEqual(
      ['AWAITING_CUSTOMER', 'DISPUTED', 'EXPIRED', 'SETTLED'],
    );
  });

  it('leaves out another captain’s pay-ins', async () => {
    await payIn(100);
    await payIn(999, 'SETTLED', new Types.ObjectId());

    const page = await history();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.amount).toBe(100);
  });

  it('leaves out a pay-in nobody has taken yet', async () => {
    await payIn(100);
    await payIn(500, 'CREATED', null);

    // Unassigned work belongs in the queue, not in a history of what this
    // captain handled.
    const page = await history();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.amount).toBe(100);
  });

  it('is empty, not broken, when there are none', async () => {
    const page = await history();
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  // =====================================================================
  // Paging
  // =====================================================================

  it('fits ten on a page', async () => {
    for (let i = 0; i < 10; i += 1) await payIn(100 * (i + 1));

    const page = await history();
    expect(page.items).toHaveLength(10);
    expect(page.totalPages).toBe(1);
  });

  it('splits fifteen across two pages with nothing lost or repeated', async () => {
    for (let i = 0; i < 15; i += 1) await payIn(100 * (i + 1));

    const first = await history(1);
    const second = await history(2);

    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(5);
    expect(first.totalPages).toBe(2);

    const ids = [...first.items, ...second.items].map((r) => r.id);
    expect(new Set(ids).size).toBe(15);

    // Still descending across the boundary: 1,500 down to 100.
    const amounts = [...first.items, ...second.items].map((r) => r.amount);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  });

  // =====================================================================
  // The old flow is gone, not hidden
  // =====================================================================

  it('no longer answers the withdrawal routes at all', async () => {
    // Removed from the router, so these are 404 rather than 403 or an empty
    // list. Hiding the screen while the endpoints still worked would have left
    // the flow reachable by anything that kept the URL.
    for (const path of ['/api/v1/captain/withdrawals', '/api/v1/captain/withdrawal-portions']) {
      const res = await request(app).get(path).set('Cookie', cookie);
      expect(res.status).toBe(404);
    }
  });
});
