import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ArrowDownToLine, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel, Money, EmptyState, ErrorState, TableSkeleton, cn } from '@/components/primitives';
import type { CaptainTransactionDto, Paginated, TransactionState } from '@/types';
import { when } from '@/lib/datetime';

/**
 * Pay In — the customer payments this captain has received.
 *
 * This screen used to be the captain asking a party for their earned DMC in
 * rupees: a request, a list of requests, and one payment-activity row per
 * source party, each with its own confirm-or-dispute handshake. None of that
 * belonged under a heading named for money coming in, and it is gone from the
 * routes and the controller as well as from here.
 *
 * What is left is the thing the tab is named after: every pay-in the captain
 * took, newest first. The party behind each one is deliberately absent — a
 * captain never learns whose money they handled.
 */
const PER_PAGE = 10;

const STATUS_LABEL: Record<TransactionState, string> = {
  CREATED: 'Waiting for a captain',
  ASSIGNED: 'Yours — QR not issued yet',
  AWAITING_CUSTOMER: 'Waiting for the customer',
  CONFIRMED: 'Payment confirmed',
  SETTLED: 'Settled',
  EXPIRED: 'Expired unpaid',
  CANCELLED: 'Cancelled',
  DISPUTED: 'Disputed',
};

const STATUS_STYLE: Record<TransactionState, string> = {
  CREATED: 'bg-ink-700/60 text-ink-300',
  ASSIGNED: 'bg-ink-700/60 text-ink-200',
  AWAITING_CUSTOMER: 'bg-signal-amber/10 text-signal-amber',
  CONFIRMED: 'bg-signal-amber/10 text-signal-amber',
  SETTLED: 'bg-signal-green/10 text-signal-green',
  EXPIRED: 'bg-ink-700/60 text-ink-400',
  CANCELLED: 'bg-ink-700/60 text-ink-400',
  DISPUTED: 'bg-signal-red/10 text-signal-red',
};

export function CaptainPayIn() {
  const [page, setPage] = useState(1);

  const payIns = useQuery<Paginated<CaptainTransactionDto>>({
    queryKey: ['captain-pay-ins', page],
    queryFn: () =>
      api.get<Paginated<CaptainTransactionDto>>(`/captain/pay-ins?page=${page}&limit=${PER_PAGE}`),
    // Keeps the table on screen while the next page loads, so paging never
    // blinks through an empty state that would read as "my history is gone".
    placeholderData: keepPreviousData,
  });

  const items = payIns.data?.items ?? [];
  const totalPages = payIns.data?.totalPages ?? 1;

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Captain</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Pay In</h1>
        <p className="mt-1 text-xs text-ink-400">
          Money customers have paid you. You take the cash and give up the matching DMC.
        </p>
      </div>

      <Panel
        title="Pay-in history"
        eyebrow="newest first"
        action={<ArrowDownToLine className="h-4 w-4 text-ink-400" />}
        bodyClassName={items.length ? 'p-0' : undefined}
      >
        {payIns.isPending && <TableSkeleton rows={5} cols={4} />}

        {payIns.isError && (
          <ErrorState message="Could not load your pay-in history." onRetry={() => void payIns.refetch()} />
        )}

        {!payIns.isPending && !payIns.isError && items.length === 0 && (
          <EmptyState
            title="No Pay-in transactions found"
            hint="A pay-in appears here as soon as one is offered to you."
          />
        )}

        {items.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-left">
                    <th className="px-4 py-2.5 eyebrow font-normal">When</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">Reference</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">State</th>
                    <th className="px-4 py-2.5 eyebrow font-normal text-right">Amount</th>
                    <th className="px-4 py-2.5 eyebrow font-normal text-right">Your fee</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {items.map((t) => (
                    <tr key={t.id} className="transition-colors hover:bg-ink-850/60">
                      <td className="px-4 py-3 font-mono tnum text-xs text-ink-300">
                        {when(t.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs text-ink-50">{t.code}</p>
                        {t.settlementReference && (
                          <p className="mt-0.5 font-mono text-2xs text-ink-500">{t.settlementReference}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium',
                            STATUS_STYLE[t.status],
                          )}
                        >
                          {STATUS_LABEL[t.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Money amount={t.amount} showUsdt={false} className="text-xs text-ink-50" />
                      </td>
                      <td className="px-4 py-3 text-right">
                        {/* The fee is earned only once the payment settles, so
                            it is shown as a dash until then rather than as a
                            number the captain has not been paid. */}
                        {t.status === 'SETTLED' ? (
                          <Money
                            amount={t.commission}
                            showUsdt={false}
                            className="text-xs font-semibold text-signal-green"
                          />
                        ) : (
                          <span className="text-xs text-ink-500">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-3 border-t border-ink-800 px-4 py-3">
                <p className="text-2xs text-ink-500">
                  Page {page} of {totalPages} · {payIns.data?.total ?? 0} pay-ins
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1 || payIns.isFetching}
                    className="btn-ghost px-2.5 py-1.5 text-xs"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages || payIns.isFetching}
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
