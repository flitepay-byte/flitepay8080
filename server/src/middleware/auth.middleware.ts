import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, ACCESS_COOKIE } from '../services/token.service';
import { isSessionActive } from '../services/auth.service';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import type { AuthUser } from '../types';

/**
 * Reads the JWT from an HTTP-only cookie and revalidates the session against
 * the database, so a logout or admin revocation takes effect immediately
 * rather than at token expiry.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
    if (!token) {
      throw AppError.unauthorized('You must be signed in to perform this action');
    }

    const payload = verifyAccessToken(token);
    const active = await isSessionActive(payload.sid);
    if (!active) {
      throw AppError.unauthorized('Session is no longer valid', ErrorCodes.SESSION_EXPIRED);
    }

    const user: AuthUser = {
      userId: payload.sub,
      role: payload.role,
      email: payload.email,
      sessionId: payload.sid,
      ...(payload.partyId ? { partyId: payload.partyId } : {}),
      ...(payload.captainId ? { captainId: payload.captainId } : {}),
    };
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Attaches the user when a token is present, but does not require one. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
    if (!token) {
      next();
      return;
    }
    const payload = verifyAccessToken(token);
    if (await isSessionActive(payload.sid)) {
      req.user = {
        userId: payload.sub,
        role: payload.role,
        email: payload.email,
        sessionId: payload.sid,
      };
    }
    next();
  } catch {
    // An invalid token on an optional route is simply ignored.
    next();
  }
}
