import { Captain, Session } from '../models';
import { notifyPresenceChanged } from './notification.service';

/**
 * Catches session timeout — a captain closing their browser or their device
 * dying without ever hitting "sign out" or "go offline". Login and logout
 * flip `isOnline` synchronously, but nothing fires the moment a session's
 * refresh token quietly expires, so a periodic sweep is the only way to
 * notice: any captain marked online whose account no longer has a single
 * live (unrevoked, unexpired) session is put back offline.
 */
export async function sweepStaleCaptainPresence(): Promise<number> {
  const onlineCaptains = await Captain.find({ isOnline: true }).select('_id userId').lean();
  if (onlineCaptains.length === 0) return 0;

  const userIds = onlineCaptains.map((c) => c.userId);
  const liveSessions = await Session.find({
    userId: { $in: userIds },
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .select('userId')
    .lean();
  const userIdsWithLiveSession = new Set(liveSessions.map((s) => String(s.userId)));

  const staleCaptains = onlineCaptains.filter((c) => !userIdsWithLiveSession.has(String(c.userId)));
  if (staleCaptains.length === 0) return 0;

  await Captain.updateMany(
    { _id: { $in: staleCaptains.map((c) => c._id) } },
    { $set: { isOnline: false } },
  );
  for (const c of staleCaptains) notifyPresenceChanged(String(c._id), false);

  return staleCaptains.length;
}
