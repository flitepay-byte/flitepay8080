/**
 * A party's pay-in history on the admin profile, with the captain named.
 *
 * Admin is the only role that may see a party and a captain together — a party
 * never learns who handled their customer's payment and a captain never learns
 * whose customer paid them — and this is admin's own view of one party, so
 * both sides are named on the same row.
 *
 * The part that has to hold under pressure is the scoping. Two parties'
 * customers must never appear in one another's history: that is not a display
 * preference, it is the boundary the whole product rests on. So it is enforced
 * on the server by the query, and these tests pin it there rather than trusting
 * a filter applied after the fetch.
 *
 * Nothing new is stored for any of this. The captain is the one already
 * assigned to the payment, and the reference is the party's own id for the
 * order — the panel only shows what was recorded when the payment was taken.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Transaction, Task, Session, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { signAccessToken, ACCESS_COOKIE } from '../../services/token.service';
import { env } from '../../config/env';
import { rupeesToPaise } from '../../utils/money';

const P = env.API_PREFIX;

interface Row {
  id: string;
  code: string;
  direction: string;
  status: string;
  amount: number;
  partyId: string;
  partyName: string | null;
  captainId: string | null;
  captainName: string | null;
  captainCode: string | null;
  partyReference: string;
  createdAt: string;
}

describeIntegration('a party’s pay-in history on the admin profile', () => {
  const app = createApp();

  let cookie: string;
  let partyA: Types.ObjectId;
  let partyB: Types.ObjectId;
  let raj: Types.ObjectId;
  let other: Types.ObjectId;
  let seq = 0;

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    seq = 0;

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');

    partyA = await makeParty('Party A', `${unique}a`, password);
    partyB = await makeParty('Party B', `${unique}b`, password);
    raj = await makeCaptain('Raj', `${unique}r`, password);
    other = await makeCaptain('Other Captain', `${unique}o`, password);

    const adminUser = await User.create({
      email: `admin-${unique}@payins.test`, passwordHash: password, name: 'Admin', role: 'ADMIN',
    });
    const sid = new Types.ObjectId().toHexString();
    await Session.create({
      sessionId: sid,
      userId: adminUser._id,
      refreshTokenHash: 'test-session-not-refreshed',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    cookie = `${ACCESS_COOKIE}=${signAccessToken({
      sub: String(adminUser._id), role: 'ADMIN', email: adminUser.email, sid,
    })}`;
  });

  async function makeParty(name: string, unique: string, password: string): Promise<Types.ObjectId> {
    const user = await User.create({
      email: `party-${unique}@payins.test`, passwordHash: password, name, role: 'PARTY',
    });
    const party = await Party.create({
      userId: user._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: name,
      contactEmail: user.email,
      dmcBalancePaise: rupeesToPaise(100_000),
    });
    return party._id;
  }

  async function makeCaptain(name: string, unique: string, password: string): Promise<Types.ObjectId> {
    const user = await User.create({
      email: `cap-${unique}@payins.test`, passwordHash: password, name, role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: name,
      collateralBalancePaise: rupeesToPaise(100_000),
      dmcBalancePaise: rupeesToPaise(50_000),
      isOnline: true,
      status: 'ACTIVE',
    });
    return captain._id;
  }

  async function payIn(opts: {
    party: Types.ObjectId;
    captain?: Types.ObjectId | null;
    amount: number;
    reference?: string;
    status?: string;
  }): Promise<void> {
    seq += 1;
    await Transaction.create({
      transactionCode: `TXN-PI-${Date.now()}-${seq}`,
      partyId: opts.party,
      captainId: opts.captain ?? null,
      direction: 'PAY_IN',
      status: opts.status ?? 'SETTLED',
      amountPaise: rupeesToPaise(opts.amount),
      partyReference: opts.reference ?? `REF-${seq}`,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });
  }

  const historyOf = async (party: Types.ObjectId, limit = 10): Promise<Row[]> => {
    const res = await request(app)
      .get(`${P}/admin/transactions?direction=PAY_IN&partyId=${String(party)}&page=1&limit=${limit}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body.data.items as Row[];
  };

  // =========================================================================
  // The captain on the row
  // =========================================================================

  it('names the captain who took the payment', async () => {
    // The client's example: Party A's customer pays 1,000, Raj takes it.
    await payIn({ party: partyA, captain: raj, amount: 1_000, reference: 'ORDER-RAHUL' });

    const [row] = await historyOf(partyA);
    expect(row?.amount).toBe(1_000);
    expect(row?.captainName).toBe('Raj');
    expect(row?.captainId).toBe(String(raj));
    // The party's own reference for the order, which is how they name the
    // customer it came from — a pay-in carries no customer name of ours.
    expect(row?.partyReference).toBe('ORDER-RAHUL');
  });

  it('carries the captain’s code alongside the name', async () => {
    // Two captains can share a display name; the code is what settles which.
    await payIn({ party: partyA, captain: raj, amount: 500 });

    const [row] = await historyOf(partyA);
    const captain = await Captain.findById(raj).lean();
    expect(row?.captainCode).toBe(captain?.captainCode);
  });

  it('says nothing rather than guessing when no captain has taken it yet', async () => {
    // A payment still in CREATED has not been assigned. The column has to
    // survive that without inventing a captain.
    await payIn({ party: partyA, captain: null, amount: 700, status: 'CREATED' });

    const [row] = await historyOf(partyA);
    expect(row?.captainId).toBeNull();
    expect(row?.captainName).toBeNull();
  });

  it('names a different captain per payment', async () => {
    await payIn({ party: partyA, captain: raj, amount: 100, reference: 'ONE' });
    await payIn({ party: partyA, captain: other, amount: 200, reference: 'TWO' });

    const rows = await historyOf(partyA);
    const byReference = new Map(rows.map((r) => [r.partyReference, r.captainName]));
    expect(byReference.get('ONE')).toBe('Raj');
    expect(byReference.get('TWO')).toBe('Other Captain');
  });

  // =========================================================================
  // The boundary between parties
  // =========================================================================

  it('never mixes two parties’ pay-ins', async () => {
    /**
     * The rule the whole product rests on. Party A's screen must show Party
     * A's customers and nobody else's — enforced by the query rather than by
     * a filter applied after the fetch, which is one refactor from being lost.
     */
    await payIn({ party: partyA, captain: raj, amount: 1_000, reference: 'A-ONE' });
    await payIn({ party: partyA, captain: other, amount: 2_000, reference: 'A-TWO' });
    await payIn({ party: partyB, captain: raj, amount: 9_000, reference: 'B-ONE' });

    const a = await historyOf(partyA);
    expect(a).toHaveLength(2);
    expect(a.every((r) => r.partyId === String(partyA))).toBe(true);
    expect(a.map((r) => r.partyReference).sort()).toEqual(['A-ONE', 'A-TWO']);

    const b = await historyOf(partyB);
    expect(b).toHaveLength(1);
    expect(b[0]?.partyReference).toBe('B-ONE');
  });

  it('keeps them apart even when the same captain served both', async () => {
    // The captain is shared; the histories are not.
    await payIn({ party: partyA, captain: raj, amount: 1_000, reference: 'A-ONLY' });
    await payIn({ party: partyB, captain: raj, amount: 1_000, reference: 'B-ONLY' });

    expect((await historyOf(partyA)).map((r) => r.partyReference)).toEqual(['A-ONLY']);
    expect((await historyOf(partyB)).map((r) => r.partyReference)).toEqual(['B-ONLY']);
  });

  // =========================================================================
  // Pay-outs are not touched
  // =========================================================================

  it('cannot show a pay-out, because a pay-out is not a transaction', async () => {
    /**
     * Not a filter that could be got wrong: a payout is a Task, and
     * TRANSACTION_DIRECTIONS is the one-member union ['PAY_IN'] (see
     * types/transaction.ts). Writing one here is rejected by the schema, so
     * this panel structurally cannot reach the pay-out side — which is why
     * the existing pay-out UI needed no change at all.
     */
    await expect(
      Transaction.create({
        transactionCode: `TXN-PO-${Date.now()}`,
        partyId: partyA,
        captainId: raj,
        direction: 'PAY_OUT',
        status: 'SETTLED',
        amountPaise: rupeesToPaise(999),
        partyReference: 'OUT-1',
        expiresAt: new Date(Date.now() + 15 * 60_000),
        stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
      }),
    ).rejects.toThrow(/not a valid enum value/);

    await payIn({ party: partyA, captain: raj, amount: 1_000 });
    const rows = await historyOf(partyA);
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.direction === 'PAY_IN')).toBe(true);
  });

  it('leaves the party’s task list exactly as it was', async () => {
    // Pay-outs are the task table on the same page, and this change must not
    // have reached it.
    await Task.create({
      taskCode: `TASK-PI-${Date.now()}`,
      partyId: partyA,
      captainId: raj,
      customerName: 'Beneficiary',
      identifier: 'UPI-1',
      amountPaise: rupeesToPaise(4_000),
      externalRef: `EXT-PI-${Date.now()}`,
      status: 'COMPLETED',
      createdBy: new Types.ObjectId(),
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });

    const res = await request(app)
      .get(`${P}/admin/tasks?page=1&limit=10&partyId=${String(partyA)}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  // =========================================================================
  // Reading it
  // =========================================================================

  it('lists newest first', async () => {
    await payIn({ party: partyA, captain: raj, amount: 100, reference: 'OLDEST' });
    await payIn({ party: partyA, captain: raj, amount: 200, reference: 'MIDDLE' });
    await payIn({ party: partyA, captain: raj, amount: 300, reference: 'NEWEST' });

    const rows = await historyOf(partyA);
    expect(rows[0]?.partyReference).toBe('NEWEST');
  });

  it('pages ten at a time without repeating or dropping a row', async () => {
    // Twelve is enough to cross the page boundary and stay readable.
    for (let i = 1; i <= 12; i += 1) {
      await payIn({ party: partyA, captain: raj, amount: i * 10, reference: `PAGE-${i}` });
    }

    const first = await historyOf(partyA, 10);
    const res = await request(app)
      .get(`${P}/admin/transactions?direction=PAY_IN&partyId=${String(partyA)}&page=2&limit=10`)
      .set('Cookie', cookie);
    const second = res.body.data.items as Row[];

    expect(first).toHaveLength(10);
    expect(second).toHaveLength(2);
    expect(res.body.data.total).toBe(12);
    // Every reference exactly once across the two pages.
    const seen = [...first, ...second].map((r) => r.partyReference);
    expect(new Set(seen).size).toBe(12);
  });

  it('is empty, not broken, for a party with no pay-ins', async () => {
    await payIn({ party: partyB, captain: raj, amount: 1_000 });

    expect(await historyOf(partyA)).toEqual([]);
  });
});
