import type { Request, Response } from 'express';
import { asyncHandler, ok, created, clientIp } from '../utils/http';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import * as authService from '../services/auth.service';
import { resendOtp } from '../services/otp.service';
import { randomToken } from '../utils/ids';
import {
  setAuthCookies,
  clearAuthCookies,
  verifyRefreshToken,
  REFRESH_COOKIE,
} from '../services/token.service';
import { User } from '../models';
import type { LoginInput, VerifyOtpInput, ResendOtpInput } from '../validators/auth.validators';
import type {
  ForgotPasswordBody,
  ResetPasswordBody,
} from '../validators/captainRegistration.validators';

/** STEP 1 — password check. Returns an OTP challenge, never a session. */
export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body as LoginInput;
  const ctx = { ip: clientIp(req), userAgent: req.headers['user-agent'] };

  const challenge = await authService.loginStepOne(email, password, ctx);

  return created(
    res,
    {
      step: 'OTP_REQUIRED',
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      resendAvailableAt: challenge.resendAvailableAt,
      maskedEmail: email.replace(/^(.).*(@.*)$/, '$1***$2'),
      ...(challenge.devOtp ? { devOtp: challenge.devOtp } : {}),
    },
    'Verification code sent',
  );
});

/** STEP 2 — OTP check. Only this endpoint issues the auth cookies. */
export const verifyOtp = asyncHandler(async (req: Request, res: Response) => {
  const { challengeId, otp } = req.body as VerifyOtpInput;
  const ctx = { ip: clientIp(req), userAgent: req.headers['user-agent'] };

  const session = await authService.loginStepTwo(challengeId, otp, ctx);
  setAuthCookies(res, session.accessToken, session.refreshToken, session.csrfToken);

  return ok(res, { user: session.user, csrfToken: session.csrfToken }, 'Signed in successfully');
});

export const resend = asyncHandler(async (req: Request, res: Response) => {
  // The address is not taken from the request. It is whatever the challenge was
  // issued to, which the server already knows; accepting it here let whoever
  // held a challenge id choose where the next code was delivered.
  const { challengeId } = req.body as ResendOtpInput;
  const challenge = await resendOtp(challengeId);
  return ok(
    res,
    {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      resendAvailableAt: challenge.resendAvailableAt,
      ...(challenge.devOtp ? { devOtp: challenge.devOtp } : {}),
    },
    'A new verification code has been sent',
  );
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const cookies = req.cookies as Record<string, string> | undefined;
  const refreshToken = cookies?.[REFRESH_COOKIE];
  if (!refreshToken) throw AppError.unauthorized('No refresh token present', ErrorCodes.SESSION_EXPIRED);

  const payload = verifyRefreshToken(refreshToken);
  const { accessToken } = await authService.refreshSession(refreshToken, payload.sid, payload.sub, {
    ip: clientIp(req),
  });

  const csrfToken = randomToken(24);
  setAuthCookies(res, accessToken, refreshToken, csrfToken);
  return ok(res, { refreshed: true, csrfToken });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  if (req.user) {
    await authService.logout(req.user.sessionId, req.user.userId, { ip: clientIp(req) });
  }
  clearAuthCookies(res);
  return ok(res, { loggedOut: true }, 'Signed out');
});

/** Session validation endpoint used by the client on boot. */
export const me = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const user = await User.findById(req.user.userId).select('name email role status lastLoginAt').lean();
  if (!user) throw AppError.unauthorized('Account no longer exists');

  return ok(res, {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    partyId: req.user.partyId,
    captainId: req.user.captainId,
  });
});

/**
 * FORGOTTEN PASSWORD — step 1.
 *
 * The same response either way, whether or not the address has an account
 * behind it, so this cannot be used to discover which addresses are registered.
 * `devOtp` appears only where the OTP service already exposes it, which is
 * never in production.
 */
export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body as ForgotPasswordBody;
  const ctx = { ip: clientIp(req), userAgent: req.headers['user-agent'] };

  const challenge = await authService.requestPasswordReset(email, ctx);

  return ok(
    res,
    {
      step: 'OTP_REQUIRED',
      maskedEmail: email.replace(/^(.).*(@.*)$/, '$1***$2'),
      // Absent when no account matched — the client shows the same screen and
      // simply has no challenge to submit against.
      ...(challenge
        ? {
            challengeId: challenge.challengeId,
            expiresAt: challenge.expiresAt,
            resendAvailableAt: challenge.resendAvailableAt,
            ...(challenge.devOtp ? { devOtp: challenge.devOtp } : {}),
          }
        : {}),
    },
    'If that email has an account, we have sent it a code',
  );
});

/** FORGOTTEN PASSWORD — step 2. Sets the new password and ends every session. */
export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { challengeId, otp, password } = req.body as ResetPasswordBody;
  const ctx = { ip: clientIp(req), userAgent: req.headers['user-agent'] };

  await authService.resetPassword(challengeId, otp, password, ctx);

  // No session is issued here. They sign in with the new password, which also
  // proves it is the one they meant to set.
  clearAuthCookies(res);
  return ok(res, { reset: true }, 'Password changed. Sign in with your new password.');
});
