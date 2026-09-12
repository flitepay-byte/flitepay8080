import type { Request } from 'express';
import { AppError } from '../../utils/AppError';
import { clientIp } from '../../utils/http';

/**
 * Who is acting, for the audit trail.
 *
 * Shared by every admin module rather than repeated in each: an audit row
 * that names the wrong actor is worse than one that names none, and one
 * definition cannot disagree with itself.
 */
export function adminActor(req: Request): { userId: string; role: 'ADMIN'; ip: string } {
  if (!req.user) throw AppError.unauthorized();
  return { userId: req.user.userId, role: 'ADMIN', ip: clientIp(req) };
}
