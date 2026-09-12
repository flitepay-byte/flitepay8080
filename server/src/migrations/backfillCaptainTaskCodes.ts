import { Task } from '../models';
import { generateCaptainTaskCode } from '../utils/ids';
import { logger } from '../config/logger';

/**
 * Gives every existing task the opaque code a captain is shown.
 *
 * Task codes are formed as TASK-<partyCode>-<year>-<sequence>, which names the
 * owning party in plain text — the one fact the rest of the system works to
 * keep from captains. New tasks get a separate opaque code at creation; tasks
 * that predate it have none, and a captain looking at one would be shown the
 * party-scoped code by the serialiser's fallback.
 *
 * The codes are random rather than derived, so they are generated one document
 * at a time rather than in a single update. Collisions on an 8-character code
 * from a 32-character alphabet are vanishingly unlikely, but the unique index
 * would reject one, so each write is retried a few times before giving up on
 * that task rather than aborting the whole run.
 *
 * Idempotent: once every task has a code, the query matches nothing.
 */
export async function backfillCaptainTaskCodes(): Promise<void> {
  const pending = await Task.find({
    $or: [{ captainTaskCode: { $exists: false } }, { captainTaskCode: null }],
  })
    .select('_id')
    .lean();

  if (pending.length === 0) return;

  let assigned = 0;
  let failed = 0;

  for (const task of pending) {
    let written = false;
    for (let attempt = 0; attempt < 5 && !written; attempt++) {
      try {
        await Task.collection.updateOne(
          { _id: task._id },
          { $set: { captainTaskCode: generateCaptainTaskCode() } },
        );
        written = true;
      } catch (err) {
        const isDuplicate = typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
        if (!isDuplicate) throw err;
      }
    }
    if (written) assigned += 1;
    else failed += 1;
  }

  logger.info({ assigned, failed }, 'Backfilled captain-facing task codes');
}
