import { getRedis } from '../config/redis';
import { randomToken } from '../utils/ids';
import { logger } from '../config/logger';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';

/**
 * REDIS DISTRIBUTED LOCK
 * ----------------------
 * Serialises contended operations across API instances. This is the OUTER
 * guard on task claiming; it reduces wasted work and database contention, but
 * it is deliberately not the only guard. Correctness rests on the database's
 * atomic compare-and-swap, because a lock can always be lost to a network
 * partition or an expiry during a slow operation.
 */

/**
 * Release must be atomic and ownership-checked: a naive DEL would let a client
 * whose lock had already expired delete a lock now held by someone else.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface LockHandle {
  key: string;
  token: string;
  release: () => Promise<void>;
}

export async function acquireLock(key: string, ttlMs = 5000): Promise<LockHandle | null> {
  const token = randomToken(16);
  try {
    // SET key token NX PX ttl -> only succeeds if the key does not exist.
    const result = await getRedis().set(key, token, 'PX', ttlMs, 'NX');
    if (result !== 'OK') return null;

    return {
      key,
      token,
      release: async () => {
        try {
          await getRedis().eval(RELEASE_SCRIPT, 1, key, token);
        } catch (err) {
          logger.warn({ err, key }, 'Failed to release distributed lock; it will expire on its own');
        }
      },
    };
  } catch (err) {
    // Redis unavailable: proceed without the outer lock. The database-level
    // compare-and-swap still prevents double claims, so this degrades
    // performance rather than correctness.
    logger.warn({ err, key }, 'Lock acquisition failed; relying on database-level atomicity');
    return {
      key,
      token,
      release: async () => {
        /* no-op */
      },
    };
  }
}

/**
 * Acquire a briefly contended key, waiting up to a deadline.
 *
 * Bounded by elapsed time rather than by a count of attempts, because what has
 * to be outlasted is the holder's critical section — a database transaction of
 * a few hundred milliseconds — and not a number of Redis round trips, which
 * take tens of milliseconds each. A fixed three attempts spent its whole budget
 * long before the holder was finished, so the wait never did its job.
 *
 * `waitMs` stays well under a typical `ttlMs`: past that point the holder is
 * either wedged or gone, and its lock will expire on its own.
 */
export async function acquireLockWithRetry(
  key: string,
  ttlMs = 5000,
  waitMs = 2000,
  pollMs = 40,
): Promise<LockHandle | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const handle = await acquireLock(key, ttlMs);
    if (handle) return handle;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Run a function while holding a lock, releasing it even if the body throws.
 *
 * Waits for a contended lock rather than refusing on the first miss. The lock
 * is an optimisation — the comment at the top of this file says so, and the
 * database's compare-and-swap is what actually decides — so turning a lost race
 * into `LOCK_ACQUISITION_FAILED` reports an internal detail in place of the
 * real answer. Two captains claiming the same task at once is the case that
 * matters: the loser should be told the task has already been claimed, which is
 * true, actionable, and what the caller checks for a moment later. Without the
 * wait that branch was unreachable for a genuine simultaneous claim.
 *
 * The budget is deliberately short. A holder that has not finished within it is
 * no longer a brief overlap, and `LOCK_ACQUISITION_FAILED` — try again — is
 * then the honest answer.
 */
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireLockWithRetry(key, ttlMs);
  if (!handle) {
    throw AppError.conflict(
      ErrorCodes.LOCK_ACQUISITION_FAILED,
      'This resource is being modified by another request. Try again.',
    );
  }
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

export const lockKeys = {
  task: (taskId: string) => `lock:task:${taskId}`,
  captainCollateral: (captainId: string) => `lock:captain:${captainId}`,
};
