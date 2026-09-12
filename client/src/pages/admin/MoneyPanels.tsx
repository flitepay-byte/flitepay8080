import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Check, ShieldAlert } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Money, EmptyState, ErrorState, TableSkeleton, cn } from '@/components/primitives';
import type {
  DepositStatus,
  DmcPurchaseDto,
  Paginated,
  PartyTopUpRequestDto,
  TopUpStatus,
  WithdrawalStatus,
} from '@/types';
import { when } from '@/lib/datetime';

/**
 * The two ledgers that are not admin's own money: what captains have withdrawn,
 * and what parties have paid in.
 *
 * They live here rather than in Wallet.tsx because admin only observes them
 * and, where a genuine dispute exists, rules on them. Each panel takes an
 * optional scope so one component serves both the whole-system Funds &
 * deposits page and a single party's or captain's profile.
 */

const PORTION_STATUS_STYLE: Record<WithdrawalStatus, string> = {
  PENDING: 'bg-signal-amber/10 text-signal-amber',
  PARTY_PAID: 'bg-brand-500/10 text-brand-500',
  FULFILLED: 'bg-signal-green/10 text-signal-green',
  DISPUTED: 'bg-signal-red/10 text-signal-red',
  CANCELLED: 'bg-ink-700/60 text-ink-300',
};
const PORTION_STATUS_LABEL: Record<WithdrawalStatus, string> = {
  PENDING: 'Awaiting party',
  PARTY_PAID: 'Party paid',
  FULFILLED: 'Settled',
  DISPUTED: 'Disputed',
  CANCELLED: 'Cancelled',
};

export function PortionStatusBadge({ status }: { status: WithdrawalStatus }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium', PORTION_STATUS_STYLE[status])}>
      {PORTION_STATUS_LABEL[status]}
    </span>
  );
}

const TOPUP_STATUS_STYLE: Record<TopUpStatus, string> = {
  AWAITING_PAYMENT: 'bg-ink-700/40 text-ink-300',
  PENDING: 'bg-signal-amber/10 text-signal-amber',
  APPROVED: 'bg-signal-green/10 text-signal-green',
  REJECTED: 'bg-signal-red/10 text-signal-red',
};
const TOPUP_STATUS_LABEL: Record<TopUpStatus, string> = {
  AWAITING_PAYMENT: 'Not submitted yet',
  PENDING: 'Awaiting review',
  APPROVED: 'Credited',
  REJECTED: 'Rejected',
};

