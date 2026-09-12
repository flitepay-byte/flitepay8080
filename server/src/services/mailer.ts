import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from '../config/logger';
import { env, isProd } from '../config/env';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';

export interface MockEmail {
  to: string;
  subject: string;
  body: string;
  sentAt: Date;
}

/**
 * MOCK EMAIL PROVIDER
 * -------------------
 * Used only when SMTP_HOST is not configured. Delivers nothing; messages are
 * logged and held in a small ring buffer so the demo UI can display the OTP
 * without any external service.
 */
const OUTBOX_LIMIT = 100;
const outbox: MockEmail[] = [];

function isSmtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST);
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}

/**
 * Sends via real SMTP when configured; otherwise falls back to the mock
 * transport so the app stays usable without credentials. Once SMTP_HOST is
 * set, delivery failures are surfaced to the caller rather than silently
 * swallowed, so a broken SMTP config is never mistaken for a working one.
 */
export async function sendMail(to: string, subject: string, body: string): Promise<MockEmail> {
  if (isSmtpConfigured()) {
    try {
      await getTransporter().sendMail({ from: env.SMTP_FROM, to, subject, text: body });
      logger.info({ to, subject }, 'Email sent via SMTP');
      return { to, subject, body, sentAt: new Date() };
    } catch (err) {
      logger.error({ err, to }, 'Failed to send email via SMTP');
      throw new AppError(502, ErrorCodes.EMAIL_SEND_FAILED, 'Failed to send verification email');
    }
  }

  const email: MockEmail = { to, subject, body, sentAt: new Date() };
  outbox.unshift(email);
  if (outbox.length > OUTBOX_LIMIT) outbox.length = OUTBOX_LIMIT;
  // The body goes in the log, not just the subject. Without SMTP this outbox
  // is the only copy, nothing serves it, and `devOtp` is withheld outside
  // development — so a verification code written here and nowhere else makes
  // two-step login impossible to complete rather than merely inconvenient.
  // Nothing is logged once SMTP_HOST is set: the branch above returns first.
  logger.info(
    { to, subject, body },
    '[MOCK MAILER] not delivered (SMTP_HOST not set); the body is logged because nothing else can reach it',
  );
  return email;
}

export function getOutbox(limit = 20): MockEmail[] {
  return outbox.slice(0, limit);
}

export function clearOutbox(): void {
  outbox.length = 0;
}

/**
 * In development the OTP is echoed to the caller so the prototype is usable
 * without an inbox. This is gated on NODE_ENV so it can never leak in prod.
 */
export function shouldExposeOtp(): boolean {
  return !isProd;
}
