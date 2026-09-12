import { sweepTransactions } from '../services/transactionSweep.service';
import { logger } from '../config/logger';

let timer: NodeJS.Timeout | null = null;
/**
 * One pass at a time. A slow pass — a party's callback endpoint hanging until
 * the timeout, say — must not have a second pass start on top of it and route
 * the same payouts twice.
 */
let running = false;

/**
 * Picks up the transactions nobody is going to ask about again: payouts with
 * no captain, windows that have closed, callbacks that never landed. See
 * transactionSweep.service.ts for why each one would otherwise stick.
 *
 * Every minute rather than every few seconds, because none of the three is
 * urgent: a payout waiting a minute longer is fine, and an expiry that fires a
 * minute late has held nothing it should not have.
 */
export function startTransactionSweepJob(intervalMs = 60_000): void {
  if (timer) return;

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await sweepTransactions();
      if (result.routed || result.expired || result.callbacksDelivered) {
        logger.info(result, 'Transaction sweep');
      }
    } catch (err) {
      logger.error({ err }, 'Transaction sweep failed');
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void run(), intervalMs);
  // Do not keep the process alive solely for this timer.
  timer.unref();
  logger.info({ intervalMs }, 'Transaction sweep job started');
}

export function stopTransactionSweepJob(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
