import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Response } from 'express';
import { env, isProd } from '../config/env';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import type { Role } from '../types';

export const ACCESS_COOKIE = 'otdms_at';
export const REFRESH_COOKIE = 'otdms_rt';
export const CSRF_COOKIE = 'otdms_csrf';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  email: string;
  sid: string;
  partyId?: string;
  captainId?: string;
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string;
  jti: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: SignOptions = { expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'] };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, options);
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  const options: SignOptions = { expiresIn: env.JWT_REFRESH_TTL as SignOptions['expiresIn'] };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    throw AppError.unauthorized(
      expired ? 'Session expired' : 'Invalid authentication token',
      expired ? ErrorCodes.SESSION_EXPIRED : ErrorCodes.UNAUTHENTICATED,
    );
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  } catch {
    throw AppError.unauthorized('Refresh token is invalid or expired', ErrorCodes.SESSION_EXPIRED);
  }
}

/** Milliseconds for a duration string such as "15m" or "7d". */
export function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) throw new Error(`Unsupported TTL format: ${ttl}`);
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const multiplier = multipliers[unit as keyof typeof multipliers];
  if (!multiplier) throw new Error(`Unsupported TTL unit: ${unit}`);
  return amount * multiplier;
}

/**
 * Tokens live in HTTP-only cookies so JavaScript — and therefore any XSS
 * payload — cannot read them. The CSRF cookie is deliberately readable: the
 * client echoes it in a header for double-submit verification.
 */
export function setAuthCookies(res: Response, accessToken: string, refreshToken: string, csrfToken: string): void {
  const common = {
    httpOnly: true,
    secure: env.COOKIE_SECURE || isProd,
    sameSite: 'lax' as const,
    path: '/',
    ...(env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'localhost' ? { domain: env.COOKIE_DOMAIN } : {}),
  };

  res.cookie(ACCESS_COOKIE, accessToken, { ...common, maxAge: ttlToMs(env.JWT_ACCESS_TTL) });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...common,
    maxAge: ttlToMs(env.JWT_REFRESH_TTL),
  });
  res.cookie(CSRF_COOKIE, csrfToken, {
    ...common,
    httpOnly: false,
    maxAge: ttlToMs(env.JWT_REFRESH_TTL),
  });
}

export function clearAuthCookies(res: Response): void {
  const common = {
    path: '/',
    ...(env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'localhost' ? { domain: env.COOKIE_DOMAIN } : {}),
  };
  res.clearCookie(ACCESS_COOKIE, common);
  res.clearCookie(REFRESH_COOKIE, common);
  res.clearCookie(CSRF_COOKIE, common);
}
