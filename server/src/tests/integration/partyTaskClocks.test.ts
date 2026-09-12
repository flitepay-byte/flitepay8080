/**
 * Whose clock a task runs on.
 *
 * The four deadlines used to be a system setting, with two of them — the time
 * to accept and the time to complete — overridable on a *captain's* profile.
 * That put the decision in the wrong hands: the party is the one promising a
 * customer something, and which promise was actually enforced depended on
 * which captain happened to pick the work up.
 *
 * Now the windows are the party's, resolved when the task is created and
 * written onto it. These tests pin three things: that the party's window is
 * what governs, that the settings default still covers a party that has set
 * nothing, and that once a task exists its clock cannot be moved under it.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig, getConfig } from '../../services/systemConfig.service';
import { createTask, claimTask } from '../../services/task.service';
import { expireStaleUnclaimedTasks } from '../../services/workflow.service';
import { clocksFor, clocksOf } from '../../services/taskClocks.service';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('a task runs on its party’s clocks', () => {
  /** The settings defaults everything falls back to. */
  const DEFAULTS = {
    taskAcceptanceMinutes: 5,
    taskCompletionMinutes: 30,
    taskMaxAgeMinutes: 40,
    taskExpiryAckMinutes: 10,
  };

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
    await updateConfig(DEFAULTS, new Types.ObjectId());
  });

  interface PartyRef {
    id: Types.ObjectId;
    actor: { userId: string; role: 'PARTY' };
  }
  interface CaptainRef {
    id: Types.ObjectId;
    actor: { userId: string; role: 'CAPTAIN' };
  }

  async function makeParty(clocks?: Record<string, number>): Promise<PartyRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `party-${unique}@clocks.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Party',
      role: 'PARTY',
    });
    const party = await Party.create({
      userId: user._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Clocks Ltd',
      contactEmail: user.email,
      dmcBalancePaise: rupeesToPaise(100_000),
      ...(clocks ?? {}),
    });
    return { id: party._id, actor: { userId: String(user._id), role: 'PARTY' } };
  }

  async function makeCaptain(): Promise<CaptainRef> {
    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique}@clocks.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Clocks Captain',
      collateralBalancePaise: rupeesToPaise(100_000),
      dmcBalancePaise: rupeesToPaise(1_000_000),
      isOnline: true,
      status: 'ACTIVE',
    });
    return { id: captain._id, actor: { userId: String(user._id), role: 'CAPTAIN' } };
  }

  const makeTask = (party: PartyRef) =>
    createTask(
      {
        partyId: party.id,
        createdBy: party.id,
        customerName: 'Customer',
        payoutMethod: { type: 'UPI', upiId: 'customer@bank' },
        amountPaise: rupeesToPaise(1_000),
      },
      party.actor,
    );

  /** Minutes between two instants, rounded — the clocks are whole minutes. */
  const minutesBetween = (from: Date, to: Date): number =>
    Math.round((to.getTime() - from.getTime()) / 60_000);

  // =========================================================================
  // Resolution
  // =========================================================================

  it('writes the party’s four windows onto every task they create', async () => {
    // The client's example, in full.
    const party = await makeParty({
      acceptanceMinutes: 2,
      completionMinutes: 15,
      maxAgeMinutes: 20,
      expiryAckMinutes: 5,
    });

    const task = await makeTask(party);

    expect({
      acceptanceMinutes: task.acceptanceMinutes,
      completionMinutes: task.completionMinutes,
      maxAgeMinutes: task.maxAgeMinutes,
      expiryAckMinutes: task.expiryAckMinutes,
    }).toEqual({
      acceptanceMinutes: 2,
      completionMinutes: 15,
      maxAgeMinutes: 20,
      expiryAckMinutes: 5,
    });
  });

  it('writes the settings defaults for a party that has set none', async () => {
    const party = await makeParty();

    const task = await makeTask(party);

    expect(task.acceptanceMinutes).toBe(5);
    expect(task.completionMinutes).toBe(30);
    expect(task.maxAgeMinutes).toBe(40);
    expect(task.expiryAckMinutes).toBe(10);
  });

  it('falls back one window at a time, not all four together', async () => {
    // A party who has only asked for a shorter completion window keeps the
    // default everywhere else.
    const party = await makeParty({ completionMinutes: 12 });

    const task = await makeTask(party);

    expect(task.completionMinutes).toBe(12);
    expect(task.acceptanceMinutes).toBe(5);
    expect(task.maxAgeMinutes).toBe(40);
    expect(task.expiryAckMinutes).toBe(10);
  });

  it('gives two parties’ tasks two different clocks', async () => {
    const quick = await makeParty({ completionMinutes: 10 });
    const patient = await makeParty({ completionMinutes: 120 });

    expect((await makeTask(quick)).completionMinutes).toBe(10);
    expect((await makeTask(patient)).completionMinutes).toBe(120);
  });

  // =========================================================================
  // What the captain is actually held to
  // =========================================================================

  it('gives the captain the party’s completion window when they claim', async () => {
    const party = await makeParty({ completionMinutes: 15 });
    const captain = await makeCaptain();
    const task = await makeTask(party);
    await Task.updateOne({ _id: task._id }, { $set: { openPoolAt: new Date() } });

    const before = new Date();
    await claimTask(String(task._id), captain.id, captain.actor);

    const claimed = await Task.findById(task._id).lean();
    // 15 from the party, not the 30 in settings.
    expect(minutesBetween(before, claimed?.expiresAt ?? before)).toBe(15);
  });

  it('gives the offered captain the party’s acceptance window', async () => {
    // Creating the task routes it, so the offer and its countdown are already
    // on the row — asked for again here it would find no captain it had not
    // already tried.
    const party = await makeParty({ acceptanceMinutes: 2 });
    await makeCaptain();

    const before = new Date();
    const task = await makeTask(party);

    const offered = await Task.findById(task._id).lean();
    expect(offered?.offeredCaptainId).not.toBeNull();
    // 2 from the party, not the 5 in settings.
    expect(minutesBetween(before, offered?.offerExpiresAt ?? before)).toBe(2);
  });

  it('holds every captain to the same window, whoever takes it', async () => {
    /**
     * The reason the setting moved off the captain. Two captains, one party's
     * task: both are held to the party's fifteen minutes, because the promise
     * was the party's to make and the customer is waiting on that one.
     */
    const party = await makeParty({ completionMinutes: 15 });
    const first = await makeCaptain();
    const second = await makeCaptain();

    for (const captain of [first, second]) {
      const task = await makeTask(party);
      await Task.updateOne({ _id: task._id }, { $set: { openPoolAt: new Date() } });
      const before = new Date();
      await claimTask(String(task._id), captain.id, captain.actor);
      const claimed = await Task.findById(task._id).lean();
      expect(minutesBetween(before, claimed?.expiresAt ?? before)).toBe(15);
    }
  });

  // =========================================================================
  // Giving up on unclaimed work
  // =========================================================================

  it('gives up on a task at its own party’s age, not one age for all', async () => {
    /**
     * Two parties, two ceilings, one sweep. A single global cutoff would
     * either leave the impatient party's task sitting past its promise or
     * cancel the patient party's early.
     */
    const impatient = await makeParty({ maxAgeMinutes: 20 });
    const patient = await makeParty({ maxAgeMinutes: 240 });
    const short = await makeTask(impatient);
    const long = await makeTask(patient);

    // Both created half an hour ago: past one ceiling, well inside the other.
    const thirtyAgo = new Date(Date.now() - 30 * 60_000);
    // Through the driver, not the model: mongoose maintains createdAt itself,
    // so a model update is the one write that will not move it.
    await Task.collection.updateMany(
      { _id: { $in: [short._id, long._id] } },
      { $set: { createdAt: thirtyAgo } },
    );
    expect((await Task.findById(short._id).lean())?.createdAt).toEqual(thirtyAgo);

    const cancelled = await expireStaleUnclaimedTasks();

    expect(cancelled.map((t) => String(t._id))).toEqual([String(short._id)]);
    expect((await Task.findById(long._id).lean())?.status).toBe('CREATED');
  });

  // =========================================================================
  // A clock already running
  // =========================================================================

  it('does not move a task’s clock when the party changes theirs', async () => {
    // The reason the windows are copied onto the task rather than read back
    // off the party: a captain who accepted a job with fifteen minutes on it
    // keeps fifteen minutes.
    const party = await makeParty({ completionMinutes: 15 });
    const task = await makeTask(party);

    await Party.updateOne({ _id: party.id }, { $set: { completionMinutes: 90 } });

    expect((await Task.findById(task._id).lean())?.completionMinutes).toBe(15);
  });

  it('does not move a task’s clock when the settings default changes', async () => {
    const party = await makeParty(); // on the defaults
    const task = await makeTask(party);

    await updateConfig({ taskCompletionMinutes: 90 }, new Types.ObjectId());

    const stored = await Task.findById(task._id).lean();
    expect(stored?.completionMinutes).toBe(30);
    const config = await getConfig();
    expect(clocksOf(stored ?? {}, config).completionMinutes).toBe(30);
  });

  it('falls back to the settings default for a task written before clocks existed', async () => {
    // Rows created before tasks carried their own windows have none. They keep
    // behaving exactly as they did rather than running to zero.
    const config = await getConfig();

    expect(clocksOf({}, config)).toEqual({
      acceptanceMinutes: 5,
      completionMinutes: 30,
      maxAgeMinutes: 40,
      expiryAckMinutes: 10,
      confirmationMinutes: 30,
    });
  });

  it('resolves a party’s windows against the defaults in one place', async () => {
    const config = await getConfig();

    expect(clocksFor(config, { completionMinutes: 15 })).toEqual({
      acceptanceMinutes: 5,
      completionMinutes: 15,
      maxAgeMinutes: 40,
      expiryAckMinutes: 10,
      confirmationMinutes: 30,
    });
    expect(clocksFor(config, null)).toEqual({
      acceptanceMinutes: 5,
      completionMinutes: 30,
      maxAgeMinutes: 40,
      expiryAckMinutes: 10,
      confirmationMinutes: 30,
    });
  });
});
