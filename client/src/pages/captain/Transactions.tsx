import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, ArrowDownToLine, ArrowUpFromLine, AlertTriangle, QrCode, Undo2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Money, StatusChip, EmptyState, TableSkeleton, cn } from '@/components/primitives';
import type { Paginated, CaptainTransactionDto, CaptainProfile, Task } from '@/types';

/**
 * The payments a captain is carrying right now.
 *
 * The two directions are opposite jobs and the screen says so rather than
 * making the captain work it out from a label. On a pay-in they are *waiting*
 * — the customer scans and pays them, and their DMC is already committed. On a
 * pay-out they have something to *do*: send real money to an account and come
 * back with the reference.
 *
 * Nothing here names the party. A captain settles payments; which business the
 * money belongs to is not theirs to know, and letting them see it would let
 * them treat one party's customers differently from another's.
 */
export function CaptainTransactions() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [disputingId, setDisputingId] = useState<string | null>(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState('');

  const profile = useQuery<CaptainProfile>({
    queryKey: ['captain-profile'],
    queryFn: () => api.get<CaptainProfile>('/captain/profile'),
  });

  const live = useQuery<Paginated<CaptainTransactionDto>>({
    queryKey: ['captain-transactions'],
    queryFn: () => api.get<Paginated<CaptainTransactionDto>>('/captain/transactions?page=1&limit=50'),
    // These change without the captain doing anything — a customer pays, a
    // window closes — so the screen cannot be a snapshot taken on arrival.
    refetchInterval: 15_000,
  });

  /**
   * The pay-outs the captain is carrying, which is where their DMC is held.
   *
   * Asked for by the question rather than by a list of states: `holding` means
   * "money of mine is committed to this", and the server decides which states
   * that is. The work itself is done on the task, so these rows link there
   * rather than repeating the start-and-submit flow in a second place.
   */
  const heldTasks = useQuery<Paginated<Task>>({
    // Keyed under 'captain-tasks' on purpose. Query keys match by prefix, so
    // every existing invalidation of the captain's task list — the socket's
    // approved / rejected / expired events, and the task screens' own — clears
    // this too. Given its own key it went stale instead, and a finished
    // pay-out sat in the panel until the next poll came round.
    // An object rather than a string: the task list is keyed
    // ['captain-tasks', search], and a captain searching for the word
    // "holding" would otherwise share this entry with a different query.
    queryKey: ['captain-tasks', { holding: true }],
    queryFn: () => api.get<Paginated<Task>>('/captain/tasks?page=1&limit=50&holding=true'),
    refetchInterval: 15_000,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['captain-transactions'] });
    void queryClient.invalidateQueries({ queryKey: ['captain-transactions-settled'] });
    void queryClient.invalidateQueries({ queryKey: ['captain-profile'] });
  };

  const raiseDispute = useMutation({
    mutationFn: (id: string) => api.post(`/captain/transactions/${id}/dispute`, { reason: disputeReason.trim() }),
    onSuccess: () => {
      toast.show('info', 'Raised with admin. Your DMC stays held until they decide.');
      setDisputingId(null);
      setDisputeReason('');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const decline = useMutation({
    mutationFn: (id: string) => api.post(`/captain/transactions/${id}/decline`, { reason: declineReason.trim() }),
    onSuccess: () => {
      toast.show('info', 'Handed back — your DMC is free again and it will go to another captain.');
      setDecliningId(null);
      setDeclineReason('');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const items = live.data?.items ?? [];
  const payIns = items.filter((t) => t.direction === 'PAY_IN');
  const payOuts = heldTasks.data?.items ?? [];

  // What the captain has actually committed: the DMC given up on each live
  // pay-in, plus the hold taken when they claimed each pay-out.
  const committed =
    payIns.reduce((sum, t) => sum + t.amount, 0) + payOuts.reduce((sum, t) => sum + t.amount, 0);

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Captain</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">In progress</h1>
        <p className="mt-1 text-xs text-ink-400">
          Everything still running, both directions — and everything your DMC is currently committed to.
        </p>
      </div>

      {/* Capital first, because it is the number that decides whether a pay-in
          can be offered to this captain at all. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard label="Available DMC" hint="Capital, earnings and commission together" amount={profile.data?.dmcBalance ?? 0} tone="text-ink-50" />
        <StatCard label="Committed right now" hint="Held against live pay-ins and pay-outs" amount={committed} tone="text-signal-amber" />
      </div>

      <Panel
        title="Money you are sending out"
        eyebrow="pay-outs you are carrying — your DMC is held against these"
        action={<ArrowUpFromLine className="h-4 w-4 text-ink-400" />}
        bodyClassName={payOuts.length ? 'p-0' : undefined}
      >
        {heldTasks.isPending && <TableSkeleton rows={2} cols={3} />}
        {!heldTasks.isPending && payOuts.length === 0 && (
          <EmptyState
            title="Nothing to send"
            hint="Pay-outs you claim appear here until the party approves them."
          />
        )}
        {payOuts.length > 0 && (
          <div className="divide-y divide-ink-800">
            {payOuts.map((t) => (
              /* The work itself lives on the task — start it, send the money,
                 submit the reference. Repeating that flow here would be a
                 second place for it to drift out of step, so this is a way in
                 rather than a copy. */
              <Link
                key={t.id}
                to={`/captain/tasks/${t.id}`}
                className="block px-4 py-3.5 transition-colors hover:bg-ink-850/60"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-2xs text-ink-500">{t.taskCode}</p>
                    <p className="mt-1 truncate text-xs text-ink-200">
                      Send to <span className="font-mono text-ink-50">{t.identifier}</span>
                    </p>
                    <p className="mt-0.5 text-2xs text-ink-500">{t.customerName}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Money amount={t.amount} className="text-sm font-semibold text-ink-50" />
                    {t.commission != null && (
                      <p className="mt-0.5 text-2xs text-signal-green">
                        +{t.commission.toLocaleString('en-IN')} commission
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <StatusChip status={t.status} size="sm" />
                  <span className="text-2xs text-ink-500">Open the task &rarr;</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Money coming in to you"
        eyebrow="the customer scans and pays you"
        action={<ArrowDownToLine className="h-4 w-4 text-ink-400" />}
        bodyClassName={payIns.length ? 'p-0' : undefined}
      >
        {live.isPending && <TableSkeleton rows={2} cols={3} />}
        {!live.isPending && payIns.length === 0 && (
          <EmptyState title="Nothing incoming" hint="Pay-ins assigned to you appear here while the customer pays." />
        )}
        {payIns.length > 0 && (
          <div className="divide-y divide-ink-800">
            {payIns.map((t) => (
              <div key={t.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="font-mono text-2xs text-ink-500">{t.code}</p>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-300">
                      <QrCode className="h-3.5 w-3.5" />
                      Waiting for the customer to pay you
                    </p>
                  </div>
                  <div className="text-right">
                    <Money amount={t.amount} className="text-sm font-semibold text-ink-50" />
                    <p className="mt-0.5 text-2xs text-signal-green">+{t.commission.toLocaleString('en-IN')} commission</p>
                  </div>
                </div>

                {/* The captain's own DMC is already committed against this, so
                    if the money never arrives they need a way to say so. */}
                {disputingId === t.id ? (
                  <div className="mt-3 space-y-2">
                    <input
                      value={disputeReason}
                      onChange={(e) => setDisputeReason(e.target.value)}
                      placeholder="What happened?"
                      className="field-input"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => raiseDispute.mutate(t.id)}
                        disabled={disputeReason.trim().length < 4 || raiseDispute.isPending}
                        className="btn-secondary flex-1"
                      >
                        {raiseDispute.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><AlertTriangle className="h-4 w-4" /> Raise with admin</>}
                      </button>
                      <button type="button" onClick={() => setDisputingId(null)} className="btn-ghost px-3">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : decliningId === t.id ? (
                  <div className="mt-3 space-y-2">
                    <input
                      value={declineReason}
                      onChange={(e) => setDeclineReason(e.target.value)}
                      placeholder="Why can you not take this one?"
                      className="field-input"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => decline.mutate(t.id)}
                        disabled={declineReason.trim().length < 4 || decline.isPending}
                        className="btn-secondary flex-1"
                      >
                        {decline.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Undo2 className="h-4 w-4" /> Hand it back</>}
                      </button>
                      <button type="button" onClick={() => setDecliningId(null)} className="btn-ghost px-3">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex gap-2">
                    {/* Only before the customer has a QR. After that somebody
                        may already be paying it, and the way out is a dispute. */}
                    {t.status === 'ASSIGNED' && (
                      <button
                        type="button"
                        onClick={() => { setDecliningId(t.id); setDisputingId(null); setDeclineReason(''); }}
                        className="btn-ghost flex-1 text-xs"
                      >
                        I cannot take this
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { setDisputingId(t.id); setDecliningId(null); setDisputeReason(''); }}
                      className="btn-ghost flex-1 text-xs"
                    >
                      The money never arrived
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

    </div>
  );
}

function StatCard({ label, hint, amount, tone }: { label: string; hint: string; amount: number; tone: string }) {
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850 px-3.5 py-3">
      <p className="eyebrow">{label}</p>
      <p className={cn('mt-1 font-mono tnum text-lg font-semibold', tone)}>
        <Money showUsdt={false} amount={amount} />
      </p>
      <p className="mt-0.5 text-2xs text-ink-500">{hint}</p>
    </div>
  );
}
