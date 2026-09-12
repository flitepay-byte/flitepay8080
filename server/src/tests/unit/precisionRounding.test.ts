/**
 * MONEY IS INTEGER PAISE, AT EVERY AMOUNT AND EVERY RATE
 *
 * Commission is a percentage, and a percentage of an integer is usually not
 * one. Every rate applied to every amount is therefore a rounding decision,
 * and the only safe answer is a whole number of paise that still adds up: what
 * the party is charged must equal what the captain is paid plus what the
 * platform keeps, exactly, with nothing lost to a half-paise.
 *
 * These cases walk the awkward amounts rather than the round ones — 1, 3, 7,
 * 99, 101, 999, 1001, 1234, 8100, 9999 — because a bug in money arithmetic
 * never shows at 10,000. It shows at 101 with 2.5% on it, where the exact
 * answer is 2.525 paise and something has to decide.
 *
 * Two properties are asserted of every combination:
 *
 *   1. Every figure is an integer number of paise. A float that reaches a
 *      balance is a balance that can never be reconciled again.
 *   2. The three figures close: party charge = captain share + platform share.
 *      The platform's cut is the remainder by subtraction and is never its own
 *      percentage, so this is the identity the whole split rests on.
 *
 * The captain's share is additionally capped at the party's charge. When the
 * captain's agreed rate is higher than the party's, the pool cannot pay it —
 * so the captain is paid the party's rate and the platform keeps nothing,
 * rather than the platform funding the difference out of nowhere.
 */
import { commissionFor, type RateConfig } from '../../services/commission.service';
import { rupeesToPaise, percentOfPaise } from '../../utils/money';

/** The amounts named as awkward, in rupees. */
const AMOUNTS = [1, 2, 3, 7, 10, 99, 100, 101, 999, 1_000, 1_001, 1_234, 5_000, 8_100, 9_999, 10_000];

/** Rates that produce fractions at those amounts, whole ones included. */
const RATES = [0, 1, 2, 2.5, 3, 3.33, 5, 7.5, 10];

const config = (partyRate: number, captainRate: number): RateConfig => ({
  payInPartyCommissionPercentage: partyRate,
  payInCaptainCommissionPercentage: captainRate,
  payOutPartyCommissionPercentage: partyRate,
  payOutCaptainCommissionPercentage: captainRate,
  version: 1,
});

describe('commission is whole paise at every amount', () => {
  describe.each(['PAY_IN', 'PAY_OUT'] as const)('%s', (direction) => {
    it.each(AMOUNTS)('DMC %s splits into integers that close', (rupees) => {
      const amount = rupeesToPaise(rupees);
      // Party 5%, captain 3%: the ordinary case, where the platform keeps 2%.
      const split = commissionFor(direction, amount, config(5, 3));

      expect(Number.isInteger(split.partyPaise)).toBe(true);
      expect(Number.isInteger(split.captainPaise)).toBe(true);
      expect(Number.isInteger(split.platformPaise)).toBe(true);
      // The identity the whole split rests on.
      expect(split.captainPaise + split.platformPaise).toBe(split.partyPaise);
    });
  });

  it.each(RATES)('a party rate of %s%% yields whole paise at every amount', (rate) => {
    for (const rupees of AMOUNTS) {
      const amount = rupeesToPaise(rupees);
      const split = commissionFor('PAY_OUT', amount, config(rate, 0));
      expect(Number.isInteger(split.partyPaise)).toBe(true);
      // With nothing paid out, the platform keeps the whole charge.
      expect(split.platformPaise).toBe(split.partyPaise);
      expect(split.captainPaise).toBe(0);
    }
  });

  it.each(RATES)('a captain rate of %s%% never exceeds the pool it is paid from', (rate) => {
    for (const rupees of AMOUNTS) {
      const amount = rupeesToPaise(rupees);
      // Party charges 2%; the captain's agreed rate varies above and below it.
      const split = commissionFor('PAY_OUT', amount, config(2, rate));
      expect(split.captainPaise).toBeLessThanOrEqual(split.partyPaise);
      expect(split.platformPaise).toBeGreaterThanOrEqual(0);
      expect(split.captainPaise + split.platformPaise).toBe(split.partyPaise);
    }
  });

  it.each(AMOUNTS)('DMC %s: a captain rate above the party rate is capped, not funded', (rupees) => {
    const amount = rupeesToPaise(rupees);
    // The case that used to let a captain be paid more than was collected.
    const split = commissionFor('PAY_OUT', amount, config(5, 6));

    expect(split.captainPaise).toBe(split.partyPaise);
    expect(split.platformPaise).toBe(0);
    expect(split.capped).toBe(true);
    // The rate recorded as paid is the party's, not the one agreed.
    expect(split.captainRate).toBe(5);
    expect(split.captainRateAgreed).toBe(6);
  });

  it.each(AMOUNTS)('DMC %s: equal rates leave the platform exactly nothing', (rupees) => {
    const amount = rupeesToPaise(rupees);
    const split = commissionFor('PAY_OUT', amount, config(3, 3));
    expect(split.captainPaise).toBe(split.partyPaise);
    expect(split.platformPaise).toBe(0);
    expect(split.capped).toBe(false);
  });
});

describe('percentOfPaise rounds without drifting', () => {
  it.each(AMOUNTS)('DMC %s never produces a fraction of a paise', (rupees) => {
    const amount = rupeesToPaise(rupees);
    for (const rate of RATES) {
      expect(Number.isInteger(percentOfPaise(amount, rate))).toBe(true);
    }
  });

  it('is exact on the halves that binary floats get wrong', () => {
    // 0.1 + 0.2 arithmetic reaches money code as amount × percent / 100. These
    // are the cases where the exact answer sits on a half-paise boundary.
    expect(percentOfPaise(10_050, 2.5)).toBe(251); // 251.25 -> 251
    expect(percentOfPaise(10_100, 2.5)).toBe(253); // 252.50 -> 253, away from zero
    expect(percentOfPaise(1, 50)).toBe(1); // 0.5 -> 1
    expect(percentOfPaise(3, 50)).toBe(2); // 1.5 -> 2
  });

  it('treats zero as zero rather than as a rounding problem', () => {
    expect(percentOfPaise(0, 5)).toBe(0);
    expect(percentOfPaise(999_999, 0)).toBe(0);
  });

  it('refuses a non-integer amount rather than rounding it silently', () => {
    expect(() => percentOfPaise(100.5, 5)).toThrow();
  });

  it('refuses a negative rate', () => {
    expect(() => percentOfPaise(100, -1)).toThrow();
  });
});
