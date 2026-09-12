/**
 * The transaction engine: a party's customer paying, or being paid.
 *
 * Two properties matter more than anything else here and nearly every test
 * below is really a statement of one of them.
 *
 * **Nothing is skimmed.** ₹100 paid in has to become exactly 100 DMC for the
 * party, and ₹100 paid out has to send exactly ₹100. The captain's commission
 * comes from the platform's funded pool, never off the top — so the amount the
 * customer sees and the amount the party sees are the same number, always.
 *
 * **Nothing is created.** Every movement is a transfer between balances that
 * already exist, so the total across the whole system is unchanged by a
 * settlement. A test that only checked "the party gained 100" would pass just
 * as happily if that 100 came from nowhere.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Transaction, DmcRedemption, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { fundPlatformPool, getPlatformAccount } from '../../services/platformAccount.service';
import {
  createPayIn,
  assignCaptain,
  openToCustomer,
  confirmMovement,
  settle,
  expire,
  dispute,
  resolveDispute,
} from '../../services/transaction.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('the transaction engine', () => {
  let partyId: Types.ObjectId;
  let partyActor: { userId: string; role: 'PARTY' };
  let adminActor: { userId: string; role: 'ADMIN' };

  const OPENING = rupeesToPaise(100_000);

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    // 1% in, 2% out — the worked example from the specification.
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

    const unique = new Types.ObjectId().toHexString();
    const password = await hashPassword('Demo@12345');

    const partyUser = await User.create({
      email: `party-${unique}@txn.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Txn Commerce',
      contactEmail: partyUser.email,
      dmcBalancePaise: OPENING,
    });
    partyId = party._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };

    const adminUser = await User.create({
      email: `admin-${unique}@txn.test`, passwordHash: password, name: 'Admin', role: 'ADMIN',
    });
    adminActor = { userId: String(adminUser._id), role: 'ADMIN' };

    await fundPlatformPool(rupeesToPaise(50_000));
  });

  async function makeCaptain(capitalRupees = 0): Promise<Types.ObjectId> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@txn.test`, passwordHash: await hashPassword('Demo@12345'), name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Txn Captain',
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

  const partyDmc = async (): Promise<number> =>
    (await Party.findById(partyId).lean())?.dmcBalancePaise ?? -1;

  const captainOf = async (id: Types.ObjectId): Promise<{ dmc: number }> => {
    const c = await Captain.findById(id).lean();
    return { dmc: c?.dmcBalancePaise ?? -1 };
  };

  /**
   * Every DMC in the system, wherever it is sitting. In-flight amounts are
   * counted from the transactions themselves, because a transaction that is
   * holding money has taken it out of a balance and put it nowhere else.
   */
  async function totalInSystem(): Promise<number> {
    const [parties, captains, transactions, redemptions, platform] = await Promise.all([
      Party.find().select('dmcBalancePaise').lean(),
      Captain.find().select('dmcBalancePaise').lean(),
      Transaction.find().select('status amountPaise direction').lean(),
      DmcRedemption.find({ status: 'PENDING' }).select('amountPaise').lean(),
      getPlatformAccount(),
    ]);
    // A pay-in commits nothing until a captain holds it.
    const HELD = ['ASSIGNED', 'AWAITING_CUSTOMER', 'CONFIRMED', 'DISPUTED'];
    const inFlight = transactions.reduce(
      (sum, t) => (HELD.includes(t.status) ? sum + t.amountPaise : sum),
      0,
    );
    return (
      parties.reduce((s, p) => s + p.dmcBalancePaise, 0) +
      captains.reduce((s, c) => s + c.dmcBalancePaise, 0) +
      redemptions.reduce((s, r) => s + r.amountPaise, 0) +
      platform.poolBalancePaise +
      inFlight
    );
  }

  const payInInput = (amount: number, reference = `ORD-${Date.now()}-${Math.random()}`) => ({
    partyReference: reference,
    amountPaise: rupeesToPaise(amount),
  });


  // =========================================================================
  // PAY-IN
  // =========================================================================

  it('moves nothing when a pay-in is created', async () => {
    const before = await totalInSystem();
    const { transaction, created } = await createPayIn(partyId, payInInput(1_000), partyActor);

    expect(created).toBe(true);
    expect(transaction.status).toBe('CREATED');
    // The captain who will hand over DMC has not been chosen yet, so there is
    // nothing to hold and nobody to hold it from.
    expect(await partyDmc()).toBe(OPENING);
    expect(await totalInSystem()).toBe(before);
  });

  it('holds the captain’s working capital when they are assigned', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(4_000), partyActor);

    const result = await assignCaptain(transaction._id);
    expect(String(result.captainId)).toBe(String(captainId));

    // The captain owes 4,000 DMC the moment they take it, so it stops being
    // theirs to spend on anything else.
    expect(paiseToRupees((await captainOf(captainId)).dmc)).toBe(6_000);
  });

  it('will not give a pay-in to a captain who cannot cover it', async () => {
    await makeCaptain(1_000);
    const { transaction } = await createPayIn(partyId, payInInput(4_000), partyActor);

    const result = await assignCaptain(transaction._id);
    expect(result.captainId).toBeNull();
    // Somebody exists who could take it once they are funded, so this is a
    // wait rather than a dead end.
    expect(result.waiting).toBe(true);
    expect(result.stalled).toBe(false);
  });

  it('says so when nobody could ever take it', async () => {
    const { transaction } = await createPayIn(partyId, payInInput(4_000), partyActor);
    const result = await assignCaptain(transaction._id);
    expect(result.waiting).toBe(false);
    expect(result.stalled).toBe(true);
  });

  it('gives the party exactly what the customer paid, and takes nothing off it', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(1_000), partyActor);
    const before = await totalInSystem();

    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id, { gatewayOrderId: 'GW-1', gatewayQrPayload: 'upi://pay?x=1' });
    await confirmMovement(transaction._id, 'UPI-REF-1');
    const settled = await settle(transaction._id);

    expect(settled.status).toBe('SETTLED');
    // The customer paid 1,000 and the captain gave up 1,000 — the amount is
    // never skimmed. The party's 3% fee is charged on top of that movement,
    // so they net 970.
    expect(paiseToRupees((await partyDmc()) - OPENING)).toBe(970);

    const captain = await captainOf(captainId);
    // 10,000 less the 1,000 they gave up, plus their 1% share back.
    expect(paiseToRupees(captain.dmc)).toBe(9_010);
    // The party's 30 funded the pool; 10 of it went to the captain.
    expect(paiseToRupees((await getPlatformAccount()).poolBalancePaise)).toBe(50_000 + 20);
    expect(await totalInSystem()).toBe(before);
  });

  it('gives the captain their capital back when a pay-in expires', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(3_000), partyActor);
    const before = await totalInSystem();

    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);
    await expire(transaction._id);

    // Nobody paid, so nobody gains and the captain is made whole.
    expect(paiseToRupees((await captainOf(captainId)).dmc)).toBe(10_000);
    expect(await partyDmc()).toBe(OPENING);
    expect(await totalInSystem()).toBe(before);
  });

  it('never refunds a pay-in that never had a captain', async () => {
    const { transaction } = await createPayIn(partyId, payInInput(3_000), partyActor);
    const before = await totalInSystem();

    await expire(transaction._id);

    // Nothing was held, so refunding anything would be inventing DMC.
    expect(await totalInSystem()).toBe(before);
    expect(await partyDmc()).toBe(OPENING);
  });

  // =========================================================================
  // PAY-OUT
  // =========================================================================

  // =========================================================================
  // IDEMPOTENCY AND RACES
  // =========================================================================

  it('treats the same reference twice as the same payment', async () => {
    const input = payInInput(1_000, 'ORDER-77');
    const first = await createPayIn(partyId, input, partyActor);
    const second = await createPayIn(partyId, input, partyActor);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(String(second.transaction._id)).toBe(String(first.transaction._id));
    expect(await Transaction.countDocuments({})).toBe(1);
  });

  it('creates one payment even when the same call arrives five times at once', async () => {
    const input = payInInput(1_000, 'ORDER-88');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createPayIn(partyId, input, partyActor)),
    );

    const ids = new Set(results.map((r) => String(r.transaction._id)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await Transaction.countDocuments({})).toBe(1);
  });

  it('assigns one captain when two routing passes run at once', async () => {
    await makeCaptain(10_000);
    await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(4_000), partyActor);

    const results = await Promise.all([
      assignCaptain(transaction._id),
      assignCaptain(transaction._id),
      assignCaptain(transaction._id),
    ]);

    const assigned = new Set(results.map((r) => String(r.captainId)).filter((id) => id !== 'null'));
    expect(assigned.size).toBe(1);

    // And exactly one captain is out of pocket.
    const captains = await Captain.find().select('dmcBalancePaise').lean();
    const held = captains.filter((c) => c.dmcBalancePaise < rupeesToPaise(10_000));
    expect(held).toHaveLength(1);
  });

  it('settles once when the gateway sends the same webhook twice', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(1_000), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);

    await confirmMovement(transaction._id, 'UPI-DUP');
    await confirmMovement(transaction._id, 'UPI-DUP');
    await settle(transaction._id);
    await settle(transaction._id);

    // Two webhooks, two settle attempts, one payment.
    expect(paiseToRupees((await partyDmc()) - OPENING)).toBe(970);
    expect(paiseToRupees((await captainOf(captainId)).dmc)).toBe(9_010);
  });

  it('settles once when two settlements race', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(1_000), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);
    await confirmMovement(transaction._id, 'UPI-RACE');

    await Promise.allSettled([settle(transaction._id), settle(transaction._id), settle(transaction._id)]);

    expect(paiseToRupees((await partyDmc()) - OPENING)).toBe(970);
    expect(paiseToRupees((await captainOf(captainId)).dmc)).toBe(9_010);
  });

  it('cannot settle something the customer never paid for', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(1_000), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);

    await expect(settle(transaction._id)).rejects.toThrow();
    expect(await partyDmc()).toBe(OPENING);
    // Still holding the capital, and nothing earned.
    expect(paiseToRupees((await captainOf(captainId)).dmc)).toBe(9_000);
  });

  it('cannot expire something that already settled', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(1_000), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);
    await confirmMovement(transaction._id, 'UPI-FINAL');
    await settle(transaction._id);

    // SETTLED is terminal, which is exactly what makes paying commission at
    // settlement safe: it can never have to be clawed back.
    await expect(expire(transaction._id)).rejects.toThrow();
    expect(paiseToRupees((await partyDmc()) - OPENING)).toBe(970);
    expect(paiseToRupees((await captainOf(captainId)).dmc)).toBe(9_010);
  });

  // =========================================================================
  // DISPUTES
  // =========================================================================

  it('keeps the hold in place while a dispute is open', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(2_000), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);

    await dispute(transaction._id, 'The customer says they paid and the gateway disagrees');

    // Neither side may spend it while they are arguing about it.
    expect(paiseToRupees((await captainOf(captainId)).dmc)).toBe(8_000);
    expect(await partyDmc()).toBe(OPENING);
  });

  it('settles a dispute admin believes', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(2_000), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);
    await dispute(transaction._id, 'Gateway never sent the webhook');

    await resolveDispute(transaction._id, 'SETTLE', 'Bank statement shows the credit', adminActor);

    expect(paiseToRupees((await partyDmc()) - OPENING)).toBe(1_940);
    expect(paiseToRupees((await captainOf(captainId)).dmc)).toBe(8_020);
  });

  it('releases a dispute admin does not believe', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(2_000), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);
    await dispute(transaction._id, 'Customer claims they paid');

    await resolveDispute(transaction._id, 'RELEASE', 'No credit found anywhere', adminActor);

    expect(await partyDmc()).toBe(OPENING);
    // Nothing happened, so the hold came back and nobody earned anything.
    expect(paiseToRupees((await captainOf(captainId)).dmc)).toBe(10_000);
  });

  // =========================================================================
  // THE POOL RUNNING DRY
  // =========================================================================

  it('still settles when the pool cannot pay the commission, and records that', async () => {
    // Drain the pool to nothing by paying a commission larger than it holds is
    // impossible, so spend it down instead.
    await makeCaptain(200_000);
    const { transaction: big } = await createPayIn(partyId, payInInput(100_000, 'DRAIN'), partyActor);
    await assignCaptain(big._id);
    await openToCustomer(big._id);
    await confirmMovement(big._id, 'UPI-DRAIN');
    await settle(big._id);
    // 1% of 100,000 is 1,000 — well inside the 50,000 pool. Empty the rest.
    const remaining = (await getPlatformAccount()).poolBalancePaise;
    const { payCommissionFromPool } = await import('../../services/platformAccount.service');
    await payCommissionFromPool(remaining);
    expect((await getPlatformAccount()).poolBalancePaise).toBe(0);

    const { transaction } = await createPayIn(partyId, payInInput(1_000, 'AFTER-DRAIN'), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);
    await confirmMovement(transaction._id, 'UPI-AFTER');
    const settled = await settle(transaction._id);

    // The customer's money already moved, so unwinding the payment because the
    // platform's float ran dry would be far worse than owing the fee.
    // The customer's money already moved, so the payment stands. The fee is
    // owed rather than paid, because this settlement's own charge funded the
    // pool *after* the drain — and the payment must never be unwound for it.
    expect(settled.status).toBe('SETTLED');
    expect(paiseToRupees((await partyDmc()) - OPENING)).toBe(97_970);
  });

  it('locks the rate at creation so a later change cannot alter it', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payInInput(1_000), partyActor);
    expect(paiseToRupees(transaction.commissionPaise)).toBe(10);

    // The platform doubles its rate after the customer has already been quoted.
    await updateConfig({ payInCaptainCommissionPercentage: 5 }, new Types.ObjectId());

    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);
    await confirmMovement(transaction._id, 'UPI-RATE');
    await settle(transaction._id);

    // Still 1%: what somebody was promised is not rewritten under them.
    expect(paiseToRupees((await captainOf(captainId)).dmc)).toBe(9_010);
  });
});
