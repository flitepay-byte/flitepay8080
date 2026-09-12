import { Task } from '../models';
import { logger } from '../config/logger';

/**
 * Backfills `stateHistory[].captainId` on tasks that predate the field.
 *
 * Task.ts stamps the holding captain onto every new state event, but events
 * written before that existed carry nothing. Left alone, the save hook would
 * read them as unstamped and write today's captain onto all of them — telling
 * admin that the task's creation, its first claim and its reassignment were
 * all the work of whoever happens to hold it now. So this runs once at
 * startup and settles every old event explicitly.
 *
 * What can honestly be reconstructed is reconstructed. A task whose
 * `previousCaptainIds` is empty has only ever been held by one captain, so
 * everything from its first claim onward was theirs; everything before it was
 * nobody's. A task that has been reassigned leaves no record of which captain
 * held which event, so those stay null — admin sees a dash, which is true,
 * rather than a name, which would not be.
 *
 * Idempotent: once every event carries a value (a captain or an explicit
 * null), the query that finds unstamped events matches nothing.
 */
export async function stampStateHistoryCaptains(): Promise<void> {
  const stale = await Task.find({ stateHistory: { $elemMatch: { captainId: { $exists: false } } } })
    .select('captainId previousCaptainIds stateHistory')
    .lean();

  if (stale.length === 0) return;

  const operations = stale.map((task) => {
    // Only a single-captain task can be attributed; a reassigned one cannot.
    const soleCaptain =
      (task.previousCaptainIds?.length ?? 0) === 0 ? task.captainId ?? null : null;

    let held = false;
    const captainIds = task.stateHistory.map((event) => {
      if (event.to === 'ASSIGNED') held = true;
      return held ? soleCaptain : null;
    });

    return {
      updateOne: {
        filter: { _id: task._id },
        update: {
          $set: Object.fromEntries(
            captainIds.map((captainId, index) => [`stateHistory.${index}.captainId`, captainId]),
          ),
        },
      },
    };
  });

  // Through the driver, not the model: this must not trip the save hook it
  // exists to protect against, and it is not a change worth touching
  // updatedAt over.
  await Task.collection.bulkWrite(operations as never[]);

  const attributed = stale.filter((t) => (t.previousCaptainIds?.length ?? 0) === 0 && t.captainId);
  logger.info(
    { tasks: stale.length, attributed: attributed.length },
    'Backfilled captain attribution onto task history predating the field',
  );
}
