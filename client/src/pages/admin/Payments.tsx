import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Scale, Check, X, ArrowDownToLine, ArrowUpFromLine, BellOff, RotateCcw } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useNavigate } from 'react-router-dom';
import { Panel, Money, StatusChip, PaymentRef, stateLabel, cn } from '@/components/primitives';
import { PaymentsSummary } from './PaymentsSummary';
import { PaymentsListSection } from './PaymentsList';
import { TASK_STATES } from '@/types';
import type { Paginated, AdminTransactionDto, TransactionState, Task } from '@/types';
import { when } from '@/lib/datetime';

/**
 * A pay-out row: the task, plus the two counterparties admin alone may see
 * named together. The names come from admin's own task list, which resolves
 * them; a party's task never names the captain and a captain's never names
 * the party.
 */
type AdminPayOut = Task & {
  partyName: string | null;
  partyCode: string | null;
  captainName: string | null;
  captainCode: string | null;
};

/**
 * ADMIN → TRANSACTIONS, at /admin/transactions.
 *
 * The file and its export still say Payments: that was this screen's name
 * until the tab and the route were renamed, and neither is visible to anyone
 * using the console. Renaming them is safe to do and has simply not been
 * done — read the name here, not the one on the file.
 *
 * Every pay-in and pay-out made through the party API, with both counterparties
 * named.
 *
 * This is the only screen in the app that shows the party and the captain
 * together. The other two views hide each from the other on purpose — but
 * admin has to settle arguments between them, and half a picture cannot settle
 * anything.
 *
 * Disputes are pulled to the top rather than left to be found by scrolling: a
 * dispute is money frozen for both sides, and it is the only status here that
 * is waiting on the person reading this screen.
 *
 * Kept apart from Funds & deposits, which is the older set of handshakes — party
 * top-ups, captain deposits, captain cash-outs. Both are "money moving", but
 * they are different mechanics with different people waiting, and folding them
 * together would make each harder to read than it is alone.
 */
/**
 * How a payment's state reads and looks. Exported because a captain's profile
 * shows the same states, and two pages inventing their own vocabulary for one
 * status is how "Awaiting the customer" and "Awaiting customer" end up meaning
 * different things to whoever is reading them.
 */
export const STATUS_STYLE: Record<TransactionState, string> = {
  CREATED: 'bg-ink-700/60 text-ink-300',
  ASSIGNED: 'bg-ink-700/60 text-ink-200',
  AWAITING_CUSTOMER: 'bg-signal-amber/10 text-signal-amber',
  CONFIRMED: 'bg-signal-amber/10 text-signal-amber',
  SETTLED: 'bg-signal-green/10 text-signal-green',
  EXPIRED: 'bg-ink-700/60 text-ink-400',
  CANCELLED: 'bg-ink-700/60 text-ink-400',
  DISPUTED: 'bg-signal-red/10 text-signal-red',
};

export const STATUS_LABEL: Record<TransactionState, string> = {
  CREATED: 'Waiting for a captain',
  ASSIGNED: 'With a captain',
  AWAITING_CUSTOMER: 'Awaiting the customer',
  CONFIRMED: 'Confirmed',
  SETTLED: 'Settled',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  DISPUTED: 'Disputed',
};

/**
 * The states each rail can be in, named the way the rest of the console names
 * them rather than as raw enum values — `stateLabel` and `STATUS_LABEL` are the
 * same vocabularies the chips use, so a filter and the row it selects always
 * read alike.
 */
const PAY_OUT_STATES = TASK_STATES.map((value) => ({ value, label: stateLabel(value) }));
const PAY_IN_STATES = (Object.keys(STATUS_LABEL) as TransactionState[]).map((value) => ({
  value,
  label: STATUS_LABEL[value],
}));

