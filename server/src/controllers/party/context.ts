import type { Request } from 'express';
import { Types } from 'mongoose';
import { clientIp } from '../../utils/http';
import { AppError } from '../../utils/AppError';

/**
 * Which party is acting, and the actor stamp for the audit trail.
 *
 * Shared by every party module rather than repeated in each: an audit row
 * naming the wrong party is worse than one naming none, and a single
 * definition cannot disagree with itself.
 */
export function partyContext(req: Request): { partyId: Types.ObjectId; actor: { userId: string; role: 'PARTY'; ip: string } } {
  if (!req.user?.partyId) throw AppError.forbidden('No party profile linked to this account');
  return {
    partyId: new Types.ObjectId(req.user.partyId),
    actor: { userId: req.user.userId, role: 'PARTY', ip: clientIp(req) },
  };
}
