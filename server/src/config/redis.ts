import Redis from 'ioredis';
import { env } from './env';
import { logger } from './logger';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: false,
    // Every caller here already has a fallback path (lock/cache/rate-limit),
    // so a command must not wait out a slow reconnect. The ceiling below is
    // what bounds that; the read-through cache in systemConfig.service adds a
    // tighter one of its own, because it sits on nearly every request.
    //
    // Note this deliberately keeps ioredis's offline queue. Turning it off
    // makes commands fail instantly, which is tempting — but rate-limit-redis
    // loads its Lua script from its constructor without awaiting it, and an
    // instant rejection there becomes an unhandled rejection that kills the
    // process at import time. Failing fast belongs at the call sites that have
    // somewhere to fall back to, not on the shared client.
    commandTimeout: 1000,
    retryStrategy: (times) => Math.min(times * 50, 500),
  });
  client.on('error', (err) => logger.error({ err }, 'Redis error'));
  client.on('connect', () => logger.info('Redis connected'));
  return client;
}

export async function disconnectRedis(): Promise<void> {
  if (!client) return;
  try {
    // QUIT is itself a command, so with the offline queue refused it throws
    // outright when the connection is already down — which is exactly when
    // shutdown is most likely to be running. Closing the socket directly
    // always works and is what we actually want.
    await client.quit();
  } catch {
    client.disconnect();
  } finally {
    client = null;
  }
}
