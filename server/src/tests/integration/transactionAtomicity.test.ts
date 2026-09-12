/**
 * When the deployment can give us a real transaction, every part of a money
 * movement is inside it.
 *
 * This is a wiring test, and deliberately only that. Whether MongoDB commits
 * atomically is MongoDB's job and not worth re-testing here. What *is* worth
 * testing is the thing that silently goes wrong in code like this: one write
 * forgetting to pass the session, so it commits on its own while the rest
 * rolls back — which is worse than having no transaction at all, because it
 * looks safe.
 *
 * Two things have to be faked to observe that, and both are faked at the edge
 * rather than in the code under test.
 *
 * `supportsTransactions` is forced on, because a development machine is
 * normally a single node where the atomic path never runs — this suite would
 * otherwise pass by not running, which is the exact failure it exists to catch.
 *
 * The session itself is a stand-in that simply runs the body, and each write
 * records whether it was given one and then drops it before calling through.
 * A single node cannot open a real session, so without this the first write
 * would fail and everything after it — the part actually under test — would
 * never execute.
 */
import mongoose, { Types } from 'mongoose';

jest.mock('../../config/db', () => {
  const actual = jest.requireActual('../../config/db');
  return { ...actual, supportsTransactions: jest.fn(async () => true) };
});

import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Transaction, PlatformAccount, WalletEntry, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { fundPlatformPool } from '../../services/platformAccount.service';
import {
  createPayIn,
  assignCaptain,
  openToCustomer,
  confirmMovement,
  settle,
} from '../../services/transaction.service';
import { supportsTransactions } from '../../config/db';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('money movements under a transaction', () => {
  let partyId: Types.ObjectId;
  let partyActor: { userId: string; role: 'PARTY' };

  let withSession: string[] = [];
  let withoutSession: string[] = [];
  const spies: jest.SpyInstance[] = [];

  /**
   * Record whether this write was handed the session, then run it for real
   * without one. The recording is the assertion; dropping the fake session is
   * what lets the rest of the flow actually execute.
   */
  function watch(model: unknown, name: string): void {
    for (const method of ['updateOne', 'findOneAndUpdate', 'create'] as const) {
      const target = model as Record<string, (...a: unknown[]) => unknown>;
      const original = target[method];
      if (typeof original !== 'function') continue;
      const spy = jest
        .spyOn(model as never, method as never)
        .mockImplementation(function (this: unknown, ...args: unknown[]) {
          const optionIndex = method === 'create' ? 1 : 2;
          const options = args[optionIndex] as { session?: unknown } | undefined;
          (options?.session ? withSession : withoutSession).push(`${name}.${method}`);
          const stripped = [...args];
          if (options && 'session' in options) {
            const { session: _drop, ...rest } = options;
            stripped[optionIndex] = rest;
          }
          return original.apply(this, stripped);
        } as never);
      spies.push(spy);
    }
  }

  function watchAll(): void {
    watch(Transaction, 'Transaction');
    watch(Party, 'Party');
    watch(Captain, 'Captain');
    watch(PlatformAccount, 'PlatformAccount');
    watch(WalletEntry, 'WalletEntry');
  }

  function stopWatching(): void {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  }

  /** A session that does nothing but run the body it is given. */
  function fakeSessions(): void {
    const spy = jest.spyOn(mongoose, 'startSession').mockResolvedValue({
      withTransaction: async (fn: () => Promise<unknown>) => fn(),
      endSession: async () => undefined,
    } as never);
    spies.push(spy);
  }

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(async () => {
    stopWatching();
    jest.restoreAllMocks();
    await teardownDatabase();
  });

  beforeEach(async () => {
    stopWatching();
    withSession = [];
    withoutSession = [];
    jest.mocked(supportsTransactions).mockResolvedValue(true);

    await clearCollections();
    await ensureSystemConfig();
    // Rates set, or nothing touches the pool and this suite would pass by
    // observing an operation that never happened.
    const { updateConfig } = await import('../../services/systemConfig.service');
    await updateConfig(
      { payInPartyCommissionPercentage: 3, payInCaptainCommissionPercentage: 1 },
      new Types.ObjectId(),
    );
    await fundPlatformPool(rupeesToPaise(50_000));

    const unique = new Types.ObjectId().toHexString();
    const partyUser = await User.create({
      email: `party-${unique}@atomic.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Atomic Commerce',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(100_000),
    });
    partyId = party._id;
    partyActor = { userId: String(partyUser._id), role: 'PARTY' };
  });

  async function makeCaptain(): Promise<Types.ObjectId> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@atomic.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Atomic Captain',
      // Security as well as capital, because a deposit splits into both and a
      // captain needs the security: a pay-in is work, and work has to fit
      // under the task limit that security buys. A fixture with capital and no
      // security is a captain who could never take anything.
      collateralBalancePaise: rupeesToPaise(50_000),
      dmcBalancePaise: rupeesToPaise(50_000),
      isOnline: true,
      status: 'ACTIVE',
    });
    return captain._id;
  }

  it('holds the captain’s capital inside the same unit as the claim', async () => {
    const captainId = await makeCaptain();
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: 'ATOM-1', amountPaise: rupeesToPaise(4_000) },
      partyActor,
    );

    fakeSessions();
    watchAll();
    await assignCaptain(transaction._id);
    stopWatching();

    // Both halves, or neither: a claim that commits without the debit leaves a
    // captain assigned work their capital was never committed to.
    expect(withSession).toContain('Transaction.findOneAndUpdate');
    expect(withSession).toContain('Captain.findOneAndUpdate');
    // The one write that is legitimately outside: `lastOfferedAt` is routing
    // bookkeeping rather than money, and it is written only once the claim has
    // already stuck.
    expect(withoutSession).toEqual(['Captain.updateOne']);

    // And it really happened, rather than only being recorded.
    const captain = await Captain.findById(captainId).lean();
    expect(captain?.dmcBalancePaise).toBe(rupeesToPaise(46_000));
  });

  it('credits the party and pays the commission inside the claim’s unit', async () => {
    const captainId = await makeCaptain();
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: 'ATOM-2', amountPaise: rupeesToPaise(1_000) },
      partyActor,
    );
    // Arranged with the probe off, so getting the transaction into a settleable
    // state does not itself try to open a session this node cannot give.
    jest.mocked(supportsTransactions).mockResolvedValue(false);
    await assignCaptain(transaction._id);
    await openToCustomer(transaction._id);
    await confirmMovement(transaction._id, 'UPI-ATOM');
    jest.mocked(supportsTransactions).mockResolvedValue(true);

    fakeSessions();
    watchAll();
    await settle(transaction._id);
    stopWatching();

    // The claim, the party's credit, and the pool the commission comes out of.
    // A commission that escaped the transaction would be the platform paying a
    // fee for a settlement that rolled back.
    expect(withSession).toContain('Transaction.findOneAndUpdate');
    expect(withSession).toContain('Party.updateOne');
    expect(withSession).toContain('PlatformAccount.findOneAndUpdate');
    expect(withSession).toContain('Captain.findOneAndUpdate');
    // The wallet ledger entry too: a commission credited without its ledger
    // row is a balance nobody can rebuild or argue with.
    expect(withSession).toContain('WalletEntry.create');
    expect(withoutSession).toHaveLength(0);

    // Commission lands in spendable DMC: 10,000 less the 1,000 given up, plus
    // the 1% share back.
    const captain = await Captain.findById(captainId).lean();
    expect(captain?.dmcBalancePaise).toBe(rupeesToPaise(49_010));
  });

  it('still works when the deployment has no transactions at all', async () => {
    // The other half of the contract. A single node is the normal case for
    // development, and refusing to run there would be far worse than running
    // without the guarantee.
    jest.mocked(supportsTransactions).mockResolvedValue(false);

    const captainId = await makeCaptain();
    const { transaction } = await createPayIn(
      partyId,
      { partyReference: 'ATOM-4', amountPaise: rupeesToPaise(2_000) },
      partyActor,
    );

    watchAll();
    const assigned = await assignCaptain(transaction._id);
    stopWatching();

    expect(String(assigned.captainId)).toBe(String(captainId));
    // Nothing asked for a session, and the money moved anyway.
    expect(withSession).toHaveLength(0);
    const captain = await Captain.findById(captainId).lean();
    expect(captain?.dmcBalancePaise).toBe(rupeesToPaise(48_000));
  });
});
