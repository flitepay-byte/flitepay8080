import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import {
  Panel, Money, StatusChip, PaymentRef, ProofPanel, PayoutMethodPanel, CancelInfoPanel, RejectionInfoPanel,
  ErrorState, Skeleton, cn, type ProofInfo,
} from '@/components/primitives';
import type { Task, CaptainProfile } from '@/types';
import { when } from '@/lib/datetime';

interface TaskDetailResponse {
  task: Task;
  party: { id: string; partyCode: string; companyName: string; contactEmail: string } | null;
  captain: CaptainProfile | null;
  proof: ProofInfo | null;
  /** Every captain this task has passed through, oldest first — admin only. */
  captainHistory: Array<{
    captainId: string;
    captainCode: string | null;
    displayName: string | null;
    current: boolean;
  }>;
  stateHistory: Array<{
    from: string | null;
    to: string;
    role: string | null;
    reason: string | null;
    at: string;
    /** Who held the task at this point. Never sent to a party or captain. */
    captainId: string | null;
    captainCode: string | null;
    captainName: string | null;
  }>;
}

export function AdminTaskDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const queryClient = useQueryClient();
  const toast = useToast();

  const detail = useQuery<TaskDetailResponse>({
    queryKey: ['admin-task-detail', taskId],
    queryFn: () => api.get<TaskDetailResponse>(`/admin/tasks/${taskId}`),
    enabled: Boolean(taskId),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin-task-detail', taskId] });
    void queryClient.invalidateQueries({ queryKey: ['admin-tasks'] });
  };

  const resolveDispute = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REASSIGN') => api.post(`/admin/tasks/${taskId}/cancel/resolve`, { decision }),
    onSuccess: (_, decision) => {
      toast.show('success', decision === 'APPROVE' ? 'Dispute resolved — task resumes.' : 'Dispute resolved — task returned to the pool.');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const resolveRejection = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REASSIGN') => api.post(`/admin/tasks/${taskId}/reject/resolve`, { decision }),
    onSuccess: (_, decision) => {
      toast.show('success', decision === 'APPROVE' ? 'Rejection overruled — task complete.' : 'Task returned to the pool.');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  return (
    <div className="space-y-5">
      <div>
        <Link to="/admin/transactions" className="btn-ghost -ml-2 px-2 py-1 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" /> Transactions
        </Link>
        <p className="eyebrow mt-2">Task</p>
        <h1 className="font-mono tnum text-xl font-semibold text-ink-50">{taskId}</h1>
      </div>

      {detail.isPending && <Skeleton className="h-96" />}
      {detail.isError && <ErrorState message="Could not load this task." onRetry={() => void detail.refetch()} />}
      {detail.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Task">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <StatusChip status={detail.data.task.status} />
                <Money amount={detail.data.task.amount} className="text-lg font-semibold text-ink-50" />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Field label="Task code" value={detail.data.task.taskCode} mono />
                {/* What the captain sees instead — the party-scoped code above
                    names the party, so captains are shown this one. Support
                    needs both to match a code read out over the phone. */}
                <Field label="Captain sees" value={detail.data.task.captainTaskCode ?? '—'} mono />
                <Field label="Reference" value={detail.data.task.externalRef ?? '—'} mono />
                <Field
                  label="Created"
                  value={new Date(detail.data.task.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                />
                <Field label="Reassignments" value={String(detail.data.task.reassignmentCount)} />
              </dl>
              <div>
                <p className="eyebrow mb-1.5">Payment reference</p>
                <PaymentRef reference={detail.data.task.providerReference} />
              </div>
              <RejectionInfoPanel task={detail.data.task} />

              {detail.data.task.status === 'REJECTED' && (
                <div className="space-y-2 rounded-panel border border-signal-red/40 bg-signal-red/10 px-4 py-3.5">
                  <p className="text-xs text-ink-100">
                    The party rejected this captain's proof — overrule it and complete the task anyway, or
                    reassign it back to the pool for a different captain.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => resolveRejection.mutate('APPROVE')}
                      disabled={resolveRejection.isPending}
                      className="btn-secondary flex-1"
                    >
                      {resolveRejection.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Overrule — complete task'}
                    </button>
                    <button
                      type="button"
                      onClick={() => resolveRejection.mutate('REASSIGN')}
                      disabled={resolveRejection.isPending}
                      className="btn-danger flex-1"
                    >
                      Reassign to the pool
                    </button>
                  </div>
                </div>
              )}

              <CancelInfoPanel task={detail.data.task} />

              {detail.data.task.status === 'CANCEL_DISPUTED' && (
                <div className="space-y-2 rounded-panel border border-signal-red/40 bg-signal-red/10 px-4 py-3.5">
                  <p className="text-xs text-ink-100">
                    The review disputed this cancellation — keep the task exactly as it was, or reassign it back
                    to the pool for a different captain.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => resolveDispute.mutate('APPROVE')}
                      disabled={resolveDispute.isPending}
                      className="btn-secondary flex-1"
                    >
                      {resolveDispute.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Keep as-is — task resumes'}
                    </button>
                    <button
                      type="button"
                      onClick={() => resolveDispute.mutate('REASSIGN')}
                      disabled={resolveDispute.isPending}
                      className="btn-danger flex-1"
                    >
                      Reassign to the pool
                    </button>
                  </div>
                </div>
              )}
            </div>
          </Panel>

          <div className="space-y-4">
            <Panel title="From — the party">
              {detail.data.party ? (
                <Link to={`/admin/parties/${detail.data.party.id}`} className="block rounded-md transition-colors hover:bg-ink-850">
                  <p className="text-sm text-ink-50">{detail.data.party.companyName}</p>
                  <p className="mt-0.5 font-mono text-2xs text-ink-400">
                    {detail.data.party.partyCode} · {detail.data.party.contactEmail}
                  </p>
                </Link>
              ) : (
                <p className="text-xs text-ink-500">Party no longer exists.</p>
              )}
            </Panel>

            <Panel title="To — the customer">
              <div className="space-y-4">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Field label="Beneficiary" value={detail.data.task.customerName} />
                  <Field label="Destination" value={detail.data.task.identifier} mono />
                </dl>
                <PayoutMethodPanel payoutMethod={detail.data.task.payoutMethod} />
              </div>
            </Panel>

            <Panel title="Assigned captain">
              {detail.data.captain ? (
                <Link
                  to={`/admin/captains/${detail.data.captain.id}`}
                  className="flex items-center justify-between rounded-md transition-colors hover:bg-ink-850"
                >
                  <div>
                    <p className="text-sm text-ink-50">{detail.data.captain.displayName}</p>
                    <p className="mt-0.5 font-mono text-2xs text-ink-400">{detail.data.captain.captainCode}</p>
                  </div>
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn('h-1.5 w-1.5 rounded-full', detail.data.captain.isOnline ? 'bg-signal-green' : 'bg-ink-500')} />
                    <span className="text-2xs text-ink-300">{detail.data.captain.isOnline ? 'Online' : 'Offline'}</span>
                  </span>
                </Link>
              ) : (
                <p className="text-xs text-ink-500">Not yet claimed.</p>
              )}
            </Panel>
          </div>

          <Panel title="Proof of completion" className="lg:col-span-2">
            <ProofPanel proof={detail.data.proof} />
          </Panel>

          <Panel
            title="History"
            eyebrow={
              detail.data.captainHistory.length > 1
                ? `passed through ${detail.data.captainHistory.length} captains`
                : undefined
            }
            className="lg:col-span-2"
          >
            {/* Whose task this is, and everyone who has held it — admin is the
                only role that sees captain identity against a task at all. */}
            <div className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-3 border-b border-ink-800 pb-4">
              <div className="min-w-0">
                <p className="eyebrow">Party</p>
                <p className="mt-0.5 text-xs text-ink-100">{detail.data.party?.companyName ?? '—'}</p>
                <p className="font-mono text-2xs text-ink-500">
                  {detail.data.party?.partyCode ?? '—'} · {detail.data.party?.id ?? '—'}
                </p>
              </div>
              <div className="min-w-0">
                <p className="eyebrow">Captains</p>
                {detail.data.captainHistory.length === 0 ? (
                  <p className="mt-0.5 text-xs text-ink-500">Never claimed</p>
                ) : (
                  <ul className="mt-0.5 space-y-1">
                    {detail.data.captainHistory.map((c) => (
                      <li key={c.captainId} className="text-xs">
                        <span className="text-ink-100">{c.displayName ?? '—'}</span>
                        <span
                          className={cn(
                            'ml-1.5 rounded-full px-1.5 py-0.5 text-2xs',
                            c.current ? 'bg-signal-green/10 text-signal-green' : 'bg-ink-700/60 text-ink-400',
                          )}
                        >
                          {c.current ? 'current' : 'released'}
                        </span>
                        <span className="ml-1.5 font-mono text-2xs text-ink-500">
                          {c.captainCode ?? '—'} · {c.captainId}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <ul className="space-y-2">
              {detail.data.stateHistory.map((event, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 text-ink-200">
                    {event.from ? `${event.from} → ${event.to}` : event.to}
                    {event.role && <span className="ml-1.5 text-2xs text-ink-500">({event.role})</span>}
                    {/* Which captain held it at this point — the thing that
                        makes a reassigned task's history readable. */}
                    {event.captainId && (
                      <span className="ml-1.5 font-mono text-2xs text-signal-cyan">
                        {event.captainCode ?? event.captainId}
                      </span>
                    )}
                    {event.reason && <span className="ml-1.5 text-2xs text-ink-400">— {event.reason}</span>}
                  </span>
                  <span className="shrink-0 font-mono tnum text-2xs text-ink-500">
                    {when(event.at)}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-xs text-ink-100', mono && 'font-mono tnum')}>{value}</dd>
    </div>
  );
}
