import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel, Money, EmptyState, ErrorState, TableSkeleton, cn, Pagination } from '@/components/primitives';
import { STATUS_LABEL, STATUS_STYLE } from './Payments';
import type { Paginated, AdminTransactionDto } from '@/types';
import { when } from '@/lib/datetime';

const PER_PAGE = 10;

/**
 * The money this party's customers have paid in, and which captain took each.
 *
 * Admin is the only role that may see this pairing — a party never learns who
 * the captain was and a captain never learns whose customer paid them — and
 * this is admin's own view of one party, so both sides are named.
 *
 * Scoped on the server by `partyId`, not filtered here: two parties' customers
 * must never appear in one another's history, and a filter applied after the
 * fetch is one refactor away from being dropped.
 *
 * Nothing new is stored for this. Every field below already existed on the
 * payment — the captain is the one assigned to it, and the reference is the
 * party's own id for the order — so this panel only shows what was already
 * recorded when the payment was taken.
 */
export function PartyPayInsPanel({ partyId }: { partyId: string }) {
  const [page, setPage] = useState(1);

  const payIns = useQuery<Paginated<AdminTransactionDto>>({
    queryKey: ['admin-party-payins', partyId, page],
    queryFn: () =>
      api.get<Paginated<AdminTransactionDto>>(
        `/admin/transactions?direction=PAY_IN&partyId=${partyId}&page=${page}&limit=${PER_PAGE}`,
      ),
    enabled: Boolean(partyId),
  });

  const items = payIns.data?.items ?? [];

  return (
    <Panel
      title="Pay-in history"
      eyebrow="money this party's customers paid in"
      bodyClassName={items.length ? 'p-0' : undefined}
    >
      {payIns.isPending && <TableSkeleton rows={4} cols={6} />}
      {payIns.isError && (
        <ErrorState message="Could not load pay-ins." onRetry={() => void payIns.refetch()} />
      )}
      {!payIns.isPending && !payIns.isError && items.length === 0 && (
        <EmptyState
          title="No pay-in transactions found"
          hint="Payments this party's customers make through the API appear here."
        />
      )}

      {items.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left">
                  <th className="px-4 py-2.5 eyebrow font-normal">Customer</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Type</th>
                  <th className="px-4 py-2.5 eyebrow font-normal text-right">Amount</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Captain</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">When</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {items.map((t) => (
                  <tr key={t.id} className="transition-colors hover:bg-ink-850/60">
                    <td className="px-4 py-3">
                      {/* A pay-in carries no customer name: the API takes an
                          amount and the party's own reference, because the
                          customer belongs to the party and not to us. That
                          reference IS how the party names this customer's
                          order, so it is what stands here — under our own code
                          for the payment, which is what admin quotes back. */}
                      <span className="block font-mono text-xs text-ink-100">{t.partyReference}</span>
                      <span className="mt-0.5 block font-mono text-2xs text-ink-500">{t.code}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-signal-cyan/10 px-2.5 py-1 text-2xs font-medium text-signal-cyan">
                        <ArrowDownToLine className="h-3 w-3" />
                        Pay-in
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Money amount={t.amount} showUsdt={false} className="text-xs font-semibold text-ink-50" />
                    </td>
                    <td className="px-4 py-3">
                      {t.captainName ? (
                        <>
                          <span className="block text-xs text-ink-100">{t.captainName}</span>
                          <span className="mt-0.5 block font-mono text-2xs text-ink-500">{t.captainCode}</span>
                        </>
                      ) : (
                        // Not every pay-in has one yet: a payment sitting in
                        // CREATED has not been assigned, and saying "—" is
                        // truer than leaving the column looking broken.
                        <span className="text-xs text-ink-500">Not assigned yet</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono tnum text-xs text-ink-300">
                      {when(t.createdAt)}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={payIns.data?.totalPages ?? 1} onChange={setPage} />
        </>
      )}
    </Panel>
  );
}
