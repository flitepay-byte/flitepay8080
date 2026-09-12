/**
 * The sweep, which is the only thing standing between a transaction and being
 * stuck forever.
 *
 * Everything else in the engine happens because somebody asked. These three
 * cases are the ones where nobody will ask again, and each one leaves real
 * money out of reach until the sweep runs — so each is tested for the money
 * coming back, not merely for the status changing.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Transaction, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { fundPlatformPool } from '../../services/platformAccount.service';
import { createPayIn, assignCaptain } from '../../services/transaction.service';
import {
  routeWaitingPayouts,
  expireOverdueTransactions,
  sweepTransactions,
} from '../../services/transactionSweep.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

describeIntegration('the transaction sweep', () => {
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
      email: `party-${unique}@sweep.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Sweep Commerce',
      contactEmail: partyUser.email,
      dmcBalancePaise: OPENING,
    });
    partyId = party._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };
  });

  async function makeCaptain(capitalRupees = 50_000, online = true): Promise<Types.ObjectId> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@sweep.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Sweep Captain',
      // Security as well as capital, because a deposit splits into both and a
      // captain needs the security: a pay-in is work, and work has to fit
      // under the task limit that security buys. A fixture with capital and no
      // security is a captain who could never take anything.
      collateralBalancePaise: rupeesToPaise(capitalRupees),
      dmcBalancePaise: rupeesToPaise(capitalRupees),
      isOnline: online,
      status: 'ACTIVE',
    });
    return captain._id;
  }

  const partyDmc = async (): Promise<number> =>
    (await Party.findById(partyId).lean())?.dmcBalancePaise ?? -1;

  const captainDmc = async (id: Types.ObjectId): Promise<number> =>
    (await Captain.findById(id).lean())?.dmcBalancePaise ?? -1;

  /** Move a transaction's deadline into the past, as time would. */
  async function makeOverdue(id: Types.ObjectId): Promise<void> {
    // Through the driver, because `expiresAt` set via the model would be fine
    // but this is the same trick the task audit needed for immutable fields —
    // going straight to the collection is unambiguous.
    await Transaction.collection.updateOne(
      { _id: id },
      { $set: { expiresAt: new Date(Date.now() - 60_000) } },
    );
  }


  // =========================================================================
  // Payouts nobody could take
  // =========================================================================

  it('leaves a pay-in alone — it was already refused at the door', async () => {
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: 'WAIT-2', amountPaise: rupeesToPaise(1_000) },
      partyActor,
    );
    await makeCaptain();

    // A customer standing at a checkout was told no. Quietly routing it later
    // would create a payment nobody is waiting to make.
    const routed = await routeWaitingPayouts();
    expect(routed).toBe(0);
    expect((await Transaction.findById(transaction._id))?.status).toBe('CREATED');
  });

  // =========================================================================
  // Windows that closed
  // =========================================================================

  it('gives the captain their capital back when a pay-in window closes', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: 'OLD-1', amountPaise: rupeesToPaise(4_000) },
      partyActor,
    );
    await assignCaptain(transaction._id);
    expect(paiseToRupees(await captainDmc(captainId))).toBe(6_000);

    await makeOverdue(transaction._id);
    const expired = await expireOverdueTransactions();

    expect(expired).toBe(1);
    // The customer never paid, so the captain is made whole.
    expect(paiseToRupees(await captainDmc(captainId))).toBe(10_000);
    expect((await Transaction.findById(transaction._id))?.status).toBe('EXPIRED');
  });

  it('never expires a settled transaction', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: 'OLD-3', amountPaise: rupeesToPaise(1_000) },
      partyActor,
    );
    await assignCaptain(transaction._id);
    const { confirmMovement, settle } = await import('../../services/transaction.service');
    const { openToCustomer } = await import('../../services/transaction.service');
    await openToCustomer(transaction._id);
    await confirmMovement(transaction._id, 'UPI-1');
    await settle(transaction._id);

    // Overdue and finished. Expiring it would refund money already paid out.
    await makeOverdue(transaction._id);
    expect(await expireOverdueTransactions()).toBe(0);

    expect((await Transaction.findById(transaction._id))?.status).toBe('SETTLED');
    expect(paiseToRupees(await captainDmc(captainId))).toBe(9_000);
    expect(paiseToRupees((await partyDmc()) - OPENING)).toBe(1_000);
  });

  it('never expires a dispute on a timer', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: 'OLD-4', amountPaise: rupeesToPaise(2_000) },
      partyActor,
    );
    await assignCaptain(transaction._id);
    const { openToCustomer, dispute } = await import('../../services/transaction.service');
    await openToCustomer(transaction._id);
    await dispute(transaction._id, 'The customer says they paid');

    await makeOverdue(transaction._id);
    expect(await expireOverdueTransactions()).toBe(0);

    // A dispute is waiting on a person, not a clock. Expiring it would decide
    // it in the party's favour with nobody having looked.
    expect((await Transaction.findById(transaction._id))?.status).toBe('DISPUTED');
    expect(paiseToRupees(await captainDmc(captainId))).toBe(8_000);
  });

  it('sweeps repeatedly without double-refunding anything', async () => {
    const captainId = await makeCaptain(10_000);
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: 'OLD-5', amountPaise: rupeesToPaise(3_000) },
      partyActor,
    );
    await assignCaptain(transaction._id);
    await makeOverdue(transaction._id);

    await sweepTransactions();
    await sweepTransactions();
    await sweepTransactions();

    // Three passes, one refund. The claim is what makes the second and third
    // passes do nothing at all.
    expect(paiseToRupees(await captainDmc(captainId))).toBe(10_000);
  });

});
