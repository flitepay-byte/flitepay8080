import { Types } from 'mongoose';
import { User, Party, Captain, Session, hashPassword, type IUser } from '../models';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { randomToken, sha256 } from '../utils/ids';
import { addMinutes } from '../utils/dates';
import { getConfig } from './systemConfig.service';
import { issueOtpChallenge, verifyOtpChallenge, type OtpChallenge } from './otp.service';
import { recordAudit } from './audit.service';
import { notifyPresenceChanged } from './notification.service';
import {
  signAccessToken,
  signRefreshToken,
  ttlToMs,
  type AccessTokenPayload,
} from './token.service';
import { env } from '../config/env';
import type { Role } from '../types';

export interface LoginContext {
  ip?: string;
  userAgent?: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: Role;
    partyId?: string;
    captainId?: string;
  };
}

/** Resolve the role-specific profile id so it can be embedded in the token. */
async function resolveProfileIds(user: IUser): Promise<{ partyId?: string; captainId?: string }> {
  if (user.role === 'PARTY') {
    const party = await Party.findOne({ userId: user._id }).select('_id').lean();
    return party ? { partyId: String(party._id) } : {};
  }
  if (user.role === 'CAPTAIN') {
    const captain = await Captain.findOne({ userId: user._id }).select('_id').lean();
    return captain ? { captainId: String(captain._id) } : {};
  }
  return {};
}

/**
 * STEP 1 — email + password.
 * Never issues a session. On success it only issues an OTP challenge.
 */
export async function loginStepOne(
  email: string,
  password: string,
  ctx: LoginContext,
): Promise<OtpChallenge & { userId: string }> {
  const config = await getConfig();
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');

  // Uniform failure response: does not reveal whether the address exists.
  const genericFailure = AppError.unauthorized('Invalid email or password', ErrorCodes.INVALID_CREDENTIALS);

  if (!user) {
    await recordAudit({
      action: 'LOGIN_FAILED',
      targetCollection: 'User',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { email, reason: 'UNKNOWN_EMAIL' },
    });
    throw genericFailure;
  }

  if (user.isLocked()) {
    await recordAudit({
      action: 'LOGIN_FAILED',
      targetCollection: 'User',
      targetId: user._id,
      userId: user._id,
      role: user.role,
      ip: ctx.ip,
      metadata: { reason: 'ACCOUNT_LOCKED' },
    });
    throw new AppError(423, ErrorCodes.ACCOUNT_LOCKED, 'Account is temporarily locked. Try again later.', {
      lockedUntil: user.lockedUntil,
    });
  }

  if (user.status !== 'ACTIVE') {
    throw new AppError(403, ErrorCodes.ACCOUNT_INACTIVE, 'This account is not active. Contact an administrator.');
  }

  const passwordValid = await user.comparePassword(password);
  if (!passwordValid) {
    user.failedLoginAttempts += 1;
    let locked = false;
    if (user.failedLoginAttempts >= config.maxFailedLoginAttempts) {
      user.lockedUntil = addMinutes(new Date(), config.accountLockMinutes);
      user.failedLoginAttempts = 0;
      locked = true;
    }
    await user.save();

    await recordAudit({
      action: locked ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
      targetCollection: 'User',
      targetId: user._id,
      userId: user._id,
      role: user.role,
      ip: ctx.ip,
      metadata: { attempts: user.failedLoginAttempts, locked },
    });

    if (locked) {
      throw new AppError(
        423,
        ErrorCodes.ACCOUNT_LOCKED,
        `Account locked after ${config.maxFailedLoginAttempts} failed attempts.`,
        { lockedUntil: user.lockedUntil },
      );
    }
    throw genericFailure;
  }

  // Password correct: reset the counter and move to step 2.
  if (user.failedLoginAttempts !== 0 || user.lockedUntil) {
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await user.save();
  }

  const challenge = await issueOtpChallenge({
    userId: user._id,
    email: user.email,
    purpose: 'LOGIN',
    ip: ctx.ip,
  });

  await recordAudit({
    action: 'OTP_ISSUED',
    targetCollection: 'User',
    targetId: user._id,
    userId: user._id,
    role: user.role,
    ip: ctx.ip,
    metadata: { challengeId: challenge.challengeId },
  });

  return { ...challenge, userId: String(user._id) };
}

/**
 * STEP 2 — OTP verification. Only this path issues an authenticated session.
 */
