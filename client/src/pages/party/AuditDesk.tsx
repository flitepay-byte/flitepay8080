import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Loader2, Check, X, ZoomIn, ZoomOut, RotateCw, FileText, AlertTriangle, ShieldCheck,
} from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { StateRail, StateHistory } from '@/components/StateRail';
import {
  Panel, Money, StatusChip, PaymentRef, EmptyState, ErrorState, TableSkeleton, cn,
} from '@/components/primitives';
import { REJECTION_CATEGORIES } from '@/types';
import type { Task, Paginated, StateEvent, RejectionCategory } from '@/types';

interface AuditDetail {
  task: Task;
  proof: {
    id: string;
    providerReference: string;
    notes: string | null;
    receipt: { fileName: string; url: string; mimeType: string; sizeBytes: number } | null;
    submittedAt: string;
  } | null;
  /** The reference the captain reported for the payment they say they made. */
  reportedReference: string | null;
  stateHistory: StateEvent[];
}

/**
 * PARTY AUDIT DESK — the party that placed the task decides whether the
 * captain's proof is good, not admin. Dual pane: the queue on the left, the
 * task beside its proof on the right. Captain identity is never shown here —
 * a party only ever sees proof of completion, matching every other
 * party-facing task view.
 */
export function PartyAuditDesk() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const queue = useQuery<Paginated<Task>>({
    queryKey: ['party-audit-queue'],
    queryFn: () => api.get<Paginated<Task>>('/party/audit-queue?page=1&limit=50'),
    refetchInterval: 30_000,
  });

  // The desk's second queue: captains asking to drop a task they hold. A
  // different decision from judging proof, so it gets its own panel rather
  // than being mixed into the proof queue's dual-pane layout.
  const cancelQueue = useQuery<Paginated<Task>>({
    queryKey: ['party-cancel-review-queue'],
    queryFn: () => api.get<Paginated<Task>>('/party/cancel-review-queue?page=1&limit=50'),
    refetchInterval: 30_000,
  });

  const activeId = selectedId ?? queue.data?.items[0]?.id ?? null;
  const pendingTotal = (queue.data?.total ?? 0) + (cancelQueue.data?.total ?? 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Party</p>
          <h1 className="font-display text-xl font-semibold text-ink-50">Audit desk</h1>
        </div>
        {(queue.data || cancelQueue.data) && (
          <span className="inline-flex items-center gap-2 rounded-full border border-signal-amber/40 bg-signal-amber/10 px-3 py-1">
            <span className="h-1.5 w-1.5 rounded-full bg-signal-amber animate-pulse-dot" />
            <span className="font-mono tnum text-xs text-signal-amber">{pendingTotal} awaiting review</span>
          </span>
        )}
      </div>

      {cancelQueue.data && cancelQueue.data.items.length > 0 && (
        <Panel
          title="Cancellation requests"
          eyebrow={`${cancelQueue.data.total} captain${cancelQueue.data.total === 1 ? '' : 's'} asking to drop a task`}
          bodyClassName="p-0"
        >
          <ul className="divide-y divide-ink-800">
            {cancelQueue.data.items.map((task) => (
              <CancelReviewRow key={task.id} task={task} />
            ))}
          </ul>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Panel title="Queue" eyebrow="oldest first" bodyClassName="p-0 max-h-[70vh] overflow-y-auto">
          {queue.isPending && <div className="p-4"><TableSkeleton rows={4} cols={2} /></div>}
          {queue.isError && <ErrorState message="Could not load the queue." onRetry={() => void queue.refetch()} />}
          {queue.data?.items.length === 0 && (
            <EmptyState title="Nothing to review" hint="Submitted proofs land here automatically." />
          )}
          {queue.data && queue.data.items.length > 0 && (
            <ul className="divide-y divide-ink-800">
              {queue.data.items.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(task.id)}
                    className={cn(
                      'w-full px-4 py-3 text-left transition-colors',
                      activeId === task.id ? 'bg-ink-800 shadow-rail text-signal-amber' : 'hover:bg-ink-850/60',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono tnum text-xs text-ink-50">{task.taskCode}</span>
                      <Money amount={task.amount} className="text-xs text-ink-200" />
                    </div>
                    <p className="mt-1 truncate text-2xs text-ink-400">{task.customerName}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {activeId ? (
          <AuditPane taskId={activeId} onResolved={() => setSelectedId(null)} />
        ) : (
          <Panel><EmptyState title="Select a task to review" /></Panel>
        )}
      </div>
    </div>
  );
}

/**
 * One captain-requested cancellation, decided inline. Approving releases the
 * captain and closes the task; disputing escalates to admin, so it needs a
 * reason — the same two-sided rule the captain follows when a party asks to
 * cancel on them.
 */
function CancelReviewRow({ task }: { task: Task }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState('');

  const review = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api.post(`/party/tasks/${task.id}/cancel-review`, {
        decision,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: (_, decision) => {
      toast.show(
        'success',
        decision === 'APPROVE' ? 'Cancellation approved.' : 'Cancellation disputed — escalated to admin.',
      );
      setDisputing(false);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['party-cancel-review-queue'] });
      void queryClient.invalidateQueries({ queryKey: ['party-tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['party-dashboard'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-mono tnum text-xs text-ink-50">{task.taskCode}</span>
            <Money amount={task.amount} className="text-xs text-ink-200" />
          </div>
          <p className="mt-1 truncate text-2xs text-ink-400">{task.customerName}</p>
          {task.cancelReason && (
            <p className="mt-1.5 flex items-start gap-1.5 text-2xs text-ink-200">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-signal-amber" />
              <span>The captain says: {task.cancelReason}</span>
            </p>
          )}
        </div>

        {!disputing && (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => review.mutate('APPROVE')}
              disabled={review.isPending}
              className="btn-secondary px-2.5 py-1 text-2xs"
            >
              {review.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Check className="h-3.5 w-3.5" /> Approve</>}
            </button>
            <button type="button" onClick={() => setDisputing(true)} className="btn-danger px-2.5 py-1 text-2xs">
              <X className="h-3.5 w-3.5" /> Dispute
            </button>
          </div>
        )}
      </div>

      {disputing && (
        <div className="mt-3 space-y-2.5">
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="field-input resize-none"
            placeholder="Why you disagree with this cancellation"
            autoFocus
          />
          <p className="text-2xs text-ink-500">
            At least 3 characters. Disputing sends this to admin for a final decision.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => review.mutate('REJECT')}
              disabled={reason.trim().length < 3 || review.isPending}
              className="btn-danger flex-1"
            >
              {review.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm dispute'}
            </button>
            <button type="button" onClick={() => setDisputing(false)} className="btn-secondary">Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}

function AuditPane({ taskId, onResolved }: { taskId: string; onResolved: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState<RejectionCategory | ''>('');

  const detail = useQuery<AuditDetail>({
    queryKey: ['party-audit-detail', taskId],
    queryFn: () => api.get<AuditDetail>(`/party/audit/${taskId}`),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['party-audit-queue'] });
    void queryClient.invalidateQueries({ queryKey: ['party-dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['party-audit-detail', taskId] });
  };

  const approve = useMutation({
    mutationFn: () => api.post<{ commission: number }>(`/party/audit/${taskId}/approve`),
    onSuccess: (data) => {
      toast.show('success', `Approved. DMC ${data.commission} credited to the captain.`);
      invalidate();
      onResolved();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const reject = useMutation({
    mutationFn: () => api.post(`/party/audit/${taskId}/reject`, { reason: reason.trim(), category }),
    onSuccess: () => {
      toast.show('info', 'Rejected. Sent to admin for a final decision.');
      setRejecting(false);
      setReason('');
      setCategory('');
      invalidate();
      onResolved();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  if (detail.isPending) return <Panel><TableSkeleton rows={6} cols={3} /></Panel>;
  if (detail.isError || !detail.data) {
    return <Panel><ErrorState message="Could not load this task." onRetry={() => void detail.refetch()} /></Panel>;
  }

  const { task, proof, reportedReference } = detail.data;
  const reviewable = task.status === 'AUDIT_PENDING';

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Task</p>
            <p className="font-mono tnum text-base text-ink-50">{task.taskCode}</p>
            <p className="mt-1 text-xs text-ink-400">{task.customerName} · {task.externalRef}</p>
          </div>
          <div className="text-right">
            <StatusChip status={task.status} />
            <Money amount={task.amount} className="mt-1.5 block text-lg font-semibold text-ink-50" />
          </div>
        </div>
        <div className="mt-4 border-t border-ink-700 pt-4">
          <StateRail current={task.status} history={detail.data.stateHistory} />
        </div>
      </Panel>

      {/* What the auditor is actually here to check: the captain says they paid
          the customer, and this is the reference they gave for it. Nothing in
          this app issued it, so it can only be checked against the party's own
          record of the customer being paid. */}
      <div className="flex items-start gap-3 rounded-panel border border-ink-700 bg-ink-850/60 px-4 py-3.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Reference reported by the captain</p>
          <p className="mt-1 font-mono tnum text-sm text-ink-50">{reportedReference ?? '—'}</p>
          <p className="mt-1.5 text-2xs leading-relaxed text-ink-400">
            Check this against your own record that {task.customerName} was paid before you approve. Approving
            releases the money for this task; rejecting sends it to admin for a final decision.
          </p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Submitted proof">
          {proof ? (
            <div className="space-y-3.5">
              <div>
                <p className="eyebrow">Reference</p>
                <div className="mt-1"><PaymentRef reference={proof.providerReference} /></div>
              </div>
              <div>
                <p className="eyebrow">Submitted</p>
                <p className="mt-0.5 font-mono tnum text-xs text-ink-200">
                  {new Date(proof.submittedAt).toLocaleString('en-IN')}
                </p>
              </div>
              {proof.notes && (
                <div>
                  <p className="eyebrow">Captain notes</p>
                  <p className="mt-0.5 text-xs text-ink-200">{proof.notes}</p>
                </div>
              )}
            </div>
          ) : (
            <EmptyState title="No proof attached" />
          )}
        </Panel>

        <Panel title="Receipt" bodyClassName="p-0">
          <ReceiptViewer receipt={proof?.receipt ?? null} />
        </Panel>
      </div>

      {reviewable && (
        <Panel>
          {rejecting ? (
            <div className="space-y-3">
              <div>
                <label htmlFor="category" className="field-label">What went wrong?</label>
                <select
                  id="category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as RejectionCategory)}
                  className="field-input"
                  autoFocus
                >
                  <option value="" disabled>Choose a reason…</option>
                  {REJECTION_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-2xs text-ink-500">
                  If this task goes to another captain, this is the only part they are told —
                  as an instruction, without your notes below.
                </p>
              </div>
              <div>
                <label htmlFor="reason" className="field-label">Explain it for admin</label>
                <textarea
                  id="reason"
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="field-input resize-none"
                  placeholder="What happened, in your own words. Admin reads this to decide; so does the captain being rejected."
                />
                <p className="mt-1.5 text-2xs text-ink-500">
                  At least 5 characters. Read by admin and by the captain who did this work — not by
                  any captain the task is reassigned to.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => reject.mutate()}
                  disabled={!category || reason.trim().length < 5 || reject.isPending}
                  className="btn-danger flex-1"
                >
                  {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm rejection'}
                </button>
                <button type="button" onClick={() => setRejecting(false)} className="btn-secondary">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => approve.mutate()}
                disabled={approve.isPending}
                className="btn-primary flex-1"
              >
                {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="h-4 w-4" /> Approve</>}
              </button>
              <button type="button" onClick={() => setRejecting(true)} className="btn-danger flex-1">
                <X className="h-4 w-4" /> Reject
              </button>
            </div>
          )}
          <p className="mt-3 text-2xs text-ink-500">
            Approving releases the captain's held limit and credits their commission.
          </p>
        </Panel>
      )}

      <Panel title="History" eyebrow="append-only">
        <StateHistory history={detail.data.stateHistory} />
      </Panel>
    </div>
  );
}

/** Zoom and rotate matter here: receipts are photographed at odd angles. */
function ReceiptViewer({ receipt }: { receipt: { fileName: string; url: string; mimeType: string } | null }) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  if (!receipt) {
    return <div className="p-4"><EmptyState title="No receipt uploaded" hint="A receipt is optional." /></div>;
  }

  const isPdf = receipt.mimeType === 'application/pdf';

  return (
    <div>
      <div className="flex items-center gap-1 border-b border-ink-700 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-2xs text-ink-400">{receipt.fileName}</span>
        {!isPdf && (
          <>
            <button type="button" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} className="btn-ghost p-1.5" aria-label="Zoom out">
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <span className="font-mono tnum text-2xs text-ink-400 w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} className="btn-ghost p-1.5" aria-label="Zoom in">
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setRotation((r) => (r + 90) % 360)} className="btn-ghost p-1.5" aria-label="Rotate">
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      <div className="flex h-[320px] items-center justify-center overflow-auto bg-ink-950 p-4">
        {isPdf ? (
          <a href={receipt.url} target="_blank" rel="noreferrer" className="flex flex-col items-center gap-2 text-ink-300 hover:text-ink-100">
            <FileText className="h-8 w-8" strokeWidth={1.5} />
            <span className="text-xs">Open PDF</span>
          </a>
        ) : (
          <img
            src={receipt.url}
            alt="Submitted receipt"
            style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
            className="max-h-full max-w-full object-contain transition-transform"
          />
        )}
      </div>
    </div>
  );
}
