import type { Request, Response } from 'express';
import { asyncHandler, ok, created, clientIp } from '../utils/http';
import * as service from '../services/captainRegistration.service';
import type {
  RegisterCaptainBody,
  VerifyRegistrationBody,
  ResendRegistrationBody,
} from '../validators/captainRegistration.validators';

/**
 * The public half of captain registration. Nothing here requires a session, and
 * nothing here creates one — a successful registration ends with an application
 * waiting on an administrator, never with the applicant signed in.
 */

/** STEP 1 — take the application and send a code. */
export const register = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as RegisterCaptainBody;
  const ip = clientIp(req);

  const { registrationId, challenge } = await service.registerCaptain(
    {
      name: body.name,
      fullName: body.fullName,
      mobile: body.mobile,
      email: body.email,
      upiId: body.upiId,
      password: body.password,
    },
    ip,
  );

  return created(
    res,
    {
      step: 'OTP_REQUIRED',
      registrationId,
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      resendAvailableAt: challenge.resendAvailableAt,
      maskedEmail: body.email.replace(/^(.).*(@.*)$/, '$1***$2'),
      ...(challenge.devOtp ? { devOtp: challenge.devOtp } : {}),
    },
    'We have sent a code to your email',
  );
});

/** STEP 2 — the code proves the address; the application goes to admin. */
export const verify = asyncHandler(async (req: Request, res: Response) => {
  const { challengeId, otp } = req.body as VerifyRegistrationBody;
  const result = await service.verifyRegistrationEmail(challengeId, otp, clientIp(req));

  return ok(
    res,
    { status: result.status },
    'Email confirmed. An administrator will review your registration.',
  );
});

export const resend = asyncHandler(async (req: Request, res: Response) => {
  const { challengeId } = req.body as ResendRegistrationBody;
  const challenge = await service.resendRegistrationOtp(challengeId);

  return ok(
    res,
    {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      resendAvailableAt: challenge.resendAvailableAt,
      ...(challenge.devOtp ? { devOtp: challenge.devOtp } : {}),
    },
    'A new code has been sent',
  );
});

/**
 * Where an applicant stands, so the form can say "waiting on an administrator"
 * rather than leaving them guessing. Deliberately narrow: the status and, if
 * they were turned down, the reason — nothing else about the application.
 */
export const status = asyncHandler(async (req: Request, res: Response) => {
  const { registrationId } = req.params as { registrationId: string };
  return ok(res, await service.registrationStatus(registrationId));
});
