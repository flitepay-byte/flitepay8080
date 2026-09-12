import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { UserX, UserPlus, Scale, HandCoins, Banknote, FileWarning, Ban, Clock, TrendingUp, HelpCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel, Money, EmptyState, ErrorState, TableSkeleton, cn, Pagination } from '@/components/primitives';
import type { Paginated } from '@/types';

/**
 * One decision waiting on admin, whatever kind of thing it sits on.
 *
 * The queue is deliberately heterogeneous. "Needs a decision" is not a status
 * on any one collection — a rejected proof, a task nobody can take, a captain
 * saying a payment never arrived, and real money waiting to be confirmed are
 * the same thing from admin's side, and they are normalised server-side into
 * this shape so one screen can hold all of them.
 */
interface Decision {
  id: string;
  kind:
    | 'TASK_REJECTED'
    | 'CANCEL_DISPUTED'
    | 'NO_ELIGIBLE_CAPTAIN'
    | 'CAPTAIN_PAYMENT_DISPUTED'
    | 'PLATFORM_PAYMENT_DISPUTED'
    | 'PARTY_TOPUP_PENDING'
    | 'CAPTAIN_DEPOSIT_PENDING'
    | 'CAPTAIN_LIMIT_PURCHASE_PENDING'
    | 'CAPTAIN_REGISTRATION_PENDING'
    | 'CAPTAIN_REDEMPTION_PENDING'
    | 'TRANSACTION_DISPUTED';
  severity: 'DISPUTE' | 'STALLED' | 'CONFIRM';
  reference: string;
  headline: string;
  detail: string | null;
  amount: number;
  waitingSince: string;
  href: string;
}

/**
 * How each kind reads at a glance. `label` is the chip; the icon carries the
 * same meaning for anyone scanning rather than reading.
 */
const KIND_META: Record<Decision['kind'], { label: string; icon: typeof Scale }> = {
  TASK_REJECTED: { label: 'Proof rejected', icon: FileWarning },
  CANCEL_DISPUTED: { label: 'Cancellation disputed', icon: Ban },
  NO_ELIGIBLE_CAPTAIN: { label: 'No captain left', icon: UserX },
  CAPTAIN_PAYMENT_DISPUTED: { label: 'Payment disputed', icon: Scale },
  PLATFORM_PAYMENT_DISPUTED: { label: 'Commission disputed', icon: Scale },
  PARTY_TOPUP_PENDING: { label: 'Top-up to confirm', icon: HandCoins },
  CAPTAIN_DEPOSIT_PENDING: { label: 'Deposit to confirm', icon: HandCoins },
  CAPTAIN_LIMIT_PURCHASE_PENDING: { label: 'Limit purchase to confirm', icon: TrendingUp },
  CAPTAIN_REGISTRATION_PENDING: { label: 'Captain waiting to be approved', icon: UserPlus },
  CAPTAIN_REDEMPTION_PENDING: { label: 'Cash-out to pay', icon: Banknote },
  TRANSACTION_DISPUTED: { label: 'Payment disputed', icon: Scale },
};

/** Blocked reads red, stuck reads amber, and waiting-to-be-confirmed reads neutral. */
const SEVERITY_TONE: Record<Decision['severity'], { chip: string; edge: string; icon: string }> = {
  DISPUTE: { chip: 'border-signal-red/40 bg-signal-red/10 text-signal-red', edge: 'border-l-signal-red', icon: 'text-signal-red' },
  STALLED: { chip: 'border-signal-amber/40 bg-signal-amber/10 text-signal-amber', edge: 'border-l-signal-amber', icon: 'text-signal-amber' },
  CONFIRM: { chip: 'border-ink-700 bg-ink-850 text-ink-300', edge: 'border-l-ink-600', icon: 'text-ink-400' },
};