export async function loginStepTwo(
  challengeId: string,
  otp: string,
  ctx: LoginContext,
): Promise<IssuedSession> {
  let userId: Types.ObjectId | null;
  try {
    ({ userId } = await verifyOtpChallenge(challengeId, otp, 'LOGIN'));
  } catch (err) {
    await recordAudit({
      action: 'OTP_FAILED',
      targetCollection: 'OtpToken',
      targetId: challengeId,
      ip: ctx.ip,
      metadata: { errorCode: err instanceof AppError ? err.errorCode : 'UNKNOWN' },
    });
    throw err;
  }

  // A LOGIN challenge is always issued against an account, so this cannot be
  // null in practice; the check is here because the type allows it and a
  // registration code reaching this path would otherwise sign nobody in.
  if (!userId) throw AppError.unauthorized('Account no longer exists', ErrorCodes.INVALID_CREDENTIALS);

  const user = await User.findById(userId);
  if (!user) throw AppError.unauthorized('Account no longer exists', ErrorCodes.INVALID_CREDENTIALS);
  if (user.status !== 'ACTIVE') {
    throw new AppError(403, ErrorCodes.ACCOUNT_INACTIVE, 'This account is not active.');
  }

  const profileIds = await resolveProfileIds(user);
  const sessionId = randomToken(24);
  const refreshJti = randomToken(24);
  const csrfToken = randomToken(24);

  const payload: AccessTokenPayload = {
    sub: String(user._id),
    role: user.role,
    email: user.email,
    sid: sessionId,
    ...profileIds,
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken({ sub: String(user._id), sid: sessionId, jti: refreshJti });

  await Session.create({
    sessionId,
    userId: user._id,
    refreshTokenHash: sha256(refreshToken),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    expiresAt: new Date(Date.now() + ttlToMs(env.JWT_REFRESH_TTL)),
  });

  user.lastLoginAt = new Date();
  await user.save();

  // A captain is only ever offered work while online, so signing in puts
  // them back in the pool automatically rather than leaving them stuck
  // offline from whenever their last session ended.
  if (user.role === 'CAPTAIN' && profileIds.captainId) {
    await Captain.updateOne({ _id: profileIds.captainId }, { $set: { isOnline: true, lastSeenAt: new Date() } });
    notifyPresenceChanged(profileIds.captainId, true);
  }

  await recordAudit({
    action: 'OTP_VERIFIED',
    targetCollection: 'User',
    targetId: user._id,
    userId: user._id,
    role: user.role,
    ip: ctx.ip,
    metadata: { sessionId },
  });
  await recordAudit({
    action: 'LOGIN_SUCCESS',
    targetCollection: 'User',
    targetId: user._id,
    userId: user._id,
    role: user.role,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { sessionId },
  });

  return {
    accessToken,
    refreshToken,
    csrfToken,
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      ...profileIds,
    },
  };
}

/** Rotate an access token using a valid, unrevoked refresh token. */
export async function refreshSession(
  refreshTokenRaw: string,
  sessionId: string,
  userId: string,
  ctx: LoginContext,
): Promise<{ accessToken: string }> {
  const session = await Session.findOne({ sessionId, userId }).select('+refreshTokenHash');
  if (!session || session.revokedAt) {
    throw AppError.unauthorized('Session has been revoked', ErrorCodes.SESSION_EXPIRED);
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw AppError.unauthorized('Session has expired', ErrorCodes.SESSION_EXPIRED);
  }
  if (session.refreshTokenHash !== sha256(refreshTokenRaw)) {
    // Token reuse or forgery: revoke defensively.
    session.revokedAt = new Date();
    await session.save();
    throw AppError.unauthorized('Refresh token mismatch', ErrorCodes.SESSION_EXPIRED);
  }

  const user = await User.findById(userId);
  if (!user || user.status !== 'ACTIVE') {
    throw AppError.unauthorized('Account is not active', ErrorCodes.ACCOUNT_INACTIVE);
  }

  const profileIds = await resolveProfileIds(user);
  const accessToken = signAccessToken({
    sub: String(user._id),
    role: user.role,
    email: user.email,
    sid: sessionId,
    ...profileIds,
  });

  await recordAudit({
    action: 'TOKEN_REFRESHED',
    targetCollection: 'Session',
    targetId: sessionId,
    userId: user._id,
    role: user.role,
    ip: ctx.ip,
  });

  return { accessToken };
}

export async function logout(sessionId: string, userId: string, ctx: LoginContext): Promise<void> {
  await Session.updateOne({ sessionId, userId }, { $set: { revokedAt: new Date() } });

  // Mirrors the auto-online-on-login behaviour: a captain who signs out is
  // no longer reachable, so the pool should stop offering them work.
  const captain = await Captain.findOneAndUpdate(
    { userId: new Types.ObjectId(userId) },
    { $set: { isOnline: false, lastSeenAt: new Date() } },
  )
    .select('_id')
    .lean();
  if (captain) notifyPresenceChanged(String(captain._id), false);

  await recordAudit({
    action: 'LOGOUT',
    targetCollection: 'Session',
    targetId: sessionId,
    userId,
    ip: ctx.ip,
  });
}

