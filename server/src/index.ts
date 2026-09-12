import './globalErrorHandlers';
import http from 'node:http';
import { createApp } from './app';
import { env, isProd } from './config/env';
import { logger } from './config/logger';
import { connectMongo, disconnectMongo, supportsTransactions } from './config/db';
import { getRedis, disconnectRedis } from './config/redis';
import { Proof, Task } from './models';
import { ensureSystemConfig } from './services/systemConfig.service';
import { stampStateHistoryCaptains } from './migrations/stampStateHistoryCaptains';
import { backfillCaptainTaskCodes } from './migrations/backfillCaptainTaskCodes';
import { initSockets } from './sockets';
import { startExpiryJob, stopExpiryJob } from './jobs/taskExpiry.job';
import { startPresenceSweepJob, stopPresenceSweepJob } from './jobs/presence.job';
import { startTransactionSweepJob, stopTransactionSweepJob } from './jobs/transactionSweep.job';

async function bootstrap(): Promise<void> {
  await connectMongo();
  getRedis();
  await ensureSystemConfig();

  // Proof used to be one-per-task, enforced by a unique index on taskId. It no
  // longer is — a reassigned task is legitimately worked by a second captain,
  // who needs to submit their own (see Proof.ts). Mongoose builds new indexes
  // but never drops retired ones, so the old unique index would still be in
  // the collection, still rejecting that second proof. syncIndexes reconciles
  // the collection with the schema; it is idempotent once that has happened.
  try {
    await Proof.syncIndexes();
  } catch (err) {
    logger.error({ err }, 'Could not reconcile Proof indexes; a resubmitted proof may be rejected');
  }

  try {
    await stampStateHistoryCaptains();
  } catch (err) {
    logger.error({ err }, 'Could not backfill captain attribution on older task history');
  }

  try {
    // Tasks created before the captain-facing code existed would otherwise
    // fall back to the party-scoped one, which names their owner.
    //
    // Backfill first, index second, and not the other way round: the index is
    // unique and a missing field indexes as null, so building it over a
    // collection where every old task lacks a code fails on the second
    // document — and the failure would take the backfill down with it.
    await backfillCaptainTaskCodes();
    await Task.syncIndexes();
  } catch (err) {
    logger.error({ err }, 'Could not backfill captain-facing task codes');
  }

  const txnCapable = await supportsTransactions();
  logger.info(
    { transactions: txnCapable },
    txnCapable
      ? 'MongoDB replica set detected: task claims will use transactions'
      : 'Standalone MongoDB detected: task claims will use the atomic compare-and-swap path',
  );

  const app = createApp();
  const server = http.createServer(app);

  initSockets(server);
  startExpiryJob();
  startPresenceSweepJob();
  startTransactionSweepJob();

  server.listen(env.PORT, () => {
    logger.info(`API listening on port ${env.PORT} (${env.NODE_ENV})`);
    if (isProd && env.OTP_STATIC_CODE) {
      logger.warn(
        'OTP_STATIC_CODE is set: every sign-in accepts the same fixed code and no verification email is sent. Intended for demonstrations only.',
      );
    }
    if (isProd && env.ALLOW_PAYMENT_SIMULATION) {
      // Said plainly on every boot, because a flag that quietly stays on is
      // the way a demonstration setting reaches somewhere it was not meant to.
      logger.warn(
        'ALLOW_PAYMENT_SIMULATION is on: the customer-payment stand-in answers in production. Intended for demonstrations only.',
      );
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    stopExpiryJob();
    stopPresenceSweepJob();
    stopTransactionSweepJob();
    server.close(() => logger.info('HTTP server closed'));
    await disconnectMongo();
    await disconnectRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception; exiting');
    process.exit(1);
  });
}

void bootstrap().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start API');
  process.exit(1);
});
