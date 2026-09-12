/**
 * Either side can stop a payment, and a captain can hand one back.
 *
 * Disputes used to be the captain's alone, which made them one-sided in a
 * system that is two-sided everywhere else: a captain could say "nobody paid
 * me", but a party whose customer swore they had paid — or who never received
 * a payout — had no way to say anything at all.
 *
 * Declining is the other half of the same problem. Without it a captain who
 * cannot do a pay-in has to sit on it for the whole fifteen-minute window with
 * their capital committed, which punishes them for being honest and makes
 * hoarding a dead transaction the rational move.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Transaction, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { fundPlatformPool } from '../../services/platformAccount.service';
import {
  createPayIn,
  assignCaptain,
  openToCustomer,
  confirmMovement,
  settle,
  dispute,
  declineAsCaptain,
} from '../../services/transaction.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('disputes and declines', () => {
  let partyId: Types.ObjectId;
  let partyActor: { userId: string; role: 'PARTY' };

  const OPENING = rupeesToPaise(100_000);

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    await fundPlatformPool(rupeesToPaise(50_000));

    const unique = new Types.ObjectId().toHexString();
    const partyUser = await User.create({
      email: `party-${unique}@dispute.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Dispute Commerce',
      contactEmail: partyUser.email,
      dmcBalancePaise: OPENING,
    });
    partyId = party._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };
  });

  async function makeCaptain(capitalRupees = 50_000): Promise<Types.ObjectId> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@dispute.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Dispute Captain',
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

  const captainDmc = async (id: Types.ObjectId): Promise<number> =>
    (await Captain.findById(id).lean())?.dmcBalancePaise ?? -1;

  const partyDmc = async (): Promise<number> =>
    (await Party.findById(partyId).lean())?.dmcBalancePaise ?? -1;

  const payIn = (amount: number, reference = `D-${Date.now()}-${Math.random()}`) => ({
    partyReference: reference,
    amountPaise: rupeesToPaise(amount),
  });


  // =========================================================================
  // The party's side of a dispute
  // =========================================================================

  it('lets a party dispute a pay-in its customer says they paid', async () => {
    const captainId = await makeCaptain();
    const { transaction } = await createPayIn(partyId, payIn(2_000), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);

    const disputed = await dispute(transaction._id, 'Our customer has a bank receipt', partyActor);

    expect(disputed.status).toBe('DISPUTED');
    // Nothing moves. The hold stays exactly where it was.
    expect(paiseToRupees(await captainDmc(captainId))).toBe(48_000);
    expect(await partyDmc()).toBe(OPENING);
  });

  it('cannot dispute a payment that already settled', async () => {
    const captainId = await makeCaptain();
    const { transaction } = await createPayIn(partyId, payIn(1_000), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);
    await confirmMovement(transaction._id, 'UPI-DONE');
    await settle(transaction._id);

    // SETTLED is terminal. Reopening it would mean commission already paid
    // might have to be clawed back, which is the thing the design avoids.
    await expect(dispute(transaction._id, 'Changed our mind', partyActor)).rejects.toThrow();
    expect(paiseToRupees(await captainDmc(captainId))).toBe(49_000);
  });

  it('is the same dispute whichever side raises it', async () => {
    const captainId = await makeCaptain();
    const { transaction } = await createPayIn(partyId, payIn(1_500), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);

    // The captain gets there first; the party's attempt finds it already open
    // rather than creating a second, competing dispute.
    await dispute(transaction._id, 'No money reached my UPI', {
      userId: String(new Types.ObjectId()),
      role: 'CAPTAIN',
    });
    const second = await dispute(transaction._id, 'Our customer paid', partyActor);

    expect(second.status).toBe('DISPUTED');
    expect(await Transaction.countDocuments({ status: 'DISPUTED' })).toBe(1);
    expect(paiseToRupees(await captainDmc(captainId))).toBe(48_500);
  });

  // =========================================================================
  // A captain handing a pay-in back
  // =========================================================================

  it('gives the capital straight back when a captain hands a pay-in back', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payIn(4_000), partyActor);
    await assignCaptain(transaction._id);
    expect(paiseToRupees(await captainDmc(captainId))).toBe(6_000);

    const released = await declineAsCaptain(transaction._id, captainId, 'I am out of cash today');

    // Immediately, not in fifteen minutes: the captain said they cannot do it,
    // so holding their capital against it is punishing them for saying so.
    expect(paiseToRupees(await captainDmc(captainId))).toBe(10_000);
    expect(released.status).toBe('CREATED');
    expect(released.captainId).toBeNull();
  });

  it('does not offer it straight back to the captain who handed it back', async () => {
    const first = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payIn(4_000), partyActor);
    await assignCaptain(transaction._id);
    await declineAsCaptain(transaction._id, first, 'Cannot do this one');

    // Only that captain exists, so there is nobody left — which is the right
    // answer, and much better than handing it back to them in a loop.
    const retry = await assignCaptain(transaction._id);
    expect(retry.captainId).toBeNull();

    // A second captain can take it.
    const second = await makeCaptain(10_000);
    const placed = await assignCaptain(transaction._id);
    expect(String(placed.captainId)).toBe(String(second));
    expect(paiseToRupees(await captainDmc(second))).toBe(6_000);
    expect(paiseToRupees(await captainDmc(first))).toBe(10_000);
  });

  it('will not let a captain hand back a QR the customer already has', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payIn(4_000), partyActor);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id, { gatewayQrPayload: 'upi://pay?x=1' });

    // Somebody may be paying it right now. Pulling the captain out from under
    // a live payment is how money ends up with nobody.
    await expect(declineAsCaptain(transaction._id, captainId, 'Changed my mind')).rejects.toThrow();
    expect(paiseToRupees(await captainDmc(captainId))).toBe(6_000);
  });

  it('will not let one captain hand back another’s transaction', async () => {
    const holder = await makeCaptain(10_000);
    const stranger = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payIn(4_000), partyActor);
    await assignCaptain(transaction._id);

    const actualHolder = (await Transaction.findById(transaction._id))?.captainId;
    const other = String(actualHolder) === String(holder) ? stranger : holder;

    await expect(declineAsCaptain(transaction._id, other, 'Not mine')).rejects.toThrow();
    // And nobody was credited for a hold they never had.
    expect(paiseToRupees(await captainDmc(other))).toBe(10_000);
  });

  it('cannot be raced into refunding the hold twice', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payIn(4_000), partyActor);
    await assignCaptain(transaction._id);

    const settled = await Promise.allSettled([
      declineAsCaptain(transaction._id, captainId, 'Out of cash'),
      declineAsCaptain(transaction._id, captainId, 'Out of cash'),
      declineAsCaptain(transaction._id, captainId, 'Out of cash'),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    // One refund, not three.
    expect(paiseToRupees(await captainDmc(captainId))).toBe(10_000);
  });

  it('needs a reason, so routing has something to learn from', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(partyId, payIn(4_000), partyActor);
    await assignCaptain(transaction._id);

    await expect(declineAsCaptain(transaction._id, captainId, '   ')).rejects.toThrow();
    expect(paiseToRupees(await captainDmc(captainId))).toBe(6_000);
  });
});
