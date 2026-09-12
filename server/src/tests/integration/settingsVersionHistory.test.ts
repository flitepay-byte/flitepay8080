/**
 * What the settings were, at every version they have been.
 *
 * SystemConfig is a single document edited in place, so each save overwrote
 * the values it replaced. The version counter went up but the state it counted
 * was gone — "priced under v2" named something nobody could look at any more,
 * and the audit log's diffs answered "what moved" without ever answering "what
 * was everything else at the time".
 *
 * Each version is now copied whole when it is made. These tests pin that a
 * version is recorded for every change and no change, that an old one still
 * reads as it did after later edits, and that the record cannot be altered
 * afterwards — which is the only thing that makes it worth citing.
 */
import '../../globalErrorHandlers';
import request from 'supertest';
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { createApp } from '../../app';
import { User, SystemConfig, SystemConfigVersion, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { env } from '../../config/env';

const P = env.API_PREFIX;

describeIntegration('the settings version history', () => {
  const app = createApp();

  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();
  });

  interface Fixture {
    agent: ReturnType<typeof request.agent>;
    csrfToken: string;
  }

  async function signIn(): Promise<Fixture> {
    const email = `admin-${new Types.ObjectId().toHexString()}@versions.test`;
    await User.create({
      email,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Version Admin',
      role: 'ADMIN',
    });

    const agent = request.agent(app);
    const step1 = await agent.post(`${P}/auth/login`).send({ email, password: 'Demo@12345' });
    const step2 = await agent
      .post(`${P}/auth/verify-otp`)
      .send({ challengeId: step1.body?.data?.challengeId, otp: step1.body?.data?.devOtp });

    return { agent, csrfToken: step2.body?.data?.csrfToken ?? '' };
  }

  const save = (f: Fixture, body: Record<string, unknown>) =>
    f.agent.patch(`${P}/admin/settings`).set('x-csrf-token', f.csrfToken).send(body);

  const versionsOf = async (): Promise<number[]> =>
    (await SystemConfigVersion.find().sort({ version: 1 }).lean()).map((v) => v.version);

  // =========================================================================
  // What gets recorded
  // =========================================================================

  it('records the version the system starts on, before anybody edits it', async () => {
    // Without this the history would begin at the first edit, and the state
    // every task before it was priced under would still be unrecoverable.
    expect(await versionsOf()).toEqual([1]);
  });

  it('records a new version for each change', async () => {
    const f = await signIn();

    await save(f, { payOutCaptainCommissionPercentage: 6 });
    await save(f, { payOutCaptainCommissionPercentage: 7 });

    expect(await versionsOf()).toEqual([1, 2, 3]);
  });

  it('records nothing when a save changes nothing', async () => {
    // The version counter already refuses to move on an empty diff. The
    // history has to agree with it, or a "version" would exist that the
    // config itself never had.
    const f = await signIn();
    await save(f, { payOutCaptainCommissionPercentage: 6 });

    await save(f, { payOutCaptainCommissionPercentage: 6 });

    expect(await versionsOf()).toEqual([1, 2]);
  });

  it('keeps the whole config in each version, not only what changed', async () => {
    const f = await signIn();
    await save(f, { payOutCaptainCommissionPercentage: 6 });

    const v2 = await SystemConfigVersion.findOne({ version: 2 }).lean();
    // The field that moved, and a field that did not — the second is the
    // point: the diff alone could never answer what the rest were.
    expect(v2?.snapshot['payOutCaptainCommissionPercentage']).toBe(6);
    expect(v2?.snapshot['taskCompletionMinutes']).toBeDefined();
    expect(v2?.changes).toEqual({
      payOutCaptainCommissionPercentage: { from: expect.anything(), to: 6 },
    });
  });

  it('names who saved it, and leaves it empty for the bootstrap', async () => {
    const f = await signIn();
    await save(f, { taskCompletionMinutes: 45 });

    expect((await SystemConfigVersion.findOne({ version: 1 }).lean())?.updatedBy).toBeNull();
    expect((await SystemConfigVersion.findOne({ version: 2 }).lean())?.updatedBy).not.toBeNull();
  });

  // =========================================================================
  // Reading it back
  // =========================================================================

  it('still reads an old version correctly after later changes', async () => {
    /**
     * The whole reason the feature exists. A commission row citing v2 must be
     * explicable in six months, by which time the live settings have moved on
     * several times.
     */
    const f = await signIn();
    await save(f, { payOutCaptainCommissionPercentage: 6 });
    await save(f, { payOutCaptainCommissionPercentage: 9 });
    await save(f, { payOutCaptainCommissionPercentage: 2 });

    const res = await f.agent.get(`${P}/admin/settings/versions/2`);

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.settings.payOutCaptainCommissionPercentage).toBe(6);
  });

  it('lists versions newest first, with what each one changed', async () => {
    const f = await signIn();
    await save(f, { payOutCaptainCommissionPercentage: 6 });
    await save(f, { taskCompletionMinutes: 45, taskAcceptanceMinutes: 3 });

    const res = await f.agent.get(`${P}/admin/settings/versions?page=1&limit=10`);

    expect(res.status).toBe(200);
    const items = res.body.data.items as Array<{ version: number; changedCount: number; isCurrent: boolean }>;
    expect(items.map((i) => i.version)).toEqual([3, 2, 1]);
    expect(items[0]?.changedCount).toBe(2);
    expect(items[0]?.isCurrent).toBe(true);
    expect(items[2]?.changedCount).toBe(0);
    expect(res.body.data.currentVersion).toBe(3);
  });

  it('reads an old version in the same units as the live screen', async () => {
    // Paise are stored, rupees are shown. A history in different units than
    // the settings page is a history nobody can compare against anything.
    const f = await signIn();
    await save(f, { minimumTaskAmount: 250 });

    const res = await f.agent.get(`${P}/admin/settings/versions/2`);

    expect(res.body.data.settings.minimumTaskAmount).toBe(250);
    expect(res.body.data.settings['minimumTaskAmountPaise']).toBeUndefined();
  });

  it('says so plainly when a version was never recorded', async () => {
    const f = await signIn();

    const res = await f.agent.get(`${P}/admin/settings/versions/99`);

    expect(res.status).toBe(404);
  });

  // =========================================================================
  // It cannot be rewritten
  // =========================================================================

  it('refuses to let a recorded version be edited or deleted', async () => {
    /**
     * A version is a record of a state that really existed, and commission
     * rows cite it by number. Editing one would make every row that cites it
     * a lie, so the model refuses rather than trusting nobody to try.
     */
    await expect(
      SystemConfigVersion.updateOne({ version: 1 }, { $set: { version: 99 } }),
    ).rejects.toThrow(/cannot be modified/i);

    await expect(SystemConfigVersion.deleteOne({ version: 1 })).rejects.toThrow(/cannot be modified/i);

    expect(await versionsOf()).toEqual([1]);
  });

  it('does not record the same version twice', async () => {
    // Boots repeatedly, and two workers can start together. The unique index
    // is what makes that safe rather than a check-then-write.
    await ensureSystemConfig();
    await ensureSystemConfig();

    expect(await versionsOf()).toEqual([1]);
  });

  it('starts the history from the live version on a database that had none', async () => {
    // An existing deployment upgrading into this feature. Its earlier versions
    // are gone, but the one it is on is still here to copy — so the history
    // begins at something real rather than at the next edit.
    const f = await signIn();
    await save(f, { payOutCaptainCommissionPercentage: 6 });
    await SystemConfigVersion.collection.deleteMany({});
    expect(await versionsOf()).toEqual([]);

    await ensureSystemConfig();

    const kept = await SystemConfigVersion.findOne({}).lean();
    const live = await SystemConfig.findOne({ key: 'GLOBAL' }).lean();
    expect(kept?.version).toBe(live?.version);
    expect(kept?.snapshot['payOutCaptainCommissionPercentage']).toBe(6);
  });

  it('does not fail a settings change when the history cannot be written', async () => {
    /**
     * The change is the thing the operator asked for; the copy is a record of
     * it. Refusing the change because the record failed would undo real work
     * to protect a note about it — so the gap is left visible instead.
     */
    const f = await signIn();
    // Rejected for the whole request, not once: a cache miss on the way in
    // makes `getConfig` re-run the bootstrap, which would otherwise absorb a
    // single-shot failure before the save it was meant for ever ran.
    const create = jest
      .spyOn(SystemConfigVersion, 'create')
      .mockRejectedValue(new Error('disk on fire'));

    const res = await save(f, { payOutCaptainCommissionPercentage: 6 });

    expect(res.status).toBe(200);
    const live = await SystemConfig.findOne({ key: 'GLOBAL' }).lean();
    expect(live?.payOutCaptainCommissionPercentage).toBe(6);
    expect(live?.version).toBe(2);
    expect(await SystemConfigVersion.findOne({ version: 2 }).lean()).toBeNull();
    create.mockRestore();
  });

  it('is admin-only', async () => {
    const res = await request(app).get(`${P}/admin/settings/versions`);
    expect([401, 403]).toContain(res.status);
  });
});
