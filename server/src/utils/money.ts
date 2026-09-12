/**
 * MONEY REPRESENTATION
 * --------------------
 * Canonical internal unit is the PAISE (integer). IEEE-754 doubles cannot
 * represent 0.1 exactly, so storing rupees as floats produces drift that
 * corrupts a ledger over time (e.g. 0.5% of 10000.20 accumulating error
 * across thousands of commission rows).
 *
 * Boundary contract:
 *   - API request/response bodies and CSV files use RUPEES (decimal).
 *   - Every persisted document uses `*Paise` integer fields.
 *   - Conversion happens only here, at the edge.
 */

export const PAISE_PER_RUPEE = 100;

/** Largest safely representable amount: ~₹90,07,19,92,547. */
export const MAX_PAISE = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {}

/** Convert a rupee amount (number or numeric string) to integer paise. */
export function rupeesToPaise(rupees: number | string): number {
  const asString = typeof rupees === 'number' ? rupees.toString() : rupees.trim();
  if (asString === '' || !/^-?\d+(\.\d+)?$/.test(asString)) {
    throw new MoneyError(`Invalid monetary amount: "${rupees}"`);
  }
  const negative = asString.startsWith('-');
  const unsigned = negative ? asString.slice(1) : asString;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  if (fraction.length > 2) {
    throw new MoneyError(`Amount "${rupees}" has sub-paise precision`);
  }
  const paddedFraction = fraction.padEnd(2, '0');
  const paise = Number(whole) * PAISE_PER_RUPEE + Number(paddedFraction);
  if (!Number.isSafeInteger(paise)) throw new MoneyError(`Amount "${rupees}" exceeds safe range`);
  return negative ? -paise : paise;
}

/** Convert integer paise to a rupee number, for API output only. */
export function paiseToRupees(paise: number): number {
  assertIntegerPaise(paise);
  return paise / PAISE_PER_RUPEE;
}

export function assertIntegerPaise(paise: number): void {
  if (!Number.isSafeInteger(paise)) {
    throw new MoneyError(`Expected integer paise, received ${paise}`);
  }
}

/**
 * Percentage of an amount, rounded half-up to the nearest paise.
 * Half-up (rather than banker's rounding) is chosen so commission figures
 * match what a user computes by hand, which matters for dispute handling.
 */
export function percentOfPaise(paise: number, percent: number): number {
  assertIntegerPaise(paise);
  if (!Number.isFinite(percent) || percent < 0) {
    throw new MoneyError(`Invalid percentage: ${percent}`);
  }
  const exact = (paise * percent) / 100;
  return Math.round(exact + Number.EPSILON * Math.sign(exact));
}

/**
 * Fictional demo currency string, e.g. 1234567 paise -> "DMC 12,345.67".
 * DMC ("Demo Currency") is entirely simulated and maps to no real-world
 * currency; see the server README for the educational-simulation scope.
 */
export function formatPaise(paise: number): string {
  assertIntegerPaise(paise);
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / PAISE_PER_RUPEE);
  const remainder = abs % PAISE_PER_RUPEE;
  const grouped = new Intl.NumberFormat('en-IN').format(rupees);
  const decimals = remainder.toString().padStart(2, '0');
  return `${negative ? '-' : ''}DMC ${grouped}.${decimals}`;
}

/** Clamp helper used by limit checks. */
export function sumPaise(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    assertIntegerPaise(v);
    total += v;
  }
  if (!Number.isSafeInteger(total)) throw new MoneyError('Sum exceeds safe integer range');
  return total;
}

/**
 * USDT REPRESENTATION
 * -------------------
 * TRC20 USDT carries six decimals, so the canonical internal unit here is the
 * MICRO-USDT: an integer, exactly as paise are for DMC. The same reasoning
 * applies — a rate applied to a float accumulates drift, and this figure is what
 * somebody is asked to transfer.
 *
 * The conversion rate is held in the unit that already exists rather than a new
 * one: "1 USDT = 9.59 DMC" is 959 paise of DMC per USDT. Integer, two decimals,
 * nothing new to reason about.
 */
export const MICROS_PER_USDT = 1_000_000;

/** Largest sane rate, guarding a typo that would make a payment nearly free. */
export const MAX_DMC_PAISE_PER_USDT = 100_000_000;

/**
 * What a captain or party must send, for the DMC they asked for.
 *
 *   usdt = dmc / rate
 *
 * Rounded half-up to the micro, matching `percentOfPaise` above — the figure a
 * person computes by hand is the figure they are shown, which is what matters
 * when somebody is reconciling a transfer against a request.
 */
export function dmcPaiseToUsdtMicros(dmcPaise: number, dmcPaisePerUsdt: number): number {
  assertIntegerPaise(dmcPaise);
  if (!Number.isInteger(dmcPaisePerUsdt) || dmcPaisePerUsdt <= 0) {
    throw new MoneyError(`Invalid conversion rate: ${dmcPaisePerUsdt}`);
  }
  const exact = (dmcPaise * MICROS_PER_USDT) / dmcPaisePerUsdt;
  const micros = Math.round(exact + Number.EPSILON * Math.sign(exact));
  if (!Number.isSafeInteger(micros)) throw new MoneyError('USDT amount exceeds safe range');
  return micros;
}

/** Micro-USDT to a decimal number, for API output only. */
export function usdtMicrosToAmount(micros: number): number {
  if (!Number.isSafeInteger(micros)) throw new MoneyError(`Expected integer micro-USDT, received ${micros}`);
  return micros / MICROS_PER_USDT;
}

/** A rate as a decimal number of DMC per USDT, for API output only. */
export function dmcPerUsdtFromPaise(dmcPaisePerUsdt: number): number {
  return paiseToRupees(dmcPaisePerUsdt);
}

/** e.g. 208550574 -> "208.550574 USDT". Trailing zeros kept: this is an exact figure to send. */
export function formatUsdtMicros(micros: number): string {
  const whole = Math.floor(Math.abs(micros) / MICROS_PER_USDT);
  const fraction = (Math.abs(micros) % MICROS_PER_USDT).toString().padStart(6, '0');
  return `${micros < 0 ? '-' : ''}${whole}.${fraction} USDT`;
}
