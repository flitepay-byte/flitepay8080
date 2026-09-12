/**
 * Finding a payment the way admin actually looks for one.
 *
 * Somebody rings up with whatever they have in front of them — our code, their
 * own order reference, a UTR off a bank statement, or just a name. Admin should
 * not have to know which of those the search box happens to understand.
 *
 * The two rails are searched separately because they are separate lists on the
 * screen, and separately implemented because they are separate collections: a
 * pay-in is a Transaction and a pay-out is a Task. So each is tested on its
 * own — a term that works on one proves nothing about the other.
 *
 * The trap worth naming: both search helpers write `filter.$or`. Applied one
 * after the other, the second silently discards the first, and a name search
 * would quietly return only the code matches. These tests would catch that.
 */
import '../../globalErrorHandlers';
import request from 'supertest';
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { createApp } from '../../app';
import { User, Party, Captain, Transaction, Task, Session, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { signAccessToken, ACCESS_COOKIE } from '../../services/token.service';
import { env } from '../../config/env';
import { rupeesToPaise } from '../../utils/money';

const P = env.API_PREFIX;

describeIntegration('searching the Payments lists', () => {
  const app = createApp();

  let cookie: string;
  let acme: Types.ObjectId;
  let globex: Types.ObjectId;
  let sharma: Types.ObjectId;
  let khan: Types.ObjectId;

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

    acme = await makeParty('Acme Retail', `${unique}a`, password);
    globex = await makeParty('Globex Trading', `${unique}g`, password);
    sharma = await makeCaptain('Sharma', `${unique}s`, password);
    khan = await makeCaptain('Khan', `${unique}k`, password);

    const adminUser = await User.create({
      email: `admin-${unique}@search.test`, passwordHash: password, name: 'Admin', role: 'ADMIN',
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
      email: `party-${unique}@search.test`, passwordHash: password, name, role: 'PARTY',
    });
    const party = await Party.create({
      userId: user._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: name,
      contactEmail: user.email,
      dmcBalancePaise: rupeesToPaise(500_000),
    });
    return party._id;
  }

  async function makeCaptain(name: string, unique: string, password: string): Promise<Types.ObjectId> {
    const user = await User.create({
      email: `cap-${unique}@search.test`, passwordHash: password, name, role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: name,
      collateralBalancePaise: rupeesToPaise(100_000),
      dmcBalancePaise: rupeesToPaise(500_000),
      status: 'ACTIVE',
    });
    return captain._id;
  }

  const payInCodes = async (search: string): Promise<string[]> => {
    const res = await request(app)
      .get(`${P}/admin/transactions?direction=PAY_IN&page=1&limit=50&search=${encodeURIComponent(search)}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body.data.items as Array<{ code: string }>).map((t) => t.code);
  };

  const payOutCodes = async (search: string): Promise<string[]> => {
    const res = await request(app)
      .get(`${P}/admin/tasks?page=1&limit=50&search=${encodeURIComponent(search)}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body.data.items as Array<{ taskCode: string }>).map((t) => t.taskCode);
  };

  // =========================================================================
  // Pay-in
  // =========================================================================

  describe('pay-ins', () => {
    beforeEach(async () => {
      await Transaction.create([
        {
          transactionCode: 'PIN-TEST-0001',
          partyId: acme,
          captainId: sharma,
          direction: 'PAY_IN',
          status: 'SETTLED',
          amountPaise: rupeesToPaise(1_000),
          partyReference: 'ACME-ORDER-77',
          settlementReference: 'UTR111222333',
          expiresAt: new Date(Date.now() + 900_000),
          stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
        },
        {
          transactionCode: 'PIN-TEST-0002',
          partyId: globex,
          captainId: khan,
          direction: 'PAY_IN',
          status: 'SETTLED',
          amountPaise: rupeesToPaise(2_000),
          partyReference: 'GLOBEX-ORDER-88',
          settlementReference: 'UTR999888777',
          expiresAt: new Date(Date.now() + 900_000),
          stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
        },
      ]);
    });

    it('finds one by our own code', async () => {
      expect(await payInCodes('PIN-TEST-0001')).toEqual(['PIN-TEST-0001']);
    });

    it('finds one by the party’s own reference', async () => {
      expect(await payInCodes('ACME-ORDER-77')).toEqual(['PIN-TEST-0001']);
    });

    it('finds one by the UTR', async () => {
      expect(await payInCodes('UTR999888777')).toEqual(['PIN-TEST-0002']);
    });

    it('finds one by the party’s name', async () => {
      expect(await payInCodes('Acme')).toEqual(['PIN-TEST-0001']);
    });

    it('finds one by the captain’s name', async () => {
      expect(await payInCodes('Khan')).toEqual(['PIN-TEST-0002']);
    });

    it('returns nothing for a name nobody has', async () => {
      // Not "everything". A term matching no one must narrow to an empty set,
      // or "who is Nobody?" is answered with the entire ledger.
      expect(await payInCodes('Nobody At All')).toEqual([]);
    });
  });

  // =========================================================================
  // Pay-out
  // =========================================================================

  describe('pay-outs', () => {
    beforeEach(async () => {
      await Task.create([
        {
          taskCode: 'TASK-SEARCH-0001',
          partyId: acme,
          captainId: sharma,
          customerName: 'Rahul Verma',
          identifier: 'rahul@bank',
          amountPaise: rupeesToPaise(3_000),
          externalRef: 'ACME-PAYOUT-11',
          providerReference: 'NEFT555444333',
          status: 'COMPLETED',
          createdBy: new Types.ObjectId(),
          stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
        },
        {
          taskCode: 'TASK-SEARCH-0002',
          partyId: globex,
          captainId: khan,
          customerName: 'Priya Nair',
          identifier: 'priya@bank',
          amountPaise: rupeesToPaise(4_000),
          externalRef: 'GLOBEX-PAYOUT-22',
          providerReference: 'NEFT000111222',
          status: 'COMPLETED',
          createdBy: new Types.ObjectId(),
          stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
        },
      ]);
    });

    it('finds one by the task code', async () => {
      expect(await payOutCodes('TASK-SEARCH-0002')).toEqual(['TASK-SEARCH-0002']);
    });

    it('finds one by the party’s own reference', async () => {
      expect(await payOutCodes('ACME-PAYOUT-11')).toEqual(['TASK-SEARCH-0001']);
    });

    it('finds one by the UTR the captain reported', async () => {
      expect(await payOutCodes('NEFT000111222')).toEqual(['TASK-SEARCH-0002']);
    });

    it('finds one by the party’s name', async () => {
      expect(await payOutCodes('Globex')).toEqual(['TASK-SEARCH-0002']);
    });

    it('finds one by the captain’s name', async () => {
      // The clause most at risk: it is the one merged in alongside the text
      // matches, and a careless merge drops it without any error.
      expect(await payOutCodes('Sharma')).toEqual(['TASK-SEARCH-0001']);
    });

    it('still finds one by the beneficiary’s name', async () => {
      // The search that already worked, checked so widening it did not
      // displace what was there.
      expect(await payOutCodes('Priya')).toEqual(['TASK-SEARCH-0002']);
    });

    it('returns nothing for a name nobody has', async () => {
      expect(await payOutCodes('Nobody At All')).toEqual([]);
    });
  });

  // =========================================================================
  // Both sides named on the row
  // =========================================================================

  it('names the party and the captain on a pay-out row', async () => {
    // Admin's list is the only one that may name both, and the screen needs
    // them by name rather than by id.
    await Task.create({
      taskCode: 'TASK-NAMED-0001',
      partyId: acme,
      captainId: sharma,
      customerName: 'Rahul Verma',
      identifier: 'rahul@bank',
      amountPaise: rupeesToPaise(3_000),
      externalRef: 'ACME-NAMED-1',
      status: 'COMPLETED',
      createdBy: new Types.ObjectId(),
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });

    const res = await request(app).get(`${P}/admin/tasks?page=1&limit=10`).set('Cookie', cookie);
    const row = res.body.data.items[0] as Record<string, unknown>;
    expect(row['partyName']).toBe('Acme Retail');
    expect(row['captainName']).toBe('Sharma');
    expect(row['partyCode']).toBeTruthy();
    expect(row['captainCode']).toBeTruthy();
  });

  it('says nothing rather than guessing when no captain holds the task', async () => {
    await Task.create({
      taskCode: 'TASK-NAMED-0002',
      partyId: acme,
      captainId: null,
      customerName: 'Rahul Verma',
      identifier: 'rahul@bank',
      amountPaise: rupeesToPaise(3_000),
      externalRef: 'ACME-NAMED-2',
      status: 'CREATED',
      createdBy: new Types.ObjectId(),
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });

    const res = await request(app).get(`${P}/admin/tasks?page=1&limit=10`).set('Cookie', cookie);
    const row = res.body.data.items[0] as Record<string, unknown>;
    expect(row['partyName']).toBe('Acme Retail');
    expect(row['captainName']).toBeNull();
  });
});
