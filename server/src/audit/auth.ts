/**
 * Signing in the way a browser does.
 *
 * Login is two-step — password, then an emailed OTP — and the second step sets
 * httpOnly cookies rather than returning a bearer token. So the audit uses a
 * supertest agent to hold the cookie jar, and reads the OTP straight out of the
 * dev-mode response. Anything less would be testing a different auth path from
 * the one real clients use.
 */
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../config/env';

const P = env.API_PREFIX;

export interface Session {
  label: string;
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  role: string;
}

export async function signIn(app: Express, email: string, password: string): Promise<Session> {
  const agent = request.agent(app);

  const step1 = await agent.post(`${P}/auth/login`).send({ email, password });
  if (step1.status !== 200 && step1.status !== 201) {
    throw new Error(`login step 1 failed for ${email}: ${step1.status} ${JSON.stringify(step1.body).slice(0, 200)}`);
  }

  const challengeId = step1.body?.data?.challengeId;
  const otp = step1.body?.data?.devOtp;
  if (!challengeId || !otp) {
    throw new Error(`no OTP challenge for ${email}: ${JSON.stringify(step1.body).slice(0, 250)}`);
  }

  const step2 = await agent.post(`${P}/auth/verify-otp`).send({ challengeId, otp });
  if (step2.status !== 200) {
    throw new Error(`OTP verification failed for ${email}: ${step2.status} ${JSON.stringify(step2.body).slice(0, 200)}`);
  }

  return {
    label: email,
    agent,
    csrfToken: step2.body?.data?.csrfToken ?? '',
    role: step2.body?.data?.user?.role ?? 'UNKNOWN',
  };
}

export const GET = (s: Session, path: string) => s.agent.get(`${P}${path}`);

export const POST = (s: Session, path: string) =>
  s.agent.post(`${P}${path}`).set('x-csrf-token', s.csrfToken);
