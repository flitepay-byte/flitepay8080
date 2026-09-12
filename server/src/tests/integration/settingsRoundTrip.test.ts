/**
 * Opening the settings screen and saving it must change nothing.
 *
 * The settings form binds each input to the value the read returns, falling
 * back to zero when the key is absent. A paise field the read forgets to
 * convert therefore does not merely fail to appear — it appears as DMC 0 while
 * the platform is really charging something else, and an admin who adjusts it
 * is editing from a number that was never true.
 *
 * `adminFlatCommissionPaise` was exactly that: missing from the list of paise
 * fields the read converts, so the platform's flat commission always showed as
 * zero on the screen that sets it. These tests hold the general rule rather
 * than that one field — every paise setting is displayed as stored, and
 * replaying the screen back changes nothing.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { User, Session, SystemConfig, hashPassword } from '../../models';
import { ensureSystemConfig, updateConfig, getConfig } from '../../services/systemConfig.service';
import { createApp } from '../../app';
import { signAccessToken, ACCESS_COOKIE } from '../../services/token.service';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('the admin settings screen', () => {
  const app = createApp();
  let cookie: string;

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();

    const unique = new Types.ObjectId().toHexString();
    const adminUser = await User.create({
      email: `admin-${unique}@settings.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'Admin',
      role: 'ADMIN',
    });
    const sid = new Types.ObjectId().toHexString();
    await Session.create({
      sessionId: sid,
      userId: adminUser._id,
      refreshTokenHash: 'test-session-not-refreshed',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    cookie = `${ACCESS_COOKIE}=${signAccessToken({
      sub: String(adminUser._id),
      role: 'ADMIN',
      email: adminUser.email,
      sid,
    })}`;
  });

  const read = async (): Promise<Record<string, unknown>> => {
    const res = await request(app).get('/api/v1/admin/settings').set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body.data as Record<string, unknown>;
  };

  const save = async (draft: Record<string, unknown>): Promise<void> => {
    const res = await request(app).patch('/api/v1/admin/settings').set('Cookie', cookie).send(draft);
    expect(res.status).toBe(200);
  };

  /** Every paise setting, with a value that is obviously not a default. */
  const STORED_TO_INPUT: Record<string, string> = {
    captainDailyLimitPaise: 'captainDailyLimit',
    captainMonthlyLimitPaise: 'captainMonthlyLimit',
    partyDailyLimitPaise: 'partyDailyLimit',
    partyMonthlyLimitPaise: 'partyMonthlyLimit',
    minimumTaskAmountPaise: 'minimumTaskAmount',
    maximumTaskAmountPaise: 'maximumTaskAmount',
  };

  it('reads back every paise setting in rupees', async () => {
    await updateConfig({ minimumTaskAmountPaise: rupeesToPaise(37) }, new Types.ObjectId());
    const view = await read();

    for (const [stored, input] of Object.entries(STORED_TO_INPUT)) {
      // The rupee-named key is what the form binds to. A stored key leaking
      // through instead means the form has nothing to show and will send back
      // a zero.
      expect(view).toHaveProperty(input);
      expect(view).not.toHaveProperty(stored);
    }
    expect(view['minimumTaskAmount']).toBe(37);
  });

  it('replays the screen back without changing anything', async () => {
    // Values chosen so a wipe to zero is unmistakable.
    await updateConfig(
      {
        minimumTaskAmountPaise: rupeesToPaise(37),
        maximumTaskAmountPaise: rupeesToPaise(120_000),
      },
      new Types.ObjectId(),
    );

    const before = await SystemConfig.findOne({ key: 'GLOBAL' }).lean();
    await save(await read());
    const after = await SystemConfig.findOne({ key: 'GLOBAL' }).lean();

    for (const stored of Object.keys(STORED_TO_INPUT)) {
      expect(after?.[stored as keyof typeof after]).toBe(before?.[stored as keyof typeof before]);
    }
  });

  it('still saves the new model’s rates when they are actually changed', async () => {
    const draft = await read();
    await save({
      ...draft,
      payInPartyCommissionPercentage: 3,
      payInCaptainCommissionPercentage: 1.5,
      payOutPartyCommissionPercentage: 7,
      payOutCaptainCommissionPercentage: 5,
      collateralLockPercentage: 70,
    });

    const config = await getConfig();
    expect(config.payInPartyCommissionPercentage).toBe(3);
    expect(config.payInCaptainCommissionPercentage).toBe(1.5);
    expect(config.payOutPartyCommissionPercentage).toBe(7);
    expect(config.payOutCaptainCommissionPercentage).toBe(5);
    expect(config.collateralLockPercentage).toBe(70);
  });

  it('refuses a lock percentage outside 0–100', async () => {
    for (const bad of [-1, 101]) {
      const res = await request(app)
        .patch('/api/v1/admin/settings')
        .set('Cookie', cookie)
        .send({ collateralLockPercentage: bad });
      expect(res.status).toBe(400);
    }
    // The stored setting is untouched by a rejected save.
    expect((await getConfig()).collateralLockPercentage).toBe(50);
  });
});
