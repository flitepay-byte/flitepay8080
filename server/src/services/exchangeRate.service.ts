import { logger } from '../config/logger';

/**
 * Live USDT/INR rate — the only thing in this app that ever touches a real
 * external source, since the client asked for the DMC-to-USDT figure shown
 * everywhere to track an actual market rate rather than a fixed local one.
 * DMC itself stays fictional throughout: this only prices what 1 DMC (pegged
 * 1:1 to INR) would be worth in real USDT terms, for display purposes.
 */

const SOURCE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=inr';
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
/** Used only if the very first fetch ever fails, so the UI never has nothing to show. */
const FALLBACK_RATE = 88;

interface RateCache {
  usdtInrRate: number;
  fetchedAt: number;
}

let cache: RateCache | null = null;
let inFlight: Promise<number> | null = null;

async function fetchLiveRate(): Promise<number> {
  const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CoinGecko request failed with status ${res.status}`);

  const data = (await res.json()) as { tether?: { inr?: number } };
  const rate = data.tether?.inr;
  if (!rate || !(rate > 0)) throw new Error('CoinGecko response did not contain a usable INR rate');
  return rate;
}

export interface UsdtRate {
  usdtInrRate: number;
  fetchedAt: string;
  /** True when the external source could not be reached and a cached or fallback value was served instead. */
  stale: boolean;
}

/** Serves the cached rate when fresh; refetches at most once every CACHE_TTL_MS, with concurrent callers sharing one in-flight request. */
export async function getUsdtInrRate(): Promise<UsdtRate> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { usdtInrRate: cache.usdtInrRate, fetchedAt: new Date(cache.fetchedAt).toISOString(), stale: false };
  }

  try {
    inFlight ??= fetchLiveRate().finally(() => {
      inFlight = null;
    });
    const rate = await inFlight;
    cache = { usdtInrRate: rate, fetchedAt: now };
    return { usdtInrRate: rate, fetchedAt: new Date(now).toISOString(), stale: false };
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch live USDT/INR rate; serving stale or fallback value');
    if (cache) {
      return { usdtInrRate: cache.usdtInrRate, fetchedAt: new Date(cache.fetchedAt).toISOString(), stale: true };
    }
    return { usdtInrRate: FALLBACK_RATE, fetchedAt: new Date(now).toISOString(), stale: true };
  }
}
