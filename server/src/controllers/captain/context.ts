import type { Request } from 'express';
import { Types } from 'mongoose';
import { clientIp } from '../../utils/http';
import { AppError } from '../../utils/AppError';

/**
 * Which captain is acting, and the actor stamp for the audit trail.
 *
 * Shared by every captain module rather than repeated in each: an audit
 * row naming the wrong captain is worse than one naming none, and a single
 * definition cannot disagree with itself.
 */
export function captainContext(req: Request): {
  captainId: Types.ObjectId;
  actor: { userId: string; role: 'CAPTAIN'; ip: string };
} {
  if (!req.user?.captainId) throw AppError.forbidden('No captain profile linked to this account');
  return {
    captainId: new Types.ObjectId(req.user.captainId),
    actor: { userId: req.user.userId, role: 'CAPTAIN', ip: clientIp(req) },
  };
}
