import { rupeesToPaise, paiseToRupees, percentOfPaise, formatPaise, MoneyError } from '../../utils/money';

describe('money', () => {
  describe('rupeesToPaise', () => {
    it('converts whole rupees', () => {
      expect(rupeesToPaise(10000)).toBe(1_000_000);
      expect(rupeesToPaise(1)).toBe(100);
      expect(rupeesToPaise(0)).toBe(0);
    });

    it('converts fractional rupees without float drift', () => {
      expect(rupeesToPaise('0.1')).toBe(10);
      expect(rupeesToPaise('0.01')).toBe(1);
      expect(rupeesToPaise('1234.56')).toBe(123_456);
      // 0.1 + 0.2 !== 0.3 in float; integers make this exact.
      expect(rupeesToPaise('0.1') + rupeesToPaise('0.2')).toBe(rupeesToPaise('0.3'));
    });

    it('pads a single decimal place correctly', () => {
      expect(rupeesToPaise('5.5')).toBe(550);
    });

    it('rejects sub-paise precision rather than silently rounding', () => {
      expect(() => rupeesToPaise('10.001')).toThrow(MoneyError);
    });

    it('rejects non-numeric input', () => {
      expect(() => rupeesToPaise('abc')).toThrow(MoneyError);
      expect(() => rupeesToPaise('')).toThrow(MoneyError);
      expect(() => rupeesToPaise('1e5')).toThrow(MoneyError);
    });
  });

  describe('percentOfPaise', () => {
    it('computes the specification examples exactly', () => {
      // ₹10,000 at 0.5% = ₹50
      expect(percentOfPaise(rupeesToPaise(10000), 0.5)).toBe(rupeesToPaise(50));
      // ₹5,000 at 0.5% = ₹25
      expect(percentOfPaise(rupeesToPaise(5000), 0.5)).toBe(rupeesToPaise(25));
    });

    it('rounds half-up to the nearest paise', () => {
      // 333 paise at 0.5% = 1.665 paise -> 2
      expect(percentOfPaise(333, 0.5)).toBe(2);
    });

    it('returns zero for a zero rate', () => {
      expect(percentOfPaise(rupeesToPaise(10000), 0)).toBe(0);
    });

    it('rejects a negative rate', () => {
      expect(() => percentOfPaise(1000, -1)).toThrow(MoneyError);
    });
  });

  describe('formatPaise', () => {
    it('formats using the Indian grouping convention', () => {
      expect(formatPaise(rupeesToPaise(50000))).toBe('DMC 50,000.00');
      expect(formatPaise(rupeesToPaise(1234567))).toBe('DMC 12,34,567.00');
      expect(formatPaise(5)).toBe('DMC 0.05');
    });

    it('handles negatives', () => {
      expect(formatPaise(-100)).toBe('-DMC 1.00');
    });
  });

  it('round-trips through paiseToRupees', () => {
    expect(paiseToRupees(rupeesToPaise('1234.56'))).toBe(1234.56);
  });
});
