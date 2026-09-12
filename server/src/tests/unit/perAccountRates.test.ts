/**
 * Whose rate applies, and what happens when the two sides disagree.
 *
 * Commission used to be one pair of percentages for everybody. Now a party can
 * be charged its own rate and a captain paid its own, with the settings figure
 * standing in for whoever has not been given one. That makes two things worth
 * pinning down that did not exist before: which of the three numbers wins, and
 * what the books do when a cheap party is served by a well-paid captain.
 */
import {
  commissionFor,
  partyRateFor,
  captainRateFor,
  repriceCaptainShare,
} from '../../services/commission.service';
import { rupeesToPaise, paiseToRupees } from '../../utils/money';

/** The settings defaults: 3% charged, 1% paid, both directions. */
const config = {
  payInPartyCommissionPercentage: 3,
  payInCaptainCommissionPercentage: 1,
  payOutPartyCommissionPercentage: 3,
  payOutCaptainCommissionPercentage: 1,
  version: 7,
};

describe('which rate applies', () => {
  it('uses the settings default when the account has none of its own', () => {
    expect(partyRateFor('PAY_IN', config, {})).toBe(3);
    expect(captainRateFor('PAY_IN', config, {})).toBe(1);
  });

  it('uses the account’s own rate when admin has set one', () => {
    expect(partyRateFor('PAY_IN', config, { payInPartyCommissionPercentage: 5 })).toBe(5);
    expect(captainRateFor('PAY_IN', config, { payInCaptainCommissionPercentage: 2 })).toBe(2);
  });

  it('treats zero as a decision, not as an absent one', () => {
    // The distinction the whole resolution turns on. A party promised free
    // service is stored as 0, and `?? ` would read that as "nothing set" and
    // bill them the default the moment anyone looked.
    expect(partyRateFor('PAY_OUT', config, { payOutPartyCommissionPercentage: 0 })).toBe(0);
    expect(captainRateFor('PAY_OUT', config, { payOutCaptainCommissionPercentage: 0 })).toBe(0);
  });

  it('keeps the two directions apart', () => {
    // A party charged 5% on money coming in and 2% on money going out is an
    // ordinary arrangement, not a contradiction.
    const party = { payInPartyCommissionPercentage: 5, payOutPartyCommissionPercentage: 2 };
    expect(partyRateFor('PAY_IN', config, party)).toBe(5);
    expect(partyRateFor('PAY_OUT', config, party)).toBe(2);
  });

  it('falls back per direction, not per account', () => {
    // An override on one direction only leaves the other on the default,
    // rather than dragging it along.
    const captain = { payOutCaptainCommissionPercentage: 4 };
    expect(captainRateFor('PAY_OUT', config, captain)).toBe(4);
    expect(captainRateFor('PAY_IN', config, captain)).toBe(1);
  });

  it('ignores a missing account entirely', () => {
    expect(partyRateFor('PAY_IN', config, null)).toBe(3);
    expect(captainRateFor('PAY_IN', config, undefined)).toBe(1);
  });
});

