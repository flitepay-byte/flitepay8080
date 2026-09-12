import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, Loader2, X, AlertCircle, Check, ShieldAlert, Wallet as WalletIcon, Banknote } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Money, EmptyState, ErrorState, TableSkeleton, cn } from '@/components/primitives';
import { PortionStatusBadge, ResolveDispute } from './MoneyPanels';
import type {
  AdminWithdrawalRequestDto,
  AdminWithdrawalPortionDto,
  Paginated,
  PlatformAccountDto,
  RedemptionDto,
  RequestStatus,
} from '@/types';
import { when } from '@/lib/datetime';

const REQUEST_STATUS_STYLE: Record<RequestStatus, string> = {
  PENDING: 'bg-signal-amber/10 text-signal-amber',
  FULFILLED: 'bg-signal-green/10 text-signal-green',
  CANCELLED: 'bg-ink-700/60 text-ink-300',
};
const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  PENDING: 'In progress',
  FULFILLED: 'Fulfilled',
  CANCELLED: 'Cancelled',
};


function RequestStatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium', REQUEST_STATUS_STYLE[status])}>
      {REQUEST_STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Admin's own DMC wallet — cashing out earned platform commission. Admin
 * requests only a total; the backend splits it into one portion per source
 * party, same as a captain's Pay In. Each portion is a two-sided handshake:
 * a party pays and submits proof, but nothing is final until admin verifies
 * it — a dispute on one portion never blocks another. Unlike a captain,
 * admin sees the full source trace on every portion.
 */
export function AdminWallet() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [fundAmount, setFundAmount] = useState('');
  const [fundReference, setFundReference] = useState('');
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payReference, setPayReference] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const account = useQuery<PlatformAccountDto>({
    queryKey: ['admin-wallet'],
    queryFn: () => api.get<PlatformAccountDto>('/admin/wallet'),
  });

  const requests = useQuery<Paginated<AdminWithdrawalRequestDto>>({
    queryKey: ['admin-withdrawals'],
    queryFn: () => api.get<Paginated<AdminWithdrawalRequestDto>>('/admin/withdrawals?page=1&limit=20'),
  });

  const portions = useQuery<Paginated<AdminWithdrawalPortionDto>>({
    queryKey: ['admin-withdrawal-portions'],
    queryFn: () => api.get<Paginated<AdminWithdrawalPortionDto>>('/admin/withdrawal-portions?page=1&limit=50'),
  });

  const activeRequest = requests.data?.items.find((r) => r.status === 'PENDING') ?? null;
  const activePortions = activeRequest
    ? (portions.data?.items.filter((p) => p.withdrawalRequestId === activeRequest.id) ?? [])
    : [];
  const canCancelActive = activeRequest != null && activePortions.every((p) => p.status === 'PENDING');
  const awaitingConfirmation = portions.data?.items.filter((p) => p.status === 'PARTY_PAID') ?? [];

  const redemptions = useQuery<Paginated<RedemptionDto>>({
    queryKey: ['admin-redemptions'],
    queryFn: () => api.get<Paginated<RedemptionDto>>('/admin/redemptions?page=1&limit=50'),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin-withdrawals'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-withdrawal-portions'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-wallet'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-redemptions'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-review-queue'] });
  };

  const request = useMutation({
    mutationFn: () => api.post<AdminWithdrawalRequestDto>('/admin/withdrawals', { amount: Number(amount) }),
    onSuccess: () => {
      toast.show('success', 'Withdrawal request sent to the party(s) it belongs to.');
      setAmount('');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.post<AdminWithdrawalRequestDto>(`/admin/withdrawals/${id}/cancel`),
    onSuccess: () => {
      toast.show('info', 'Withdrawal request cancelled.');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });




  const fundPool = useMutation({
    mutationFn: () =>
      api.post('/admin/platform/pool/fund', {
        amount: Number(fundAmount),
        ...(fundReference.trim() ? { reference: fundReference.trim() } : {}),
      }),
    onSuccess: () => {
      toast.show('success', 'Commission pool funded.');
      setFundAmount('');
      setFundReference('');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const payCashOut = useMutation({
    mutationFn: (id: string) => api.post(`/admin/redemptions/${id}/pay`, { reference: payReference.trim() }),
    onSuccess: () => {
      toast.show('success', 'Cash-out marked as paid.');
      setPayingId(null);
      setPayReference('');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const rejectCashOut = useMutation({
    mutationFn: (id: string) => api.post(`/admin/redemptions/${id}/reject`, { reason: rejectReason.trim() }),
    onSuccess: () => {
      toast.show('info', 'Cash-out rejected — the DMC went back to the captain.');
      setRejectingId(null);
      setRejectReason('');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const pendingCashOuts = redemptions.data?.items ?? [];
  const poolBalance = account.data?.poolBalance ?? 0;
  const parsedFund = Number(fundAmount);
  const fundValid = fundAmount.trim() !== '' && parsedFund > 0;

  // The pool is the platform's balance, so it is also what an admin
  // withdrawal draws from. There is no second figure to reconcile against.
  const balance = poolBalance;
  const parsedAmount = Number(amount);
  const amountError =
    amount.trim() === ''
      ? null
      : !(parsedAmount > 0)
        ? 'Enter an amount greater than zero'
        : parsedAmount > balance
          ? `Only ${balance.toLocaleString('en-IN')} DMC in the pool`
          : null;

  const valid = !activeRequest && amount.trim() !== '' && !amountError;

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">My wallet</h1>
        <p className="mt-1 text-xs text-ink-400">
          The pool is the platform&apos;s balance: parties&apos; commission flows into it, captains&apos;
          shares are paid out of it, and what is left is what you have made. Withdraw it the same way a
          captain does — each source party pays and attaches proof, and you verify it before anything is
          final. Captains and parties have their own ledgers under Funds &amp; deposits.
        </p>
      </div>

      {awaitingConfirmation.map((portion) => (
        <VerifyPaymentPanel key={portion.id} portion={portion} onDone={refresh} />
      ))}

      {/*
        The pool and the cash-out queue are the two halves of the platform's
        real-money position: what it has put in to pay captains with, and what
        it owes them right now. They sit above admin's own withdrawal because
        both are obligations, and admin's cut is not.
      */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        <Panel
          title="Commission pool"
          eyebrow="funds what captains earn"
          action={<WalletIcon className="h-4 w-4 text-ink-400" />}
        >
          <div className="mb-3.5 space-y-2 rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
            <div className="flex items-baseline justify-between">
              <p className="eyebrow">Left to pay out</p>
              <p className={cn(
                'font-mono tnum text-sm font-semibold',
                poolBalance > 0 ? 'text-ink-50' : 'text-signal-red',
              )}>
                <Money showUsdt={false} amount={poolBalance} />
              </p>
            </div>
            <div className="flex items-baseline justify-between border-t border-ink-700 pt-2">
              <p className="eyebrow">Charged to parties</p>
              <p className="font-mono tnum text-sm text-ink-300">
                <Money showUsdt={false} amount={account.data?.poolCollected ?? 0} />
              </p>
            </div>
            <div className="flex items-baseline justify-between">
              <p className="eyebrow">Paid to captains</p>
              <p className="font-mono tnum text-sm text-ink-300">
                <Money showUsdt={false} amount={account.data?.poolPaidOut ?? 0} />
              </p>
            </div>
            {/* Income less cost. The one line that says whether running the
                network makes money or costs money. */}
            <div className="flex items-baseline justify-between border-t border-ink-700 pt-2">
              <p className="eyebrow">Made on commission</p>
              <p className={cn(
                'font-mono tnum text-sm font-semibold',
                (account.data?.poolNet ?? 0) >= 0 ? 'text-signal-green' : 'text-signal-red',
              )}>
                <Money showUsdt={false} amount={account.data?.poolNet ?? 0} />
              </p>
            </div>
            <div className="flex items-baseline justify-between">
              <p className="eyebrow">Funded from your own money</p>
              <p className="font-mono tnum text-sm text-ink-300">
                <Money showUsdt={false} amount={account.data?.poolFundedTotal ?? 0} />
              </p>
            </div>
          </div>

          {poolBalance <= 0 && (
            <p className="mb-3.5 rounded-md border border-signal-red/40 bg-signal-red/10 px-3 py-2 text-2xs leading-relaxed text-signal-red">
              The pool is empty, so commission cannot be paid. Work still completes and captains still keep
              their capital — but their fee goes unpaid until this is funded.
            </p>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (fundValid && !fundPool.isPending) fundPool.mutate();
            }}
            className="space-y-3.5"
          >
            <div>
              <label htmlFor="fund-amount" className="field-label">Add funds (DMC)</label>
              <input
                id="fund-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={fundAmount}
                onChange={(e) => setFundAmount(e.target.value)}
                placeholder="50000"
                className="field-input font-mono tnum"
              />
            </div>
            <div>
              <label htmlFor="fund-reference" className="field-label">Reference (optional)</label>
              <input
                id="fund-reference"
                value={fundReference}
                onChange={(e) => setFundReference(e.target.value)}
                placeholder="Bank transfer ID"
                className="field-input font-mono"
              />
            </div>
            <button type="submit" disabled={!fundValid || fundPool.isPending} className="btn-primary w-full">
              {fundPool.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><WalletIcon className="h-4 w-4" /> Fund the pool</>}
            </button>
            <p className="text-2xs leading-relaxed text-ink-500">
              This is real money the platform puts behind the commission it promises. Captain earnings are
              paid out of it rather than created when earned, so what the network costs to run is a number
              you can watch go down.
            </p>
          </form>
        </Panel>

        <Panel
          title="Captains waiting to be paid out"
          eyebrow="send the transfer, then confirm here"
          action={<Banknote className="h-4 w-4 text-ink-400" />}
          bodyClassName={pendingCashOuts.length ? 'p-0' : undefined}
        >
          {redemptions.isPending && <TableSkeleton rows={2} cols={4} />}
          {!redemptions.isPending && pendingCashOuts.length === 0 && (
            <EmptyState title="Nothing waiting" hint="Cash-out requests from captains appear here." />
          )}
          {pendingCashOuts.length > 0 && (
            <div className="divide-y divide-ink-800">
              {pendingCashOuts.map((r) => (
                <div key={r.id} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium text-ink-100">
                        {r.captainName ?? 'Captain'}{' '}
                        <span className="font-mono text-2xs text-ink-500">{r.captainCode ?? ''}</span>
                      </p>
                      <p className="mt-0.5 font-mono text-2xs text-ink-400">
                        {r.payoutMethod === 'UPI'
                          ? `UPI · ${r.payoutUpiId ?? ''}`
                          : `${r.payoutAccountName ?? ''} · ${r.payoutAccountNumber ?? ''} · ${r.payoutIfsc ?? ''}`}
                      </p>
                    </div>
                    <Money amount={r.amount} className="text-sm font-semibold text-ink-50" />
                  </div>

                  {payingId === r.id ? (
                    <div className="mt-3 space-y-2">
                      <input
                        value={payReference}
                        onChange={(e) => setPayReference(e.target.value)}
                        placeholder="Transfer reference (UTR / NEFT)"
                        className="field-input font-mono"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => payCashOut.mutate(r.id)}
                          disabled={payReference.trim().length < 4 || payCashOut.isPending}
                          className="btn-primary flex-1"
                        >
                          {payCashOut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="h-4 w-4" /> Confirm paid</>}
                        </button>
                        <button type="button" onClick={() => setPayingId(null)} className="btn-ghost px-3">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : rejectingId === r.id ? (
                    <div className="mt-3 space-y-2">
                      <input
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Why it cannot be paid"
                        className="field-input"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => rejectCashOut.mutate(r.id)}
                          disabled={rejectReason.trim().length < 4 || rejectCashOut.isPending}
                          className="btn-secondary flex-1"
                        >
                          {rejectCashOut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><X className="h-4 w-4" /> Reject and return</>}
                        </button>
                        <button type="button" onClick={() => setRejectingId(null)} className="btn-ghost px-3">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => { setPayingId(r.id); setRejectingId(null); setPayReference(''); }}
                        className="btn-primary flex-1"
                      >
                        <Banknote className="h-4 w-4" /> I have sent it
                      </button>
                      <button
                        type="button"
                        onClick={() => { setRejectingId(r.id); setPayingId(null); setRejectReason(''); }}
                        className="btn-ghost px-3"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        <Panel title="Request withdrawal" eyebrow={`balance: ${balance.toLocaleString('en-IN')} DMC`} action={<ArrowDownToLine className="h-4 w-4 text-ink-400" />}>
          {activeRequest ? (
            <div className="space-y-3">
              <p className="text-xs text-ink-300">
                You have a withdrawal of <Money amount={activeRequest.amount} className="text-xs font-semibold text-ink-50" /> in progress.
              </p>
              {canCancelActive ? (
                <button
                  type="button"
                  onClick={() => cancel.mutate(activeRequest.id)}
                  disabled={cancel.isPending}
                  className="btn-secondary w-full"
                >
                  {cancel.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><X className="h-4 w-4" /> Cancel request</>}
                </button>
              ) : (
                <p className="text-xs text-ink-400">Verify payment above before requesting another withdrawal.</p>
              )}
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (valid && !request.isPending) request.mutate();
              }}
              className="space-y-3.5"
            >
              <div>
                <label htmlFor="admin-payin-amount" className="field-label">Amount (DMC)</label>
                <input
                  id="admin-payin-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className={cn('field-input font-mono tnum', amountError && 'border-signal-red')}
                />
                {amountError && <p className="field-error"><AlertCircle className="h-3 w-3" />{amountError}</p>}
              </div>

              <button type="submit" disabled={!valid || request.isPending} className="btn-primary w-full">
                {request.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><ArrowDownToLine className="h-4 w-4" /> Request withdrawal</>}
              </button>
            </form>
          )}
        </Panel>

        <Panel title="Withdrawal history" bodyClassName={requests.data?.items.length ? 'p-0' : undefined}>
          {requests.isPending && <TableSkeleton rows={4} cols={3} />}
          {requests.isError && <ErrorState message="Could not load requests." onRetry={() => void requests.refetch()} />}
          {requests.data?.items.length === 0 && (
            <EmptyState title="No withdrawals yet" hint="Request one once commission has accrued." />
          )}
          {requests.data && requests.data.items.length > 0 && (
            <ul className="divide-y divide-ink-800">
              {requests.data.items.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5">
                  <div>
                    <Money amount={r.amount} className="text-sm font-semibold text-ink-50" />
                    <p className="mt-1 font-mono tnum text-2xs text-ink-500">
                      {when(r.createdAt)}
                    </p>
                  </div>
                  <RequestStatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Payment activity" eyebrow="one entry per source party" bodyClassName={portions.data?.items.length ? 'p-0' : undefined}>
        {portions.isPending && <TableSkeleton rows={4} cols={3} />}
        {portions.isError && <ErrorState message="Could not load payment activity." onRetry={() => void portions.refetch()} />}
        {portions.data?.items.length === 0 && (
          <EmptyState title="No activity yet" hint="Each withdrawal may be settled by more than one party — activity appears here per slice." />
        )}
        {portions.data && portions.data.items.length > 0 && (
          <ul className="divide-y divide-ink-800">
            {portions.data.items.map((p) => (
              <li key={p.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Money amount={p.amount} className="text-sm font-semibold text-ink-50" />
                  <PortionStatusBadge status={p.status} />
                </div>
                {p.allocations.length > 0 && (
                  <p className="mt-1 font-mono text-2xs text-ink-500">
                    from {p.allocations.map((a) => `${a.taskCode} (${a.customerName})`).join(', ')}
                  </p>
                )}
                {(p.status === 'FULFILLED' || p.status === 'DISPUTED') && p.proof && (
                  <div className="mt-2.5 rounded-md border border-ink-700 bg-ink-850/60 px-3 py-2.5">
                    <p className="text-2xs text-ink-300">
                      Paid by party · ref <span className="font-mono text-ink-100">{p.proof.reference}</span>
                    </p>
                    {p.proof.notes && <p className="mt-1 text-2xs text-ink-400">{p.proof.notes}</p>}
                    {p.proof.receiptUrl && (
                      <a href={p.proof.receiptUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-2xs text-brand-500 hover:underline">
                        View proof
                      </a>
                    )}
                    {p.status === 'DISPUTED' && p.disputeReason && (
                      <p className="mt-1.5 text-2xs text-signal-red">Disputed: {p.disputeReason}</p>
                    )}
                  </div>
                )}
                {p.status === 'DISPUTED' && (
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-2xs text-ink-400">Settle this dispute:</span>
                    <ResolveDispute portionId={p.id} scope="own" />
                  </div>
                )}
                <p className="mt-1.5 font-mono tnum text-2xs text-ink-500">
                  {when(p.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

    </div>
  );
}

function VerifyPaymentPanel({ portion, onDone }: { portion: AdminWithdrawalPortionDto; onDone: () => void }) {
  const toast = useToast();
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState('');

  const confirm = useMutation({
    mutationFn: () => api.post(`/admin/withdrawal-portions/${portion.id}/confirm`),
    onSuccess: () => {
      toast.show('success', 'Payment confirmed. The commission balance has been updated.');
      onDone();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const dispute = useMutation({
    mutationFn: () => api.post(`/admin/withdrawal-portions/${portion.id}/dispute`, { reason: reason.trim() }),
    onSuccess: () => {
      toast.show('info', 'Marked as disputed.');
      setDisputing(false);
      setReason('');
      onDone();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  return (
    <Panel title="Verify payment" eyebrow="a party says they paid this portion">
      <div className="space-y-3.5">
        <Money amount={portion.amount} className="text-lg font-semibold text-ink-50" />

        {portion.allocations.length > 0 && (
          <p className="font-mono text-2xs text-ink-500">
            from {portion.allocations.map((a) => `${a.taskCode} (${a.customerName})`).join(', ')}
          </p>
        )}

        {portion.proof && (
          <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3 py-2.5">
            <p className="text-2xs text-ink-300">
              Reference <span className="font-mono text-ink-100">{portion.proof.reference}</span>
            </p>
            {portion.proof.notes && <p className="mt-1 text-2xs text-ink-400">{portion.proof.notes}</p>}
            {portion.proof.receiptUrl && (
              <a href={portion.proof.receiptUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-2xs text-brand-500 hover:underline">
                View proof
              </a>
            )}
          </div>
        )}

        {disputing ? (
          <div className="space-y-3">
            <div>
              <label htmlFor={`admin-dispute-reason-${portion.id}`} className="field-label">What went wrong?</label>
              <textarea
                id={`admin-dispute-reason-${portion.id}`}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="field-input resize-none"
                placeholder="e.g. I never received this payment"
                autoFocus
              />
              <p className="mt-1.5 text-2xs text-ink-500">At least 5 characters.</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => dispute.mutate()}
                disabled={reason.trim().length < 5 || dispute.isPending}
                className="btn-danger flex-1"
              >
                {dispute.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm dispute'}
              </button>
              <button type="button" onClick={() => setDisputing(false)} className="btn-secondary">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button type="button" onClick={() => confirm.mutate()} disabled={confirm.isPending} className="btn-primary flex-1">
              {confirm.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="h-4 w-4" /> I received this</>}
            </button>
            <button type="button" onClick={() => setDisputing(true)} className="btn-danger flex-1">
              <ShieldAlert className="h-4 w-4" /> I didn't receive this
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}
