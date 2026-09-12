import rateLimit, { type Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request, Response } from 'express';
import { getRedis } from '../config/redis';
import { logger } from '../config/logger';
import { ErrorCodes } from '../utils/errorCodes';
import { isTest } from '../config/env';
import { clientIp } from '../utils/http';

/**
 * How long a rate-limit lookup may take before the request stops waiting.
 *
 * This runs on *every* request, so it is the single most latency-sensitive
 * Redis call in the system — and the one whose answer is worth least, because
 * `passOnStoreError` already lets the request through when it fails. With
 * Redis unreachable, ioredis spent the client's whole budget before rejecting
 * (`commandTimeout: 1000` × `maxRetriesPerRequest: 1`), which measured at
 * roughly two seconds *per request*: a trivial `/health` call took 2,006ms
 * while doing nothing at all. A Redis outage turned into a total slowdown of
 * every endpoint, which is exactly how it was reported — "the app is slow",
 * everywhere, uniformly.
 */
const REDIS_DEADLINE_MS = 50;

/**
 * Once Redis has failed, stop asking for a while.
 *
 * The deadline alone caps the damage at 50ms a request, but paying even that
 * on every call during an outage is waste: the answer is already known. After
 * a failure the breaker opens and lookups fail instantly until it is time to
 * probe again, so a sustained outage costs nothing per request rather than
 * compounding across every endpoint the page happens to call.
 */
const BREAKER_COOLDOWN_MS = 10_000;
let breakerOpenUntil = 0;

class RateLimitStoreUnavailable extends Error {}

function withDeadline<T>(operation: Promise<T>): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new RateLimitStoreUnavailable('rate limit store timed out')), REDIS_DEADLINE_MS);
      // Never hold the process open for a timer whose only job is to give up.
      timer.unref?.();
    }),
  ]);
}

/**
 * Redis-backed so limits hold across horizontally scaled API instances.
 * Falls back to in-memory if Redis is unavailable rather than failing open
 * on the whole endpoint.
 */
function buildStore(prefix: string): Options['store'] | undefined {
  try {
    const client = getRedis();
    return new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (...args: string[]) => {
        const command = (args[0] ?? '').toUpperCase();
        const pending = (async () => {
          // Redis is known to be down and the cooldown has not elapsed: give
          // the same answer immediately rather than paying to rediscover it.
          if (command !== 'SCRIPT' && Date.now() < breakerOpenUntil) {
            throw new RateLimitStoreUnavailable('rate limit store is in cooldown');
          }
          try {
            const result = (await withDeadline(client.call(...(args as [string, ...string[]])))) as never;
            breakerOpenUntil = 0;
            return result;
          } catch (err) {
            if (command !== 'SCRIPT') breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
            // rate-limit-redis loads its Lua script from its constructor and
            // never awaits the result, so a rejection here has nothing
            // observing it — with Redis unreachable that surfaces as an
            // unhandled rejection at import time, which is exactly when the
            // in-memory fallback below is supposed to be quietly taking over.
            //
            // Answering the script load with a placeholder digest keeps that
            // promise resolved. Every real command still rejects, and those
            // ARE awaited — by the limiter, which passOnStoreError then lets
            // through. So the failure still reaches the code equipped to
            // handle it, and only the fire-and-forget one is silenced.
            if (command === 'SCRIPT') {
              logger.warn({ err }, 'Rate limiter could not load its Redis script; falling back per request');
              return 'redis-unavailable' as never;
            }
            throw err;
          }
        })();
        return pending;
      },
    });
  } catch (err) {
    logger.warn({ err }, 'Rate limiter falling back to in-memory store');
    return undefined;
  }
}

function makeLimiter(
  prefix: string,
  windowMs: number,
  max: number,
  message: string,
  /**
   * What counts as "the same caller". Defaults to the client IP, which is the
   * only thing a browser reliably identifies itself by — but a party's server
   * calls from one address on behalf of many customers, so the API limiter
   * keys on the API key instead. See apiLimiter below.
   */
  keyOf: (req: Request) => string = clientIp,
) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // A Redis outage must degrade the limiter, not fail every request.
    passOnStoreError: true,
    // Disabled under test so suites do not trip limits.
    skip: () => isTest,
    keyGenerator: keyOf,
    store: buildStore(prefix),
    handler: (_req: Request, res: Response) => {
      res.status(429).json({ success: false, message, errorCode: ErrorCodes.RATE_LIMITED });
    },
  });
}

/** Broad protection on the whole API surface. */
export const globalLimiter = makeLimiter('global', 60_000, 300, 'Too many requests. Please slow down.');

/** Credential endpoints get a much tighter budget to blunt brute force. */
export const loginLimiter = makeLimiter('login', 15 * 60_000, 10, 'Too many sign-in attempts. Try again later.');

export const otpLimiter = makeLimiter('otp', 15 * 60_000, 20, 'Too many verification attempts. Try again later.');

/** Public tracking is unauthenticated, so it is rate limited by IP. */
export const trackingLimiter = makeLimiter('track', 60_000, 30, 'Too many tracking lookups. Please wait a moment.');

/** Claiming is the hot contended path; keeps a single client from spamming it. */
export const claimLimiter = makeLimiter('claim', 60_000, 60, 'Too many claim attempts. Please slow down.');

/**
 * The party-facing API.
 *
 * Keyed on the API key rather than the IP, because a party's whole business
 * calls us from one server: limiting by address would make one busy party
 * throttle every other party behind the same load balancer, and would let a
 * stolen key spread its abuse across addresses to escape the limit entirely.
 *
 * Falls back to the IP when the key header is missing, so an unsigned flood
 * still gets a budget rather than sharing one bucket labelled "undefined".
 *
 * The budget is deliberately generous: this is a payment API and a real
 * checkout burst is normal traffic. It exists to blunt a leaked key being used
 * to hammer us, not to shape ordinary load.
 */
export const apiLimiter = makeLimiter(
  'party-api',
  60_000,
  600,
  'Too many API requests. Please slow down.',
  (req: Request) => {
    const header = req.headers['x-otdms-key'];
    const keyId = Array.isArray(header) ? header[0] : header;
    return keyId ? `key:${keyId}` : `ip:${clientIp(req)}`;
  },
);

/**
 * The gateway's webhook, keyed by address because the provider has no API key
 * of ours. Tighter than the API budget: a payment provider retries, it does
 * not stream.
 */
export const gatewayWebhookLimiter = makeLimiter(
  'gateway-webhook',
  60_000,
  120,
  'Too many webhook deliveries. Please slow down.',
);