describe('what the two sides cost together', () => {
  const AMOUNT = rupeesToPaise(10_000);

  it('charges the party their rate and pays the captain theirs', () => {
    // The client's example: Party A on 5%, Captain A on 2%.
    const split = commissionFor('PAY_IN', AMOUNT, config, {
      party: { payInPartyCommissionPercentage: 5 },
      captain: { payInCaptainCommissionPercentage: 2 },
    });

    expect(paiseToRupees(split.partyPaise)).toBe(500);
    expect(paiseToRupees(split.captainPaise)).toBe(200);
    expect(paiseToRupees(split.platformPaise)).toBe(300);
    expect(split.partyRate).toBe(5);
    expect(split.captainRate).toBe(2);
  });

  it('mixes an overridden side with a defaulted one', () => {
    // Party B on 2%, captain on the 1% default.
    const split = commissionFor('PAY_IN', AMOUNT, config, {
      party: { payInPartyCommissionPercentage: 2 },
    });

    expect(paiseToRupees(split.partyPaise)).toBe(200);
    expect(paiseToRupees(split.captainPaise)).toBe(100);
    expect(paiseToRupees(split.platformPaise)).toBe(100);
  });

  it('never pays a captain more than their party was charged', () => {
    /**
     * The case per-account rates make ordinary rather than exceptional: a
     * party on 2% served by a captain on 5%. The captain's 500 is capped at
     * the 200 the pool actually received, and the platform takes nothing
     * rather than funding the difference out of DMC that does not exist.
     */
    const split = commissionFor('PAY_OUT', AMOUNT, config, {
      party: { payOutPartyCommissionPercentage: 2 },
      captain: { payOutCaptainCommissionPercentage: 5 },
    });

    expect(paiseToRupees(split.partyPaise)).toBe(200);
    expect(paiseToRupees(split.captainPaise)).toBe(200);
    expect(paiseToRupees(split.platformPaise)).toBe(0);
  });

  it('always adds up, whatever the two rates are', () => {
    for (const partyRate of [0, 0.33, 1, 2.5, 7, 100]) {
      for (const captainRate of [0, 0.25, 1, 5, 100]) {
        for (const amount of [1, 999, rupeesToPaise(1_234.56), rupeesToPaise(99_999)]) {
          const split = commissionFor('PAY_IN', amount, config, {
            party: { payInPartyCommissionPercentage: partyRate },
            captain: { payInCaptainCommissionPercentage: captainRate },
          });
          expect(split.captainPaise + split.platformPaise).toBe(split.partyPaise);
          expect(split.captainPaise).toBeGreaterThanOrEqual(0);
          expect(split.platformPaise).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('re-pricing once the captain is known', () => {
  const AMOUNT = rupeesToPaise(10_000);

  it('divides the pool at the captain’s own rate', () => {
    // The party was charged 5% and has paid it. A 2% captain takes 200 of the
    // 500, and the platform keeps 300.
    const priced = repriceCaptainShare(rupeesToPaise(500), AMOUNT, 2, 5);

    expect(paiseToRupees(priced.captainPaise)).toBe(200);
    expect(paiseToRupees(priced.platformPaise)).toBe(300);
  });

  it('never moves the total, only the split', () => {
    // The invariant the refund path depends on: whatever re-pricing does, the
    // captain's share and the platform's still sum to what the party paid, so
    // a cancellation gives back exactly what it took.
    const pool = rupeesToPaise(500);
    for (const rate of [0, 0.5, 1, 2, 4.9, 5, 9, 100]) {
      const priced = repriceCaptainShare(pool, AMOUNT, rate, 5);
      expect(priced.captainPaise + priced.platformPaise).toBe(pool);
    }
  });

  it('caps the captain at the pool rather than inventing DMC', () => {
    const priced = repriceCaptainShare(rupeesToPaise(200), AMOUNT, 5, 2);

    expect(paiseToRupees(priced.captainPaise)).toBe(200);
    expect(paiseToRupees(priced.platformPaise)).toBe(0);
  });

  it('gives everything to the platform when the captain earns nothing', () => {
    const priced = repriceCaptainShare(rupeesToPaise(500), AMOUNT, 0, 5);

    expect(priced.captainPaise).toBe(0);
    expect(paiseToRupees(priced.platformPaise)).toBe(500);
  });
});

describe('what a capped payment says it was paid at', () => {
  /**
   * The cap was always safe with the money. What it was not was honest about
   * it: the rate written to the row was the one admin agreed with the captain,
   * while the amount paid was the party's smaller charge. The captain's ledger
   * then showed "6%" beside an amount that was five percent of the payment,
   * which reads as a shortfall rather than as a cap.
   */
  const AMOUNT = rupeesToPaise(10_000);
  const capped = () =>
    commissionFor('PAY_OUT', AMOUNT, config, {
      party: { payOutPartyCommissionPercentage: 5 },
      captain: { payOutCaptainCommissionPercentage: 6 },
    });

  it('names the rate the captain was actually paid at', () => {
    const split = capped();

    // 500 paid on 10,000 is five percent, and that is what the row must say.
    expect(paiseToRupees(split.captainPaise)).toBe(500);
    expect(split.captainRate).toBe(5);
  });

  it('keeps the rate that was agreed, so a dispute can be answered', () => {
    const split = capped();

    expect(split.captainRateAgreed).toBe(6);
    expect(split.capped).toBe(true);
  });

  it('says the two are the same when nothing was capped', () => {
    const split = commissionFor('PAY_OUT', AMOUNT, config, {
      party: { payOutPartyCommissionPercentage: 7 },
      captain: { payOutCaptainCommissionPercentage: 6 },
    });

    expect(split.captainRate).toBe(6);
    expect(split.captainRateAgreed).toBe(6);
    expect(split.capped).toBe(false);
  });

  it('does not call it capped when the rates are simply equal', () => {
    // Equal rates pay the whole charge to the captain, which is the cap's
    // boundary but not the cap biting — nothing was withheld.
    const split = commissionFor('PAY_IN', AMOUNT, config, {
      party: { payInPartyCommissionPercentage: 4 },
      captain: { payInCaptainCommissionPercentage: 4 },
    });

    expect(split.capped).toBe(false);
    expect(split.captainRate).toBe(4);
  });

  it('reports the paid rate on the client’s exact pair, both directions', () => {
    // Party 3/5, captain 4/6 — the pair the client asked about.
    const accounts = {
      party: { payInPartyCommissionPercentage: 3, payOutPartyCommissionPercentage: 5 },
      captain: { payInCaptainCommissionPercentage: 4, payOutCaptainCommissionPercentage: 6 },
    };

    const payIn = commissionFor('PAY_IN', AMOUNT, config, accounts);
    expect(paiseToRupees(payIn.captainPaise)).toBe(300);
    expect(payIn.captainRate).toBe(3);
    expect(payIn.captainRateAgreed).toBe(4);
    expect(payIn.capped).toBe(true);

    const payOut = commissionFor('PAY_OUT', AMOUNT, config, accounts);
    expect(paiseToRupees(payOut.captainPaise)).toBe(500);
    expect(payOut.captainRate).toBe(5);
    expect(payOut.captainRateAgreed).toBe(6);
    expect(payOut.capped).toBe(true);
  });

  it('carries the same two numbers through re-pricing', () => {
    // Re-pricing is where a real claim decides the captain's half, so it has
    // to answer the question the same way the creation-time split does.
    const priced = repriceCaptainShare(rupeesToPaise(500), AMOUNT, 6, 5);

    expect(paiseToRupees(priced.captainPaise)).toBe(500);
    expect(priced.captainRate).toBe(5);
    expect(priced.captainRateAgreed).toBe(6);
    expect(priced.capped).toBe(true);
  });
});
