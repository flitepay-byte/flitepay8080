import {
  computeRating,
  computeSuccessRate,
  computeOnTimeRate,
  computeBadges,
  type RatingInputs,
} from '../../services/captainRating.service';

const EMPTY: RatingInputs = {
  totalTasksCompleted: 0,
  totalTasksOnTime: 0,
  totalTasksExpired: 0,
  totalProofsRejected: 0,
  totalRejectionsUpheldByAdmin: 0,
  totalOffersMissed: 0,
};

const inputs = (over: Partial<RatingInputs>): RatingInputs => ({ ...EMPTY, ...over });

describe('captain rating', () => {
  describe('success rate', () => {
    it('is zero with no finished work rather than dividing by zero', () => {
      expect(computeSuccessRate(EMPTY)).toBe(0);
    });

    it('counts only finished work — a missed offer is not a failed task', () => {
      const withMissedOffers = inputs({ totalTasksCompleted: 10, totalOffersMissed: 50 });
      expect(computeSuccessRate(withMissedOffers)).toBe(1);
    });

    it('splits completions against every way a task can end badly', () => {
      const mixed = inputs({
        totalTasksCompleted: 6,
        totalTasksExpired: 2,
        totalProofsRejected: 2,
      });
      expect(computeSuccessRate(mixed)).toBe(0.6);
    });
  });

  describe('on-time rate', () => {
    it('is zero before there is anything to be on time for', () => {
      expect(computeOnTimeRate(EMPTY)).toBe(0);
    });

    it('cannot exceed 1 even if the counters disagree', () => {
      expect(computeOnTimeRate(inputs({ totalTasksCompleted: 2, totalTasksOnTime: 5 }))).toBe(1);
    });
  });

  describe('rating', () => {
    it('starts a captain with no history at the neutral prior', () => {
      expect(computeRating(EMPTY)).toBe(3.5);
    });

    it('does not hand a perfect score to a captain with one good task', () => {
      const rookie = computeRating(inputs({ totalTasksCompleted: 1, totalTasksOnTime: 1 }));
      expect(rookie).toBeGreaterThan(3.5);
      expect(rookie).toBeLessThan(4.5);
    });

    it('converges upward as a clean record accumulates', () => {
      const few = computeRating(inputs({ totalTasksCompleted: 5, totalTasksOnTime: 5 }));
      const many = computeRating(inputs({ totalTasksCompleted: 100, totalTasksOnTime: 100 }));
      expect(many).toBeGreaterThan(few);
      expect(many).toBeGreaterThan(4.7);
      expect(many).toBeLessThanOrEqual(5);
    });

    it('punishes an admin-upheld rejection harder than a party-only rejection', () => {
      const partyOnly = computeRating(inputs({ totalTasksCompleted: 20, totalProofsRejected: 4 }));
      const upheld = computeRating(
        inputs({ totalTasksCompleted: 20, totalProofsRejected: 4, totalRejectionsUpheldByAdmin: 4 }),
      );
      expect(upheld).toBeLessThan(partyOnly);
    });

    it('does not double-charge a rejection that admin upheld', () => {
      // All four rejections were upheld, so none should also be counted as a
      // plain rejection on top.
      const upheld = computeRating(
        inputs({ totalTasksCompleted: 20, totalProofsRejected: 4, totalRejectionsUpheldByAdmin: 4 }),
      );
      // Same captain, but the counters claim more upheld than were ever
      // rejected — the surplus is clamped rather than charged twice.
      const overclaimed = computeRating(
        inputs({ totalTasksCompleted: 20, totalProofsRejected: 4, totalRejectionsUpheldByAdmin: 9 }),
      );
      expect(overclaimed).toBe(upheld);
    });

    it('treats a missed offer as a much lighter matter than an expired task', () => {
      const missedOffers = computeRating(inputs({ totalTasksCompleted: 20, totalOffersMissed: 5 }));
      const expiredTasks = computeRating(inputs({ totalTasksCompleted: 20, totalTasksExpired: 5 }));
      expect(missedOffers).toBeGreaterThan(expiredTasks);
    });

    it('rewards punctuality among otherwise identical records', () => {
      const punctual = computeRating(inputs({ totalTasksCompleted: 30, totalTasksOnTime: 30 }));
      const late = computeRating(inputs({ totalTasksCompleted: 30, totalTasksOnTime: 0 }));
      expect(punctual).toBeGreaterThan(late);
    });

    it('stays inside 0..5 even for a uniformly terrible record', () => {
      const awful = computeRating(
        inputs({
          totalTasksCompleted: 0,
          totalTasksExpired: 40,
          totalProofsRejected: 40,
          totalRejectionsUpheldByAdmin: 40,
          totalOffersMissed: 40,
        }),
      );
      expect(awful).toBeGreaterThanOrEqual(0);
      expect(awful).toBeLessThan(1);
    });
  });

  describe('badges', () => {
    const captain = (over: Partial<Parameters<typeof computeBadges>[0]>): Parameters<typeof computeBadges>[0] =>
      ({
        rating: 3.5,
        totalTasksCompleted: 0,
        totalTasksOnTime: 0,
        totalTasksExpired: 0,
        totalProofsRejected: 0,
        totalRejectionsUpheldByAdmin: 0,
        totalOffersMissed: 0,
        totalOffersAccepted: 0,
        totalAcceptSeconds: 0,
        ...over,
      }) as Parameters<typeof computeBadges>[0];

    const codes = (c: Parameters<typeof computeBadges>[0]): string[] => computeBadges(c).map((b) => b.code);

    it('marks a captain with almost no history as New', () => {
      expect(codes(captain({ totalTasksCompleted: 2 }))).toContain('NEW');
    });

    it('withholds Top rated until there is enough history behind the score', () => {
      expect(codes(captain({ rating: 4.9, totalTasksCompleted: 3 }))).not.toContain('TOP_RATED');
      expect(codes(captain({ rating: 4.9, totalTasksCompleted: 30 }))).toContain('TOP_RATED');
    });

    it('awards On time only at a sustained 90%', () => {
      expect(codes(captain({ totalTasksCompleted: 20, totalTasksOnTime: 17 }))).not.toContain('ON_TIME');
      expect(codes(captain({ totalTasksCompleted: 20, totalTasksOnTime: 19 }))).toContain('ON_TIME');
    });

    it('awards Reliable on a 95% success rate over enough tasks', () => {
      expect(codes(captain({ totalTasksCompleted: 39, totalProofsRejected: 1 }))).toContain('RELIABLE');
      expect(codes(captain({ totalTasksCompleted: 30, totalProofsRejected: 10 }))).not.toContain('RELIABLE');
    });

    it('awards Fast responder on mean accept time, not on a single quick answer', () => {
      expect(codes(captain({ totalOffersAccepted: 2, totalAcceptSeconds: 10 }))).not.toContain('FAST_RESPONDER');
      expect(codes(captain({ totalOffersAccepted: 20, totalAcceptSeconds: 600 }))).toContain('FAST_RESPONDER');
      expect(codes(captain({ totalOffersAccepted: 20, totalAcceptSeconds: 4000 }))).not.toContain('FAST_RESPONDER');
    });

    it('awards Veteran at a hundred completions', () => {
      expect(codes(captain({ totalTasksCompleted: 120 }))).toContain('VETERAN');
    });
  });
});
