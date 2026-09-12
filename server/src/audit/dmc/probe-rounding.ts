/**
 * Is the commission rounding actually the rule it claims to be?
 *
 * `percentOfPaise` documents "rounded half-up to the nearest paise" and
 * implements it as a floating-point multiply plus a `Number.EPSILON` nudge.
 * Both halves deserve suspicion: the multiply loses precision at scale, and
 * EPSILON is an *absolute* quantity (2.22e-16), so once `exact` is above about
 * 1, adding it is smaller than one ULP and does nothing at all. The nudge only
 * bites for values near zero — which is not where a ledger accumulates drift.
 *
 * The oracle here is exact integer arithmetic over the decimal the user
 * actually typed, done in BigInt so there is no float anywhere in it. It is
 * deliberately not a copy of the implementation: if the two disagree, one of
 * them is wrong about the stated rule.
 */
import { percentOfPaise } from '../../utils/money';

/** Exact round-half-up of paise * percent / 100, with no floating point. */
function exactPercent(paise: number, percentLiteral: string): bigint {
  const [whole = '0', fraction = ''] = percentLiteral.split('.');
  const scale = BigInt(10) ** BigInt(fraction.length);
  const percentScaled = BigInt(whole) * scale + BigInt(fraction || '0');

  const numerator = BigInt(paise) * percentScaled;
  const denominator = BigInt(100) * scale;
  // round half up: floor((2n + d) / 2d) for non-negative values
  return (numerator * BigInt(2) + denominator) / (denominator * BigInt(2));
}

interface Mismatch {
  paise: number;
  percent: string;
  expected: bigint;
  actual: number;
}

function main(): void {
  const percentages = [
    '0.01', '0.05', '0.1', '0.25', '0.33', '0.5', '0.75', '1', '1.5', '1.67',
    '2', '2.5', '3', '5', '7.5', '10', '12.5', '15', '17.5', '25', '33.33',
    '50', '66.67', '75', '99.99', '100',
  ];

  // Amounts chosen to sit on rounding boundaries, not just round numbers.
  const amounts: number[] = [];
  for (let r = 100; r <= 200; r += 1) amounts.push(r * 100);
  for (const base of [1, 5, 10, 99, 100, 999, 1_000, 9_999, 10_000, 99_999, 100_000, 999_999]) {
    for (const off of [0, 1, 2, 3, 49, 50, 51, 97, 98, 99]) amounts.push(base * 100 + off);
  }
  // Large values, where a float multiply has the least headroom.
  for (const big of [1e7, 5e7, 1e8, 5e8, 1e9, 5e9, 1e10, 9e10, 5e11, 9e12, 9e13, 9e14]) {
    for (const off of [0, 1, 7, 49, 50, 51, 99]) amounts.push(big + off);
  }

  const mismatches: Mismatch[] = [];
  let checked = 0;

  for (const percent of percentages) {
    for (const paise of amounts) {
      if (!Number.isSafeInteger(paise)) continue;
      checked += 1;
      const expected = exactPercent(paise, percent);
      const actual = percentOfPaise(paise, Number(percent));
      if (BigInt(actual) !== expected) {
        mismatches.push({ paise, percent, expected, actual });
      }
    }
  }

  console.log(`checked ${checked.toLocaleString('en-IN')} (amount, percentage) pairs`);
  console.log(`mismatches against exact half-up: ${mismatches.length}`);

  if (mismatches.length > 0) {
    console.log('\nfirst 25:');
    for (const m of mismatches.slice(0, 25)) {
      console.log(
        `  ${m.paise} paise @ ${m.percent}%  exact ${m.expected}  got ${m.actual}  (off by ${BigInt(m.actual) - m.expected})`,
      );
    }
    const byPercent = new Map<string, number>();
    for (const m of mismatches) byPercent.set(m.percent, (byPercent.get(m.percent) ?? 0) + 1);
    console.log('\nby percentage:');
    for (const [p, n] of [...byPercent].sort((a, b) => b[1] - a[1])) console.log(`  ${p}% : ${n}`);
  }

  // ---- accumulation: does the drift compound across many rows? ----
  console.log('\n--- accumulation over 100,000 rows ---');
  for (const percent of ['0.33', '1.67', '2.5', '7.5']) {
    let sumImpl = 0n;
    let sumExact = 0n;
    for (let i = 0; i < 100_000; i += 1) {
      const paise = 10_000 + i * 7; // sweeps every rounding boundary
      sumImpl += BigInt(percentOfPaise(paise, Number(percent)));
      sumExact += exactPercent(paise, percent);
    }
    const drift = sumImpl - sumExact;
    console.log(`  ${percent}% : implementation ${sumImpl}  exact ${sumExact}  drift ${drift} paise`);
  }

  process.exit(mismatches.length === 0 ? 0 : 1);
}

main();
