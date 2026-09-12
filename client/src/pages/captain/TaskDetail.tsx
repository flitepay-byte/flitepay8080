import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Play, Send, Upload, CheckCircle2, AlertTriangle, Ban, Archive } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { StateRail } from '@/components/StateRail';
import { Countdown } from '@/components/Countdown';
import {
  Panel, Money, StatusChip, ProofPanel, PayoutMethodPanel, CancelInfoPanel,
  RejectionInfoPanel, ReattemptNotice, CancelRequestForm, ErrorState, Skeleton, cn, type ProofInfo,
} from '@/components/primitives';
import { timeAgo } from './Queue';
import type { Task } from '@/types';

/**
 * States from which the captain can still ask to cancel a task they hold.
 * Once work has started (IN_PROGRESS), it can no longer be cancelled by
 * anyone — see TASK_TRANSITIONS in the server's types/index.ts, the single
 * authoritative gate this mirrors for the UI.
 */
const CANCELLABLE_STATES = ['ASSIGNED'];

interface CaptainTaskDetail extends Task {
  proof: ProofInfo | null;
}

/** Full workflow page: start the task, report the payment, submit proof, or recover from expiry. */
export function CaptainTaskDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const detail = useQuery<CaptainTaskDetail>({
    queryKey: ['captain-task-detail', taskId],
    queryFn: () => api.get<CaptainTaskDetail>(`/captain/tasks/${taskId}`),
    enabled: Boolean(taskId),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['captain-tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['captain-task-detail', taskId] });
    void queryClient.invalidateQueries({ queryKey: ['captain-profile'] });
    void queryClient.invalidateQueries({ queryKey: ['captain-dashboard'] });
  };

  const start = useMutation({
    mutationFn: () => api.post(`/captain/tasks/${taskId}/start`),
    onSuccess: () => {
      toast.show('success', 'Task started.');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const [expiryReason, setExpiryReason] = useState('');
  const rejectExpired = useMutation({
    mutationFn: () => api.post(`/captain/tasks/${taskId}/reject-expired`, { reason: expiryReason.trim() }),
    onSuccess: () => {
      toast.show('success', 'Returned to the pool for another captain.');
      refresh();
      navigate('/captain/tasks');
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const requestCancel = useMutation({
    mutationFn: (reason: string) => api.post(`/captain/tasks/${taskId}/cancel`, { reason }),
    onSuccess: () => {
      toast.show('success', 'Cancellation requested — awaiting the party’s review.');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const [cancelDecisionReason, setCancelDecisionReason] = useState('');
  const reviewCancel = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api.post(`/captain/tasks/${taskId}/cancel-review`, {
        decision,
        ...(cancelDecisionReason.trim() ? { reason: cancelDecisionReason.trim() } : {}),
      }),
    onSuccess: (_, decision) => {
      toast.show('success', decision === 'APPROVE' ? 'Cancellation approved.' : 'Cancellation disputed — escalated to admin.');
      refresh();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const current = detail.data;
  /**
   * The task moved on to another captain. Everything here is a record of what
   * happened, never something to act on — a released captain must not be
   * offered buttons for work that is no longer theirs.
   */
  const released = Boolean(current?.releasedFromYou);

  return (
    <div className="space-y-5">
      <div>
        <Link to="/captain/tasks" className="btn-ghost -ml-2 px-2 py-1 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" /> My tasks
        </Link>
        <p className="eyebrow mt-2">Captain</p>
        <h1 className="font-mono tnum text-xl font-semibold text-ink-50">{current?.taskCode ?? taskId}</h1>
      </div>

      {detail.isPending && <Skeleton className="h-96" />}
      {detail.isError && <ErrorState message="Could not load this task." onRetry={() => void detail.refetch()} />}
      {current && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <Panel title="Task">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <StatusChip status={current.status} />
                  <Money amount={current.amount} className="text-lg font-semibold text-ink-50" />
                </div>

                {released && (
                  <div className="flex items-start gap-2.5 rounded-panel border border-ink-700 bg-ink-850/60 px-3.5 py-3">
                    <Archive className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-ink-100">
                        This task is no longer yours
                        {current.releasedAt &&
                          ` — reassigned on ${new Date(current.releasedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`}
                      </p>
                      <p className="mt-0.5 text-2xs text-ink-400">
                        Kept here as a record of your part in it. What happened afterwards is between the
                        party and whoever took it on.
                      </p>
                    </div>
                  </div>
                )}

                {/* The clock only matters while the task is still yours to finish. */}
                {(current.status === 'ASSIGNED' || current.status === 'IN_PROGRESS') && current.expiresAt && (
                  <div className="flex items-center justify-between gap-3 rounded-panel border border-ink-700 bg-ink-850/40 px-3.5 py-2.5">
                    <p className="text-2xs text-ink-400">Finish before the deadline or the task expires back to the pool.</p>
                    <Countdown deadline={current.expiresAt} label="left" urgentBelowSeconds={300} expiredLabel="Overdue" />
                  </div>
                )}

                <StateRail current={current.status} />

                <div className="rounded-panel border border-sim-dim bg-sim-wash px-4 py-3.5">
                  <p className="text-2xs font-mono font-semibold uppercase tracking-wider text-sim">Customer Details</p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3">
                    <Field label="Beneficiary" value={current.customerName} />
                    <Field label="Destination" value={current.identifier} mono />
                    <Field label="Claimed" value={current.claimedAt ? timeAgo(current.claimedAt) : '—'} />
                  </dl>
                </div>
              </div>
            </Panel>

            {!released && current.status === 'ASSIGNED' && (
              <button type="button" onClick={() => start.mutate()} disabled={start.isPending} className="btn-primary w-full">
                {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Play className="h-4 w-4" /> Start task</>}
              </button>
            )}

            {!released && current.status === 'IN_PROGRESS' && (
              <div className="space-y-4">
                {/* <SimulationNotice /> */}
                <ProofForm taskId={current.id} onSubmitted={refresh} />
              </div>
            )}

            {!released && current.status === 'CANCEL_REVIEW' && current.cancelInitiatedBy === 'PARTY' && (
              <div className="panel space-y-3 p-4">
                <div className="flex items-start gap-2.5 rounded-panel border border-signal-amber/40 bg-signal-amber/10 px-3.5 py-3">
                  <Ban className="mt-0.5 h-4 w-4 shrink-0 text-signal-amber" />
                  <p className="text-xs text-ink-100">
                    The party asked to cancel this task. Approve to release your collateral and close it, or reject
                    if you disagree — a rejection is escalated to admin for a final decision.
                  </p>
                </div>

                <div>
                  <label htmlFor="cancel-decision-reason" className="field-label">Reason (required to reject)</label>
                  <textarea
                    id="cancel-decision-reason"
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

            {!released && current.status === 'CANCEL_REVIEW' && current.cancelInitiatedBy === 'CAPTAIN' && (
              <div className="flex items-start gap-2.5 rounded-panel border border-signal-amber/40 bg-signal-amber/10 px-3.5 py-3">
                <Ban className="mt-0.5 h-4 w-4 shrink-0 text-signal-amber" />
                <p className="text-xs text-ink-100">
                  Your cancellation request is awaiting the party's review.
                </p>
              </div>
            )}

            {!released && current.status === 'CANCEL_DISPUTED' && (
              <div className="flex items-start gap-2.5 rounded-panel border border-signal-red/40 bg-signal-red/10 px-3.5 py-3">
                <Ban className="mt-0.5 h-4 w-4 shrink-0 text-signal-red" />
                <p className="text-xs text-ink-100">
                  {current.cancelInitiatedBy === 'CAPTAIN'
                    ? 'The party disputed your cancellation request.'
                    : 'You disputed this cancellation.'}{' '}
                  It has been escalated to admin, who will make the final call.
                </p>
              </div>
            )}

            {!released && current.status === 'EXPIRED' && (
              <div className="panel space-y-3 p-4">
                <div className="flex items-start gap-2.5 rounded-panel border border-signal-red/40 bg-signal-red/10 px-3.5 py-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-red" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-ink-100">
                      The deadline passed before proof was submitted. Give a reason, then return this task to the
                      pool so another captain can take it — it cannot be resumed from here.
                    </p>
                    {current.expiryAckDeadline && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Countdown
                          deadline={current.expiryAckDeadline}
                          label="reclaimed in"
                          urgentBelowSeconds={120}
                          expiredLabel="Reclaiming"
                        />
                        <span className="text-2xs text-ink-400">
                          If you don't respond in time, the task is handed to another captain automatically.
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label htmlFor="expiry-reason" className="field-label">Reason</label>
                  <textarea
                    id="expiry-reason"
                    rows={2}
                    value={expiryReason}
                    onChange={(e) => setExpiryReason(e.target.value)}
                    className="field-input resize-none"
                    placeholder="Why the deadline was missed"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => rejectExpired.mutate()}
                  disabled={expiryReason.trim().length < 5 || rejectExpired.isPending}
                  className="btn-danger w-full"
                >
                  {rejectExpired.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Reject and return to pool'}
                </button>
              </div>
            )}

            {current.status === 'AUDIT_PENDING' && (
              <div className="flex items-start gap-2.5 rounded-panel border border-signal-amber/40 bg-signal-amber/10 px-3.5 py-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-signal-amber" />
                <p className="text-xs text-ink-100">
                  Proof submitted. An auditor is reviewing it — you will be notified when there is a decision.
                </p>
              </div>
            )}

            {current.status === 'COMPLETED' && current.commission != null && (
              <div className="flex items-center justify-between rounded-panel border border-signal-green/40 bg-signal-green/10 px-4 py-3">
                <p className="text-xs text-ink-100">Approved and credited</p>
                <Money amount={current.commission} showUsdt={false} className="text-sm font-semibold text-signal-green" />
              </div>
            )}

            {/* The party's words when they were about this captain's own work;
                a blameless instruction when the task was inherited. */}
            <RejectionInfoPanel task={current} />
            <ReattemptNotice reassignmentCount={current.reassignmentCount} guidance={current.rejectionGuidance} />

            <CancelInfoPanel task={current} />

            {!released && CANCELLABLE_STATES.includes(current.status) && (
              <CancelRequestForm onSubmit={(reason) => requestCancel.mutate(reason)} pending={requestCancel.isPending} />
            )}
          </div>

          <div className="space-y-4">
            <Panel title="Payout method">
              <PayoutMethodPanel payoutMethod={current.payoutMethod} />
            </Panel>

            {(current.status === 'AUDIT_PENDING' || current.status === 'COMPLETED') && (
              <Panel title="Your submitted proof">
                <ProofPanel proof={current.proof} />
              </Panel>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Only ever rendered inside the fixed-dark "Demo data" panel above, so its text is fixed too — see the `sim.fg` token. */
function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-mono uppercase tracking-[0.12em] text-sim/70">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-xs text-sim-fg', mono && 'font-mono tnum')}>{value}</dd>
    </div>
  );
}

/**
 * What the captain files once they have actually paid the customer.
 *
 * The reference is typed in, not pre-filled: the payment happens outside this
 * app, so the UTR is the captain's report of what their bank gave them and
 * nothing here can produce it for them. It is what the party checks against
 * their own record, and what reconciliation later matches to a bank statement
 * line, so a wrong one costs the captain a rejection.
 */
function ProofForm({ taskId, onSubmitted }: { taskId: string; onSubmitted: () => void }) {
  const toast = useToast();
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const trimmed = reference.trim();
  // The server holds the real rule; this only stops an obviously empty filing.
  const referenceReady = trimmed.length >= 6;

  const submit = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('providerReference', trimmed);
      if (notes.trim()) form.append('notes', notes.trim());
      if (file) form.append('receipt', file);
      return api.upload(`/captain/tasks/${taskId}/proof`, form);
    },
    onSuccess: () => {
      toast.show('success', 'Proof submitted for audit.');
      onSubmitted();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  return (
    <div className="panel p-4">
      <p className="eyebrow">Have you paid this customer?</p>
      <p className="mt-1 text-xs text-ink-400">
        Enter the reference your bank gave you for that payment, then submit it for the party to audit.
      </p>

      <div className="mt-3">
        <label htmlFor="provider-reference" className="field-label">UTR / payment reference</label>
        <input
          id="provider-reference"
          type="text"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          className="field-input font-mono tnum uppercase"
          placeholder="e.g. 412345678901"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1.5 text-2xs text-ink-500">
          The UTR from your bank, or the transaction reference for a UPI payment. It is checked against the
          party's own record, so enter it exactly as it appears.
        </p>
      </div>

      <div className="mt-3">
        <label htmlFor="notes" className="field-label">Notes (optional)</label>
        <textarea
          id="notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="field-input resize-none"
          placeholder="Anything the auditor should know"
        />
      </div>

      <div className="mt-3">
        <span className="field-label">Receipt (optional)</span>
        <label
          className={cn(
            'flex cursor-pointer items-center gap-2.5 rounded-md border border-dashed px-3 py-2.5 transition-colors',
            file ? 'border-signal-green/50 bg-signal-green/5' : 'border-ink-600 hover:border-ink-500',
          )}
        >
          <Upload className="h-4 w-4 shrink-0 text-ink-400" />
          <span className="min-w-0 flex-1 truncate text-xs text-ink-200">
            {file ? file.name : 'JPEG, PNG, or PDF up to 5 MB'}
          </span>
          <input
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      <button
        type="button"
        onClick={() => submit.mutate()}
        disabled={!referenceReady || submit.isPending}
        className="btn-primary mt-4 w-full"
      >
        {submit.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Send className="h-4 w-4" /> Submit proof</>}
      </button>
    </div>
  );
}
