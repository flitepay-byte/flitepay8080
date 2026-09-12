import type { Request, Response, NextFunction } from 'express';
import { CSRF_COOKIE } from '../services/token.service';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { timingSafeEqual } from '../utils/ids';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Double-submit cookie CSRF defence. Because auth lives in a cookie the
 * browser attaches automatically, a state-changing request must additionally
 * echo the CSRF value in a header, which a cross-origin attacker cannot read.
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const cookies = req.cookies as Record<string, string> | undefined;
  const cookieToken = cookies?.[CSRF_COOKIE];
  // Unauthenticated routes (login, tracking) have no cookie yet.
  if (!cookieToken) {
    next();
    return;
  }

  const headerValue = req.headers[CSRF_HEADER];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (!headerToken || !timingSafeEqual(cookieToken, headerToken)) {
    next(new AppError(403, ErrorCodes.CSRF_INVALID, 'CSRF validation failed'));
    return;
  }
  next();
}
