import { sweepStaleCaptainPresence } from '../services/presence.service';
import { logger } from '../config/logger';

let timer: NodeJS.Timeout | null = null;

/**
 * Sweeps captains left marked online by a session that timed out rather than
 * an explicit sign-out or "go offline" — see presence.service.ts. Runs on an
 * interval for the same reason the task-expiry job does: state lives in the
 * database, so a restart cannot lose a pending sweep.
 */
export function startPresenceSweepJob(intervalMs = 60_000): void {
  if (timer) return;

  const run = async (): Promise<void> => {
    try {
      const count = await sweepStaleCaptainPresence();
      if (count > 0) logger.info({ count }, 'Marked captains offline after session timeout');
    } catch (err) {
      logger.error({ err }, 'Presence sweep failed');
    }
  };

  timer = setInterval(() => void run(), intervalMs);
  // Do not keep the process alive solely for this timer.
  timer.unref();
  logger.info({ intervalMs }, 'Presence sweep job started');
}

export function stopPresenceSweepJob(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
