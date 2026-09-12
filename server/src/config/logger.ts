import pino from 'pino';
import { env, isProd } from './env';

/**
 * Human-readable logs are a developer convenience, and `pino-pretty` is a
 * devDependency — so asking for it is only safe when it is actually installed.
 *
 * Keying that off NODE_ENV alone is not the same question. A production build
 * runs `npm ci --omit=dev`, and such an image is legitimately started with
 * NODE_ENV=development: a demo or staging instance that wants the relaxed
 * behaviour but was built from the production image. That combination made
 * pino ask for a transport that was not there, and the process crash-looped
 * on the very first import — before any logger existed to report why.
 *
 * Resolving it first answers the question that actually matters: not "is this
 * production?" but "is the formatter here?".
 */
function prettyAvailable(): boolean {
  if (isProd) return false;
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Structured logging. Redaction list prevents credentials/tokens/OTP
 * from ever reaching log sinks.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'otp',
      '*.otp',
      'otpHash',
      '*.otpHash',
      'token',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  ...(prettyAvailable()
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
