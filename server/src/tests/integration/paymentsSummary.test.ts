/**
 * What the Payments totals actually count.
 *
 * A total on a money screen is read as "this is what we handled", so it has to
 * mean exactly that. Two decisions carry the weight, and both are easy to get
 * silently wrong:
 *
 *   - Only money that reached the other end counts. An expired pay-in and a
 *     cancelled pay-out moved nothing, and folding them in would answer "what
 *     did people attempt" under a heading that says "total".
 *   - The buckets are measured by when the money moved, not when the payment
 *     was raised. A pay-in created last night and settled this morning belongs
 *     to this morning — that is the day it landed and the day admin is asked
 *     about.
 *
 * The two rails come from two collections because that is what they are: a
 * pay-in is a Transaction, a pay-out is a Task. Nothing here reads a PAY_OUT
 * transaction, which no longer exists.
 */
import '../../globalErrorHandlers';
import request from 'supertest';
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { createApp } from '../../app';
import { User, Party, Captain, Transaction, Task, Session, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { env } from '../../config/env';
import { rupeesToPaise } from '../../utils/money';
import { istDayBounds, istMonthBounds } from '../../utils/dates';
import { signAccessToken, ACCESS_COOKIE } from '../../services/token.service';

const P = env.API_PREFIX;

interface Bucket { count: number; amount: number }
interface Rail { total: Bucket; today: Bucket; last7Days: Bucket; thisMonth: Bucket }
interface Summary { payIn: Rail; payOut: Rail }

describeIntegration('the Payments totals', () => {
  const app = createApp();

  let cookie: string;
  let partyId: Types.ObjectId;
  let captainId: Types.ObjectId;
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

    const partyUser = await User.create({
      email: `party-${unique}@sum.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Summary Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(1_000_000),
    });
    partyId = party._id;

    const captainUser = await User.create({
      email: `cap-${unique}@sum.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Summary Captain',
      collateralBalancePaise: rupeesToPaise(100_000),
      dmcBalancePaise: rupeesToPaise(1_000_000),
      status: 'ACTIVE',
    });
    captainId = captain._id;

    const adminUser = await User.create({
      email: `admin-${unique}@sum.test`, passwordHash: password, name: 'Admin', role: 'ADMIN',
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

  /** A pay-in that reached the party. `settledAt` is when the money landed. */
  async function settledPayIn(amount: number, settledAt: Date): Promise<void> {
    seq += 1;
    await Transaction.create({
      transactionCode: `TXN-S-${Date.now()}-${seq}`,
      partyId,
      captainId,
      direction: 'PAY_IN',
      status: 'SETTLED',
      amountPaise: rupeesToPaise(amount),
      partyReference: `REF-S-${seq}`,
      settledAt,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      stateHistory: [{ from: null, to: 'CREATED', at: settledAt }],
    });
  }

  /** A pay-in that never reached anybody. */
  async function deadPayIn(amount: number, status: 'EXPIRED' | 'CANCELLED'): Promise<void> {
    seq += 1;
    await Transaction.create({
      transactionCode: `TXN-D-${Date.now()}-${seq}`,
      partyId,
      captainId: null,
      direction: 'PAY_IN',
      status,
      amountPaise: rupeesToPaise(amount),
      partyReference: `REF-D-${seq}`,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });
  }

  /** A pay-out the captain actually made. `completedAt` is when it landed. */
  async function completedPayOut(amount: number, completedAt: Date): Promise<void> {
    seq += 1;
    await Task.create({
      taskCode: `TASK-S-${Date.now()}-${seq}`,
      partyId,
      captainId,
      customerName: 'Beneficiary',
      identifier: `UPI-${seq}`,
      amountPaise: rupeesToPaise(amount),
      externalRef: `EXT-S-${Date.now()}-${seq}`,
      status: 'COMPLETED',
      completedAt,
      createdBy: new Types.ObjectId(),
      stateHistory: [{ from: null, to: 'CREATED', at: completedAt }],
    });
  }

  /** A pay-out that never happened. */
  async function deadPayOut(amount: number, status: 'CANCELLED' | 'EXPIRED'): Promise<void> {
    seq += 1;
    await Task.create({
      taskCode: `TASK-D-${Date.now()}-${seq}`,
      partyId,
      captainId: null,
      customerName: 'Beneficiary',
      identifier: `UPI-D-${seq}`,
      amountPaise: rupeesToPaise(amount),
      externalRef: `EXT-D-${Date.now()}-${seq}`,
      status,
      createdBy: new Types.ObjectId(),
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });
  }

  const summary = async (): Promise<Summary> => {
    const res = await request(app).get(`${P}/admin/payments/summary`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body.data as Summary;
  };

  /** Midday today in IST, safely inside the day whichever way the clock sits. */
  const today = (): Date => new Date(istDayBounds().start.getTime() + 12 * 60 * 60_000);
  const daysAgo = (n: number): Date => new Date(today().getTime() - n * 24 * 60 * 60_000);

  // =========================================================================
  // What counts
  // =========================================================================

  it('counts a settled pay-in and a completed pay-out, kept apart', async () => {
    await settledPayIn(1_000, today());
    await completedPayOut(400, today());

    const s = await summary();
    expect(s.payIn.total).toEqual({ count: 1, amount: 1_000 });
    expect(s.payOut.total).toEqual({ count: 1, amount: 400 });
  });

  it('leaves out money that never moved', async () => {
    // The distinction the whole panel turns on: attempted is not handled.
    await settledPayIn(1_000, today());
    await deadPayIn(9_000, 'EXPIRED');
    await deadPayIn(8_000, 'CANCELLED');
    await completedPayOut(400, today());
    await deadPayOut(7_000, 'CANCELLED');
    await deadPayOut(6_000, 'EXPIRED');

    const s = await summary();
    expect(s.payIn.total).toEqual({ count: 1, amount: 1_000 });
    expect(s.payOut.total).toEqual({ count: 1, amount: 400 });
  });

  it('adds up several of each', async () => {
    await settledPayIn(1_000, today());
    await settledPayIn(250.5, today());
    await completedPayOut(400, today());
    await completedPayOut(99.5, today());

    const s = await summary();
    expect(s.payIn.total).toEqual({ count: 2, amount: 1_250.5 });
    expect(s.payOut.total).toEqual({ count: 2, amount: 499.5 });
  });

  it('is all zeroes, not an error, when nothing has moved', async () => {
    const s = await summary();
    expect(s.payIn.total).toEqual({ count: 0, amount: 0 });
    expect(s.payOut.total).toEqual({ count: 0, amount: 0 });
    expect(s.payIn.today).toEqual({ count: 0, amount: 0 });
  });

  // =========================================================================
  // The windows
  // =========================================================================

  it('puts today’s money in Today, and older money only in the wider windows', async () => {
    await settledPayIn(100, today());
    await settledPayIn(200, daysAgo(3));

    const s = await summary();
    expect(s.payIn.today).toEqual({ count: 1, amount: 100 });
    expect(s.payIn.last7Days).toEqual({ count: 2, amount: 300 });
    expect(s.payIn.total.amount).toBe(300);
  });

  it('counts seven days ending today, today included', async () => {
    // Six days back is inside; eight is not. The boundary is worth pinning:
    // an off-by-one here silently drops or doubles a day of money.
    await settledPayIn(10, today());
    await settledPayIn(20, daysAgo(6));
    await settledPayIn(40, daysAgo(8));

    const s = await summary();
    expect(s.payIn.last7Days).toEqual({ count: 2, amount: 30 });
    expect(s.payIn.total.amount).toBe(70);
  });

  it('counts the calendar month, not the last thirty days', async () => {
    const monthStart = istMonthBounds().start;
    // A day before this month began. When today IS the first, there is no
    // in-month past day to use, so the assertion is on exclusion alone.
    const lastMonth = new Date(monthStart.getTime() - 12 * 60 * 60_000);

    await settledPayIn(500, today());
    await settledPayIn(900, lastMonth);

    const s = await summary();
    expect(s.payIn.thisMonth.amount).toBe(500);
    expect(s.payIn.total.amount).toBe(1_400);
  });

  it('measures by when the money landed, not when it was raised', async () => {
    /**
     * A pay-in raised days ago and settled today is today's money. Reading
     * createdAt instead would file it under the day nobody was paid, and
     * Today would quietly under-report every payment that took overnight.
     */
    seq += 1;
    await Transaction.create({
      transactionCode: `TXN-LATE-${Date.now()}`,
      partyId,
      captainId,
      direction: 'PAY_IN',
      status: 'SETTLED',
      amountPaise: rupeesToPaise(777),
      partyReference: 'REF-LATE',
      settledAt: today(),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      stateHistory: [{ from: null, to: 'CREATED', at: daysAgo(4) }],
    });
    await Transaction.collection.updateOne(
      { partyReference: 'REF-LATE' },
      { $set: { createdAt: daysAgo(4) } },
    );

    const s = await summary();
    expect(s.payIn.today).toEqual({ count: 1, amount: 777 });
  });

  it('keeps the two rails’ windows independent', async () => {
    await settledPayIn(100, today());
    await completedPayOut(900, daysAgo(3));

    const s = await summary();
    expect(s.payIn.today.amount).toBe(100);
    expect(s.payOut.today.amount).toBe(0);
    expect(s.payOut.last7Days.amount).toBe(900);
  });

  it('says what it is counting', async () => {
    // The screen quotes this rather than inventing its own wording, so the
    // heading and the arithmetic cannot drift apart.
    const res = await request(app).get(`${P}/admin/payments/summary`).set('Cookie', cookie);
    expect(res.body.data.basis).toEqual({
      payIn: 'Settled pay-ins, by the time they settled',
      payOut: 'Completed pay-outs, by the time they completed',
      timezone: 'IST',
    });
  });
});
