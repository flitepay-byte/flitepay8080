import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, RefreshCw, AlertTriangle, Loader2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Money, EmptyState, TableSkeleton, cn } from '@/components/primitives';
import type { Paginated, PartyTransactionDto, TransactionState } from '@/types';
import { when } from '@/lib/datetime';

/**
 * The party's own view of payments made through their API integration.
 *
 * Their site is where these actually happen — this screen exists for the
 * moments when something has gone quiet and somebody needs to look: a customer
 * says they paid and the order never updated, a refund has not landed. So it is
 * built around *their* reference rather than ours, because that is the id they
 * will have in front of them when they come looking.
 *
 * The captain is never named. A party is buying settlement, not a relationship
 * with a particular person, and which captain handled a payment is not theirs
 * to know — the same boundary the API itself holds.
 */
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

/**
 * Worded from the party's side rather than ours. "AWAITING_CUSTOMER" is our
 * internal state; what the party needs to know is that their customer has not
 * paid yet, and there is nothing for them to do about it.
 */
const STATUS_LABEL: Record<TransactionState, string> = {
  CREATED: 'Starting up',
  ASSIGNED: 'Starting up',
  AWAITING_CUSTOMER: 'Waiting on your customer',
  CONFIRMED: 'Payment confirmed, settling',
  SETTLED: 'Done',
  EXPIRED: 'Nobody paid in time',
  CANCELLED: 'Cancelled',
  DISPUTED: 'Being looked into',
};

/** Nothing has finished, so a dispute is still possible. */
const OPEN_STATUSES: TransactionState[] = ['ASSIGNED', 'AWAITING_CUSTOMER', 'CONFIRMED'];

export function PartyTransactions() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<'' | 'PAY_IN' | 'PAY_OUT'>('');
  const [disputingId, setDisputingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const params = new URLSearchParams({ page: '1', limit: '50' });
  if (direction) params.set('direction', direction);

  const transactions = useQuery<Paginated<PartyTransactionDto>>({
    queryKey: ['party-transactions', direction],
    queryFn: () => api.get<Paginated<PartyTransactionDto>>(`/party/transactions?${params.toString()}`),
    // These move without anybody on this screen doing anything — a customer
    // pays, a captain sends a transfer — so a snapshot taken on arrival would
    // be stale by the time somebody read it.
    refetchInterval: 20_000,
  });

  const raiseDispute = useMutation({
    mutationFn: (reference: string) =>
      api.post(`/party/transactions/${encodeURIComponent(reference)}/dispute`, { reason: reason.trim() }),
    onSuccess: () => {
      toast.show('info', 'Raised with the platform. The money stays held until they decide.');
      setDisputingId(null);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['party-transactions'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const items = transactions.data?.items ?? [];
  const settling = items.filter((t) => !['SETTLED', 'EXPIRED', 'CANCELLED'].includes(t.status));

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Party</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">API payments</h1>
        <p className="mt-1 text-xs text-ink-400">
          Money your customers have paid you, and money you have sent them, through your integration.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Still moving" value={String(settling.length)} hint="Not finished yet" />
        <Stat
          label="Received"
          value={items.filter((t) => t.direction === 'PAY_IN' && t.status === 'SETTLED').length.toString()}
          hint="Pay-ins that settled"
        />
        <Stat
          label="Sent"
          value={items.filter((t) => t.direction === 'PAY_OUT' && t.status === 'SETTLED').length.toString()}
          hint="Pay-outs that settled"
        />
      </div>

      <Panel title="Payments" bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-4 py-3">
          <div className="flex gap-2">
            {([
              { value: '', label: 'All' },
              { value: 'PAY_IN', label: 'Money in' },
              { value: 'PAY_OUT', label: 'Money out' },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setDirection(option.value)}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-xs transition-colors',
                  direction === option.value
                    ? 'border-accent-500 bg-accent-500/10 text-ink-50'
                    : 'border-ink-700 text-ink-400 hover:border-ink-600 hover:text-ink-200',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="ml-auto flex items-center gap-1.5 text-2xs text-ink-500">
            <RefreshCw className={cn('h-3 w-3', transactions.isFetching && 'animate-spin')} />
            updates on its own
          </span>
        </div>

        {transactions.isPending && <TableSkeleton rows={5} cols={5} />}
        {!transactions.isPending && items.length === 0 && (
          <EmptyState
            title="No payments yet"
            hint="Payments your site makes through the API appear here. Create an API key to get started."
          />
        )}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left">
                  <th className="px-4 py-2.5 eyebrow font-normal">When</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Your reference</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Direction</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Status</th>
                  <th className="px-4 py-2.5 eyebrow font-normal text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {items.map((t) => (
                  <tr key={t.id} className="transition-colors hover:bg-ink-850/60">
                    <td className="px-4 py-3 font-mono tnum text-xs text-ink-300">
                      {when(t.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      {/* Their id first and ours underneath: theirs is what
                          they will have in front of them when they come here. */}
                      <p className="font-mono text-2xs text-ink-200">{t.reference}</p>
                      <p className="mt-0.5 font-mono text-2xs text-ink-500">{t.id}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 text-xs text-ink-300">
                        {t.direction === 'PAY_IN'
                          ? <><ArrowDownToLine className="h-3 w-3 text-signal-green" /> In</>
                          : <><ArrowUpFromLine className="h-3 w-3 text-ink-400" /> Out</>}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium', STATUS_STYLE[t.status])}>
                        {STATUS_LABEL[t.status]}
                      </span>
                      {t.failureReason && (
                        <p className="mt-1 max-w-[28ch] text-2xs text-ink-500">{t.failureReason}</p>
                      )}
                      {t.settlementReference && (
                        <p className="mt-1 font-mono text-2xs text-ink-500">Ref {t.settlementReference}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Money
                        amount={t.amount}
                        showUsdt={false}
                        className={cn(
                          'text-xs font-semibold',
                          t.status === 'SETTLED' ? 'text-ink-50' : 'text-ink-400',
                        )}
                      />
                      {/* Your customer says they paid and this still says they
                          have not — this is how you say so. Only while it is
                          unfinished: a settled payment is final. */}
                      {OPEN_STATUSES.includes(t.status) && disputingId !== t.reference && (
                        <button
                          type="button"
                          onClick={() => { setDisputingId(t.reference); setReason(''); }}
                          className="btn-ghost mt-1 px-2 py-1 text-2xs"
                        >
                          Something is wrong
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {disputingId && (
                  <tr>
                    <td colSpan={5} className="bg-ink-850/60 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="What went wrong? Your customer's side of it helps."
                          className="field-input min-w-[240px] flex-1"
                        />
                        <button
                          type="button"
                          onClick={() => raiseDispute.mutate(disputingId)}
                          disabled={reason.trim().length < 4 || raiseDispute.isPending}
                          className="btn-secondary"
                        >
                          {raiseDispute.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><AlertTriangle className="h-4 w-4" /> Raise it</>}
                        </button>
                        <button type="button" onClick={() => setDisputingId(null)} className="btn-ghost px-3">
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="text-2xs leading-relaxed text-ink-500">
        Nothing is deducted from these amounts. A customer paying ₹100 credits you exactly 100 DMC, and a
        payout of ₹100 sends exactly ₹100 — the captain&apos;s fee is paid by the platform, not taken off
        the top.
      </p>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850 px-3.5 py-3">
      <p className="eyebrow">{label}</p>
      <p className="mt-1 font-mono tnum text-lg font-semibold text-ink-50">{value}</p>
      <p className="mt-0.5 text-2xs text-ink-500">{hint}</p>
    </div>
  );
}