export function TopUpStatusBadge({ status }: { status: TopUpStatus }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium', TOPUP_STATUS_STYLE[status])}>
      {TOPUP_STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Admin's ruling on a disputed portion — the only way out of DISPUTED. Until
 * this existed the portion stayed stuck, which also pinned the whole
 * withdrawal open and stopped that captain requesting another one.
 */
export function ResolveDispute({ portionId, scope }: { portionId: string; scope: 'captain' | 'own' }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);

  const path = scope === 'captain' ? 'captain-withdrawal-portions' : 'withdrawal-portions';

  const resolve = useMutation({
    mutationFn: (decision: 'SETTLE' | 'RETRY') => api.post(`/admin/${path}/${portionId}/resolve`, { decision }),
    onSuccess: (_, decision) => {
      toast.show(
        'success',
        decision === 'SETTLE'
          ? 'Marked as received — the portion is settled.'
          : 'The party has been asked to pay this again.',
      );
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['admin-captain-withdrawal-portions'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-withdrawal-portions'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary py-1 text-2xs">
        Resolve
      </button>
    );
  }

  return (
    <div className="flex justify-end gap-1.5">
      <button
        type="button"
        onClick={() => resolve.mutate('SETTLE')}
        disabled={resolve.isPending}
        className="btn-secondary py-1 text-2xs"
      >
        {resolve.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Payment arrived'}
      </button>
      <button
        type="button"
        onClick={() => resolve.mutate('RETRY')}
        disabled={resolve.isPending}
        className="btn-danger py-1 text-2xs"
      >
        Pay again
      </button>
      <button type="button" onClick={() => setOpen(false)} className="btn-ghost py-1 text-2xs">
        Cancel
      </button>
    </div>
  );
}

/**
 * Every party top-up — real security money a party says it sent, which admin
 * confirms before any DMC is credited.
 *
 * The full history is shown rather than only the pending queue, because
 * "has this party paid in before, and was it confirmed" is what a profile has
 * to answer. A row still awaiting review carries its Confirm and Reject
 * buttons wherever it appears.
 */
export function PartyTopUpsPanel({
  partyId,
  search,
  title = 'Party top-ups',
}: {
  partyId?: string;
  search?: string;
  title?: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const scoped = Boolean(partyId);

  const params = new URLSearchParams({ page: '1', limit: '50', status: 'ALL' });
  if (partyId) params.set('partyId', partyId);
  if (search) params.set('search', search);

  const topUps = useQuery<Paginated<PartyTopUpRequestDto>>({
    queryKey: ['admin-topups', partyId ?? '', search ?? ''],
    queryFn: () => api.get<Paginated<PartyTopUpRequestDto>>(`/admin/dmc-topups?${params.toString()}`),
    refetchInterval: 30_000,
  });

  // A decision here changes the same record wherever it is on screen — this
  // party's profile and the Funds & deposits page both list it.
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin-topups'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-parties'] });
  };

  const approve = useMutation({
    mutationFn: (id: string) => api.post<PartyTopUpRequestDto>(`/admin/dmc-topups/${id}/approve`),
    onSuccess: () => {
      toast.show('success', 'Top-up confirmed and credited.');
      invalidate();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const reject = useMutation({
    mutationFn: (id: string) =>
      api.post<PartyTopUpRequestDto>(`/admin/dmc-topups/${id}/reject`, { reason: rejectReason.trim() }),
    onSuccess: () => {
      toast.show('info', 'Top-up rejected.');
      setRejectingId(null);
      setRejectReason('');
      invalidate();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const pendingCount = topUps.data?.items.filter((t) => t.status === 'PENDING').length ?? 0;

  return (
    <Panel
      title={title}
      eyebrow={
        pendingCount > 0
          ? `${pendingCount} awaiting review`
          : topUps.data
            ? `${topUps.data.total} total`
            : undefined
      }
      bodyClassName={topUps.data?.items.length ? 'p-0' : undefined}
    >
      {topUps.isPending && <TableSkeleton rows={3} cols={2} />}
      {topUps.isError && (
        <ErrorState message="Could not load top-up requests." onRetry={() => void topUps.refetch()} />
      )}
      {topUps.data?.items.length === 0 && (
        <EmptyState
          title={search ? 'Nothing matched' : 'Nothing yet'}
          hint={
            search
              ? 'No top-up from a party by that name.'
              : scoped
                ? 'This party has not topped up its DMC balance yet.'
                : 'A DMC top-up request appears here for you to verify.'
          }
        />
      )}
      {topUps.data && topUps.data.items.length > 0 && (
        <ul className="divide-y divide-ink-800">
          {topUps.data.items.map((t) => (
            <li key={t.id} className="px-4 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Money amount={t.amount} className="text-sm font-semibold text-ink-50" />
                    <TopUpStatusBadge status={t.status} />
                  </div>
                  {!scoped && (
                    <p className="mt-0.5 text-2xs text-ink-300">
                      {t.partyCompanyName ?? '—'}
                      <span className="ml-1.5 font-mono text-ink-500">{t.partyCode}</span>
                    </p>
                  )}
                  <p className="mt-0.5 font-mono text-2xs text-ink-400">ref {t.proof.reference}</p>
                  <p className="mt-0.5 font-mono tnum text-2xs text-ink-500">
                    {when(t.createdAt)}
                  </p>
                  {t.proof.notes && <p className="mt-1 text-2xs text-ink-400">{t.proof.notes}</p>}
                  {t.rejectionReason && <p className="mt-1 text-2xs text-signal-red">{t.rejectionReason}</p>}
                  {t.proof.receiptUrl && (
                    <a
                      href={t.proof.receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-2xs text-brand-500 hover:underline"
                    >
                      View proof
                    </a>
                  )}
                </div>
                {t.status === 'PENDING' && rejectingId !== t.id && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => approve.mutate(t.id)}
                      disabled={approve.isPending}
                      className="btn-primary"
                    >
                      {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="h-4 w-4" /> Confirm</>}
                    </button>
                    <button type="button" onClick={() => setRejectingId(t.id)} className="btn-danger">
                      <ShieldAlert className="h-4 w-4" /> Reject
                    </button>
                  </div>
                )}
              </div>
              {rejectingId === t.id && (
                <div className="mt-3 space-y-2.5">
                  <textarea
                    rows={2}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    className="field-input resize-none"
                    placeholder="Why this payment was not confirmed"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => reject.mutate(t.id)}
                      disabled={rejectReason.trim().length < 5 || reject.isPending}
                      className="btn-danger flex-1"
                    >
                      {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm rejection'}
                    </button>
                    <button type="button" onClick={() => setRejectingId(null)} className="btn-secondary">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const DEPOSIT_STATUS_STYLE: Record<DepositStatus, string> = {
  AWAITING_PAYMENT: 'bg-ink-700/40 text-ink-300',
  PENDING: 'bg-signal-amber/10 text-signal-amber',
  APPROVED: 'bg-signal-green/10 text-signal-green',
  REJECTED: 'bg-signal-red/10 text-signal-red',
};
const DEPOSIT_STATUS_LABEL: Record<DepositStatus, string> = {
  AWAITING_PAYMENT: 'Not submitted yet',
  PENDING: 'Awaiting review',
  APPROVED: 'Added to collateral',
  REJECTED: 'Rejected',
};

export function DepositStatusBadge({ status }: { status: DepositStatus }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium', DEPOSIT_STATUS_STYLE[status])}>
      {DEPOSIT_STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Captains posting security money to raise their collateral.
 *
 * Nothing moved when the captain submitted this — confirming here is what
 * credits their collateral, so the reference is worth checking against the
 * platform account first. Same handshake as a party top-up: whoever receives
 * the money is the one who confirms it.
 */
export function CaptainDepositsPanel({
  captainId,
  search,
  title = 'Security deposits',
}: {
  captainId?: string;
  search?: string;
  title?: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const scoped = Boolean(captainId);

  const params = new URLSearchParams({ page: '1', limit: '50', status: 'ALL' });
  if (captainId) params.set('captainId', captainId);
  if (search) params.set('search', search);

  const deposits = useQuery<Paginated<DmcPurchaseDto>>({
    queryKey: ['admin-collateral-deposits', captainId ?? '', search ?? ''],
    queryFn: () => api.get<Paginated<DmcPurchaseDto>>(`/admin/collateral-deposits?${params.toString()}`),
    refetchInterval: 30_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin-collateral-deposits'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-captains'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-captain-detail'] });
  };

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/admin/collateral-deposits/${id}/approve`),
    onSuccess: () => {
      toast.show('success', 'Deposit confirmed and added to their collateral.');
      invalidate();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const reject = useMutation({
    mutationFn: (id: string) =>
      api.post(`/admin/collateral-deposits/${id}/reject`, { reason: rejectReason.trim() }),
    onSuccess: () => {
      toast.show('info', 'Deposit rejected. No collateral was moved.');
      setRejectingId(null);
      setRejectReason('');
      invalidate();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const pendingCount = deposits.data?.items.filter((d) => d.status === 'PENDING').length ?? 0;

  return (
    <Panel
      title={title}
      eyebrow={
        pendingCount > 0
          ? `${pendingCount} awaiting review`
          : deposits.data
            ? `${deposits.data.total} total`
            : undefined
      }
      bodyClassName={deposits.data?.items.length ? 'p-0' : undefined}
    >
      {deposits.isPending && <TableSkeleton rows={3} cols={2} />}
      {deposits.isError && (
        <ErrorState message="Could not load deposits." onRetry={() => void deposits.refetch()} />
      )}
      {deposits.data?.items.length === 0 && (
        <EmptyState
          title={search ? 'Nothing matched' : 'Nothing yet'}
          hint={
            search
              ? 'No deposit from a captain by that name.'
              : scoped
                ? 'This captain has not posted any security money yet.'
                : 'A captain posting security money appears here for you to verify.'
          }
        />
      )}
      {deposits.data && deposits.data.items.length > 0 && (
        <ul className="divide-y divide-ink-800">
          {deposits.data.items.map((d) => (
            <li key={d.id} className="px-4 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Money amount={d.amount} className="text-sm font-semibold text-ink-50" />
                    <DepositStatusBadge status={d.status} />
                  </div>
                  {!scoped && (
                    <p className="mt-0.5 text-2xs text-ink-300">
                      {d.captainDisplayName ?? '—'}
                      <span className="ml-1.5 font-mono text-ink-500">{d.captainCode}</span>
                    </p>
                  )}
                  <p className="mt-0.5 font-mono text-2xs text-ink-400">ref {d.proof.reference}</p>
                  <p className="mt-0.5 font-mono tnum text-2xs text-ink-500">
                    {when(d.createdAt)}
                  </p>
                  {d.status === 'PENDING' && d.captainCollateral != null && (
                    <p className="mt-1 text-2xs text-ink-500">
                      Their collateral today is{' '}
                      <Money amount={d.captainCollateral} className="text-2xs" />.
                    </p>
                  )}
                  {d.proof.notes && <p className="mt-1 text-2xs text-ink-400">{d.proof.notes}</p>}
                  {d.rejectionReason && <p className="mt-1 text-2xs text-signal-red">{d.rejectionReason}</p>}
                  {d.proof.receiptUrl && (
                    <a
                      href={d.proof.receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-2xs text-brand-500 hover:underline"
                    >
                      View proof
                    </a>
                  )}
                </div>
                {d.status === 'PENDING' && rejectingId !== d.id && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => approve.mutate(d.id)}
                      disabled={approve.isPending}
                      className="btn-primary"
                    >
                      {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="h-4 w-4" /> Confirm</>}
                    </button>
                    <button type="button" onClick={() => setRejectingId(d.id)} className="btn-danger">
                      <ShieldAlert className="h-4 w-4" /> Reject
                    </button>
                  </div>
                )}
              </div>
              {rejectingId === d.id && (
                <div className="mt-3 space-y-2.5">
                  <textarea
                    rows={2}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    className="field-input resize-none"
                    placeholder="Why this deposit was not confirmed"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => reject.mutate(d.id)}
                      disabled={rejectReason.trim().length < 5 || reject.isPending}
                      className="btn-danger flex-1"
                    >
                      {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm rejection'}
                    </button>
                    <button type="button" onClick={() => setRejectingId(null)} className="btn-secondary">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
