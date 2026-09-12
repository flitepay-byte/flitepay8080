/**
 * Each party is charged its own rate; each captain is paid its own.
 *
 * The rates used to be global: one pair of percentages that everybody was
 * charged and paid at. Now admin can agree a rate with a particular party and
 * a different one with a particular captain, and the settings figure is the
 * fallback for whoever has not been given one.
 *
 * The part that needed care is *when* each half can be priced. The party is
 * known when the work is created — they are debited there and refunded exactly
 * that on cancellation — so their charge is settled at creation and must never
 * move afterwards. The captain does not exist yet at that point. Their share
 * is therefore priced when they claim, out of the charge the party has already
 * paid, which means re-pricing divides the pool differently but can never
 * change its size.
 *
 * These tests run the real flows end to end and check the money, not the
 * arithmetic — the arithmetic is pinned in tests/unit/perAccountRates.test.ts.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig } from '../../services/systemConfig.service';
import { getPlatformAccount } from '../../services/platformAccount.service';
import { createTask, claimTask } from '../../services/task.service';
import {
  createPayIn, assignCaptain, openToCustomer, confirmMovement, settle,
} from '../../services/transaction.service';
import { Transaction, WalletEntry } from '../../models';
import {
  startTask, submitProof, approveTask,
  requestCancellation, reviewCancellationAsCaptain,
} from '../../services/workflow.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('commission is per party and per captain', () => {
  const OPENING = rupeesToPaise(100_000);
  const CAPTAIN_OPENING = rupeesToPaise(1_000_000);

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    // The defaults everyone falls back to: 3% charged, 1% paid, both ways.
    await updateConfig(
      {
        payOutPartyCommissionPercentage: 3, payOutCaptainCommissionPercentage: 1,
        payInPartyCommissionPercentage: 3, payInCaptainCommissionPercentage: 1,
      },
      new Types.ObjectId(),
    );
  });

  interface PartyRef {
    id: Types.ObjectId;
    actor: { userId: string; role: 'PARTY' };
  }
  interface CaptainRef {
    id: Types.ObjectId;
    actor: { userId: string; role: 'CAPTAIN' };
  }

  /** `charged` is this party's own rate; undefined leaves them on the default. */
  async function makeParty(charged?: number): Promise<PartyRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `party-${unique}@rates.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: user._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Rates Ltd',
      contactEmail: user.email,
      dmcBalancePaise: OPENING,
      ...(charged !== undefined
        ? {
            payOutPartyCommissionPercentage: charged,
            payInPartyCommissionPercentage: charged,
          }
        : {}),
    });
    return { id: party._id, actor: { userId: String(user._id), role: 'PARTY' } };
  }

  /** `paid` is this captain's own rate; undefined leaves them on the default. */
  async function makeCaptain(paid?: number): Promise<CaptainRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@rates.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Rates Captain',
      collateralBalancePaise: rupeesToPaise(100_000),
      dmcBalancePaise: CAPTAIN_OPENING,
      ...(paid !== undefined
        ? {
            payOutCaptainCommissionPercentage: paid,
            payInCaptainCommissionPercentage: paid,
          }
        : {}),
      isOnline: true,
      status: 'ACTIVE',
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  const makeTask = (party: PartyRef, amountRupees: number) =>
    createTask(
      {
        partyId: party.id,
        createdBy: party.id,
        customerName: 'Customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: rupeesToPaise(amountRupees),
      },
      party.actor,
    );

  /**
   * Open the task to whoever we want to claim it.
   *
   * Routing offers a new task to one captain at a time, and which captain that
   * is depends on scoring these tests are not about — with two captains in the
   * fixture the offer goes to whichever scores higher, and the other cannot
   * claim. Opening the pool makes the choice of captain the test's rather than
   * the router's, without touching how the claim itself is priced.
   */
  const openToAll = (taskId: string) =>
    Task.updateOne({ _id: taskId }, { $set: { openPoolAt: new Date() } });

  async function carryOut(taskId: string, party: PartyRef, captain: CaptainRef): Promise<void> {
    await openToAll(taskId);
    await claimTask(taskId, captain.id, captain.actor);
    await startTask(taskId, captain.id, captain.actor);
    await submitProof({ taskId, captainId: captain.id, providerReference: 'NEFT-1' }, captain.actor);
    await approveTask(taskId, party.actor);
  }

  const spent = async (party: PartyRef): Promise<number> =>
    OPENING - ((await Party.findById(party.id).lean())?.dmcBalancePaise ?? -1);

  /** What the captain *earned*, net of the pay-out hold that comes back at completion. */
  const earned = async (captain: CaptainRef, taskRupees: number): Promise<number> =>
    ((await Captain.findById(captain.id).lean())?.dmcBalancePaise ?? -1) -
    CAPTAIN_OPENING -
    rupeesToPaise(taskRupees);

  const pool = async (): Promise<number> => (await getPlatformAccount()).poolBalancePaise;

  // =========================================================================
  // The party's own rate
  // =========================================================================

  it('charges a party their own rate rather than the default', async () => {
    // The client's example: default 3%, Party A on 5%.
    const partyA = await makeParty(5);
    await makeTask(partyA, 10_000);

    expect(paiseToRupees(await spent(partyA))).toBe(10_500);
  });

  it('charges two parties differently for identical work', async () => {
    // The whole point of the feature in one test: same amount, same default,
    // different bills, because admin agreed different rates.
    const partyA = await makeParty(5);
    const partyB = await makeParty(2);
    await makeTask(partyA, 10_000);
    await makeTask(partyB, 10_000);

    expect(paiseToRupees(await spent(partyA))).toBe(10_500);
    expect(paiseToRupees(await spent(partyB))).toBe(10_200);
  });

  it('falls back to the settings default for a party with no rate of their own', async () => {
    const party = await makeParty();
    await makeTask(party, 10_000);

    expect(paiseToRupees(await spent(party))).toBe(10_300);
  });

  it('charges a party on zero percent nothing at all', async () => {
    // Zero has to survive as a decision. Read as "no rate set", this party
    // would be billed the 3% default the moment anyone looked at them.
    const free = await makeParty(0);
    await makeTask(free, 10_000);

    expect(paiseToRupees(await spent(free))).toBe(10_000);
  });

  // =========================================================================
  // The captain's own rate
  // =========================================================================

  it('pays a captain their own rate rather than the default', async () => {
    // Party charged 5, captain paid 2 — the client's pair, end to end.
    const party = await makeParty(5);
    const captain = await makeCaptain(2);
    const task = await makeTask(party, 10_000);

    await carryOut(String(task._id), party, captain);

    expect(paiseToRupees(await earned(captain, 10_000))).toBe(200);
  });

  it('pays two captains differently for the same party’s work', async () => {
    const party = await makeParty(5);
    const generous = await makeCaptain(2);
    const cheap = await makeCaptain(0.5);

    const first = await makeTask(party, 10_000);
    await carryOut(String(first._id), party, generous);
    const second = await makeTask(party, 10_000);
    await carryOut(String(second._id), party, cheap);

    expect(paiseToRupees(await earned(generous, 10_000))).toBe(200);
    expect(paiseToRupees(await earned(cheap, 10_000))).toBe(50);
  });

  it('pays the settings default to a captain with no rate of their own', async () => {
    const party = await makeParty(5);
    const captain = await makeCaptain();
    const task = await makeTask(party, 10_000);

    await carryOut(String(task._id), party, captain);

    expect(paiseToRupees(await earned(captain, 10_000))).toBe(100);
  });

  it('re-prices the task the moment a captain claims it', async () => {
    /**
     * At creation nobody has claimed the work, so the captain's half is the
     * default standing in. The claim is where it becomes this captain's rate —
     * and the party's charge does not move when that happens, only its split.
     */
    const party = await makeParty(5);
    const captain = await makeCaptain(2);
    const created = await makeTask(party, 10_000);

    expect(paiseToRupees(created.commissionPaise ?? 0)).toBe(100); // 1% default
    expect(paiseToRupees(created.adminCommissionPaise ?? 0)).toBe(400);

    await openToAll(String(created._id));
    await claimTask(String(created._id), captain.id, captain.actor);

    const claimed = await Task.findById(created._id).lean();
    expect(paiseToRupees(claimed?.commissionPaise ?? 0)).toBe(200); // 2% theirs
    expect(paiseToRupees(claimed?.adminCommissionPaise ?? 0)).toBe(300);
    expect(claimed?.captainCommissionRate).toBe(2);
    // The charge itself is untouched: 200 + 300 is the 500 the party paid.
    expect(paiseToRupees(await spent(party))).toBe(10_500);
  });

  // =========================================================================
  // The two together
  // =========================================================================

  it('leaves the platform whatever the captain did not take', async () => {
    const party = await makeParty(5);
    const captain = await makeCaptain(2);
    const task = await makeTask(party, 10_000);

    await carryOut(String(task._id), party, captain);

    // 500 collected, 200 paid out, 300 left. Never computed as its own
    // percentage, so the three always reconcile.
    expect(paiseToRupees(await pool())).toBe(300);
  });

  it('never pays a captain more than their party was charged', async () => {
    /**
     * Per-account rates make this ordinary rather than exceptional: a party on
     * 2% served by a captain on 5%. The captain's share is capped at the 200
     * the pool actually received, and the platform takes nothing rather than
     * funding the gap out of DMC that was never created.
     */
    const cheapParty = await makeParty(2);
    const expensiveCaptain = await makeCaptain(5);
    const task = await makeTask(cheapParty, 10_000);

    await carryOut(String(task._id), cheapParty, expensiveCaptain);

    expect(paiseToRupees(await earned(expensiveCaptain, 10_000))).toBe(200);
    expect(paiseToRupees(await pool())).toBe(0);
  });

  it('refunds exactly what it charged, even after re-pricing', async () => {
    /**
     * The invariant re-pricing must not break. The party paid 500; the split
     * moved from 100/400 to 200/300 when the captain claimed; the cancellation
     * refund is computed from those two halves, so if re-pricing had changed
     * their sum the party would get back a different number than they paid.
     */
    const party = await makeParty(5);
    const captain = await makeCaptain(2);
    const task = await makeTask(party, 10_000);
    await openToAll(String(task._id));
    await claimTask(String(task._id), captain.id, captain.actor);

    expect(paiseToRupees(await spent(party))).toBe(10_500);

    // A claimed task is cancelled by agreement: the party asks, the captain
    // who holds it agrees. That is the path a real refund takes.
    await requestCancellation(String(task._id), 'Customer changed their mind', party.actor);
    await reviewCancellationAsCaptain(
      String(task._id), captain.id, 'APPROVE', undefined, captain.actor,
    );

    expect(await spent(party)).toBe(0);
    expect(await pool()).toBe(0);
  });

  it('reprices again when the work moves to a different captain', async () => {
    // A task rejected off one captain and taken by another is priced at the
    // second captain's rate, not left on the first's.
    const party = await makeParty(5);
    const first = await makeCaptain(2);
    const second = await makeCaptain(4);
    const task = await makeTask(party, 10_000);

    await openToAll(String(task._id));
    await claimTask(String(task._id), first.id, first.actor);
    expect(paiseToRupees((await Task.findById(task._id).lean())?.commissionPaise ?? 0)).toBe(200);

    // Back to the pool, then taken by the other captain.
    await Task.updateOne(
      { _id: task._id },
      { $set: { status: 'CREATED', captainId: null, openPoolAt: new Date() } },
    );
    await claimTask(String(task._id), second.id, second.actor);

    const repriced = await Task.findById(task._id).lean();
    expect(paiseToRupees(repriced?.commissionPaise ?? 0)).toBe(400);
    expect(paiseToRupees(repriced?.adminCommissionPaise ?? 0)).toBe(100);
    expect(paiseToRupees(await spent(party))).toBe(10_500);
  });
  // =========================================================================
  // Money coming in
  //
  // A pay-in prices the same way and at the same two moments, but through
  // entirely separate code — the transaction engine rather than the task
  // service — so it is checked on its own rather than assumed to follow.
  // =========================================================================

  it('charges the party their own rate on a pay-in too', async () => {
    const party = await makeParty(5);
    // The router needs somebody to offer the pay-in to; creating them is enough.
    await makeCaptain(2);

    const { transaction } = await createPayIn(
      party.id,
      { partyReference: `PI-${Date.now()}`, amountPaise: rupeesToPaise(10_000) },
      party.actor,
    );

    expect(paiseToRupees(transaction.partyCommissionPaise)).toBe(500);
  });

  it('prices the captain’s share on a pay-in when they are assigned', async () => {
    const party = await makeParty(5);
    const captain = await makeCaptain(2);

    const { transaction } = await createPayIn(
      party.id,
      { partyReference: `PI-${Date.now()}`, amountPaise: rupeesToPaise(10_000) },
      party.actor,
    );
    // At creation nobody is assigned, so the captain's half is the default.
    expect(paiseToRupees(transaction.commissionPaise)).toBe(100);

    await assignCaptain(transaction._id);

    const assigned = await Transaction.findById(transaction._id).lean();
    expect(String(assigned?.captainId)).toBe(String(captain.id));
    expect(paiseToRupees(assigned?.commissionPaise ?? 0)).toBe(200);
    expect(assigned?.commissionRate).toBe(2);
    // And the party's charge is where it was — only the split moved.
    expect(paiseToRupees(assigned?.partyCommissionPaise ?? 0)).toBe(500);
  });

  it('pays a pay-in captain their own rate and leaves the rest in the pool', async () => {
    const party = await makeParty(5);
    const captain = await makeCaptain(2);

    const { transaction } = await createPayIn(
      party.id,
      { partyReference: `PI-${Date.now()}`, amountPaise: rupeesToPaise(10_000) },
      party.actor,
    );
    const id = transaction._id;
    await assignCaptain(id);
    await openToCustomer(id, { gatewayQrPayload: 'upi://pay?x=1' });
    await confirmMovement(id, `UTR${Date.now()}`);
    await settle(id);

    // 500 collected from the party, 200 to the captain, 300 left over.
    const paid = (await Captain.findById(captain.id).lean())?.dmcBalancePaise ?? 0;
    expect(paiseToRupees(paid - CAPTAIN_OPENING + rupeesToPaise(10_000))).toBe(200);
    expect(paiseToRupees(await pool())).toBe(300);
  });

  // =========================================================================
  // A quote already given
  // =========================================================================

  it('does not let a settings change re-price work already created', async () => {
    /**
     * The captain's share is priced at the claim, which is later than the
     * party's — so a default changed in between could otherwise reach back
     * into work somebody had already been quoted for. Where the captain has no
     * rate of their own, the default that applies is the one the work was
     * priced under, recorded on the row.
     */
    const party = await makeParty(7);
    const captain = await makeCaptain(); // no rate of their own
    const task = await makeTask(party, 10_000);

    await updateConfig(
      { payOutCaptainCommissionPercentage: 6 },
      new Types.ObjectId(),
    );

    await carryOut(String(task._id), party, captain);

    // Still the 1% in force when the task was created, not the new 6%.
    expect(paiseToRupees(await earned(captain, 10_000))).toBe(100);
  });

  it('still applies the captain’s own rate agreed before they claimed', async () => {
    // The other half of the same rule: a rate that is *theirs* is not a
    // settings change reaching backwards, so it does apply.
    const party = await makeParty(7);
    const captain = await makeCaptain(4);
    const task = await makeTask(party, 10_000);

    await carryOut(String(task._id), party, captain);

    expect(paiseToRupees(await earned(captain, 10_000))).toBe(400);
  });
  // =========================================================================
  // When the captain is promised more than the party is charged
  //
  // The money was always safe — the cap has been there from the start. What
  // was not safe was the story the row told about it: the rate recorded was
  // the one admin agreed, while the amount paid was the party's smaller
  // charge, so the captain's ledger showed a rate their payment did not match.
  // =========================================================================

  it('records the rate a capped captain was actually paid at', async () => {
    // The client's pair: party charged 5, captain promised 6.
    const party = await makeParty(5);
    const captain = await makeCaptain(6);
    const task = await makeTask(party, 10_000);

    await carryOut(String(task._id), party, captain);

    const done = await Task.findById(task._id).lean();
    // 500 on 10,000 is five percent, and that is what the row says.
    expect(paiseToRupees(done?.commissionPaise ?? 0)).toBe(500);
    expect(done?.captainCommissionRate).toBe(5);
    // And the 6 they were promised is still on the row, so the shortfall can
    // be explained as a cap rather than looking like a mistake.
    expect(done?.captainCommissionRateAgreed).toBe(6);
  });

  it('records both rates on a capped pay-in as well', async () => {
    const party = await makeParty(3);
    const captain = await makeCaptain(4);

    const { transaction } = await createPayIn(
      party.id,
      { partyReference: `PI-${Date.now()}`, amountPaise: rupeesToPaise(10_000) },
      party.actor,
    );
    await assignCaptain(transaction._id);

    const assigned = await Transaction.findById(transaction._id).lean();
    expect(String(assigned?.captainId)).toBe(String(captain.id));
    expect(paiseToRupees(assigned?.commissionPaise ?? 0)).toBe(300);
    expect(assigned?.commissionRate).toBe(3);
    expect(assigned?.commissionRateAgreed).toBe(4);
  });

  it('leaves the two rates equal when nothing was capped', async () => {
    const party = await makeParty(7);
    const captain = await makeCaptain(6);
    const task = await makeTask(party, 10_000);

    await carryOut(String(task._id), party, captain);

    const done = await Task.findById(task._id).lean();
    expect(paiseToRupees(done?.commissionPaise ?? 0)).toBe(600);
    expect(done?.captainCommissionRate).toBe(6);
    expect(done?.captainCommissionRateAgreed).toBe(6);
  });

  it('shows the captain the rate they were paid, not the one they were promised', async () => {
    /**
     * The ledger reads the rate off the row, so this is what the capped
     * captain actually sees. It reveals nothing they could not already work
     * out — the same ledger line shows them the amount and the commission —
     * but "6%" beside a five-percent payment reads as a shortfall, and that is
     * a dispute nobody needed.
     */
    const party = await makeParty(5);
    const captain = await makeCaptain(6);
    const task = await makeTask(party, 10_000);
    await carryOut(String(task._id), party, captain);

    const entries = await WalletEntry.find({ captainId: captain.id, kind: 'COMMISSION_EARNED' }).lean();
    expect(entries).toHaveLength(1);
    const done = await Task.findById(task._id).lean();
    expect(paiseToRupees(entries[0]?.amountPaise ?? 0)).toBe(500);
    expect(done?.captainCommissionRate).toBe(5);
  });

  it('still refunds exactly the party’s charge when the captain was capped', async () => {
    // The cap moves the whole charge to the captain and leaves the platform
    // nothing — the two halves must still sum to what the party paid.
    const party = await makeParty(5);
    const captain = await makeCaptain(6);
    const task = await makeTask(party, 10_000);
    await openToAll(String(task._id));
    await claimTask(String(task._id), captain.id, captain.actor);

    const claimed = await Task.findById(task._id).lean();
    expect(paiseToRupees(claimed?.commissionPaise ?? 0)).toBe(500);
    expect(paiseToRupees(claimed?.adminCommissionPaise ?? 0)).toBe(0);

    await requestCancellation(String(task._id), 'Not needed', party.actor);
    await reviewCancellationAsCaptain(String(task._id), captain.id, 'APPROVE', undefined, captain.actor);

    expect(await spent(party)).toBe(0);
  });
});
