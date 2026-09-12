import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Check, Loader2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { StateRail } from '@/components/StateRail';
import { Countdown } from '@/components/Countdown';
import {
  Panel, Money, StatusChip, PaymentRef, ProofPanel, PayoutMethodPanel, CancelInfoPanel, CancelRequestForm,
  RejectionInfoPanel, ErrorState, Skeleton, cn, type ProofInfo,
} from '@/components/primitives';
import type { Task } from '@/types';
import { when } from '@/lib/datetime';

/**
 * States from which the party can still ask for a cancellation. Once a
 * captain has started work (IN_PROGRESS), it can no longer be cancelled by
 * anyone — see TASK_TRANSITIONS in the server's types/index.ts, the single
 * authoritative gate this mirrors for the UI.
 */
const CANCELLABLE_STATES = ['CREATED', 'REASSIGNED', 'ASSIGNED'];

interface PartyTaskDetail extends Omit<Task, 'captainId'> {
  proof: ProofInfo | null;
  stateHistory: Array<{ from: string | null; to: string; role: string | null; reason: string | null; at: string }>;
}

/**
 * Party sees proof of completion, never which captain is assigned — captain
 * identity is need-to-know for admin and the captain themselves only.
 */
export function PartyTaskDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const queryClient = useQueryClient();
  const toast = useToast();

  const detail = useQuery<PartyTaskDetail>({
    queryKey: ['party-task-detail', taskId],
    queryFn: () => api.get<PartyTaskDetail>(`/party/tasks/${taskId}`),
    enabled: Boolean(taskId),
  });

  const cancel = useMutation({
    mutationFn: (reason: string) => api.post(`/party/tasks/${taskId}/cancel`, { reason }),
    onSuccess: () => {
      toast.show('success', 'Cancellation submitted.');
      void queryClient.invalidateQueries({ queryKey: ['party-task-detail', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['party-tasks'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const [cancelDecisionReason, setCancelDecisionReason] = useState('');
  const reviewCancel = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api.post(`/party/tasks/${taskId}/cancel-review`, {
        decision,
        ...(cancelDecisionReason.trim() ? { reason: cancelDecisionReason.trim() } : {}),
      }),
    onSuccess: (_, decision) => {
      toast.show('success', decision === 'APPROVE' ? 'Cancellation approved.' : 'Cancellation disputed — escalated to admin.');
      void queryClient.invalidateQueries({ queryKey: ['party-task-detail', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['party-tasks'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  return (
    <div className="space-y-5">
      <div>
        <Link to="/party/tasks" className="btn-ghost -ml-2 px-2 py-1 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" /> Tasks
        </Link>
        <p className="eyebrow mt-2">Party</p>
        <h1 className="font-mono tnum text-xl font-semibold text-ink-50">{detail.data?.taskCode ?? taskId}</h1>
      </div>

      {detail.isPending && <Skeleton className="h-96" />}
      {detail.isError && <ErrorState message="Could not load this task." onRetry={() => void detail.refetch()} />}
      {detail.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Task">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <StatusChip status={detail.data.status} />
                <Money amount={detail.data.amount} className="text-lg font-semibold text-ink-50" />
              </div>
              {/* What the party actually wants to know: when this lands. A
                  claimed task has a real deadline; an unclaimed one is still
                  being offered around, so we show that instead of a fake ETA. */}
              {detail.data.expiresAt && (detail.data.status === 'ASSIGNED' || detail.data.status === 'IN_PROGRESS') && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-signal-cyan/30 bg-signal-cyan/5 px-3.5 py-2.5">
                  <p className="text-2xs text-ink-300">
                    A captain is on this. Expected to complete by{' '}
                    <span className="font-mono text-ink-100">
                      {new Date(detail.data.expiresAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    .
                  </p>
                  <Countdown deadline={detail.data.expiresAt} label="due in" urgentBelowSeconds={300} expiredLabel="Overdue" />
                </div>
              )}
              {(detail.data.status === 'CREATED' || detail.data.status === 'REASSIGNED') && (
                <div className="rounded-panel border border-ink-700 bg-ink-850/40 px-3.5 py-2.5">
                  <p className="text-2xs text-ink-400">
                    Being offered to captains, best match first. The countdown to completion starts once one accepts.
                  </p>
                </div>
              )}
              <StateRail current={detail.data.status} />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Field label="Beneficiary" value={detail.data.customerName} />
                <Field label="Destination" value={detail.data.identifier} mono />
                <Field
                  label="Created"
                  value={new Date(detail.data.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                />
              </dl>
              {detail.data.externalRef && <ReferenceCallout reference={detail.data.externalRef} />}
              <div>
                <p className="eyebrow mb-1.5">Payment reference</p>
                <PaymentRef reference={detail.data.providerReference} />
              </div>
              <RejectionInfoPanel task={detail.data} />

              <CancelInfoPanel task={detail.data} />

              {detail.data.status === 'CANCEL_REVIEW' && detail.data.cancelInitiatedBy === 'CAPTAIN' && (
                <div className="panel space-y-3 p-4">
                  <p className="text-xs text-ink-100">
                    The captain asked to cancel this task. Approve to let it go, or reject if you disagree — a
                    rejection is escalated to admin for a final decision.
                  </p>
                  <div>
                    <label htmlFor="party-cancel-decision-reason" className="field-label">Reason (required to reject)</label>
                    <textarea
                      id="party-cancel-decision-reason"
                      rows={2}
                      value={cancelDecisionReason}
                      onChange={(e) => setCancelDecisionReason(e.target.value)}
                      className="field-input resize-none"
                      placeholder="Why you disagree with this cancellation"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => reviewCancel.mutate('APPROVE')}
                      disabled={reviewCancel.isPending}
                      className="btn-secondary flex-1"
                    >
                      {reviewCancel.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Approve cancellation'}
                    </button>
                    <button
                      type="button"
                      onClick={() => reviewCancel.mutate('REJECT')}
                      disabled={reviewCancel.isPending || cancelDecisionReason.trim().length < 3}
                      className="btn-danger flex-1"
                    >
                      Reject — escalate to admin
                    </button>
                  </div>
                </div>
              )}

              {CANCELLABLE_STATES.includes(detail.data.status) && (
                <CancelRequestForm onSubmit={(reason) => cancel.mutate(reason)} pending={cancel.isPending} />
              )}
            </div>
          </Panel>

          <Panel title="Payout method">
            <PayoutMethodPanel payoutMethod={detail.data.payoutMethod} />
          </Panel>

          <Panel title="Proof of completion">
            <ProofPanel proof={detail.data.proof} />
          </Panel>

          <Panel title="History" className="lg:col-span-2">
            <ul className="space-y-2">
              {detail.data.stateHistory.map((event, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-ink-200">
                    {event.from ? `${event.from} → ${event.to}` : event.to}
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

/**
 * The system-generated tracking reference — the party's own hand-off
 * artifact for their customer, since customers have no login of their own
 * and only ever look this up on the public tracking page.
 */
function ReferenceCallout({ reference }: { reference: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(reference);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the browser; the code is still
      // visible to select and copy manually.
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-panel border border-brand-500/30 bg-brand-500/5 px-4 py-3">
      <div className="min-w-0">
        <p className="eyebrow">Customer tracking reference</p>
        <p className="mt-0.5 truncate font-mono tnum text-sm text-ink-50">{reference}</p>
      </div>
      <button type="button" onClick={() => void copy()} className="btn-secondary shrink-0 px-2.5 py-1.5 text-xs">
        {copied ? <Check className="h-3.5 w-3.5 text-signal-green" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
