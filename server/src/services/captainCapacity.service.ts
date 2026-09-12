/**
 * CURRENT LIMIT — how much more work a captain may take on.
 *
 * The ceiling admin approved, and the captain's own capital, whichever binds
 * first. Commission they have already earned is subtracted: it is theirs to
 * keep, and it is not capacity. A captain holding 8,150 of DMC of which 150 is
 * earned fees may take on 8,000, not 8,150.
 *
 * This module exists because that rule was written twice — once in the
 * serializer, to show the captain a number, and once in each claim guard, to
 * decide whether to allow a claim. The two were free to disagree, and did: the
 * guards asked "do they hold this much DMC" and "is this within the ceiling"
 * and never subtracted the commission, so a captain could claim work their own
 * dashboard had already told them was beyond them.
 *
 *     Available DMC 8,150 · Current Limit 8,000 · claim 8,100  ->  allowed
 *
 * So the rule is stated once here, in two forms of the same thing: a number
 * for anything that reads, and a query fragment for the conditional writes
 * that decide. Changing one changes both, which is the only way they stay
 * honest with each other.
 */

/** Everything Current Limit is derived from, and nothing else. */
export interface CapacityFields {
  /** Admin's ceiling, or null when the posted security is the ceiling. */
  creditLimitPaise?: number | null;
  collateralBalancePaise: number;
  dmcBalancePaise: number;
  /** Earned fees — part of the balance, but never part of capacity. */
  commissionEarnedTotalPaise?: number | null;
}

/** The ceiling on any single claim: admin's override, else the security posted. */
export function ceilingPaise(captain: CapacityFields): number {
  return captain.creditLimitPaise ?? captain.collateralBalancePaise;
}

/**
 * What this captain may still take on, in paise.
 *
 * Floored at zero so a captain whose earnings exceed their working capital
 * reads as "nothing more", rather than as a negative number that no screen
 * knows how to say.
 */
export function currentLimitPaise(captain: CapacityFields): number {
  const capital = captain.dmcBalancePaise - (captain.commissionEarnedTotalPaise ?? 0);
  return Math.max(0, Math.min(ceilingPaise(captain), capital));
}

/**
 * The same rule as a Mongo filter, for the conditional write that takes a claim.
 *
 * Written as two comparisons rather than one `min`, because `min(a, b) >= n` is
 * exactly `a >= n and b >= n` — and expressing it this way lets the server
 * evaluate it against the stored document at write time. That is what makes it
 * safe against a race: two claims arriving together are serialised by the two
 * writes, and the second sees the balance the first already reduced.
 *
 * The zero floor in `currentLimitPaise` needs no counterpart here. An amount is
 * always positive, so where the floor would bite, both comparisons fail anyway.
 *
 * A separate `dmcBalancePaise >= amount` check is not needed either, and is
 * deliberately not added: earned commission is never negative, so the second
 * comparison already implies it. Two overlapping rules is how the displayed
 * figure and the enforced one drifted apart in the first place.
 */
export function withinCurrentLimit(amountPaise: number): Record<string, unknown> {
  return {
    $expr: {
      $and: [
        { $lte: [amountPaise, { $ifNull: ['$creditLimitPaise', '$collateralBalancePaise'] }] },
        {
          $lte: [
            amountPaise,
            { $subtract: ['$dmcBalancePaise', { $ifNull: ['$commissionEarnedTotalPaise', 0] }] },
          ],
        },
      ],
    },
  };
}
