/**
 * "What is my money committed to right now?"
 *
 * The captain's In-progress screen asks this to fill the pay-outs panel, which
 * before this could never show anything: it filtered transactions for
 * `direction === 'PAY_OUT'`, and a pay-out has been a task since the direction
 * was removed from the transaction engine. So a captain carrying ten pay-outs
 * saw "Nothing to send".
 *
 * The question is asked by name rather than by listing states, because the set
 * is exactly "the claim's hold has not come back yet" and that belongs in one
 * place. These tests pin which states those are, from the captain's side.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Party, Captain, Task, Session, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { signAccessToken, ACCESS_COOKIE } from '../../services/token.service';
import { rupeesToPaise } from '../../utils/money';
import type { TaskState } from '../../types';

interface Row { id: string; taskCode: string; status: TaskState; amount: number }

describeIntegration('the tasks a captain’s money is committed to', () => {
  const app = createApp();

  let cookie: string;
  let captainId: Types.ObjectId;
  let partyId: Types.ObjectId;
  let partyUserId: Types.ObjectId;
  let seq = 0;

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

    const partyUser = await User.create({
      email: `party-${unique}@hold.test`, passwordHash: password, name: 'Party', role: 'PARTY',
    });
    const party = await Party.create({
      userId: partyUser._id,
      partyCode: `PARTY-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      companyName: 'Holding Ltd',
      contactEmail: partyUser.email,
      dmcBalancePaise: rupeesToPaise(100_000),
    });
    partyId = party._id;
    partyUserId = partyUser._id;

    const captainUser = await User.create({
      email: `cap-${unique}@hold.test`, passwordHash: password, name: 'Captain', role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: captainUser._id,
      captainCode: `CAP-${Math.floor(Math.random() * 899_999 + 100_000)}`,
      displayName: 'Holding Captain',
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
    cookie = `${ACCESS_COOKIE}=${signAccessToken({
      sub: String(captainUser._id),
      role: 'CAPTAIN',
      email: captainUser.email,
      sid,
      captainId: String(captain._id),
    })}`;
  });

  async function task(
    status: TaskState,
    amount = 1_000,
    owner: Types.ObjectId | null = captainId,
  ): Promise<string> {
    seq += 1;
    const code = `TASK-HOLD-${seq}`;
    await Task.create({
      taskCode: code,
      partyId,
      captainId: owner,
      customerName: 'Holding Customer',
      identifier: `UPI-${seq}`,
      amountPaise: rupeesToPaise(amount),
      externalRef: `EXT-HOLD-${seq}`,
      status,
      createdBy: partyUserId,
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });
    return code;
  }

  const holding = async (): Promise<Row[]> => {
    const res = await request(app)
      .get('/api/v1/captain/tasks?page=1&limit=50&holding=true')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body.data.items as Row[];
  };

  it('lists every state in which the hold is still out', async () => {
    // Exactly the states a claim's DMC has not come back from. Pinned here so
    // adding a state to the workflow without deciding about the hold shows up
    // as a failure rather than as a quietly missing row.
    for (const state of [
      'ASSIGNED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'AUDIT_PENDING',
      'REJECTED', 'CANCEL_REVIEW', 'CANCEL_DISPUTED',
    ] as TaskState[]) {
      await task(state);
    }

    const rows = await holding();
    expect(rows).toHaveLength(7);
  });

  it('leaves out the states where the hold has already come back', async () => {
    await task('ASSIGNED');
    await task('COMPLETED');
    await task('CANCELLED');
    await task('EXPIRED');
    await task('REASSIGNED', 1_000, null);

    const rows = await holding();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ASSIGNED');
  });

  it('leaves out another captain’s work', async () => {
    await task('ASSIGNED', 1_000);
    await task('IN_PROGRESS', 9_000, new Types.ObjectId());

    const rows = await holding();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(1_000);
  });

  it('leaves out a task they merely used to hold', async () => {
    // A task rejected off them stays in their history, but their money is not
    // in it any more — so it must not be counted as committed.
    seq += 1;
    await Task.create({
      taskCode: `TASK-HOLD-${seq}`,
      partyId,
      captainId: null,
      previousCaptainIds: [captainId],
      customerName: 'Former Customer',
      identifier: `UPI-${seq}`,
      amountPaise: rupeesToPaise(4_000),
      externalRef: `EXT-HOLD-${seq}`,
      status: 'REASSIGNED',
      createdBy: partyUserId,
      stateHistory: [{ from: null, to: 'CREATED', at: new Date() }],
    });

    expect(await holding()).toHaveLength(0);
  });

  it('is empty, not broken, when nothing is held', async () => {
    await task('COMPLETED');
    expect(await holding()).toEqual([]);
  });

  it('still lists their whole history when not asked about holdings', async () => {
    await task('ASSIGNED');
    await task('COMPLETED');

    const res = await request(app)
      .get('/api/v1/captain/tasks?page=1&limit=50')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
  });
});
