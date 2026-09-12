import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Money, EmptyState, ErrorState, TableSkeleton } from '@/components/primitives';
import { when } from '@/lib/datetime';
import type { Paginated, LimitPurchaseDto, LimitPurchaseStatus } from '@/types';

const STATUS_STYLE: Record<LimitPurchaseStatus, string> = {
  AWAITING_PAYMENT: 'bg-ink-700/40 text-ink-300',
  PENDING: 'bg-signal-amber/10 text-signal-amber',
  APPROVED: 'bg-signal-green/10 text-signal-green',
  REJECTED: 'bg-signal-red/10 text-signal-red',
};

function StatusBadge({ status }: { status: LimitPurchaseStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium ${STATUS_STYLE[status]}`}
    >
      {status === 'PENDING' ? 'Awaiting you' : status === 'APPROVED' ? 'Confirmed' : 'Rejected'}
    </span>
  );
}

/**
 * Captains who have paid to raise their limit.
 *
 * A panel of its own rather than another row type under security deposits,
 * because the two do different things and confusing them is the expensive
 * mistake: security is split in half and posts collateral, whereas this posts
 * none and applies wholly to the captain's working capacity.
 *
 * Every row shows the decision admin is actually making — what the captain's
 * limit is now and what it becomes — worked out on the server from the same
 * rule the approval will apply, so the preview cannot disagree with the result.
 */
export function CaptainLimitPurchasesPanel({
  captainId,
  title = 'Limit purchases',
}: {
  captainId?: string;
  title?: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const scoped = Boolean(captainId);

  const params = new URLSearchParams({ page: '1', limit: '50', status: 'ALL' });
  if (captainId) params.set('captainId', captainId);

  const purchases = useQuery<Paginated<LimitPurchaseDto>>({
    queryKey: ['admin-limit-purchases', captainId ?? ''],
    queryFn: () => api.get<Paginated<LimitPurchaseDto>>(`/admin/limit-purchases?${params.toString()}`),
    refetchInterval: 30_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin-limit-purchases'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-captains'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-captain-detail'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-review-queue'] });
  };

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/admin/limit-purchases/${id}/approve`),
    onSuccess: () => {
      invalidate();
      toast.show('success', 'Purchase confirmed — capacity raised');
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const reject = useMutation({
    mutationFn: (id: string) =>
      api.post(`/admin/limit-purchases/${id}/reject`, { reason: rejectReason.trim() }),
    onSuccess: () => {
      invalidate();
      setRejectingId(null);
      setRejectReason('');
      toast.show('success', 'Purchase rejected');
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const pendingCount = purchases.data?.items.filter((p) => p.status === 'PENDING').length ?? 0;

  return (
    <Panel
      title={title}
      eyebrow={
        pendingCount > 0
          ? `${pendingCount} awaiting review`
          : purchases.data
            ? `${purchases.data.total} total`
            : undefined
      }
      bodyClassName={purchases.data?.items.length ? 'p-0' : undefined}
    >
      {purchases.isPending && <TableSkeleton rows={3} cols={2} />}
      {purchases.isError && (
        <ErrorState message="Could not load purchases." onRetry={() => void purchases.refetch()} />
      )}
      {purchases.data?.items.length === 0 && (
        <EmptyState
          title="Nothing yet"
          hint={
            scoped
              ? 'This captain has not bought any extra capacity.'
              : 'A captain paying to raise their limit appears here for you to verify.'
          }
        />
      )}
      {purchases.data && purchases.data.items.length > 0 && (
        <ul className="divide-y divide-ink-800">
          {purchases.data.items.map((p) => (
            <li key={p.id} className="px-4 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Money amount={p.amount} className="text-sm font-semibold text-ink-50" />
                    <StatusBadge status={p.status} />
                  </div>
                  {!scoped && (
                    <p className="mt-0.5 text-2xs text-ink-300">
                      {p.captainDisplayName ?? '—'}
                      <span className="ml-1.5 font-mono text-ink-500">{p.captainCode}</span>
                    </p>
                  )}
                  <p className="mt-0.5 font-mono text-2xs text-ink-400">
                    {p.proof.reference ? `txid ${p.proof.reference}` : 'no transaction reference yet'}
                  </p>
                  {p.payment?.usdtAmount != null && (
                    <p className="mt-0.5 text-2xs text-ink-400">
                      <span className="font-mono tnum text-ink-200">{p.payment.usdtAmount} USDT</span>
                      {' · '}
                      {p.payment.network ?? 'TRON (TRC20)'}
                      {p.payment.dmcPerUsdt != null && ` · 1 USDT = ${p.payment.dmcPerUsdt} DMC`}
                    </p>
                  )}
                  {p.payment?.address && (
                    <p className="mt-0.5 break-all font-mono text-2xs text-ink-500">
                      to {p.payment.address}
                    </p>
                  )}
                  {p.payment?.markedPaidAt == null && p.status === 'PENDING' && (
                    <p className="mt-0.5 text-2xs text-signal-amber">
                      Not yet marked as paid by the captain
                    </p>
                  )}

                  <p className="mt-0.5 font-mono tnum text-2xs text-ink-500">{when(p.createdAt)}</p>

                  {p.status === 'PENDING' && p.currentLimitBefore != null && (
                    <p className="mt-1 text-2xs text-ink-500">
                      Current limit <Money amount={p.currentLimitBefore} showUsdt={false} className="text-2xs" />
                      {' → '}
                      <Money
                        amount={p.currentLimitAfter ?? 0}
                        showUsdt={false}
                        className="text-2xs text-signal-cyan"
                      />
                      {p.captainCollateral != null && (
                        <>
                          {' · collateral '}
                          <Money amount={p.captainCollateral} showUsdt={false} className="text-2xs" />
                          {' stays as it is'}
                        </>
                      )}
                    </p>
                  )}
                  {p.status === 'APPROVED' && p.credited != null && (
                    <p className="mt-1 text-2xs text-signal-green">
                      <Money amount={p.credited} showUsdt={false} className="text-2xs" /> added to
                      their limit and their DMC. No collateral was posted.
                    </p>
                  )}
                  {p.proof.notes && <p className="mt-1 text-2xs text-ink-400">{p.proof.notes}</p>}
                  {p.rejectionReason && (
                    <p className="mt-1 text-2xs text-signal-red">{p.rejectionReason}</p>
                  )}
                  {p.proof.receiptUrl && (
                    <a
                      href={p.proof.receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-2xs text-brand-400 underline"
                    >
                      View receipt
                    </a>
                  )}
                </div>

                {p.status === 'PENDING' && (
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <button
                      type="button"
                      className="btn-primary px-3 py-1 text-2xs"
                      disabled={approve.isPending}
                      onClick={() => approve.mutate(p.id)}
                    >
                      Money received — approve
                    </button>
                    <button
                      type="button"
                      className="btn-ghost px-3 py-1 text-2xs"
                      onClick={() => {
                        setRejectingId(rejectingId === p.id ? null : p.id);
                        setRejectReason('');
                      }}
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>

              {rejectingId === p.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className="field flex-1 text-2xs"
                    placeholder="Why is this being rejected?"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-danger px-3 py-1 text-2xs"
                    disabled={reject.isPending || rejectReason.trim().length === 0}
                    onClick={() => reject.mutate(p.id)}
                  >
                    Confirm reject
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
