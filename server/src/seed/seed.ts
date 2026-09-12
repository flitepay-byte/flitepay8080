/**
 * SEED — ACCOUNTS ONLY, NO DEMO BUSINESS DATA
 * ============================================
 * Creates just enough to log in and start testing from a clean slate: one
 * admin, one party, two captains, and the system configuration they need.
 * No tasks, proofs, payouts, commissions, withdrawals, or purchases are
 * created — every balance starts at its true real-world default so the
 * whole app (task creation, claiming, audit, Pay In, DMC top-ups, admin's
 * wallet) can be exercised manually from zero.
 */
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../config/db';
import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  User,
  Party,
  Captain,
  Customer,
  Task,
  TaskOffer,
  Proof,
  Commission,
  AuditLog,
  SystemConfig,
  SystemConfigVersion,
  Session,
  OtpToken,
  ImportBatch,
  ReconciliationRun,
  Counter,
  DmcPurchase,
  CaptainLimitPurchase,
  PlatformAccount,
  AdminWithdrawalRequest,
  AdminWithdrawalPortion,
  PartyTopUpRequest,
  DMCAllocation,
  Transaction,
  ApiKey,
  WalletEntry,
  DmcRedemption,
  hashPassword,
  nextSequence,
} from '../models';
import { formatPartyCode, formatCaptainCode } from '../utils/ids';
import { ensureSystemConfig } from '../services/systemConfig.service';
import { issueApiKey } from '../services/apiKey.service';

/**
 * Every collection, wiped together.
 *
 * A partial wipe is worse than none: it once left old transactions behind
 * while resetting the counter that names them, so the very next payment was
 * refused for colliding with a code from a database that was supposed to be
 * gone. If a collection is added to the app it belongs in this list, and the
 * check below is what stops it being forgotten.
 */
/**
 * NOTHING IS SEEDED WITH MONEY.
 *
 * Every balance starts at zero — the captain's DMC, the party's DMC, the
 * platform's commission pool. Accounts and structure only.
 *
 * Pre-filled balances were tried and were worse than useless. A captain's
 * screen opened showing DMC 50,050 and there was no way to tell where it had
 * come from; the figure was correct (seeded capital, plus half a deposit, less
 * a settled pay-in) but establishing that took a database trace, and a number
 * nobody can account for makes every other number on the screen untrustworthy
 * too.
 *
 * The cost is real and is the point: a captain with no DMC cannot be offered a
 * pay-in, so the main flow does not work until somebody posts a security
 * deposit, admin approves it, and admin funds the pool. That is the actual
 * onboarding path rather than an obstacle in front of it.
 */

