import { Types } from 'mongoose';
import { OtpToken, type IOtpToken, type OtpPurpose } from '../models';
import { generateOtp, randomToken, sha256, timingSafeEqual } from '../utils/ids';
import { addMinutes, addSeconds } from '../utils/dates';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { getConfig } from './systemConfig.service';
import { sendMail, shouldExposeOtp } from './mailer';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * TEMPORARY local-testing escape hatch (see OTP_STATIC_CODE in env.ts). When
 * active, every challenge uses the same fixed code and no email is sent at
 * all, so login works with no network path to the mail server.
 */
function resolveOtp(): { otp: string; skipEmail: boolean } {
  // Setting OTP_STATIC_CODE is itself the deliberate act — it is empty by
  // default and nothing sets it accidentally — so it is honoured wherever it
  // is set rather than only outside production. A production deployment that
  // has one says so loudly on every boot; see index.ts.
  if (env.OTP_STATIC_CODE) {
    return { otp: env.OTP_STATIC_CODE, skipEmail: true };
  }
  return { otp: generateOtp(), skipEmail: false };
}

export interface OtpChallenge {
  challengeId: string;
  expiresAt: Date;
  resendAvailableAt: Date;
  /** Populated in non-production only, so the prototype is usable without email. */
  devOtp?: string;
}

export interface IssueOtpOptions {
  email: string;
  purpose: OtpPurpose;
  /** Absent for a registration, where the account does not exist yet. */
  userId?: Types.ObjectId | null;
  ip?: string;
}

/**
 * What each purpose says in the email it sends.
 *
 * Kept in one place because the wording is the only part of an OTP that differs
 * between the three flows. Everything else about issuing, resending and
 * verifying one is identical, and duplicating the mechanism per flow is how the
 * hardened parts — hashing, the attempt budget, the resend cooldown, atomic
 * consumption — end up implemented three times and correct once.
 */
const PURPOSE_COPY: Record<OtpPurpose, { subject: string; line: (otp: string, minutes: number) => string }> = {
  LOGIN: {
    subject: 'Your OTDMS verification code',
    line: (otp, minutes) =>
      `Your one-time code is ${otp}. It expires in ${minutes} minutes. ` +
      `If you did not attempt to sign in, ignore this message.`,
  },
  CAPTAIN_REGISTRATION: {
    subject: 'Confirm your email address — OTDMS captain registration',
    line: (otp, minutes) =>
      `Your registration code is ${otp}. It expires in ${minutes} minutes.\n\n` +
      `Entering it confirms this email address. Your application then goes to an ` +
      `administrator, who decides whether to approve it, and you will not be able ` +
      `to sign in until they do.`,
  },
  PASSWORD_RESET: {
    subject: 'Reset your OTDMS password',
    line: (otp, minutes) =>
      `Your password reset code is ${otp}. It expires in ${minutes} minutes.\n\n` +
      `If you did not ask to reset your password, ignore this message. Nothing has ` +
      `changed and your existing password still works.`,
  },
};

/**
 * Issue an OTP challenge. The plaintext code is hashed before storage and is
 * returned to the caller only outside production.
 */
export async function issueOtpChallenge(options: IssueOtpOptions): Promise<OtpChallenge> {
  const { email, purpose, userId = null, ip } = options;
  const config = await getConfig();
  const { otp, skipEmail } = resolveOtp();
  const challengeId = randomToken(24);
  const now = new Date();
  const expiresAt = addMinutes(now, config.otpExpiryMinutes);

  await OtpToken.create({
    userId,
    email,
    purpose,
    challengeId,
    otpHash: sha256(otp),
    attempts: 0,
    maxAttempts: config.otpMaxAttempts,
    lastSentAt: now,
    expiresAt,
    ip,
  });

  if (skipEmail) {
    logger.warn(
      { email, challengeId, purpose },
      '[DEV] OTP_STATIC_CODE active: email not sent, use the static code',
    );
  } else {
    const copy = PURPOSE_COPY[purpose];
    await sendMail(email, copy.subject, copy.line(otp, config.otpExpiryMinutes));
  }

  return {
    challengeId,
    expiresAt,
    resendAvailableAt: addSeconds(now, config.otpResendCooldownSeconds),
    ...(shouldExposeOtp() ? { devOtp: otp } : {}),
  };
}

