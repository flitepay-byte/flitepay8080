import { useQuery } from '@tanstack/react-query';
import { Bell, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { Panel, Metric, Money } from '@/components/primitives';
import { RatingStars, BadgeRow, RateStat } from '@/components/Rating';
import { timeAgo } from './Queue';
import type { CaptainProfile } from '@/types';

interface DashboardSummary {
  activeCount: number;
  completedCount: number;
  conversionRate: number;
  totalTransactions: number;
  totalClaimedValue: number;
  todaysEarnings: number;
  totalEarned: number;
}

export function CaptainHome() {
  const { events } = useSocket();

  const profile = useQuery<CaptainProfile>({
    queryKey: ['captain-profile'],
    queryFn: () => api.get<CaptainProfile>('/captain/profile'),
  });

  const summary = useQuery<DashboardSummary>({
    queryKey: ['captain-dashboard'],
    queryFn: () => api.get<DashboardSummary>('/captain/dashboard'),
    refetchInterval: 60_000,
  });

  const collateral = profile.data?.collateralBalance ?? 0;
  const conversionRate = summary.data?.conversionRate ?? 0;

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Captain</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Home</h1>
      </div>

      {/* Balance card — mirrors the wallet-style summary at the top of the reference layout. */}
      <div className="overflow-hidden rounded-panel bg-gradient-to-br from-brand-600 to-brand-900 px-5 py-5 text-white shadow-panel">
        <div className="flex items-center justify-between gap-3">
          <div>
            {/* The headline is the money that actually decides what this
                captain can do today. It used to be the task-claim ceiling,
                which is a different number from a different flow — so this
                screen said 500 while the wallet said 50,050 and both were
                right, which is the worst kind of wrong. */}
            <p className="text-2xs font-mono uppercase tracking-wider text-white/60">Available DMC</p>
            <p className="mt-1 font-display text-2xl font-bold tnum">
              <Money amount={profile.data?.dmcBalance ?? 0} />
            </p>
            {/* The headline is everything they hold; this is the part of it
                they may still commit to new work. The two differ by the
                commission they have earned — theirs to keep, but not
                headroom — so it belongs here, under the balance it is derived
                from, rather than under a ceiling it has no effect on. */}
            <p className="mt-1 text-2xs text-white/70">
              Current limit{' '}
              <Money
                showUsdt={false}
                amount={profile.data?.canTakeNow ?? 0}
                className="text-2xs font-semibold text-white"
              />
            </p>
          </div>
          {/* <Link
            to="/captain/wallet"
            className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/25"
          >
            <ArrowRightLeft className="h-3.5 w-3.5" /> Crypto settle (demo)
          </Link> */}
        </div>

        <div className="mt-4 grid gap-4 border-t border-white/15 pt-4 sm:grid-cols-2">
          <div>
            <p className="text-2xs font-mono uppercase tracking-wider text-white/60">Security</p>
            <div className="mt-1 flex items-baseline gap-2.5">
              <span className="font-display text-lg font-semibold tnum"><Money amount={collateral} /></span>
            </div>
            <p className="mt-0.5 text-2xs text-white/60">Backs your limit, never spent</p>
          </div>

          <div>
            {/* Named for who decides it. It is not DMC and never was — it is
                how much task work this captain may hold at once, and only
                admin moves it.

                Nothing the captain does changes this figure: claiming work
                does not spend it and completing work does not restore it. The
                one that moves is Current limit, shown above beneath the
                balance it comes out of. Carrying the remainder here instead
                made a claim look like security being spent, which is the one
                thing that never happens to it. */}
            <p className="text-2xs font-mono uppercase tracking-wider text-white/60">Limit approved by admin</p>
            <div className="mt-1 flex items-baseline gap-2.5">
              <span className="font-display text-lg font-semibold tnum">
                <Money amount={profile.data?.taskLimit ?? 0} />
              </span>
            </div>
            <p className="mt-0.5 text-2xs text-white/60">Fixed until admin changes it</p>
          </div>
        </div>

        <div className="mt-3">
          {/* Without this, a limit that does not match the money they posted
              looks like their collateral went missing. */}
          {profile.data?.creditLimit != null && (
            <p className="mt-2 text-2xs text-white/70">
              Your security money is unchanged. Support has set your limit to{' '}
              <Money showUsdt={false} amount={profile.data.creditLimit} className="text-2xs font-semibold text-white" />
              {profile.data.creditLimit > collateral
                ? ' — above what you have posted.'
                : ' for now.'}
            </p>
          )}
        </div>
      </div>

      {/* Rating drives which tasks get offered to this captain at all, so it
          belongs up front rather than buried in a stats panel. */}
      {profile.data && (
        <Panel title="Your rating" eyebrow="decides which tasks you are offered">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-2">
              <RatingStars rating={profile.data.rating} />
              <BadgeRow badges={profile.data.badges} />
            </div>
            <div className="flex gap-6">
              <RateStat label="Success" value={profile.data.successRate} />
              <RateStat label="On time" value={profile.data.onTimeRate} />
              <div>
                <p className="eyebrow">Missed offers</p>
                <p className="mt-0.5 font-mono tnum text-sm text-ink-100">{profile.data.totalOffersMissed}</p>
              </div>
            </div>
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Notifications" eyebrow="live" action={<Bell className="h-4 w-4 text-ink-400" />} bodyClassName="p-0">
          {events.length === 0 ? (
            <div className="px-4 py-6">
              <p className="text-center text-xs text-ink-500">Events appear here as they happen.</p>
            </div>
          ) : (
            <ul className="divide-y divide-ink-800">
              {events.slice(0, 6).map((e) => (
                <li key={e.id} className="px-4 py-2.5">
                  <p className="text-xs text-ink-200">{e.message}</p>
                  <p className="mt-0.5 flex items-baseline gap-2">
                    {e.taskCode && <span className="font-mono tnum text-2xs text-ink-400">{e.taskCode}</span>}
                    <span className="font-mono tnum text-2xs text-ink-500">{timeAgo(new Date(e.at).toISOString())}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Earnings" eyebrow="today" action={<TrendingUp className="h-4 w-4 text-ink-400" />}>
          <div className="space-y-3">
            <div>
              <p className="text-2xs text-ink-400">Today</p>
              <p className="mt-0.5 font-display text-xl font-semibold text-signal-green">
                <Money showUsdt={false} amount={summary.data?.todaysEarnings ?? 0} />
              </p>
            </div>
            <div>
              <p className="text-2xs text-ink-400">Task success rate</p>
              <p className="mt-0.5 font-mono tnum text-lg font-semibold text-ink-50">
                {summary.data ? `${conversionRate}%` : '—'}
              </p>
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="Overall statistics" eyebrow="all time">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Metric label="Total claimed" value={<Money showUsdt={false} amount={summary.data?.totalClaimedValue ?? 0} compact />} />
          <Metric label="Total earned" value={<Money showUsdt={false} amount={summary.data?.totalEarned ?? 0} compact />} tone="green" />
          <Metric label="Transactions" value={summary.data?.totalTransactions ?? 0} />
        </div>
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-ink-300">Conversion rate</span>
            <span className="font-mono tnum font-semibold text-signal-green">{conversionRate}%</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-850">
            <div className="h-full rounded-full bg-signal-green transition-all" style={{ width: `${conversionRate}%` }} />
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-3">
        <Metric label="Active tasks" value={summary.data?.activeCount ?? 0} tone="cyan" />
        <Metric label="Completed tasks" value={summary.data?.completedCount ?? 0} tone="green" />
      </div>
    </div>
  );
}
