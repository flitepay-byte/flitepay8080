import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Mail, Phone, Wallet } from 'lucide-react';
import { api, type ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, EmptyState, ErrorState, TableSkeleton } from '@/components/primitives';
import { when } from '@/lib/datetime';
import type { Paginated, CaptainRegistrationDto, RegistrationStatus } from '@/types';

const STATUS_STYLE: Record<RegistrationStatus, string> = {
  PENDING_EMAIL: 'bg-ink-700/40 text-ink-300',
  PENDING_APPROVAL: 'bg-signal-amber/10 text-signal-amber',
  APPROVED: 'bg-signal-green/10 text-signal-green',
  REJECTED: 'bg-signal-red/10 text-signal-red',
};

const STATUS_LABEL: Record<RegistrationStatus, string> = {
  PENDING_EMAIL: 'Email not confirmed',
  PENDING_APPROVAL: 'Awaiting you',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

const FILTERS: { value: RegistrationStatus | 'ALL'; label: string }[] = [
  { value: 'PENDING_APPROVAL', label: 'Awaiting you' },
  { value: 'PENDING_EMAIL', label: 'Not confirmed' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'ALL', label: 'All' },
];

/**
 * Captains who have applied to join.
 *
 * Approving one here is the only thing in the application that creates a captain
 * account, which is why the panel says what approval will and will not do: it
 * opens a sign-in, and it grants no money and no capacity. The captain starts at
 * zero and posts security afterwards like any other.
 *
 * Applicants who have not confirmed their email are visible but cannot be
 * approved — there is nothing yet to say the address is theirs.
 */
export function AdminCaptainRegistrations() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<RegistrationStatus | 'ALL'>('PENDING_APPROVAL');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const registrations = useQuery<Paginated<CaptainRegistrationDto>>({
    queryKey: ['admin-captain-registrations', filter],
    queryFn: () =>
      api.get<Paginated<CaptainRegistrationDto>>(
        `/admin/captain-registrations?page=1&limit=50&status=${filter}`,
      ),
    refetchInterval: 30_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin-captain-registrations'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-captains'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-review-queue'] });
  };

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/admin/captain-registrations/${id}/approve`),
    onSuccess: () => {
      invalidate();
      toast.show('success', 'Approved — they can sign in now');
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const reject = useMutation({
    mutationFn: (id: string) =>
      api.post(`/admin/captain-registrations/${id}/reject`, { reason: rejectReason.trim() }),
    onSuccess: () => {
      invalidate();
      setRejectingId(null);
      setRejectReason('');
      toast.show('success', 'Registration rejected');
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const items = registrations.data?.items ?? [];
  const awaiting = items.filter((r) => r.status === 'PENDING_APPROVAL').length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink-50">Captain registrations</h1>
        <p className="mt-1 text-xs text-ink-400">
          Approving opens a sign-in. It grants no DMC, no collateral and no limit — an approved captain
          starts at zero and posts security money the ordinary way.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={
              filter === f.value
                ? 'rounded-full bg-brand-600 px-3 py-1 text-2xs font-medium text-white'
                : 'rounded-full border border-ink-700 px-3 py-1 text-2xs text-ink-300 hover:border-ink-600'
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      <Panel
        title="Applications"
        eyebrow={awaiting > 0 ? `${awaiting} awaiting you` : `${registrations.data?.total ?? 0} total`}
        action={<UserPlus className="h-4 w-4 text-ink-400" />}
        bodyClassName={items.length ? 'p-0' : undefined}
      >
        {registrations.isPending && <TableSkeleton rows={3} cols={2} />}
        {registrations.isError && (
          <ErrorState
            message="Could not load registrations."
            onRetry={() => void registrations.refetch()}
          />
        )}
        {!registrations.isPending && items.length === 0 && (
          <EmptyState
            title="Nothing here"
            hint={
              filter === 'PENDING_APPROVAL'
                ? 'Nobody is waiting on a decision right now.'
                : 'No registrations match this filter.'
            }
          />
        )}

        {items.length > 0 && (
          <ul className="divide-y divide-ink-800">
            {items.map((r) => (
              <li key={r.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-ink-50">{r.name}</span>
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium ${STATUS_STYLE[r.status]}`}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                      {r.captainCode && (
                        <span className="font-mono text-2xs text-ink-400">{r.captainCode}</span>
                      )}
                    </div>

                    <p className="mt-0.5 text-2xs text-ink-300">{r.fullName}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-2xs text-ink-400">
                      <span className="inline-flex items-center gap-1">
                        <Mail className="h-3 w-3" />
                        {r.email}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Phone className="h-3 w-3" />
                        {r.mobile}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Wallet className="h-3 w-3" />
                        {r.upiId}
                      </span>
                    </p>
                    <p className="mt-0.5 font-mono tnum text-2xs text-ink-500">
                      applied {when(r.createdAt)}
                      {r.emailVerifiedAt && ` · confirmed ${when(r.emailVerifiedAt)}`}
                    </p>

                    {r.status === 'PENDING_EMAIL' && (
                      <p className="mt-1 text-2xs text-ink-500">
                        They have not entered the code we emailed, so there is nothing to decide yet.
                      </p>
                    )}
                    {r.rejectionReason && (
                      <p className="mt-1 text-2xs text-signal-red">{r.rejectionReason}</p>
                    )}
                  </div>

                  {r.status === 'PENDING_APPROVAL' && (
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <button
                        type="button"
                        className="btn-primary px-3 py-1 text-2xs"
                        disabled={approve.isPending}
                        onClick={() => approve.mutate(r.id)}
                      >
                        Approve — open their account
                      </button>
                      <button
                        type="button"
                        className="btn-ghost px-3 py-1 text-2xs"
                        onClick={() => {
                          setRejectingId(rejectingId === r.id ? null : r.id);
                          setRejectReason('');
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>

                {rejectingId === r.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      className="field flex-1 text-2xs"
                      placeholder="Why is this being rejected? They will be told."
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn-danger px-3 py-1 text-2xs"
                      disabled={reject.isPending || rejectReason.trim().length < 3}
                      onClick={() => reject.mutate(r.id)}
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
    </div>
  );
}
