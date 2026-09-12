/**
 * Admin can see both sides of what a captain does, from the captain's profile.
 *
 * A captain earns two ways, and the two are stored differently: a pay-out is a
 * Task, a pay-in is a Transaction. The profile page listed only the tasks, so
 * admin could open a captain who had taken twenty payments that morning and be
 * shown an empty screen — and then settle an argument about that captain
 * without ever seeing the payments the argument was about.
 *
 * The rule these tests hold: whichever direction the money went, admin can find
 * it under the captain who handled it, scoped to that captain and nobody else.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Transaction, Session, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { signAccessToken, ACCESS_COOKIE } from '../../services/token.service';
import { rupeesToPaise } from '../../utils/money';

interface TxnRow {
  id: string;
  code: string;
  direction: string;
  status: string;
  amount: number;
  captainId: string | null;
  partyName: string | null;
}

describeIntegration('a captain’s pay-ins on the admin profile', () => {
  const app = createApp();
  let cookie: string;
  let partyId: Types.ObjectId;
  let mine: Types.ObjectId;
  let theirs: Types.ObjectId;

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

    const adminUser = await User.create({
      email: `admin-${unique}@both.test`, passwordHash: password, name: 'Admin', role: 'ADMIN',
    });
    const partyUser = await User.create({
      email: `party-${unique}@both.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Both Directions Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(100_000),
    });
    partyId = party._id;

    mine = (await makeCaptain('Watched Captain', unique, password))._id;
    theirs = (await makeCaptain('Other Captain', `${unique}b`, password))._id;

    const sid = new Types.ObjectId().toHexString();
    await Session.create({
      sessionId: sid,
      userId: adminUser._id,
      refreshTokenHash: 'test-session-not-refreshed',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const token = signAccessToken({ sub: String(adminUser._id), role: 'ADMIN', email: adminUser.email, sid });
    cookie = `${ACCESS_COOKIE}=${token}`;
  });

  async function makeCaptain(name: string, unique: string, password: string) {
    const user = await User.create({
      email: `cap-${unique}@both.test`, passwordHash: password, name, role: 'CAPTAIN',
    });
    return Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: name,
      collateralBalancePaise: rupeesToPaise(100_000),
      dmcBalancePaise: rupeesToPaise(50_000),
      isOnline: true,
      status: 'ACTIVE',
    });
  }

  let seq = 0;
  async function payIn(captainId: Types.ObjectId, amount: number, status = 'SETTLED'): Promise<void> {
    seq += 1;
    await Transaction.create({
      transactionCode: `TXN-BOTH-${Date.now()}-${seq}`,
      partyId,
      captainId,
      direction: 'PAY_IN',
      status,
      amountPaise: rupeesToPaise(amount),
      partyReference: `REF-${seq}`,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });
  }

  const listFor = async (captainId: Types.ObjectId): Promise<TxnRow[]> => {
    const res = await request(app)
      .get(`/api/v1/admin/transactions?page=1&limit=50&captainId=${String(captainId)}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body.data.items as TxnRow[];
  };

  it('lists the pay-ins this captain handled', async () => {
    await payIn(mine, 1_000);
    await payIn(mine, 2_500);

    const rows = await listFor(mine);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.captainId === String(mine))).toBe(true);
    expect(rows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([1_000, 2_500]);
  });

  it('shows none of another captain’s', async () => {
    await payIn(mine, 1_000);
    await payIn(theirs, 9_000);
    await payIn(theirs, 4_000);

    // The whole point of a scoped list: an unscoped one would have made this
    // page a list of everybody's payments under one captain's name.
    const rows = await listFor(mine);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(1_000);
  });

  it('names the party, because admin is the one role that may see across', async () => {
    await payIn(mine, 1_000);

    // A captain must never learn whose money they handled. Admin must, or an
    // argument between the two sides cannot be settled at all.
    const rows = await listFor(mine);
    expect(rows[0]?.partyName).toBe('Both Directions Ltd');
  });

  it('includes payments that never settled, not only the finished ones', async () => {
    await payIn(mine, 1_000, 'SETTLED');
    await payIn(mine, 3_000, 'AWAITING_CUSTOMER');
    await payIn(mine, 800, 'EXPIRED');
    await payIn(mine, 600, 'DISPUTED');

    // An unpaid or disputed payment is exactly the kind admin opens a profile
    // to look at. Listing only the settled ones would hide the problems and
    // show only the things that already went right.
    const rows = await listFor(mine);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.status).sort()).toEqual(
      ['AWAITING_CUSTOMER', 'DISPUTED', 'EXPIRED', 'SETTLED'],
    );
  });

  it('still returns everybody when no captain is named', async () => {
    await payIn(mine, 1_000);
    await payIn(theirs, 9_000);

    const res = await request(app)
      .get('/api/v1/admin/transactions?page=1&limit=50')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
  });

  it('refuses a captain id that is not one', async () => {
    // Rejected at the edge rather than cast into a query that would silently
    // match nothing and look like "this captain has no payments".
    const res = await request(app)
      .get('/api/v1/admin/transactions?page=1&limit=50&captainId=not-an-id')
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
  });
});
