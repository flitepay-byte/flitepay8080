import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel, Metric, Money, EmptyState, ErrorState, TableSkeleton, cn } from '@/components/primitives';
import type { CaptainProfile, Paginated } from '@/types';
import { when } from '@/lib/datetime';

/**
 * One line of the commission ledger.
 *
 * `direction` and `amount` are null when the payment the commission came from
 * no longer exists. The fee was still earned, so the row is still shown — it is
 * the payment beside it that cannot be described, not the money.
 */
interface CommissionEntry {
  id: string;
  direction: 'PAY_IN' | 'PAY_OUT' | null;
  reference: string | null;
  /**
   * The rate this entry was actually priced at, read off the payment rather
   * than from today's settings. It is per entry because a captain's rate is
   * their own and admin can change it — two entries a week apart can honestly
   * carry different rates, and one current figure over all of them would say
   * the older work had been mispaid.
   */
  rate: number | null;
  amount: number | null;
  commission: number;
  earnedAt: string;
}

interface EarningsResponse extends Paginated<CommissionEntry> {
  totalEarned: number;
  entryCount: number;
}

const PER_PAGE = 10;

type Filter = '' | 'PAY_IN' | 'PAY_OUT';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: '', label: 'All' },
  { value: 'PAY_IN', label: 'Pay-in' },
  { value: 'PAY_OUT', label: 'Pay-out' },
];

export function CaptainEarnings() {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<Filter>('');

  const earnings = useQuery<EarningsResponse>({
    queryKey: ['captain-earnings', page, filter],
    queryFn: () =>
      api.get<EarningsResponse>(
        `/captain/earnings?page=${page}&limit=${PER_PAGE}${filter ? `&direction=${filter}` : ''}`,
      ),
    // Keeps the table on screen while the next page loads, so paging does not
    // blink through an empty state that would read as "your history is gone".
    placeholderData: keepPreviousData,
  });

  const profile = useQuery<CaptainProfile>({
    queryKey: ['captain-profile'],
    queryFn: () => api.get<CaptainProfile>('/captain/profile'),
  });

  const items = earnings.data?.items ?? [];
  const totalPages = earnings.data?.totalPages ?? 1;

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Captain</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Earnings</h1>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Total earned"
          value={<Money showUsdt={false} amount={earnings.data?.totalEarned ?? 0} compact />}
          tone="green"
        />
        <Metric label="Entries" value={earnings.data?.entryCount ?? 0} />
        <Metric label="Tasks completed" value={profile.data?.totalTasksCompleted ?? 0} />
        {/* No balance tile on this screen, so no Current limit either: this
            page is about what was earned, and the remaining headroom would
            have nothing here to hang off. It is on Home, Queue and Wallet. */}
        <Metric
          label="Limit approved by admin"
          value={<Money amount={profile.data?.taskLimit ?? 0} compact />}
          tone="cyan"
          hint="Fixed until admin changes it"
        />
      </div>

      <Panel
        title="Commission ledger"
        eyebrow="money in and money out — immutable, never edited"
        action={
          <div className="flex shrink-0 gap-1 rounded-md border border-ink-700 p-0.5">
            {FILTERS.map((option) => (
              <button
                key={option.value || 'all'}
                type="button"
                onClick={() => {
                  // Back to the first page: page 4 of the unfiltered list is
                  // rarely a page at all once the list gets shorter, and
                  // landing on an empty one reads as "my history is gone".
                  setFilter(option.value);
                  setPage(1);
                }}
                className={cn(
                  'rounded px-2.5 py-1 text-2xs font-medium transition-colors',
                  filter === option.value
                    ? 'bg-brand-500/15 text-brand-500'
                    : 'text-ink-400 hover:text-ink-200',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
        bodyClassName={items.length ? 'p-0' : undefined}
      >
        {earnings.isPending && <TableSkeleton rows={5} cols={5} />}

        {earnings.isError && (
          <ErrorState message="Could not load your commission ledger." onRetry={() => void earnings.refetch()} />
        )}

        {!earnings.isPending && !earnings.isError && items.length === 0 && (
          <EmptyState
            title={filter ? `No ${filter === 'PAY_IN' ? 'pay-in' : 'pay-out'} commission yet` : 'No commission yet'}
            hint={
              filter
                ? 'Nothing on this side yet — try All to see the whole ledger.'
                : "You earn on both directions: taking a customer's payment, and sending one out."
            }
          />
        )}

        {items.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-left">
                    <th className="px-4 py-2.5 eyebrow font-normal">Earned</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">Transaction</th>
                    <th className="px-4 py-2.5 eyebrow font-normal text-right">Amount</th>
                    <th className="px-4 py-2.5 eyebrow font-normal text-right">Rate</th>
                    <th className="px-4 py-2.5 eyebrow font-normal text-right">Commission</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {items.map((entry) => (
                    <tr key={entry.id} className="transition-colors hover:bg-ink-850/60">
                      <td className="px-4 py-3 font-mono tnum text-xs text-ink-300">
                        {when(entry.earnedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium',
                            entry.direction === 'PAY_IN'
                              ? 'bg-signal-cyan/10 text-signal-cyan'
                              : entry.direction === 'PAY_OUT'
                                ? 'bg-signal-amber/10 text-signal-amber'
                                : 'bg-ink-700/60 text-ink-300',
                          )}
                        >
                          {entry.direction === 'PAY_IN'
                            ? 'Pay-in'
                            : entry.direction === 'PAY_OUT'
                              ? 'Pay-out'
                              : 'Unknown'}
                        </span>
                        {entry.reference && (
                          <p className="mt-0.5 font-mono text-2xs text-ink-500">{entry.reference}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {entry.amount != null ? (
                          <Money amount={entry.amount} showUsdt={false} className="text-xs text-ink-200" />
                        ) : (
                          <span className="text-xs text-ink-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tnum text-xs text-ink-300">
                        {entry.rate != null ? `${entry.rate}%` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Money
                          amount={entry.commission}
                          showUsdt={false}
                          className="text-xs font-semibold text-signal-green"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-3 border-t border-ink-800 px-4 py-3">
                <p className="text-2xs text-ink-500">
                  Page {page} of {totalPages} · {earnings.data?.entryCount ?? 0} entries
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1 || earnings.isFetching}
                    className="btn-ghost px-2.5 py-1.5 text-xs"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages || earnings.isFetching}
                    className="btn-ghost px-2.5 py-1.5 text-xs"
                  >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
