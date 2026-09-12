import { Star, Clock, ShieldCheck, Zap, Award, Sparkles } from 'lucide-react';
import { cn } from '@/components/primitives';
import type { BadgeCode, CaptainBadge } from '@/types';

/**
 * A captain's rating and badges. Both come from the server
 * (captainRating.service.ts owns the formula); nothing is recomputed here, so
 * the number a captain sees is exactly the one routing used.
 */

export function RatingStars({ rating, className }: { rating: number; className?: string }) {
  const tone = rating >= 4.5 ? 'text-signal-green' : rating >= 3.5 ? 'text-signal-amber' : 'text-signal-red';
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Star className={cn('h-3.5 w-3.5 fill-current', tone)} />
      <span className={cn('font-mono tnum text-sm font-semibold', tone)}>{rating.toFixed(2)}</span>
      <span className="text-2xs text-ink-500">/ 5</span>
    </span>
  );
}

const BADGE_STYLE: Record<BadgeCode, { icon: typeof Star; tone: string }> = {
  TOP_RATED: { icon: Star, tone: 'bg-signal-green/10 text-signal-green' },
  ON_TIME: { icon: Clock, tone: 'bg-signal-cyan/10 text-signal-cyan' },
  RELIABLE: { icon: ShieldCheck, tone: 'bg-signal-green/10 text-signal-green' },
  FAST_RESPONDER: { icon: Zap, tone: 'bg-signal-amber/10 text-signal-amber' },
  VETERAN: { icon: Award, tone: 'bg-brand-500/10 text-brand-500' },
  NEW: { icon: Sparkles, tone: 'bg-ink-700/60 text-ink-300' },
};

export function BadgeRow({ badges, className }: { badges: CaptainBadge[]; className?: string }) {
  if (badges.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {badges.map((badge) => {
        const style = BADGE_STYLE[badge.code] ?? BADGE_STYLE.NEW;
        const Icon = style.icon;
        return (
          <span
            key={badge.code}
            title={badge.description}
            className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium', style.tone)}
          >
            <Icon className="h-3 w-3" />
            {badge.label}
          </span>
        );
      })}
    </div>
  );
}

/** Compact percentage, for the success/on-time figures shown beside a rating. */
export function RateStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p className="mt-0.5 font-mono tnum text-sm text-ink-100">{Math.round(value * 100)}%</p>
    </div>
  );
}