export function AdminPayments() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  /**
   * Only what needs a decision or a warning. The two full lists below fetch
   * their own pages — this one exists so a dispute cannot be missed by being
   * on page four of a history nobody scrolled.
   */
  const attention = useQuery<Paginated<AdminTransactionDto>>({
    queryKey: ['admin-payments-attention'],
    queryFn: () => api.get<Paginated<AdminTransactionDto>>('/admin/transactions?page=1&limit=50'),
  });

  const resolve = useMutation({
    mutationFn: (input: { id: string; decision: 'SETTLE' | 'RELEASE' }) =>
      api.post(`/admin/transactions/${input.id}/resolve-dispute`, {
        decision: input.decision,
        reason: reason.trim(),
      }),
    onSuccess: (_data, input) => {
      toast.show(
        'success',
        input.decision === 'SETTLE' ? 'Settled — the money has moved.' : 'Released — the hold went back.',
      );
      setResolvingId(null);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['admin-payments-attention'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-payins'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-payments-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-review-queue'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const items = attention.data?.items ?? [];
  const disputed = items.filter((t) => t.status === 'DISPUTED');
  // Settled money the party was never told about. Silent by nature: the
  // payment worked, so nothing else on this screen looks wrong.
  const undelivered = items.filter((t) => !t.callbackDelivered && t.callbackAttempts >= 5);

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Transactions</h1>
        <p className="mt-1 text-xs text-ink-400">
          Money in and money out, each on its own list, with both sides named.
        </p>
      </div>

      {undelivered.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-signal-red/40 bg-signal-red/10 px-3 py-2.5 text-xs leading-relaxed text-signal-red">
          <BellOff className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {undelivered.length} finished payment{undelivered.length === 1 ? '' : 's'} could not be reported
            back to the party. Their order is still showing as unpaid on their side — check their callback URL.
          </span>
        </div>
      )}

      {disputed.length > 0 && (
        <Panel
          title={`${disputed.length} waiting on your decision`}
          eyebrow="money is frozen for both sides"
          action={<Scale className="h-4 w-4 text-signal-red" />}
          bodyClassName="p-0"
        >
          <div className="divide-y divide-ink-800">
            {disputed.map((t) => (
              <div key={t.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="font-mono text-2xs text-ink-500">{t.code}</p>
                    <p className="mt-1 text-xs text-ink-200">
                      Pay-in · {t.partyName ?? 'Unknown party'} · {t.captainName ?? 'Unknown captain'}
                    </p>
                    <p className="mt-1 max-w-[60ch] text-2xs text-signal-red">{t.disputeReason}</p>
                  </div>
                  <Money amount={t.amount} className="text-sm font-semibold text-ink-50" />
                </div>

                {resolvingId === t.id ? (
                  <div className="mt-3 space-y-2">
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="What did you find? Both sides will read this."
                      className="field-input"
                    />
                    <div className="flex flex-wrap gap-2">
                      {/* Two answers only, because only two things can be true:
                          the money moved, or it did not. */}
                      <button
                        type="button"
                        onClick={() => resolve.mutate({ id: t.id, decision: 'SETTLE' })}
                        disabled={reason.trim().length < 4 || resolve.isPending}
                        className="btn-primary flex-1"
                      >
                        {resolve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="h-4 w-4" /> The money moved</>}
                      </button>
                      <button
                        type="button"
                        onClick={() => resolve.mutate({ id: t.id, decision: 'RELEASE' })}
                        disabled={reason.trim().length < 4 || resolve.isPending}
                        className="btn-secondary flex-1"
                      >
                        <X className="h-4 w-4" /> It did not — release the hold
                      </button>
                      <button type="button" onClick={() => setResolvingId(null)} className="btn-ghost px-3">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setResolvingId(t.id); setReason(''); }}
                    className="btn-primary mt-3 w-full"
                  >
                    <Scale className="h-4 w-4" /> Decide this
                  </button>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <PaymentsSummary />

      <PaymentsListSection<AdminTransactionDto>
        title="All pay-in"
        eyebrow="money this platform's parties took from their customers"
        action={<ArrowDownToLine className="h-4 w-4 text-signal-cyan" />}
        endpoint="/admin/transactions?direction=PAY_IN"
        queryKey="admin-payins"
        placeholder="Our code, the party's reference, a UTR, or a name"
        statuses={PAY_IN_STATES}
        emptyTitle="No pay-ins yet"
        emptyHint="Payments made through the party API appear here."
        rowKey={(t) => t.id}
        columns={[
          { label: 'When' },
          { label: 'Reference' },
          { label: 'Party' },
          { label: 'Captain' },
          { label: 'Status' },
          { label: 'Amount', align: 'right' },
        ]}
        renderRow={(t) => (
          <>
            <td className="px-4 py-3 font-mono tnum text-xs text-ink-300">{when(t.createdAt)}</td>
            <td className="px-4 py-3">
              <span className="flex items-center gap-1.5 font-mono text-2xs text-ink-300">
                <ArrowDownToLine className="h-3 w-3 text-ink-500" />
                {t.code}
              </span>
              <p className="mt-0.5 font-mono text-2xs text-ink-500">{t.partyReference}</p>
            </td>
            <td className="px-4 py-3 text-xs text-ink-200">{t.partyName ?? '—'}</td>
            <td className="px-4 py-3 text-xs text-ink-200">{t.captainName ?? '—'}</td>
            <td className="px-4 py-3">
              <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium', STATUS_STYLE[t.status])}>
                {STATUS_LABEL[t.status]}
              </span>
              {/* A settled payment whose commission never got paid is the
                  platform owing a captain — worth seeing here. */}
              {t.status === 'SETTLED' && !t.commissionPaid && (
                <p className="mt-1 text-2xs text-signal-amber">Commission unpaid — pool was empty</p>
              )}
              {/* The party thinks nothing happened. Their order is stuck at
                  "awaiting payment" for a payment that settled. */}
              {!t.callbackDelivered && t.callbackAttempts > 0 && (
                <p className="mt-1 text-2xs text-signal-red">
                  Callback failed x{t.callbackAttempts}
                  {t.callbackAttempts >= 5 && ' — given up, the party has not been told'}
                </p>
              )}
            </td>
            <td className="px-4 py-3 text-right">
              <Money amount={t.amount} showUsdt={false} className="text-xs font-semibold text-ink-50" />
              <p className="mt-0.5 font-mono tnum text-2xs text-ink-500">
                +{t.commission.toLocaleString('en-IN')} fee
              </p>
            </td>
          </>
        )}
      />

      {/* Pay-outs are tasks, and have been since the direction came off the
          transaction engine. This reads that rail rather than reviving the
          PAY_OUT transaction it replaced. */}
      <PaymentsListSection<AdminPayOut>
        title="All pay-out"
        eyebrow="money captains sent to parties' customers"
        action={<ArrowUpFromLine className="h-4 w-4 text-signal-amber" />}
        endpoint="/admin/tasks"
        queryKey="admin-payouts"
        placeholder="Task code, the party's reference, a UTR, or a name"
        statuses={PAY_OUT_STATES}
        // The task's own page, which this list is now the only route to.
        onRowClick={(t) => navigate(`/admin/tasks/${t.id}`)}
        emptyTitle="No pay-outs yet"
        emptyHint="Payouts a party raises through the API or the console appear here."
        rowKey={(t) => t.id}
        columns={[
          { label: 'When' },
          { label: 'Reference' },
          { label: 'Beneficiary' },
          { label: 'Party' },
          { label: 'Captain' },
          { label: 'Status' },
          { label: 'UTR' },
          { label: 'Amount', align: 'right' },
        ]}
        renderRow={(t) => (
          <>
            <td className="px-4 py-3 font-mono tnum text-xs text-ink-300">{when(t.createdAt)}</td>
            <td className="px-4 py-3">
              <span className="flex items-center gap-1.5 font-mono text-2xs text-ink-300">
                <ArrowUpFromLine className="h-3 w-3 text-ink-500" />
                {t.taskCode}
                <ReassignedBadge count={t.reassignmentCount} />
              </span>
              <p className="mt-0.5 font-mono text-2xs text-ink-500">{t.externalRef}</p>
            </td>
            <td className="px-4 py-3 text-xs text-ink-200">{t.customerName}</td>
            <td className="px-4 py-3 text-xs text-ink-200">{t.partyName ?? '—'}</td>
            <td className="px-4 py-3 text-xs text-ink-200">{t.captainName ?? '—'}</td>
            <td className="px-4 py-3"><StatusChip status={t.status} size="sm" /></td>
            <td className="px-4 py-3"><PaymentRef reference={t.providerReference} /></td>
            <td className="px-4 py-3 text-right">
              <Money amount={t.amount} showUsdt={false} className="text-xs font-semibold text-ink-50" />
            </td>
          </>
        )}
      />
    </div>
  );
}


/**
 * Marks a task that has been through more than one captain.
 *
 * Without it a reassigned task is indistinguishable from a clean one in the
 * list: the state column shows where it ended up, not the fact that somebody
 * was rejected or timed out along the way. The count matters as much as the
 * flag — a task on its fourth captain is a different problem from one on its
 * second.
 *
 * Deliberately says nothing about the cause. A reassignment can follow a
 * rejected proof, an expiry, or a disputed cancellation, and the task detail
 * page carries that story properly; here it is only a signal to go and look.
 */
function ReassignedBadge({ count }: { count: number }) {
  if (count < 1) return null;

  return (
    <span
      title={`Reassigned ${count} time${count === 1 ? '' : 's'} — a later captain picked this up. Open the task to see why.`}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-signal-amber/10 px-1.5 py-0.5 text-2xs font-medium text-signal-amber"
    >
      <RotateCcw className="h-2.5 w-2.5" />
      x{count}
    </span>
  );
}
