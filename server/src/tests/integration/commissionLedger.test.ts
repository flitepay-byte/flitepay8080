/**
 * The captain's commission ledger.
 *
 * Two things were wrong with it, and they had the same root: the screen read
 * the Commission collection, which holds a row per completed *pay-out task*
 * and nothing else. So a captain who had spent the week taking pay-ins opened
 * their Earnings tab and saw an empty ledger next to a wallet that had visibly
 * grown — and the page itself blanked out whenever there *were* rows, because
 * it rendered a `mode` field that had been removed with the old commission
 * scheme and crashed on the undefined.
 *
 * The ledger now reads the wallet entries instead. `payCommissionToCaptain`
 * writes one for a settled pay-in and a completed pay-out alike, so it is the
 * single source that has both — and it records what was actually *paid*, which
 * is what a captain is owed an honest account of.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, Transaction, WalletEntry, Session, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { signAccessToken, ACCESS_COOKIE } from '../../services/token.service';
import { rupeesToPaise } from '../../utils/money';

interface LedgerRow {
  id: string;
  direction: 'PAY_IN' | 'PAY_OUT' | null;
  reference: string | null;
  amount: number | null;
  commission: number;
  earnedAt: string;
}

interface LedgerPage {
  items: LedgerRow[];
  page: number;
  totalPages: number;
  total: number;
  totalEarned: number;
  entryCount: number;
}

describeIntegration('the captain’s commission ledger', () => {
  const app = createApp();
  const adminId = new Types.ObjectId();

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
    await updateConfig(
      {
        payInPartyCommissionPercentage: 3, payInCaptainCommissionPercentage: 2,
        payOutPartyCommissionPercentage: 7, payOutCaptainCommissionPercentage: 2,
      },
      adminId,
    );

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');

    const partyUser = await User.create({
      email: `party-${unique}@ledger.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Ledger Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(100_000),
    });
    partyId = party._id;

    const captainUser = await User.create({
      email: `cap-${unique}@ledger.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Ledger Captain',
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
    // The captain profile id rides in the token — that is where the routes
    // read it from, not from a lookup.
    const token = signAccessToken({
      sub: String(captainUser._id),
      role: 'CAPTAIN',
      email: captainUser.email,
      sid,
      captainId: String(captain._id),
    });
    cookie = `${ACCESS_COOKIE}=${token}`;
  });

  // ---------------------------------------------------------------------
  // Building history directly, so a case takes a few rows rather than a
  // full walk through the workflow for each one.
  // ---------------------------------------------------------------------

  async function payInCommission(amount: number, commission: number): Promise<string> {
    seq += 1;
    const code = `PIN-LEDGER-${seq}`;
    await Transaction.create({
      transactionCode: code,
      partyId,
      captainId,
      direction: 'PAY_IN',
      status: 'SETTLED',
      amountPaise: rupeesToPaise(amount),
      partyReference: `REF-IN-${seq}`,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });
    await WalletEntry.create({
      captainId,
      kind: 'COMMISSION_EARNED',
      amountPaise: rupeesToPaise(commission),
      walletBalanceAfterPaise: rupeesToPaise(commission),
      sourceReference: code,
      createdAt: new Date(Date.now() + seq * 1000),
    });
    return code;
  }

  async function payOutCommission(amount: number, commission: number): Promise<string> {
    seq += 1;
    const code = `TASK-LEDGER-${seq}`;
    await Task.create({
      taskCode: code,
      partyId,
      captainId,
      customerName: 'Ledger Customer',
      identifier: `UPI-${seq}`,
      amountPaise: rupeesToPaise(amount),
      externalRef: `EXT-${seq}`,
      status: 'COMPLETED',
      createdBy: partyId,
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });
    await WalletEntry.create({
      captainId,
      kind: 'COMMISSION_EARNED',
      amountPaise: rupeesToPaise(commission),
      walletBalanceAfterPaise: rupeesToPaise(commission),
      sourceReference: code,
      createdAt: new Date(Date.now() + seq * 1000),
    });
    return code;
  }

  /**
   * The codes the application really generates, not the ones this file makes
   * up. The filter reads their prefixes, so the shapes have to be checked
   * against the generators rather than against the fixtures.
   */
  async function nextTransactionCodeShape(): Promise<{ payIn: string; payOut: string }> {
    const { createPayIn } = await import('../../services/transaction.service');
    const { formatTaskCode } = await import('../../utils/ids');
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: `SHAPE-${Date.now()}`, amountPaise: rupeesToPaise(100) },
      { userId: String(new Types.ObjectId()), role: 'PARTY' },
    );
    return { payIn: transaction.transactionCode, payOut: formatTaskCode('PARTY-001', 2026, 1) };
  }

  const ledger = async (page = 1, limit = 10, direction?: 'PAY_IN' | 'PAY_OUT'): Promise<LedgerPage> => {
    const res = await request(app)
      .get(
        `/api/v1/captain/earnings?page=${page}&limit=${limit}` +
        (direction ? `&direction=${direction}` : ''),
      )
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body.data as LedgerPage;
  };

  // =====================================================================
  // What it shows
  // =====================================================================

  it('shows a pay-in commission, which it never used to', async () => {
    // The original defect: the ledger read the Commission collection, which
    // has no row for a pay-in, so this history was invisible.
    await payInCommission(1_000, 20);

    const page = await ledger();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ direction: 'PAY_IN', amount: 1_000, commission: 20 });
  });

  it('shows a pay-out commission', async () => {
    await payOutCommission(500, 10);

    const page = await ledger();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ direction: 'PAY_OUT', amount: 500, commission: 10 });
  });

  it('puts both kinds in the one list', async () => {
    await payInCommission(1_000, 20);
    await payOutCommission(500, 10);

    const page = await ledger();
    expect(page.items).toHaveLength(2);
    expect(page.items.map((i) => i.direction).sort()).toEqual(['PAY_IN', 'PAY_OUT']);
  });

  it('lists the newest first', async () => {
    await payInCommission(1_000, 20);
    await payOutCommission(500, 10);
    await payInCommission(300, 6);

    const page = await ledger();
    expect(page.items.map((i) => i.commission)).toEqual([6, 10, 20]);
  });

  it('adds up only what was actually paid', async () => {
    await payInCommission(1_000, 20);
    await payOutCommission(500, 10);

    const page = await ledger();
    expect(page.totalEarned).toBe(30);
    expect(page.entryCount).toBe(2);
  });

  it('is empty, not broken, when nothing has been earned', async () => {
    const page = await ledger();
    expect(page.items).toEqual([]);
    expect(page.totalEarned).toBe(0);
    expect(page.entryCount).toBe(0);
    // One page, which happens to be empty — the app's convention everywhere,
    // and what keeps the pagination bar hidden rather than showing "page 1 of 0".
    expect(page.totalPages).toBe(1);
  });

  it('still lists a fee whose payment has since gone', async () => {
    // The money was earned even if the thing it was earned on is no longer
    // there. Hiding the row would understate what the captain was paid.
    seq += 1;
    await WalletEntry.create({
      captainId,
      kind: 'COMMISSION_EARNED',
      amountPaise: rupeesToPaise(15),
      walletBalanceAfterPaise: rupeesToPaise(15),
      sourceReference: 'PIN-GONE-1',
    });

    const page = await ledger();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ direction: null, amount: null, commission: 15 });
    expect(page.totalEarned).toBe(15);
  });

  it('leaves another captain’s commission out of it', async () => {
    await payInCommission(1_000, 20);
    await WalletEntry.create({
      captainId: new Types.ObjectId(),
      kind: 'COMMISSION_EARNED',
      amountPaise: rupeesToPaise(999),
      walletBalanceAfterPaise: rupeesToPaise(999),
      sourceReference: 'PIN-SOMEBODY-ELSE',
    });

    const page = await ledger();
    expect(page.items).toHaveLength(1);
    expect(page.totalEarned).toBe(20);
  });

  // =====================================================================
  // Filtering by direction
  // =====================================================================

  it('narrows to pay-ins when asked', async () => {
    await payInCommission(1_000, 20);
    await payOutCommission(500, 10);
    await payInCommission(300, 6);

    const page = await ledger(1, 10, 'PAY_IN');
    expect(page.items).toHaveLength(2);
    expect(page.items.every((i) => i.direction === 'PAY_IN')).toBe(true);
  });

  it('narrows to pay-outs when asked', async () => {
    await payInCommission(1_000, 20);
    await payOutCommission(500, 10);
    await payOutCommission(200, 4);

    const page = await ledger(1, 10, 'PAY_OUT');
    expect(page.items).toHaveLength(2);
    expect(page.items.every((i) => i.direction === 'PAY_OUT')).toBe(true);
  });

  it('totals only the side being shown', async () => {
    await payInCommission(1_000, 20);
    await payOutCommission(500, 10);

    // The headline has to agree with the list under it. A total that still
    // counted the whole ledger would contradict the rows on screen.
    expect((await ledger(1, 10, 'PAY_IN')).totalEarned).toBe(20);
    expect((await ledger(1, 10, 'PAY_OUT')).totalEarned).toBe(10);
    expect((await ledger()).totalEarned).toBe(30);
  });

  it('says so plainly when one side is empty', async () => {
    await payInCommission(1_000, 20);

    const page = await ledger(1, 10, 'PAY_OUT');
    expect(page.items).toEqual([]);
    expect(page.entryCount).toBe(0);
  });

  it('pages a filtered list on its own count', async () => {
    for (let i = 0; i < 12; i += 1) await payInCommission(100, i + 1);
    await payOutCommission(500, 99);

    const filtered = await ledger(1, 10, 'PAY_IN');
    expect(filtered.items).toHaveLength(10);
    expect(filtered.totalPages).toBe(2);
    expect((await ledger(2, 10, 'PAY_IN')).items).toHaveLength(2);
  });

  /**
   * The filter matches on the reference's prefix, because the direction is a
   * property of the payment rather than of the wallet entry. Both prefixes are
   * generated in exactly one place — `transaction.service.ts` and
   * `utils/ids.ts` — so this pins them: change either format and the failure
   * lands here rather than quietly emptying the filter on the screen.
   */
  it('rests on the code prefixes, which are pinned here', async () => {
    const payInCode = await payInCommission(1_000, 20);
    const payOutCode = await payOutCommission(500, 10);

    expect(payInCode.startsWith('PIN-')).toBe(true);
    expect(payOutCode.startsWith('TASK-')).toBe(true);

    const real = await nextTransactionCodeShape();
    expect(real.payIn.startsWith('PIN-')).toBe(true);
    expect(real.payOut.startsWith('TASK-')).toBe(true);
  });

  // =====================================================================
  // Paging
  // =====================================================================

  it('fits ten on a page and says there is one page', async () => {
    for (let i = 0; i < 10; i += 1) await payInCommission(100 * (i + 1), i + 1);

    const page = await ledger();
    expect(page.items).toHaveLength(10);
    expect(page.totalPages).toBe(1);
  });

  it('splits fifteen across two pages with nothing lost or repeated', async () => {
    for (let i = 0; i < 15; i += 1) await payInCommission(100, i + 1);

    const first = await ledger(1);
    const second = await ledger(2);

    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(5);
    expect(first.totalPages).toBe(2);

    // Every entry appears exactly once across the two pages.
    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(15);
    expect(ids).toHaveLength(15);

    // And they are still in order across the boundary: 15 down to 1.
    const commissions = [...first.items, ...second.items].map((i) => i.commission);
    expect(commissions).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('reports the same total on every page', async () => {
    for (let i = 0; i < 15; i += 1) await payInCommission(100, 2);

    expect((await ledger(1)).totalEarned).toBe(30);
    expect((await ledger(2)).totalEarned).toBe(30);
    expect((await ledger(1)).entryCount).toBe(15);
    expect((await ledger(2)).entryCount).toBe(15);
  });
});
