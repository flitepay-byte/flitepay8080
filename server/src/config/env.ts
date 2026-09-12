import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Environment schema. Fail fast at boot rather than at first use.
 * Secrets are never given defaults in production.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    API_PREFIX: z.string().default('/api/v1'),

    MONGO_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/otdms'),
    REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

    JWT_ACCESS_SECRET: z.string().min(16).default('dev_only_access_secret_change_me_now'),
    JWT_REFRESH_SECRET: z.string().min(16).default('dev_only_refresh_secret_change_me_now'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('7d'),
    COOKIE_DOMAIN: z.string().default('localhost'),
    COOKIE_SECURE: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),

    CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

    /**
     * Lets the customer-payment stand-in answer in production.
     *
     * There is no real UPI rail anywhere in this system — the gateway is a
     * simulation throughout — so the stand-in is how a pay-in is completed at
     * all. It was gated on NODE_ENV alone, which meant a deployment could be
     * production-shaped (secure cookies, the login code kept out of responses)
     * or demonstrable, but never both. This separates the two decisions: off by
     * default, so production still refuses it unless somebody has said other-
     * wise on purpose.
     */
    ALLOW_PAYMENT_SIMULATION: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),

    // SMTP — used to deliver the login OTP by real email. When SMTP_HOST is
    // unset, the mailer falls back to a mock transport (logged, not delivered)
    // so the app remains usable without credentials.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    /**
     * Read leniently. This used to be `v === 'true'`, so `TRUE`, `True`, ` true`
     * and `1` all quietly meant false — and on port 465 a false here does not
     * fail cleanly: the connection sits open for many seconds and then closes
     * with no error code at all. mailer.ts also reconciles this against the port.
     */
    SMTP_SECURE: z
      .string()
      .default('false')
      .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().default('OTDMS <no-reply@otdms.local>'),

    // TEMPORARY local-testing escape hatch: when set (non-production only),
    // every OTP challenge uses this fixed code instead of a random one, and no
    // email is sent at all — useful when there is no working network path to
    // the mail server. Unset it once real SMTP delivery is confirmed working.
    OTP_STATIC_CODE: z
      .string()
      .regex(/^\d{6}$/, 'OTP_STATIC_CODE must be exactly 6 digits')
      .optional(),

    // Cloudinary — proof/receipt files are uploaded here rather than to local
    // disk. Required for the proof-submission endpoint to work.
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),
    CLOUDINARY_FOLDER: z.string().default('otdms/proofs'),

    PROOF_MAX_FILE_SIZE_MB: z.coerce.number().positive().default(5),

    /**
     * Encrypts party API secrets at rest.
     *
     * HMAC request signing needs both ends to hold the same secret, so unlike
     * a password it cannot be stored as a one-way hash — we have to be able to
     * get it back to verify a signature. Encrypting it with a key that lives
     * outside the database is what makes a stolen database dump useless on its
     * own: an attacker needs the dump *and* this value.
     */
    API_SECRET_ENCRYPTION_KEY: z.string().min(32).default('dev_only_api_secret_encryption_key_32b'),

    SEED_DEFAULT_PASSWORD: z.string().min(8).default('Demo@12345'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV === 'production') {
      if (val.JWT_ACCESS_SECRET.startsWith('dev_only') || val.JWT_REFRESH_SECRET.startsWith('dev_only')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'JWT secrets must be explicitly set in production',
        });
      }
      if (val.JWT_ACCESS_SECRET === val.JWT_REFRESH_SECRET) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Access and refresh secrets must differ' });
      }
      if (val.API_SECRET_ENCRYPTION_KEY.startsWith('dev_only')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'API_SECRET_ENCRYPTION_KEY must be explicitly set in production',
        });
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Cannot use the logger here: it depends on this module.
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