async function wipe(): Promise<void> {
  logger.warn('Clearing existing collections');
  await Promise.all([
    User.deleteMany({}),
    Party.deleteMany({}),
    Captain.deleteMany({}),
    Customer.deleteMany({}),
    Task.deleteMany({}),
    TaskOffer.deleteMany({}),
    Proof.deleteMany({}),
    Commission.collection.deleteMany({}),
    AuditLog.collection.deleteMany({}),
    SystemConfig.deleteMany({}),
    // The settings history goes with the settings. A snapshot of a version of
    // a config that no longer exists is not history, it is a dangling claim —
    // and the version counter restarts at 1, so the old rows would collide
    // with the new ones by number.
    SystemConfigVersion.collection.deleteMany({}),
    Session.deleteMany({}),
    OtpToken.deleteMany({}),
    ImportBatch.deleteMany({}),
    ReconciliationRun.deleteMany({}),
    Counter.deleteMany({}),
    DmcPurchase.deleteMany({}),
    CaptainLimitPurchase.deleteMany({}),
    PlatformAccount.deleteMany({}),
    AdminWithdrawalRequest.deleteMany({}),
    AdminWithdrawalPortion.deleteMany({}),
    PartyTopUpRequest.deleteMany({}),
    DMCAllocation.deleteMany({}),
    Transaction.deleteMany({}),
    ApiKey.deleteMany({}),
    WalletEntry.collection.deleteMany({}),
    DmcRedemption.deleteMany({}),
  ]);

  // Anything the app writes that this function forgot. Named rather than
  // silently ignored, because the failure it causes — a counter reset under
  // surviving rows — looks like a bug in the app rather than in the seed.
  const db = mongoose.connection.db;
  if (db) {
    const known = new Set([
      'users', 'parties', 'captains', 'customers', 'tasks', 'taskoffers', 'proofs',
      'commissions', 'auditlogs', 'systemconfigs', 'systemconfigversions', 'sessions', 'otptokens',
      'importbatches', 'reconciliationruns', 'counters', 'withdrawalrequests',
      'withdrawalportions', 'dmcpurchases', 'captainlimitpurchases', 'platformaccounts',
      'adminwithdrawalrequests', 'adminwithdrawalportions', 'partytopuprequests',
      'dmcallocations', 'transactions', 'apikeys', 'walletentries', 'dmcredemptions',
    ]);
    const leftover: string[] = [];
    for (const c of await db.collections()) {
      if (known.has(c.collectionName)) continue;
      if ((await c.countDocuments({})) === 0) continue;
      leftover.push(c.collectionName);
      await c.deleteMany({});
    }
    if (leftover.length > 0) {
      logger.warn({ collections: leftover }, 'Wiped collections the seed did not know about — add them to wipe()');
    }
  }
}