/**
 * Resend on an existing challenge, honouring the cooldown.
 *
 * The destination is read from the challenge rather than supplied by the
 * caller. It used to be a request field, which meant whoever held a challenge
 * id could name the address the next code was mailed to — the server always
 * knew the right one and asked anyway.
 */
export async function resendOtp(challengeId: string): Promise<OtpChallenge> {
  const config = await getConfig();
  const token = await OtpToken.findOne({ challengeId }).select('+otpHash');
  if (!token) throw AppError.notFound('Verification challenge not found', ErrorCodes.OTP_INVALID);
  if (token.consumedAt) throw AppError.badRequest(ErrorCodes.OTP_INVALID, 'This challenge has already been used');

  const cooldownEnds = addSeconds(token.lastSentAt, config.otpResendCooldownSeconds);
  if (cooldownEnds.getTime() > Date.now()) {
    const retryAfterSeconds = Math.ceil((cooldownEnds.getTime() - Date.now()) / 1000);
    throw new AppError(429, ErrorCodes.OTP_RESEND_COOLDOWN, 'Please wait before requesting another code', {
      retryAfterSeconds,
    });
  }

  const { otp, skipEmail } = resolveOtp();
  const now = new Date();
  const email = token.email;
  token.otpHash = sha256(otp);
  token.lastSentAt = now;
  token.expiresAt = addMinutes(now, config.otpExpiryMinutes);
  // A resent code resets the attempt budget for the new code.
  token.attempts = 0;
  await token.save();

  if (skipEmail) {
    logger.warn(
      { email, challengeId, purpose: token.purpose },
      '[DEV] OTP_STATIC_CODE active: email not sent, use the static code',
    );
  } else {
    await sendMail(
      email,
      PURPOSE_COPY[token.purpose].subject,
      `Your new code is ${otp}. It expires in ${config.otpExpiryMinutes} minutes.`,
    );
  }

  return {
    challengeId,
    expiresAt: token.expiresAt,
    resendAvailableAt: addSeconds(now, config.otpResendCooldownSeconds),
    ...(shouldExposeOtp() ? { devOtp: otp } : {}),
  };
}

export interface VerifiedChallenge {
  /** Null when the challenge belongs to a registration, which has no account yet. */
  userId: Types.ObjectId | null;
  email: string;
  purpose: OtpPurpose;
}

/**
 * Verify and atomically consume a challenge. Returns who it belonged to.
 *
 * The expected purpose is a required argument rather than an optional one:
 * every caller knows which flow it is completing, and a caller that did not
 * have to say so could be handed a code issued for a different one.
 *
 * Every failure path increments the attempt counter before throwing.
 */
export async function verifyOtpChallenge(
  challengeId: string,
  otp: string,
  expectedPurpose: OtpPurpose,
): Promise<VerifiedChallenge> {
  const token: IOtpToken | null = await OtpToken.findOne({ challengeId }).select('+otpHash');
  if (!token) throw AppError.badRequest(ErrorCodes.OTP_INVALID, 'Invalid or expired verification challenge');

  if (token.purpose !== expectedPurpose) {
    throw AppError.badRequest(ErrorCodes.OTP_WRONG_PURPOSE, 'This code was not issued for this action');
  }

  if (token.consumedAt) {
    throw AppError.badRequest(ErrorCodes.OTP_INVALID, 'This code has already been used');
  }
  if (token.expiresAt.getTime() <= Date.now()) {
    throw AppError.badRequest(ErrorCodes.OTP_EXPIRED, 'This code has expired. Request a new one.');
  }
  if (token.attempts >= token.maxAttempts) {
    throw AppError.badRequest(ErrorCodes.OTP_MAX_ATTEMPTS, 'Too many incorrect attempts. Request a new code.');
  }

  const matches = timingSafeEqual(token.otpHash, sha256(otp));
  if (!matches) {
    token.attempts += 1;
    await token.save();
    const remaining = Math.max(0, token.maxAttempts - token.attempts);
    throw AppError.badRequest(ErrorCodes.OTP_INVALID, 'Incorrect verification code', {
      attemptsRemaining: remaining,
    });
  }

  // Compare-and-swap consumption: guards against two concurrent submissions of
  // the same correct code both succeeding.
  const consumed = await OtpToken.findOneAndUpdate(
    { challengeId, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { new: true },
  );
  if (!consumed) {
    throw AppError.badRequest(ErrorCodes.OTP_INVALID, 'This code has already been used');
  }

  return { userId: token.userId ?? null, email: token.email, purpose: token.purpose };
}
