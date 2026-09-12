import {
  expireOverdueTasks,
  expireStaleUnclaimedTasks,
  reclaimUnacknowledgedExpiredTasks,
  autoApproveUnconfirmedPayouts,
} from '../services/workflow.service';
import { sweepOffers } from '../services/taskRouting.service';
import { Task } from '../models';
import {
  notifyTaskExpired,
  notifyTaskUnfulfilled,
  notifyExpiredTaskReclaimed,
} from '../services/notification.service';
import { logger } from '../config/logger';

let timer: NodeJS.Timeout | null = null;

/**
 * Sweeps everything the task clocks owe: lapsed offers, missed completion
 * deadlines, and tasks nobody ever accepted.
 *
 * Runs on an interval rather than a per-task timer so that a restart cannot
 * lose pending expiries: state lives in the database, not in process memory.
 */
export function startExpiryJob(intervalMs = 60_000): void {
  if (timer) return;

  const run = async (): Promise<void> => {
    // Each sweep is independent — one failing must not stop the others, since
    // a stuck offer sweep would otherwise strand every task behind it.
    try {
      // A payout whose party never came back with their customer's answer.
      // Independent of the others: a stuck expiry must not leave a captain
      // waiting on money they have already sent.
      const approved = await autoApproveUnconfirmedPayouts();
      if (approved.length > 0) {
        logger.info(
          { count: approved.length },
          'Auto-approved payouts whose confirmation window lapsed',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Confirmation timeout sweep failed');
    }

    try {
      const { lapsed, routed } = await sweepOffers();
      if (lapsed || routed) logger.info({ lapsed, routed }, 'Task offers swept');
    } catch (err) {
      logger.error({ err }, 'Task offer sweep failed');
    }

    try {
      // Capture who held each task before expiry so the right captain is told.
      const due = await Task.find({
        status: { $in: ['ASSIGNED', 'IN_PROGRESS'] },
        expiresAt: { $lte: new Date() },
      })
        .select('_id captainId')
        .lean();

      const count = await expireOverdueTasks();
      if (count > 0) {
        for (const record of due) {
          const task = await Task.findById(record._id);
          if (task && task.status === 'EXPIRED') {
            notifyTaskExpired(task, record.captainId ? String(record.captainId) : null);
          }
        }
        logger.info({ count }, 'Expired overdue tasks');
      }
    } catch (err) {
      logger.error({ err }, 'Task expiry sweep failed');
    }

    try {
      // Captains who let a task expire get a grace period to explain; past it
      // the task is taken back rather than left frozen. The captain who held
      // it is captured before the reclaim clears it off the task.
      const heldBy = new Map<string, string | null>();
      const pending = await Task.find({ status: 'EXPIRED', expiryAckDeadline: { $ne: null, $lte: new Date() } })
        .select('_id captainId')
        .lean();
      for (const t of pending) heldBy.set(String(t._id), t.captainId ? String(t.captainId) : null);

      const reclaimed = await reclaimUnacknowledgedExpiredTasks();
      for (const task of reclaimed) {
        notifyExpiredTaskReclaimed(task, heldBy.get(String(task._id)) ?? null);
      }
      if (reclaimed.length > 0) {
        logger.info({ count: reclaimed.length }, 'Reclaimed expired tasks nobody acknowledged');
      }
    } catch (err) {
      logger.error({ err }, 'Expired-task reclaim sweep failed');
    }

    try {
      const cancelled = await expireStaleUnclaimedTasks();
      for (const task of cancelled) notifyTaskUnfulfilled(task);
      if (cancelled.length > 0) {
        logger.info({ count: cancelled.length }, 'Cancelled tasks no captain accepted in time');
      }
    } catch (err) {
      logger.error({ err }, 'Stale unclaimed task sweep failed');
    }
  };

  timer = setInterval(() => void run(), intervalMs);
  // Do not keep the process alive solely for this timer.
  timer.unref();
  logger.info({ intervalMs }, 'Task expiry job started');
}

export function stopExpiryJob(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