async function seed(): Promise<void> {
  await connectMongo();
  await wipe();

  const config = await ensureSystemConfig();

  // Commission rates the demo can actually be watched through.
  //
  // The model defaults every rate to zero, which is the right default for a
  // fresh install: what a party is charged is admin's decision and nothing
  // should assume it. But zero also makes the whole commission model invisible
  // on first run — every task costs the amount and nothing else — so the demo
  // seed sets the worked example: the party is charged 7%, the captain takes 5
  // of it, and the platform keeps the 2 that are left.
  await SystemConfig.updateOne(
    { key: 'GLOBAL' },
    {
      $set: {
        payOutPartyCommissionPercentage: 7,
        payOutCaptainCommissionPercentage: 5,
        payInPartyCommissionPercentage: 3,
        payInCaptainCommissionPercentage: 1,
      },
      $inc: { version: 1 },
    },
  );

  const password = await hashPassword(env.SEED_DEFAULT_PASSWORD);

  // --- Users ---
  const adminUser = await User.create({
    /**
     * The predefined administrator.
     *
     * There is no admin self-registration anywhere in this system — a captain
     * registers themselves and waits for approval, a party is created by an
     * administrator, and this account is the one the seed puts there so that
     * somebody exists to do the approving. It is the root of the chain and so it
     * cannot be created by anything inside it.
     */
    email: 'pradue243@gmail.com',
    passwordHash: password,
    name: 'Demo Admin',
    role: 'ADMIN',
    status: 'ACTIVE',
  });

  // One party and one captain, deliberately.
  //
  // There used to be two of each, so that a reviewer could watch one party's
  // money stay clear of another's. That is a real property, but it made the
  // thing people actually came to see impossible to follow: with two captains,
  // a payment went to whichever one routing picked, and somebody watching the
  // other captain's screen saw nothing happen and concluded the money had
  // vanished. Isolation between parties is covered by the test suite, which is
  // a better place for it than a demo nobody can read.
  //
  // The party here *is* the demo shop's party, so the dashboard and the shop
  // are two views of the same business rather than two unrelated ones.
  const partyUser = await User.create({
    email: 'chai@co.in',
    passwordHash: password,
    name: 'Chai & Co',
    role: 'PARTY',
    status: 'ACTIVE',
  });

  const primaryCaptainUser = await User.create({
    email: 'demo1@otdms.demo',
    passwordHash: password,
    name: 'Demo Captain',
    role: 'CAPTAIN',
    status: 'ACTIVE',
  });

  // --- Profiles ---
  const partySequence = await nextSequence('party');
  const party = await Party.create({
    userId: partyUser._id,
    partyCode: formatPartyCode(partySequence),
    companyName: 'Chai & Co',
    contactEmail: 'chai@co.in',
    // Zero. The party tops itself up through the app, which is the same
    // handshake a real one goes through.
    dmcBalancePaise: 0,
  });
  void config;

  // Drawn from the counter rather than written as a literal. Registration takes
  // its codes from the same counter, so a captain who signs up after the seed
  // gets CAP-002 — with a literal here, the first one to register would have
  // been handed CAP-001 again and collided on a unique index.
  const captainSequence = await nextSequence('captain');
  await Captain.create({
    userId: primaryCaptainUser._id,
    captainCode: formatCaptainCode(captainSequence),
    displayName: 'Demo Captain',
    // All zero. DMC arrives by posting a security deposit and having admin
    // confirm it — half is locked as security, half becomes spendable DMC.
    collateralBalancePaise: 0,
    lockedAmountPaise: 0,
    dmcBalancePaise: 0,
    // Presence follows real sign-in, not a seeded flag — a captain with no
    // backing session gets swept back offline within a minute regardless.
    isOnline: false,
    status: 'ACTIVE',
  });

  // The demo shop's credentials, issued against the same party whose dashboard
  // you log into. One command, one party, one captain — nothing to line up by
  // hand and nothing that can drift apart.
  const issued = await issueApiKey(party._id, 'Demo shop', {
    userId: String(partyUser._id),
    role: 'PARTY',
  });

  await AuditLog.create({
    action: 'USER_CREATED',
    targetCollection: 'User',
    targetId: String(adminUser._id),
    userId: adminUser._id,
    role: 'ADMIN',
    metadata: { seeded: true },
    timestamp: new Date(),
  });

  logger.info('--------------------------------------------------');
  logger.info('Seed complete. One admin, one party, one captain.');
  logger.info(`Accounts (password: ${env.SEED_DEFAULT_PASSWORD}):`);
  logger.info('  ADMIN    pradue243@gmail.com');
  logger.info('  PARTY    chai@co.in         (Chai & Co — the demo shop is this same party)');
  logger.info('  CAPTAIN  demo1@otdms.demo');
  logger.info('Two-step login: OTP is printed in the API logs and returned as devOtp outside production.');
  logger.info('');
  logger.info('Every balance is zero. To make a pay-in possible:');
  logger.info('  1. Captain -> My wallet -> post security money (half becomes DMC)');
  logger.info('  2. Admin   -> Review queue -> confirm that deposit');
  logger.info('');
  logger.info('The pool needs no funding to start: a party is charged its');
  logger.info('commission first and the captain is paid out of that, so the');
  logger.info('pool can always cover what it owes. Admin -> My wallet -> fund');
  logger.info('the pool is for putting real money behind it, not a prerequisite.');
  logger.info('');
  logger.info('Commission: party charged 7% on a pay-out (3% on a pay-in), of');
  logger.info('which the captain takes 5% (1%). Admin -> Settings to change it.');
  logger.info('');
  logger.info('Demo shop — the secret is shown once and never again:');
  logger.info(`  OTDMS_KEY_ID=${issued.keyId}`);
  logger.info(`  OTDMS_SECRET=${issued.secret}`);
  logger.info('');
  logger.info('  cd otdms/demo-party');
  logger.info(`  OTDMS_KEY_ID=${issued.keyId} OTDMS_SECRET=${issued.secret} node server.js`);
  logger.info('--------------------------------------------------');

  await disconnectMongo();
}

seed()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.fatal({ err }, 'Seeding failed');
    void mongoose.disconnect().finally(() => process.exit(1));
  });
