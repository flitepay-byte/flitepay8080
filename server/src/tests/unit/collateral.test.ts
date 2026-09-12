import { computeAvailableLimit, canAfford, type CollateralView } from '../../services/collateral.service';
import { rupeesToPaise } from '../../utils/money';

function view(collateral: number, locked: number, creditLimit?: number): CollateralView {
  const collateralBalancePaise = rupeesToPaise(collateral);
  const lockedAmountPaise = rupeesToPaise(locked);
  const creditLimitPaise = creditLimit === undefined ? null : rupeesToPaise(creditLimit);
  return {
    collateralBalancePaise,
    lockedAmountPaise,
    creditLimitPaise,
    availableLimitPaise: computeAvailableLimit(collateralBalancePaise, lockedAmountPaise, creditLimitPaise),
  };
}

describe('collateral', () => {
  it('reproduces the specification worked example', () => {
    // Collateral ₹50,000, locked ₹18,000 -> available ₹32,000
    const before = view(50000, 18000);
    expect(before.availableLimitPaise).toBe(rupeesToPaise(32000));

    // A ₹10,000 task is within the available limit.
    expect(canAfford(before, rupeesToPaise(10000))).toBe(true);

    // After the claim: locked ₹28,000, available ₹22,000
    const after = view(50000, 28000);
    expect(after.lockedAmountPaise).toBe(rupeesToPaise(28000));
    expect(after.availableLimitPaise).toBe(rupeesToPaise(22000));
  });

  it('permits a task exactly equal to the available limit', () => {
    const v = view(50000, 18000);
    expect(canAfford(v, rupeesToPaise(32000))).toBe(true);
  });

  it('refuses a task one paise over the available limit', () => {
    const v = view(50000, 18000);
    expect(canAfford(v, rupeesToPaise(32000) + 1)).toBe(false);
  });

  it('refuses any task when fully locked', () => {
    const v = view(50000, 50000);
    expect(v.availableLimitPaise).toBe(0);
    expect(canAfford(v, 1)).toBe(false);
  });

  it('refuses every task for a captain with no collateral', () => {
    const v = view(0, 0);
    expect(canAfford(v, rupeesToPaise(1))).toBe(false);
  });

  it('derives the available limit rather than storing it', () => {
    // Changing either input immediately changes the derived value.
    expect(computeAvailableLimit(rupeesToPaise(50000), rupeesToPaise(0))).toBe(rupeesToPaise(50000));
    expect(computeAvailableLimit(rupeesToPaise(50000), rupeesToPaise(50000))).toBe(0);
  });

  describe('an admin-set credit limit', () => {
    it('stands in for the collateral as the ceiling', () => {
      // ₹50,000 posted, but admin trusts them with ₹80,000.
      const extended = view(50000, 0, 80000);
      expect(extended.availableLimitPaise).toBe(rupeesToPaise(80000));
      expect(canAfford(extended, rupeesToPaise(70000))).toBe(true);
    });

    it('leaves the collateral itself untouched', () => {
      // The whole point: a limit decision never moves the captain's money.
      const extended = view(50000, 0, 80000);
      const restricted = view(50000, 0, 20000);
      expect(extended.collateralBalancePaise).toBe(rupeesToPaise(50000));
      expect(restricted.collateralBalancePaise).toBe(rupeesToPaise(50000));
    });

    it('can pull a captain back below what they posted', () => {
      const restricted = view(50000, 0, 20000);
      expect(restricted.availableLimitPaise).toBe(rupeesToPaise(20000));
      expect(canAfford(restricted, rupeesToPaise(30000))).toBe(false);
    });

    it('still has locked work subtracted from it', () => {
      const extended = view(50000, 18000, 80000);
      expect(extended.availableLimitPaise).toBe(rupeesToPaise(62000));
    });

    it('falls back to the collateral when unset', () => {
      expect(view(50000, 18000).availableLimitPaise).toBe(view(50000, 18000, 50000).availableLimitPaise);
    });

    it('can be set to zero, which is not the same as unset', () => {
      // Zero is a real decision — this captain claims nothing for now.
      const frozen = view(50000, 0, 0);
      expect(frozen.availableLimitPaise).toBe(0);
      expect(canAfford(frozen, rupeesToPaise(1))).toBe(false);
      expect(frozen.collateralBalancePaise).toBe(rupeesToPaise(50000));
    });

    it('goes negative only in the sense that locked work already exceeds it', () => {
      // Admin cut the limit below what the captain is already holding. Nothing
      // new can be claimed, but the work in hand is untouched.
      const cut = view(50000, 30000, 20000);
      expect(cut.availableLimitPaise).toBe(rupeesToPaise(-10000));
      expect(canAfford(cut, rupeesToPaise(1))).toBe(false);
    });
  });
});
