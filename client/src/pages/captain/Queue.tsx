import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Zap, Clock, WifiOff, RotateCcw } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import {
  Panel, Metric, Money, EmptyState, ErrorState, TableSkeleton, cn,
} from '@/components/primitives';
import { Countdown } from '@/components/Countdown';
import type { QueueCard, CaptainProfile, Paginated } from '@/types';

interface QueueResponse extends Paginated<QueueCard> {
  availableLimit: number;
}

export function CaptainQueue() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const profile = useQuery<CaptainProfile>({
    queryKey: ['captain-profile'],
    queryFn: () => api.get<CaptainProfile>('/captain/profile'),
  });

  const queue = useQuery<QueueResponse>({
    queryKey: ['captain-queue'],
    queryFn: () => api.get<QueueResponse>('/captain/queue?page=1&limit=20'),
    // Socket events drive updates; this is a safety net if the socket drops.
    refetchInterval: 30_000,
  });

  const presence = useMutation({
    mutationFn: (online: boolean) => api.post('/captain/presence', { online }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['captain-profile'] });
      void queryClient.invalidateQueries({ queryKey: ['captain-queue'] });
    },
    onError: (error) => toast.show('error', (error as ApiRequestError).message),
  });

  const claim = useMutation({
    mutationFn: (taskId: string) => api.post(`/captain/tasks/${taskId}/claim`),
    onMutate: (taskId) => setClaimingId(taskId),
    onSettled: () => setClaimingId(null),
    onSuccess: () => {
      toast.show('success', 'Task claimed. Your limit has been held against it.');
      void queryClient.invalidateQueries({ queryKey: ['captain-queue'] });
      void queryClient.invalidateQueries({ queryKey: ['captain-profile'] });
      void queryClient.invalidateQueries({ queryKey: ['captain-tasks'] });
    },
    onError: (error) => {
      const err = error as ApiRequestError;
      // The common case in a contended queue: someone else got there first.
      if (err.errorCode === 'TASK_ALREADY_CLAIMED') {
        toast.show('info', 'Another captain claimed that one first.');
        void queryClient.invalidateQueries({ queryKey: ['captain-queue'] });
        return;
      }
      toast.show('error', err.message);
    },
  });

  const isOnline = profile.data?.isOnline ?? false;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Captain</p>
          <h1 className="font-display text-xl font-semibold text-ink-50">Available tasks</h1>
        </div>
        <button
          type="button"
          onClick={() => presence.mutate(!isOnline)}
          disabled={presence.isPending}
          className={cn(isOnline ? 'btn-secondary' : 'btn-primary')}
        >
          {presence.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isOnline ? (
            <><WifiOff className="h-4 w-4" /> Go offline</>
          ) : (
            <><Zap className="h-4 w-4" /> Go online</>
          )}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Limit approved by admin"
          value={<Money showUsdt={false} amount={profile.data?.taskLimit ?? 0} compact />}
          tone="cyan"
          hint="Fixed until admin changes it"
        />
        {/* The room left under that ceiling belongs to the balance, not to the
            ceiling — the ceiling does not move when work is claimed. */}
        <Metric
          label="Available DMC"
          value={<Money showUsdt={false} amount={profile.data?.dmcBalance ?? 0} compact />}
          hint={`Current limit DMC ${(profile.data?.canTakeNow ?? 0).toLocaleString('en-IN')}`}
        />
        <Metric label="Security" value={<Money showUsdt={false} amount={profile.data?.collateralBalance ?? 0} compact />} hint="Backs your limit" />
        <Metric label="Completed" value={profile.data?.totalTasksCompleted ?? 0} tone="green" />
      </div>

      {!isOnline && (
        <div className="flex items-start gap-2.5 rounded-panel border border-signal-amber/40 bg-signal-amber/10 px-3.5 py-3">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-signal-amber" />
          <p className="text-xs text-ink-100">
            You are offline, so no tasks will be offered to you. Go online to start receiving work.
          </p>
        </div>
      )}

      <Panel
        title="Queue"
        eyebrow={queue.data ? `${queue.data.total} available` : undefined}
        bodyClassName={queue.data?.items.length ? 'p-0' : undefined}
      >
        {queue.isPending && <TableSkeleton rows={4} cols={4} />}
        {queue.isError && <ErrorState message="Could not load the queue." onRetry={() => void queue.refetch()} />}
        {queue.data?.items.length === 0 && (
          <EmptyState
            title="Nothing offered right now"
            hint="Tasks are offered to one captain at a time, best match first. Yours appear here with a window to accept them."
          />
        )}
        {queue.data && queue.data.items.length > 0 && (
          <ul className="divide-y divide-ink-800">
            {queue.data.items.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5 transition-colors hover:bg-ink-850/60">
                <div className="min-w-0 flex-1">
                  <span className="font-mono tnum text-sm text-ink-50">{task.taskCode}</span>
                  <p className="mt-1 text-xs text-ink-200">
                    {task.customerName} <span className="font-mono text-2xs text-ink-500">· {task.identifier}</span>
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-2xs text-ink-400">
                    <Clock className="h-3 w-3" />
                    {timeAgo(task.createdAt)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    {task.offerExpiresAt ? (
                      <Countdown deadline={task.offerExpiresAt} label="accept within" urgentBelowSeconds={60} expiredLabel="Offer lapsed" />
                    ) : task.openToPool ? (
                      <span className="inline-flex items-center rounded-full bg-signal-amber/10 px-2.5 py-1 text-2xs font-medium text-signal-amber">
                        Open to all captains
                      </span>
                    ) : null}
                    {/* Worth knowing before accepting, not after. */}
                    {task.reassignmentCount > 0 && (
                      <span
                        title={task.rejectionGuidance ?? undefined}
                        className="inline-flex items-center gap-1 rounded-full bg-signal-amber/10 px-2.5 py-1 text-2xs font-medium text-signal-amber"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Attempt {task.reassignmentCount + 1}
                      </span>
                    )}
                  </div>
                  {task.rejectionGuidance && (
                    <p className="mt-1.5 max-w-prose text-2xs text-ink-300">{task.rejectionGuidance}</p>
                  )}
                </div>

                <div className="text-right">
                  <Money amount={task.amount} className="block text-sm font-semibold text-ink-50" />
                  <p className="mt-0.5 text-2xs text-signal-green">
                    earns <Money amount={task.commission} className="text-2xs" />
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => claim.mutate(task.id)}
                  disabled={claim.isPending || !isOnline}
                  className="btn-primary shrink-0"
                >
                  {claimingId === task.id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Claim'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