/** "14m", "3h", "2d" — how long somebody has been waiting on admin. */
function waitingFor(since: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * ADMIN REVIEW QUEUE — the one screen that must show everything waiting on
 * admin.
 *
 * If the app is holding a task or somebody's money still because admin has not
 * decided something, it belongs here. Nothing that needs a decision may live
 * only on a profile page: a captain disputing a payment used to appear solely
 * under Captains -> that captain -> withdrawals, so the screen admin actually
 * watches sat empty while a captain waited to be paid.
 */
export function AdminReviewQueue() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);

  const queue = useQuery<Paginated<Decision>>({
    queryKey: ['admin-review-queue', page],
    queryFn: () => api.get<Paginated<Decision>>(`/admin/review-queue?page=${page}&limit=25`),
    refetchInterval: 30_000,
  });

  const items = queue.data?.items ?? [];
  const blocking = items.filter((d) => d.severity !== 'CONFIRM').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Admin</p>
          <h1 className="font-display text-xl font-semibold text-ink-50">Review queue</h1>
          <p className="mt-1 text-xs text-ink-400">
            Everything waiting on your decision — disputes, tasks nobody can take, and money to confirm.
          </p>
        </div>
        {queue.data && (
          <span
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3 py-1',
              blocking > 0 ? 'border-signal-red/40 bg-signal-red/10' : 'border-ink-700 bg-ink-850',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', blocking > 0 ? 'bg-signal-red animate-pulse-dot' : 'bg-signal-slate')} />
            <span className={cn('font-mono tnum text-xs', blocking > 0 ? 'text-signal-red' : 'text-ink-300')}>
              {queue.data.total} waiting on you
            </span>
          </span>
        )}
      </div>

      <Panel bodyClassName={items.length ? 'p-0' : undefined}>
        {queue.isPending && <TableSkeleton rows={5} cols={4} />}
        {queue.isError && <ErrorState message="Could not load the review queue." onRetry={() => void queue.refetch()} />}
        {queue.data && items.length === 0 && (
          <EmptyState
            title="Nothing waiting on you"
            hint="Disputes, tasks that ran out of captains, and money awaiting your confirmation all land here."
          />
        )}
        {items.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-left">
                    <th className="px-4 py-2.5 eyebrow font-normal">Needs you because</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">Who / what</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">Waiting</th>
                    <th className="px-4 py-2.5 eyebrow font-normal text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {items.map((decision) => {
                    /**
                     * Falls back rather than indexing blind.
                     *
                     * This screen is the one place admin is promised will show
                     * everything waiting on them, and the server decides which
                     * kinds exist — the two lists are not a shared type. A kind
                     * added there and not here read `undefined` and took the
                     * whole page down with it. A row nobody has written a label
                     * for is still a row admin must be able to see.
                     */
                    const meta =
                      KIND_META[decision.kind] ?? { label: 'Needs a decision', icon: HelpCircle };
                    const tone = SEVERITY_TONE[decision.severity];
                    const Icon = meta.icon;
                    return (
                      <tr
                        key={decision.id}
                        // Straight to where the decision is actually made, which
                        // differs by kind — a task page, a captain's profile,
                        // admin's own wallet.
                        onClick={() => navigate(decision.href)}
                        className={cn('cursor-pointer border-l-2 transition-colors hover:bg-ink-850/60', tone.edge)}
                      >
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-1.5 text-xs font-medium text-ink-50">
                            <Icon className={cn('h-3.5 w-3.5 shrink-0', tone.icon)} />
                            {decision.headline}
                          </span>
                          {decision.detail && (
                            <span className="mt-0.5 block max-w-md truncate text-2xs text-ink-400">{decision.detail}</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className="block font-mono tnum text-xs text-ink-100">{decision.reference}</span>
                          <span className={cn('mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-2xs', tone.chip)}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-1 font-mono tnum text-xs text-ink-300">
                            <Clock className="h-3 w-3 text-ink-500" /> {waitingFor(decision.waitingSince)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Money amount={decision.amount} className="text-xs text-ink-50" showUsdt={false} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={queue.data?.totalPages ?? 1} onChange={setPage} />
          </>
        )}
      </Panel>
    </div>
  );
}
