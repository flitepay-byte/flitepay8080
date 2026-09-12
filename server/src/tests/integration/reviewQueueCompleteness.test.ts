/**
 * Every decision that needs admin appears in admin's review queue.
 *
 * The queue used to list tasks only. Everything else that stops until admin
 * decides — a captain saying a party's payment never arrived, a commission
 * payment disputed, real money sitting unconfirmed — lived on a profile page
 * instead: Captains -> that captain -> withdrawals. So the one screen admin
 * actually watches showed nothing while a captain waited to be paid, and the
 * only way to find it was to already know where to look.
 *
 * The rule these tests hold is deliberately absolute, because a queue that is
 * *nearly* complete is worse than none: admin stops trusting it and goes back
 * to hunting through profiles. If the app is holding a task or somebody's
 * money because admin has not decided, it is in here.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import {
  User, Party, Captain, Task,
  AdminWithdrawalRequest, AdminWithdrawalPortion, PartyTopUpRequest, DmcPurchase, DmcRedemption,
  CaptainLimitPurchase, Transaction, Session, hashPassword,
} from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { signAccessToken, ACCESS_COOKIE } from '../../services/token.service';
import { rupeesToPaise } from '../../utils/money';
import { SOURCE_CAP } from '../../controllers/admin/dashboard.controller';

interface QueueItem {
  id: string;
  kind: string;
  severity: string;
  reference: string;
  headline: string;
  detail: string | null;
  amount: number;
  waitingSince: string;
  href: string;
}

describeIntegration('the admin review queue holds every pending decision', () => {
  const app = createApp();
  let cookie: string;
  let partyId: Types.ObjectId;
  let captainId: Types.ObjectId;

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
      email: `admin-${unique}@queue.test`, passwordHash: password, name: 'Admin', role: 'ADMIN',
    });
    const partyUser = await User.create({
      email: `party-${unique}@queue.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const captainUser = await User.create({
      email: `cap-${unique}@queue.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });

    const party = await Party.create({
      userId: partyUser._id,
      partyCode: 'PARTY-700',
      companyName: 'Queue Logistics',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(100_000),
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: 'CAP-700',
      displayName: 'Queue Captain',
      collateralBalancePaise: rupeesToPaise(100_000),
      lockedAmountPaise: 0,
      dmcBalancePaise: rupeesToPaise(5_000),
      isOnline: true,
      status: 'ACTIVE',
    });
    partyId = party._id;
    captainId = captain._id;

    // requireAuth checks the session is live, not just that the token parses,
    // so the session has to exist as it would after a real sign-in.
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

  const fetchQueue = async (): Promise<QueueItem[]> => {
    const res = await request(app).get('/api/v1/admin/review-queue?page=1&limit=50').set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body.data.items as QueueItem[];
  };

  /** The whole envelope, because what the queue *claims* is now part of the contract. */
  const fetchQueueBody = async (): Promise<{
    items: QueueItem[];
    total: number;
    outstanding: number;
    truncated: boolean;
  }> => {
    const res = await request(app).get('/api/v1/admin/review-queue?page=1&limit=50').set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  const kinds = async (): Promise<string[]> => (await fetchQueue()).map((i) => i.kind);

  async function makeTask(overrides: Record<string, unknown> = {}): Promise<Types.ObjectId> {
    const unique = new Types.ObjectId().toHexString();
    const task = await Task.create({
      partyId,
      createdBy: new Types.ObjectId(),
      taskCode: `TASK-Q-${unique.slice(-8)}`,
      externalRef: `Q-${unique.slice(-8)}`,
      customerName: 'Queue Customer',
      identifier: 'queue@bank',
      payoutMethod: { type: 'UPI', upiId: 'queue@bank' },
      amountPaise: rupeesToPaise(1_000),
      commissionPaise: rupeesToPaise(10),
      adminCommissionPaise: rupeesToPaise(20),
      status: 'CREATED',
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
      ...overrides,
    });
    return task._id;
  }

  /** A pay-in whose captain says the customer's money never arrived. */
  async function disputedTransaction(): Promise<void> {
    await Transaction.create({
      transactionCode: `PIN-Q-${new Types.ObjectId().toHexString().slice(-6)}`,
      direction: 'PAY_IN',
      partyId,
      captainId,
      partyReference: `QREF-${new Types.ObjectId().toHexString().slice(-8)}`,
      amountPaise: rupeesToPaise(3_000),
      commissionPaise: rupeesToPaise(30),
      commissionMode: 'PERCENTAGE',
      commissionRate: 1,
      commissionConfigVersion: 1,
      status: 'DISPUTED',
      disputeReason: 'Nothing reached my UPI',
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
      expiresAt: new Date(Date.now() + 900_000),
    });
  }

  it('lists a rejected proof', async () => {
    await makeTask({ status: 'REJECTED', rejectionReason: 'Wrong account' });
    expect(await kinds()).toEqual(['TASK_REJECTED']);
  });

  it('lists a disputed cancellation', async () => {
    await makeTask({ status: 'CANCEL_DISPUTED', cancelReason: 'Changed my mind' });
    expect(await kinds()).toEqual(['CANCEL_DISPUTED']);
  });

  it('lists a task that has run out of captains', async () => {
    await makeTask({ status: 'REASSIGNED', routingStalledAt: new Date(), previousCaptainIds: [captainId] });
    expect(await kinds()).toEqual(['NO_ELIGIBLE_CAPTAIN']);
  });

  it('lists a disputed payment of admin’s own commission', async () => {
    const req = await AdminWithdrawalRequest.create({ amountPaise: rupeesToPaise(500), status: 'PENDING' });
    await AdminWithdrawalPortion.create({
      withdrawalRequestId: req._id,
      partyId,
      amountPaise: rupeesToPaise(500),
      status: 'DISPUTED',
      disputeReason: 'Reference does not match',
    });
    expect(await kinds()).toEqual(['PLATFORM_PAYMENT_DISPUTED']);
  });

  it('lists a party top-up waiting to be confirmed', async () => {
    await PartyTopUpRequest.create({
      partyId, amountPaise: rupeesToPaise(50_000), status: 'PENDING', proofReference: 'UTR123456',
    });
    const items = await fetchQueue();
    expect(items.map((i) => i.kind)).toEqual(['PARTY_TOPUP_PENDING']);
    expect(items[0]?.severity).toBe('CONFIRM');
  });

  it('lists a captain’s security deposit waiting to be confirmed', async () => {
    await DmcPurchase.create({
      captainId, amountPaise: rupeesToPaise(20_000), status: 'PENDING',
      securityPaise: rupeesToPaise(20_000), balancePaise: 0,
      simulatedPaymentRef: 'REF654321', proofReference: 'UTR654321',
    });
    expect(await kinds()).toEqual(['CAPTAIN_DEPOSIT_PENDING']);
  });

  it('lists a captain waiting to be paid out in rupees', async () => {
    // The captain's DMC is already held against this request, so they are not
    // simply waiting for money — they cannot spend it either. It stops here
    // until admin sends the transfer.
    await DmcRedemption.create({
      captainId, amountPaise: rupeesToPaise(5_000), status: 'PENDING',
      payoutMethod: 'UPI', payoutUpiId: 'captain@upi',
    });
    const items = await fetchQueue();
    expect(items.map((i) => i.kind)).toEqual(['CAPTAIN_REDEMPTION_PENDING']);
    expect(items[0]?.severity).toBe('CONFIRM');
    // Admin has to know where to send it without opening anything else.
    expect(items[0]?.detail).toContain('captain@upi');
    // And the link has to land on the screen that can actually pay it.
    expect(items[0]?.href).toBe('/admin/wallet');
  });

  it('lists a captain’s limit purchase waiting to be confirmed', async () => {
    // Real money the captain says they sent, and their capacity does not move
    // until admin confirms it — so it is a decision sitting on admin, and it
    // belongs here rather than only on the captain's profile.
    await CaptainLimitPurchase.create({
      captainId,
      amountPaise: rupeesToPaise(5_000),
      collateralAtRequestPaise: rupeesToPaise(10_000),
      status: 'PENDING',
      proofReference: 'UTR-LIMIT-1',
    });
    const items = await fetchQueue();
    expect(items.map((i) => i.kind)).toEqual(['CAPTAIN_LIMIT_PURCHASE_PENDING']);
    expect(items[0]?.severity).toBe('CONFIRM');
    expect(items[0]?.href).toBe(`/admin/captains/${String(captainId)}`);
  });

  it('lists a disputed pay-in or pay-out', async () => {
    // Both sides are frozen: the DMC is held and neither the party nor the
    // captain can touch it until admin decides. That is the whole test for
    // whether something belongs in this queue.
    await disputedTransaction();
    const items = await fetchQueue();
    expect(items.map((i) => i.kind)).toEqual(['TRANSACTION_DISPUTED']);
    expect(items[0]?.severity).toBe('DISPUTE');
    expect(items[0]?.detail).toContain('Nothing reached my UPI');
    expect(items[0]?.href).toBe('/admin/transactions');
  });

  it('holds all nine kinds at once, and nothing is dropped', async () => {
    await makeTask({ status: 'REJECTED', rejectionReason: 'Wrong account' });
    await makeTask({ status: 'CANCEL_DISPUTED', cancelReason: 'Changed my mind' });
    await makeTask({ status: 'REASSIGNED', routingStalledAt: new Date(), previousCaptainIds: [captainId] });
    const areq = await AdminWithdrawalRequest.create({ amountPaise: rupeesToPaise(500), status: 'PENDING' });
    await AdminWithdrawalPortion.create({
      withdrawalRequestId: areq._id, partyId, amountPaise: rupeesToPaise(500), status: 'DISPUTED',
    });
    await PartyTopUpRequest.create({
      partyId, amountPaise: rupeesToPaise(50_000), status: 'PENDING', proofReference: 'UTR123456',
    });
    await DmcPurchase.create({
      captainId, amountPaise: rupeesToPaise(20_000), status: 'PENDING',
      securityPaise: rupeesToPaise(20_000), balancePaise: 0,
      simulatedPaymentRef: 'REF654321', proofReference: 'UTR654321',
    });
    await DmcRedemption.create({
      captainId, amountPaise: rupeesToPaise(5_000), status: 'PENDING',
      payoutMethod: 'UPI', payoutUpiId: 'captain@upi',
    });
    await CaptainLimitPurchase.create({
      captainId,
      amountPaise: rupeesToPaise(5_000),
      collateralAtRequestPaise: rupeesToPaise(10_000),
      status: 'PENDING',
      proofReference: 'UTR-LIMIT-ALL',
    });
    await disputedTransaction();

    const items = await fetchQueue();
    expect(items).toHaveLength(9);
    expect(new Set(items.map((i) => i.kind))).toEqual(
      new Set([
        'TASK_REJECTED', 'CANCEL_DISPUTED', 'NO_ELIGIBLE_CAPTAIN',
        'PLATFORM_PAYMENT_DISPUTED',
        'PARTY_TOPUP_PENDING', 'CAPTAIN_DEPOSIT_PENDING',
        'CAPTAIN_LIMIT_PURCHASE_PENDING',
        'CAPTAIN_REDEMPTION_PENDING', 'TRANSACTION_DISPUTED',
      ]),
    );
  });

  it('says plainly that nothing is hidden when the queue fits', async () => {
    await makeTask({ status: 'REJECTED', rejectionReason: 'Wrong account' });
    await PartyTopUpRequest.create({
      partyId, amountPaise: rupeesToPaise(50_000), status: 'PENDING', proofReference: 'UTR123456',
    });

    const body = await fetchQueueBody();
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.outstanding).toBe(2);
    expect(body.truncated).toBe(false);
  });

  it('reports the whole backlog when a source overflows the cap, not just what fitted', async () => {
    // One row past the cap, in the cheapest source there is. Each source is
    // capped so a pathological backlog degrades rather than exhausts memory,
    // and that is deliberate — but the queue used to serve the first
    // SOURCE_CAP rows and report *that* as the total, so a queue holding more
    // than the cap looked merely full instead of overflowing, and the excess
    // never appeared at all. Admin could not tell a short queue from a cut one.
    await PartyTopUpRequest.insertMany(
      Array.from({ length: SOURCE_CAP + 1 }, (_, i) => ({
        partyId,
        amountPaise: rupeesToPaise(1_000 + i),
        status: 'PENDING' as const,
        proofReference: `UTR-CAP-${i}`,
      })),
    );

    const body = await fetchQueueBody();
    // Still bounded: the cap governs what is loaded.
    expect(body.total).toBe(SOURCE_CAP);
    // But the number admin reads is the true one, and the list admits it is cut.
    expect(body.outstanding).toBe(SOURCE_CAP + 1);
    expect(body.truncated).toBe(true);
  });

  it('puts blocked people above money merely waiting to be confirmed', async () => {
    // The top-up is older, so date order alone would float it to the top —
    // but nobody is stuck behind it, and a disputed payment means a captain is.
    await PartyTopUpRequest.create({
      partyId, amountPaise: rupeesToPaise(50_000), status: 'PENDING',
      proofReference: 'UTR123456', createdAt: new Date('2020-01-01'),
    });
    const req = await AdminWithdrawalRequest.create({ amountPaise: rupeesToPaise(500), status: 'PENDING' });
    await AdminWithdrawalPortion.create({
      withdrawalRequestId: req._id, partyId, amountPaise: rupeesToPaise(500), status: 'DISPUTED',
    });

    const items = await fetchQueue();
    expect(items[0]?.kind).toBe('PLATFORM_PAYMENT_DISPUTED');
    expect(items[1]?.kind).toBe('PARTY_TOPUP_PENDING');
  });

  it('leaves settled and already-decided things out of it', async () => {
    // Nothing here is waiting on admin, so the queue must be empty — a queue
    // that cries wolf is one admin stops reading.
    await makeTask({ status: 'COMPLETED' });
    await makeTask({ status: 'CANCELLED' });
    const req = await AdminWithdrawalRequest.create({ amountPaise: rupeesToPaise(2_000), status: 'FULFILLED' });
    await AdminWithdrawalPortion.create({
      withdrawalRequestId: req._id, partyId, amountPaise: rupeesToPaise(2_000), status: 'FULFILLED',
    });
    await PartyTopUpRequest.create({
      partyId, amountPaise: rupeesToPaise(50_000), status: 'APPROVED', proofReference: 'UTR1',
    });
    await DmcPurchase.create({
      captainId, amountPaise: rupeesToPaise(20_000), status: 'REJECTED',
      securityPaise: rupeesToPaise(20_000), balancePaise: 0,
      simulatedPaymentRef: 'REF2', proofReference: 'UTR2',
    });
    await DmcRedemption.create({
      captainId, amountPaise: rupeesToPaise(5_000), status: 'PAID',
      payoutMethod: 'UPI', payoutUpiId: 'captain@upi', paymentReference: 'NEFT-1',
    });
    await DmcRedemption.create({
      captainId, amountPaise: rupeesToPaise(1_000), status: 'REJECTED',
      payoutMethod: 'UPI', payoutUpiId: 'captain@upi', rejectionReason: 'Wrong details',
    });
    await Transaction.create({
      transactionCode: 'PIN-Q-SETTLED',
      direction: 'PAY_IN',
      partyId,
      captainId,
      partyReference: 'QREF-SETTLED',
      amountPaise: rupeesToPaise(3_000),
      commissionPaise: rupeesToPaise(30),
      commissionMode: 'PERCENTAGE',
      commissionRate: 1,
      commissionConfigVersion: 1,
      status: 'SETTLED',
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
      expiresAt: new Date(Date.now() + 900_000),
    });

    expect(await fetchQueue()).toHaveLength(0);
  });

  it('is admin-only', async () => {
    await makeTask({ status: 'REJECTED', rejectionReason: 'Wrong account' });
    const res = await request(app).get('/api/v1/admin/review-queue?page=1&limit=50');
    expect(res.status).toBe(401);
  });
});
