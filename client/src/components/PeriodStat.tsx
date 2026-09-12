import { Money, cn } from '@/components/primitives';

/**
 * A figure over a chosen period, and the control that chooses it.
 *
 * Today, the last seven days and this month used to be rendered side by side,
 * three at a time, on every panel that had them. Three panels of three windows
 * is nine figures competing for one glance, and almost all of them are being
 * scrolled past — so the period becomes a choice, and one figure is shown at a
 * time.
 *
 * The selector is deliberately separate from the figure. A screen usually has
 * several of these panels — pay-in beside pay-out — and if each carried its own
 * control they would drift out of step, leaving one showing today beside
 * another showing the month, which is the one arrangement in which the two
 * cannot be compared. So the page owns the period and every panel on it reads
 * the same one.
 *
 * Nothing here computes anything. The buckets arrive already worked out by the
 * server, which is also where the windows are defined — IST days, and a seven
 * day window that ends today rather than yesterday. This only decides which of
 * the numbers already sent is the one on screen.
 */
export interface PeriodBucket {
  count: number;
  amount: number;
}

/** The shape every one of these endpoints already returns. */
export interface PeriodTotals {
  total: PeriodBucket;
  today: PeriodBucket;
  last7Days: PeriodBucket;
  thisMonth: PeriodBucket;
}

export type Period = 'today' | 'last7Days' | 'thisMonth';

/** One vocabulary for these three windows, so no screen invents its own. */
export const PERIODS: Array<{ key: Period; label: string; short: string }> = [
  { key: 'today', label: 'Today', short: 'Today' },
  { key: 'last7Days', label: 'Last 7 days', short: '7 days' },
  { key: 'thisMonth', label: 'This month', short: 'Month' },
];

/** Today, because the question these screens are opened with is "what today". */
export const DEFAULT_PERIOD: Period = 'today';

export function periodLabel(period: Period): string {
  return PERIODS.find((p) => p.key === period)?.label ?? period;
}

/**
 * The control. Rendered once per screen, above whatever it governs.
 *
 * Buttons rather than a select: there are three options, they are always the
 * same three, and a dropdown would hide two of them behind a click to save
 * space it does not need to save.
 */
export function PeriodSelector({
  value,
  onChange,
  className,
}: {
  value: Period;
  onChange: (period: Period) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Period"
      className={cn(
        'inline-flex shrink-0 rounded-md border border-ink-700 bg-ink-850 p-0.5',
        className,
      )}
    >
      {PERIODS.map((p) => {
        const active = p.key === value;
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange(p.key)}
            aria-pressed={active}
            // The full label where there is room, the short one where there is
            // not — the same button either way, so the layout changes and the
            // control does not.
            className={cn(
              'rounded px-2.5 py-1 text-2xs font-medium transition-colors',
              active ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200',
            )}
          >
            <span className="hidden sm:inline">{p.label}</span>
            <span className="sm:hidden">{p.short}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The figure itself, for whichever period the page has selected.
 *
 * All-time stays underneath rather than becoming a fourth option. It answers a
 * different question — "how much has this ever been" against "how much lately"
 * — and it is the one figure somebody checks without having chosen anything.
 */
export function PeriodStat({
  data,
  period,
  tone = 'text-ink-50',
}: {
  data: PeriodTotals | undefined;
  period: Period;
  tone?: string;
}) {
  const bucket = data?.[period];
  const count = bucket?.count ?? 0;
  const allTime = data?.total.count ?? 0;

  return (
    <div>
      <p className={cn('font-display text-2xl font-semibold tnum', tone)}>
        <Money amount={bucket?.amount ?? 0} showUsdt={false} />
      </p>
      <p className="mt-0.5 text-2xs text-ink-500">
        {count.toLocaleString('en-IN')} {count === 1 ? 'payment' : 'payments'} ·{' '}
        {periodLabel(period).toLowerCase()}
      </p>

      <p className="mt-3 border-t border-ink-800 pt-2.5 text-2xs text-ink-500">
        All time{' '}
        <Money
          amount={data?.total.amount ?? 0}
          showUsdt={false}
          className="text-2xs font-semibold text-ink-300"
        />{' '}
        · {allTime.toLocaleString('en-IN')} {allTime === 1 ? 'payment' : 'payments'}
      </p>
    </div>
  );
}
