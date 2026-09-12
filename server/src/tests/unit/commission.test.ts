/**
 * The commission split, as a pure function.
 *
 * `commissionSplit.test.ts` proves the money actually moves this way against a
 * database. This file proves the arithmetic itself, which is where the edges
 * live: rounding, zero rates, and a pair of settings that contradict each
 * other. Those are cheap to enumerate here and expensive to set up there.
 *
 * There used to be a different engine behind this name — a captain rate and a
 * platform rate, each of which could be a flat amount or a percentage, with
 * per-party overrides on both. Six settings, and no screen could answer "what
 * does this payment cost" without evaluating all of them. What is tested here
 * is what replaced it: the party is charged one rate, the captain is paid a
 * share of that charge, and the platform keeps the difference.
 */
import { commissionFor } from '../../services/commission.service';
import { rupeesToPaise } from '../../utils/money';

const rates = (
  payOutParty: number,
  payOutCaptain: number,
  payInParty = 0,
  payInCaptain = 0,
): Parameters<typeof commissionFor>[2] => ({
  payInPartyCommissionPercentage: payInParty,
  payInCaptainCommissionPercentage: payInCaptain,
  payOutPartyCommissionPercentage: payOutParty,
  payOutCaptainCommissionPercentage: payOutCaptain,
  version: 1,
});

describe('what a payment costs and what it pays', () => {
  it('charges the party its rate and pays the captain their share of it', () => {
    // ₹5,000 at 7% charged and 5% paid: 350 in, 250 out, 100 kept.
    const split = commissionFor('PAY_OUT', rupeesToPaise(5_000), rates(7, 5));
    expect(split.partyPaise).toBe(rupeesToPaise(350));
    expect(split.captainPaise).toBe(rupeesToPaise(250));
    expect(split.platformPaise).toBe(rupeesToPaise(100));
  });

  it('always has the two halves add back to the charge', () => {
    // The property that matters more than any single figure: the platform's
    // cut is computed by subtraction, so no paise can be lost between them.
    for (const amount of [1, 7, 99, 1_234, 99_999, 1_000_000]) {
      const pairs: Array<[number, number]> = [[7, 5], [3, 1], [0.33, 0.25], [12.5, 9], [2, 2]];
      for (const [party, captain] of pairs) {
        const split = commissionFor('PAY_OUT', amount, rates(party, captain));
        expect(split.captainPaise + split.platformPaise).toBe(split.partyPaise);
      }
    }
  });

  it('reads the rates for the direction it was asked about', () => {
    const config = rates(7, 5, 3, 1);
    const out = commissionFor('PAY_OUT', rupeesToPaise(1_000), config);
    const inn = commissionFor('PAY_IN', rupeesToPaise(1_000), config);

    // A pay-in costs the captain only their float; a pay-out costs them the
    // effort of actually sending money. They are priced apart on purpose.
    expect(out.partyPaise).toBe(rupeesToPaise(70));
    expect(out.captainPaise).toBe(rupeesToPaise(50));
    expect(inn.partyPaise).toBe(rupeesToPaise(30));
    expect(inn.captainPaise).toBe(rupeesToPaise(10));
  });

  it('reports the rates it used, so a row can record what it was priced at', () => {
    const split = commissionFor('PAY_OUT', rupeesToPaise(1_000), rates(7, 5));
    expect(split.partyRate).toBe(7);
    expect(split.captainRate).toBe(5);
    expect(split.configVersion).toBe(1);
  });

  it('charges nothing at all when both rates are zero', () => {
    const split = commissionFor('PAY_OUT', rupeesToPaise(9_999), rates(0, 0));
    expect(split.partyPaise).toBe(0);
    expect(split.captainPaise).toBe(0);
    expect(split.platformPaise).toBe(0);
  });

  it('lets the platform keep the whole charge, paying the captain nothing', () => {
    const split = commissionFor('PAY_OUT', rupeesToPaise(1_000), rates(7, 0));
    expect(split.partyPaise).toBe(rupeesToPaise(70));
    expect(split.captainPaise).toBe(0);
    expect(split.platformPaise).toBe(rupeesToPaise(70));
  });

  it('lets the captain take the whole charge, leaving the platform nothing', () => {
    const split = commissionFor('PAY_OUT', rupeesToPaise(1_000), rates(5, 5));
    expect(split.captainPaise).toBe(rupeesToPaise(50));
    expect(split.platformPaise).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The misconfiguration that would otherwise invent money
  // -------------------------------------------------------------------------

  it('never promises the captain more than the party was charged', () => {
    // 2% charged, 9% promised. Without the cap the pool would owe 90 against
    // the 20 it received, and the shortfall would have to come from somewhere
    // the books do not model. Capping turns a bad setting into a visibly
    // smaller fee rather than into DMC appearing from nowhere.
    const split = commissionFor('PAY_OUT', rupeesToPaise(1_000), rates(2, 9));
    expect(split.partyPaise).toBe(rupeesToPaise(20));
    expect(split.captainPaise).toBe(rupeesToPaise(20));
    expect(split.platformPaise).toBe(0);
  });

  it('keeps the platform’s cut at zero rather than negative when capped', () => {
    for (const amount of [1, 13, 777, 250_000]) {
      const split = commissionFor('PAY_OUT', amount, rates(1, 50));
      expect(split.platformPaise).toBe(0);
      expect(split.captainPaise).toBe(split.partyPaise);
    }
  });

  // -------------------------------------------------------------------------
  // Rounding
  // -------------------------------------------------------------------------

  it('produces whole paise on amounts that do not divide evenly', () => {
    const split = commissionFor('PAY_OUT', rupeesToPaise(333.33), rates(1.67, 0.33));
    expect(Number.isInteger(split.partyPaise)).toBe(true);
    expect(Number.isInteger(split.captainPaise)).toBe(true);
    expect(Number.isInteger(split.platformPaise)).toBe(true);
  });

  it('never charges a negative amount, however small the payment', () => {
    for (const amount of [1, 2, 3, 49, 50, 51]) {
      const split = commissionFor('PAY_OUT', amount, rates(0.33, 0.25));
      expect(split.partyPaise).toBeGreaterThanOrEqual(0);
      expect(split.captainPaise).toBeGreaterThanOrEqual(0);
      expect(split.platformPaise).toBeGreaterThanOrEqual(0);
    }
  });
});
