/**
 * A CAPTAIN'S MERCHANT UPI IDS
 *
 * The rule worth defending is that exactly one is active. It is enforced by the
 * write — activating rewrites every entry in one operation — so these tests
 * check the invariant itself rather than the sequence of calls that produced it:
 * after any of these, the number of active entries is one, or deliberately zero.
 *
 * The second half is what that means for money. A withdrawal goes to whichever
 * id is active at the moment it is made, and a withdrawal already made keeps the
 * id it was sent to even after the captain switches.
 */
import { Types } from 'mongoose';
import { describeIntegration, setupDatabase, teardownDatabase, clearCollections } from '../setup';
import { Captain, User, DmcRedemption, hashPassword } from '../../models';
import { ensureSystemConfig } from '../../services/systemConfig.service';
import {
  listMerchantUpiIds,
  addMerchantUpiId,
  activateMerchantUpiId,
  deactivateMerchantUpiId,
  activeMerchantUpi,
  MERCHANT_UPI_NOTICE,
  MAX_MERCHANT_UPI_IDS,
} from '../../services/captainUpi.service';
import { requestRedemption } from '../../services/captainBalance.service';
import { rupeesToPaise } from '../../utils/money';

describeIntegration('Captain merchant UPI IDs', () => {
  let captainId: Types.ObjectId;
  let actor: { userId: string; role: 'CAPTAIN' };

  beforeAll(async () => {
    await setupDatabase();
    await ensureSystemConfig();
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await clearCollections();
    await ensureSystemConfig();

    const unique = new Types.ObjectId().toHexString();
    const user = await User.create({
      email: `cap-${unique.slice(-8)}@upi.test`,
      passwordHash: await hashPassword('Demo@12345'),
      name: 'UPI Captain',
      role: 'CAPTAIN',
    });
    const captain = await Captain.create({
      userId: user._id,
      captainCode: `CAP-${unique.slice(-6)}`,
      displayName: 'UPI Captain',
      collateralBalancePaise: rupeesToPaise(10_000),
      dmcBalancePaise: rupeesToPaise(5_000),
      status: 'ACTIVE',
    });
    captainId = captain._id;
    actor = { userId: String(user._id), role: 'CAPTAIN' };
  });

  /** The invariant, asked of the stored document rather than of a return value. */
  const activeCount = async (): Promise<number> => {
    const c = await Captain.findById(captainId).select('merchantUpiIds').lean();
    return (c?.merchantUpiIds ?? []).filter((u) => u.active).length;
  };

  // ====================================================================== 1 ==
  it('1. states that only a merchant UPI ID is allowed', () => {
    // The exact sentence the screens show, kept here so it cannot drift.
    expect(MERCHANT_UPI_NOTICE).toBe('Only Merchant UPI ID is allowed.');
  });

  // ====================================================================== 2 ==
  it('2. starts with no UPI IDs and nothing active', async () => {
    expect(await listMerchantUpiIds(captainId)).toEqual([]);
    expect(await activeMerchantUpi(captainId)).toBeNull();
  });

  // ====================================================================== 3 ==
  it('3. makes the first one active, because a captain with none cannot be paid', async () => {
    const list = await addMerchantUpiId(captainId, 'first@okaxis', 'Shop', actor);
    expect(list).toHaveLength(1);
    expect(list[0]?.active).toBe(true);
    expect(await activeCount()).toBe(1);
  });

  // ====================================================================== 4 ==
  it('4. adds later ones inactive — switching is a deliberate act', async () => {
    await addMerchantUpiId(captainId, 'first@okaxis', undefined, actor);
    const list = await addMerchantUpiId(captainId, 'second@okicici', undefined, actor);

    expect(list).toHaveLength(2);
    expect(list.find((u) => u.upiId === 'first@okaxis')?.active).toBe(true);
    expect(list.find((u) => u.upiId === 'second@okicici')?.active).toBe(false);
    expect(await activeCount()).toBe(1);
  });

  // ====================================================================== 5 ==
  it('5. keeps several', async () => {
    for (const id of ['a@okaxis', 'b@okicici', 'c@oksbi']) {
      await addMerchantUpiId(captainId, id, undefined, actor);
    }
    expect(await listMerchantUpiIds(captainId)).toHaveLength(3);
  });

  // ====================================================================== 6 ==
  it('6. deactivates the old one when another is activated', async () => {
    await addMerchantUpiId(captainId, 'first@okaxis', undefined, actor);
    await addMerchantUpiId(captainId, 'second@okicici', undefined, actor);

    const list = await activateMerchantUpiId(captainId, 'second@okicici', actor);

    expect(list.find((u) => u.upiId === 'second@okicici')?.active).toBe(true);
    expect(list.find((u) => u.upiId === 'first@okaxis')?.active).toBe(false);
    expect(await activeCount()).toBe(1);
  });

  // ====================================================================== 7 ==
  it('7. never leaves two active, however many times it is switched', async () => {
    const ids = ['a@okaxis', 'b@okicici', 'c@oksbi', 'd@okhdfc'];
    for (const id of ids) await addMerchantUpiId(captainId, id, undefined, actor);

    for (const id of [...ids, ...ids.slice().reverse()]) {
      await activateMerchantUpiId(captainId, id, actor);
      // Asserted after every single switch, not merely at the end.
      expect(await activeCount()).toBe(1);
      expect((await activeMerchantUpi(captainId))?.upiId).toBe(id);
    }
  });

  // ====================================================================== 8 ==
  it('8. leaves nothing active when one is deactivated on its own', async () => {
    await addMerchantUpiId(captainId, 'only@okaxis', undefined, actor);
    await deactivateMerchantUpiId(captainId, 'only@okaxis', actor);

    expect(await activeCount()).toBe(0);
    expect(await activeMerchantUpi(captainId)).toBeNull();
  });

  // ====================================================================== 9 ==
  it('9. refuses a duplicate, and refuses more than the maximum', async () => {
    await addMerchantUpiId(captainId, 'dupe@okaxis', undefined, actor);
    await expect(addMerchantUpiId(captainId, 'dupe@okaxis', undefined, actor)).rejects.toThrow();
    // Case and spacing do not make it a different id.
    await expect(addMerchantUpiId(captainId, '  DUPE@OKAXIS ', undefined, actor)).rejects.toThrow();

    for (let i = 1; i < MAX_MERCHANT_UPI_IDS; i += 1) {
      await addMerchantUpiId(captainId, `fill${i}@okaxis`, undefined, actor);
    }
    await expect(addMerchantUpiId(captainId, 'one-too-many@okaxis', undefined, actor)).rejects.toThrow();
    expect(await listMerchantUpiIds(captainId)).toHaveLength(MAX_MERCHANT_UPI_IDS);
  });

  // ===================================================================== 10 ==
  it('10. refuses to activate one that is not on the profile', async () => {
    await addMerchantUpiId(captainId, 'mine@okaxis', undefined, actor);
    await expect(activateMerchantUpiId(captainId, 'somebody-else@okaxis', actor)).rejects.toThrow();
    // And the one that was active still is.
    expect((await activeMerchantUpi(captainId))?.upiId).toBe('mine@okaxis');
  });

  // ===================================================================== 11 ==
  it('11. sends a withdrawal to the active UPI', async () => {
    await addMerchantUpiId(captainId, 'first@okaxis', undefined, actor);
    await addMerchantUpiId(captainId, 'second@okicici', undefined, actor);
    await activateMerchantUpiId(captainId, 'second@okicici', actor);

    const active = await activeMerchantUpi(captainId);
    const request = await requestRedemption(
      captainId,
      rupeesToPaise(1_000),
      { method: 'UPI', upiId: active?.upiId as string },
      actor,
    );

    expect(request.payoutMethod).toBe('UPI');
    expect(request.payoutUpiId).toBe('second@okicici');
  });

  // ===================================================================== 12 ==
  it('12. does not rewrite a withdrawal that has already been made', async () => {
    await addMerchantUpiId(captainId, 'first@okaxis', undefined, actor);
    await addMerchantUpiId(captainId, 'second@okicici', undefined, actor);

    const old = await requestRedemption(
      captainId,
      rupeesToPaise(500),
      { method: 'UPI', upiId: (await activeMerchantUpi(captainId))?.upiId as string },
      actor,
    );
    expect(old.payoutUpiId).toBe('first@okaxis');

    // The captain moves to another merchant account afterwards.
    await activateMerchantUpiId(captainId, 'second@okicici', actor);

    // The record keeps where the money was actually sent. Rewriting it would
    // make the history disagree with the transfer that really happened.
    const reread = await DmcRedemption.findById(old._id).lean();
    expect(reread?.payoutUpiId).toBe('first@okaxis');
  });

  // ===================================================================== 13 ==
  it('13. sends a later withdrawal to the new one', async () => {
    await addMerchantUpiId(captainId, 'first@okaxis', undefined, actor);
    await addMerchantUpiId(captainId, 'second@okicici', undefined, actor);

    await requestRedemption(
      captainId,
      rupeesToPaise(500),
      { method: 'UPI', upiId: (await activeMerchantUpi(captainId))?.upiId as string },
      actor,
    );
    await activateMerchantUpiId(captainId, 'second@okicici', actor);
    const next = await requestRedemption(
      captainId,
      rupeesToPaise(500),
      { method: 'UPI', upiId: (await activeMerchantUpi(captainId))?.upiId as string },
      actor,
    );

    expect(next.payoutUpiId).toBe('second@okicici');
    const all = await DmcRedemption.find({ captainId }).sort({ createdAt: 1 }).lean();
    expect(all.map((r) => r.payoutUpiId)).toEqual(['first@okaxis', 'second@okicici']);
  });

  // ===================================================================== 14 ==
  it('14. stores ids lowercased and trimmed, so two spellings are one account', async () => {
    const list = await addMerchantUpiId(captainId, '  Merchant@OkAxis  ', '  Shop  ', actor);
    expect(list[0]?.upiId).toBe('merchant@okaxis');
    expect(list[0]?.label).toBe('Shop');
  });

  // ===================================================================== 15 ==
  it('15. survives two switches racing, still with exactly one active', async () => {
    await addMerchantUpiId(captainId, 'a@okaxis', undefined, actor);
    await addMerchantUpiId(captainId, 'b@okicici', undefined, actor);

    // Both rewrite the whole array, so whichever lands last wins outright —
    // there is no interleaving that leaves two set.
    await Promise.all([
      activateMerchantUpiId(captainId, 'a@okaxis', actor),
      activateMerchantUpiId(captainId, 'b@okicici', actor),
    ]);

    expect(await activeCount()).toBe(1);
  });
});