export async function isSessionActive(sessionId: string): Promise<boolean> {
  const session = await Session.findOne({ sessionId }).select('revokedAt expiresAt').lean();
  if (!session) return false;
  if (session.revokedAt) return false;
  return session.expiresAt.getTime() > Date.now();
}

/** Admin action: unlock an account that hit the failed-attempt threshold. */
export async function unlockAccount(targetUserId: string, adminUserId: string): Promise<void> {
  const user = await User.findById(targetUserId);
  if (!user) throw AppError.notFound('User not found');
  const wasLocked = user.isLocked();
  user.lockedUntil = null;
  user.failedLoginAttempts = 0;
  await user.save();

  await recordAudit({
    action: 'ACCOUNT_UNLOCKED',
    targetCollection: 'User',
    targetId: user._id,
    userId: adminUserId,
    role: 'ADMIN',
    oldState: { locked: wasLocked },
    newState: { locked: false },
  });
}

/**
 * FORGOTTEN PASSWORD, BY EMAIL CODE
 * ---------------------------------
 * Same two steps as signing in, and the same machinery underneath: a code is
 * mailed, and presenting it is what authorises the change. The code is issued
 * for PASSWORD_RESET and will not complete a sign-in, just as a sign-in code
 * will not reset a password.
 */

/**
 * Step one. Always answers the same way.
 *
 * Whether or not the address belongs to an account, the caller is told a code
 * has been sent. Saying "no such account" here would turn this endpoint into a
 * way of asking which email addresses are registered, which is worth more to
 * somebody enumerating accounts than the convenience is worth to a person who
 * mistyped their own address.
 */
export async function requestPasswordReset(
  email: string,
  ctx: LoginContext,
): Promise<OtpChallenge | null> {
  const user = await User.findOne({ email: email.trim().toLowerCase() });

  // Silently do nothing for an unknown or inactive account. The caller cannot
  // tell this apart from a code that was sent.
  if (!user || user.status !== 'ACTIVE') return null;

  const challenge = await issueOtpChallenge({
    userId: user._id,
    email: user.email,
    purpose: 'PASSWORD_RESET',
    ip: ctx.ip,
  });

  await recordAudit({
    action: 'OTP_ISSUED',
    targetCollection: 'User',
    targetId: user._id,
    userId: user._id,
    role: user.role,
    ip: ctx.ip,
    metadata: { challengeId: challenge.challengeId, purpose: 'PASSWORD_RESET' },
  });

  return challenge;
}

/**
 * Step two: the code is correct, so the password becomes the new one.
 *
 * Every existing session is ended as part of this. Somebody resetting a password
 * may be doing it because another person has been using the account, and leaving
 * that person's session alive would make the reset pointless. The attempt counter
 * and any lock are cleared too, since a successful reset is proof enough of
 * ownership to let them sign in again straight away.
 */
export async function resetPassword(
  challengeId: string,
  otp: string,
  newPassword: string,
  ctx: LoginContext,
): Promise<void> {
  let userId: Types.ObjectId | null;
  try {
    ({ userId } = await verifyOtpChallenge(challengeId, otp, 'PASSWORD_RESET'));
  } catch (err) {
    await recordAudit({
      action: 'OTP_FAILED',
      targetCollection: 'OtpToken',
      targetId: challengeId,
      ip: ctx.ip,
      metadata: { errorCode: err instanceof AppError ? err.errorCode : 'UNKNOWN', purpose: 'PASSWORD_RESET' },
    });
    throw err;
  }

  if (!userId) throw AppError.badRequest(ErrorCodes.OTP_INVALID, 'This code is not valid for a password reset');

  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('Account no longer exists', ErrorCodes.NOT_FOUND);
  if (user.status !== 'ACTIVE') {
    throw new AppError(403, ErrorCodes.ACCOUNT_INACTIVE, 'This account is not active.');
  }

  user.passwordHash = await hashPassword(newPassword);
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  await user.save();

  // Whoever was signed in before, is not any more.
  await Session.deleteMany({ userId: user._id });

  await recordAudit({
    action: 'PASSWORD_RESET',
    targetCollection: 'User',
    targetId: user._id,
    userId: user._id,
    role: user.role,
    ip: ctx.ip,
  });
}
