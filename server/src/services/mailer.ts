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

/**
 * Whether the connection starts in TLS, reconciled against the port.
 *
 * Port 465 is implicit TLS and 587 is STARTTLS, and pairing either with the
 * wrong setting does not fail helpfully. 465 with secure=false is the bad one:
 * the client connects in plain text to a server speaking TLS, waits for a
 * greeting that never arrives, and after many seconds reports "Connection
 * closed" with no error code — which is indistinguishable, from the outside,
 * from a network problem. 587 with secure=true fails at once with a TLS version
 * error, which is at least loud.
 *
 * For those two ports only one value can ever work, so the port wins and the
 * correction is logged. Any other port is taken exactly as configured.
 */
export function effectiveSecure(port: number, configured: boolean): { secure: boolean; corrected: boolean } {
  if (port === 465 && !configured) return { secure: true, corrected: true };
  if (port === 587 && configured) return { secure: false, corrected: true };
  return { secure: configured, corrected: false };
}

/**
 * Bounds on every stage of an SMTP conversation.
 *
 * Nodemailer's defaults are two minutes to connect and ten for an idle socket.
 * A send runs inside the sign-in request, so a misconfigured transport used to
 * hold that request open far longer than any proxy in front of it would wait —
 * the client saw a timeout, and the error that explained it arrived in the log
 * long after anyone was looking. These make a bad connection fail in seconds,
 * with its real reason.
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
} as const;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const { secure, corrected } = effectiveSecure(env.SMTP_PORT, env.SMTP_SECURE);

  // TEMPORARY DIAGNOSTIC. Everything a reader needs to see which transport the
  // running process actually built — and deliberately nothing that is secret:
  // SMTP_PASS is reported only as present or absent.
  logger.info(
    {
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpSecureConfigured: env.SMTP_SECURE,
      smtpSecureRawValue: process.env['SMTP_SECURE'] ?? '(unset)',
      smtpSecureEffective: secure,
      smtpSecureCorrected: corrected,
      smtpUser: env.SMTP_USER ?? '(unset)',
      smtpPassPresent: Boolean(env.SMTP_PASS),
      smtpFrom: env.SMTP_FROM,
      ...SMTP_TIMEOUTS,
    },
    '[MAILER DIAG] SMTP transport created',
  );
  if (corrected) {
    logger.warn(
      { smtpPort: env.SMTP_PORT, configured: env.SMTP_SECURE, using: secure },
      '[MAILER DIAG] SMTP_SECURE contradicted SMTP_PORT; using the only value that port accepts',
    );
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    ...SMTP_TIMEOUTS,
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
  // TEMPORARY DIAGNOSTIC. Which route this call took, before anything happens.
  // The body is not logged here: it carries the one-time code.
  logger.info(
    { to, subject, route: isSmtpConfigured() ? 'SMTP' : 'MOCK', smtpHostPresent: Boolean(env.SMTP_HOST) },
    '[MAILER DIAG] sendMail called',
  );

  if (isSmtpConfigured()) {
    const started = Date.now();
    try {
      const info = (await getTransporter().sendMail({ from: env.SMTP_FROM, to, subject, text: body })) as {
        messageId?: string;
        accepted?: unknown[];
        rejected?: unknown[];
        response?: string;
      };
      // What the server said, which is the only real evidence it took the
      // message: accepted/rejected recipients and its final response line.
      logger.info(
        {
          to,
          subject,
          ms: Date.now() - started,
          messageId: info.messageId,
          accepted: info.accepted,
          rejected: info.rejected,
          response: info.response,
        },
        'Email sent via SMTP',
      );
      return { to, subject, body, sentAt: new Date() };
    } catch (err) {
      const e = err as { code?: string; command?: string; responseCode?: number; response?: string; message?: string };
      // The fields that distinguish one SMTP failure from another. `err` itself
      // is kept as well for the stack; neither contains the password, which
      // nodemailer never puts into an error.
      logger.error(
        {
          err,
          to,
          ms: Date.now() - started,
          code: e.code,
          command: e.command,
          responseCode: e.responseCode,
          response: e.response,
        },
        'Failed to send email via SMTP',
      );
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
