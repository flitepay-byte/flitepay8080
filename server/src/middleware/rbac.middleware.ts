import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import type { Role } from '../types';

/**
 * Role gate. Authorisation is enforced here on the server for every sensitive
 * route; the frontend hiding a button is presentation, never security.
 */
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized());
      return;
    }
    if (!allowed.includes(req.user.role)) {
      next(AppError.forbidden(`This action requires one of: ${allowed.join(', ')}`));
      return;
    }
    next();
  };
}

/** Ensures a PARTY user actually has a linked party profile. */
export function requirePartyProfile(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user?.partyId) {
    next(AppError.forbidden('No party profile is linked to this account'));
    return;
  }
  next();
}

/** Ensures a CAPTAIN user actually has a linked captain profile. */
export function requireCaptainProfile(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user?.captainId) {
    next(AppError.forbidden('No captain profile is linked to this account'));
    return;
  }
  next();
}
