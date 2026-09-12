import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { Panel, Metric, Money, ErrorState, Skeleton, cn, stateLabel } from '@/components/primitives';
import type { TaskState } from '@/types';

interface AdminDashboard {
  byStatus: Record<string, { count: number; value: number }>;
  pendingAudits: number;
  today: { taskCount: number; taskValue: number };
  captains: { total: number; online: number; totalCollateral: number; totalLocked: number };
  totalCommissionPaid: number;
}

const STATE_ORDER: TaskState[] = [
  'CREATED', 'ASSIGNED', 'IN_PROGRESS', 'AUDIT_PENDING',
  'COMPLETED', 'REJECTED', 'REASSIGNED', 'EXPIRED', 'CANCELLED',
];

const BAR_TONE: Record<string, string> = {
  CREATED: 'bg-ink-400',
  ASSIGNED: 'bg-signal-cyan',
  IN_PROGRESS: 'bg-signal-cyan',
  PROOF_SUBMITTED: 'bg-signal-amber',
  AUDIT_PENDING: 'bg-signal-amber',
  COMPLETED: 'bg-signal-green',
  REJECTED: 'bg-signal-red',
  REASSIGNED: 'bg-signal-amber',
  EXPIRED: 'bg-signal-slate',
  CANCELLED: 'bg-signal-slate',
};

export function AdminOverview() {
  const { events } = useSocket();

  const dashboard = useQuery<AdminDashboard>({
    queryKey: ['admin-dashboard'],
    queryFn: () => api.get<AdminDashboard>('/admin/dashboard'),
    refetchInterval: 60_000,
  });

  const data = dashboard.data;
  const maxCount = data ? Math.max(1, ...Object.values(data.byStatus).map((s) => s.count)) : 1;

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Overview</h1>
      </div>

      {dashboard.isError && <ErrorState message="Could not load metrics." onRetry={() => void dashboard.refetch()} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {dashboard.isPending ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[86px]" />)
        ) : (
          <>
            <Metric
              label="Awaiting audit"
              value={data?.pendingAudits ?? 0}
              tone={data && data.pendingAudits > 0 ? 'amber' : 'default'}
              hint="Party's decision"
            />
            <Metric label="Today" value={data?.today.taskCount ?? 0} hint={data ? `worth ${formatCompact(data.today.taskValue)}` : undefined} />
            <Metric
              label="Captains online"
              value={`${data?.captains.online ?? 0}/${data?.captains.total ?? 0}`}
              tone="cyan"
            />
            <Metric label="Commission paid" value={<Money amount={data?.totalCommissionPaid ?? 0} compact />} tone="green" />
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Panel title="Tasks by state" eyebrow="all time">
          {dashboard.isPending && <Skeleton className="h-48" />}
          {data && (
            <ul className="space-y-2.5">
              {STATE_ORDER.filter((s) => data.byStatus[s]).map((state) => {
                const entry = data.byStatus[state];
                if (!entry) return null;
                return (
                  <li key={state}>
                    <Link
                      to={`/admin/tasks?status=${state}`}
                      className="flex items-center gap-3 rounded-md py-1 transition-colors hover:bg-ink-850"
                    >
                      <span className="w-28 shrink-0 text-xs text-ink-300">{stateLabel(state)}</span>
                      <div className="h-5 flex-1 overflow-hidden rounded bg-ink-850">
                        <div
                          className={cn('h-full rounded transition-all', BAR_TONE[state] ?? 'bg-ink-400')}
                          style={{ width: `${Math.max(2, (entry.count / maxCount) * 100)}%` }}
                        />
                      </div>
                      <span className="w-10 shrink-0 text-right font-mono tnum text-xs text-ink-100">{entry.count}</span>
                      <Money amount={entry.value} compact showUsdt={false} className="hidden w-20 shrink-0 text-right text-2xs text-ink-400 sm:block" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel
            title="Collateral"
            action={
              <Link to="/admin/captains" className="btn-ghost px-2 py-1 text-2xs">
                Manage <ArrowRight className="h-3 w-3" />
              </Link>
            }
          >
            {data && (
              <div className="space-y-3">
                <div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-ink-300">Held against open tasks</span>
                    <Money showUsdt={false} amount={data.captains.totalLocked} compact className="text-xs text-signal-amber" />
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-850">
                    <div
                      className="h-full rounded-full bg-signal-amber"
                      style={{
                        width: `${data.captains.totalCollateral > 0 ? Math.min(100, (data.captains.totalLocked / data.captains.totalCollateral) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <p className="mt-1.5 text-2xs text-ink-500">
                    of <Money amount={data.captains.totalCollateral} compact className="text-2xs" /> posted
                  </p>
                </div>
              </div>
            )}
          </Panel>

          <Panel title="Live activity" eyebrow={`${events.length} recent`} bodyClassName="p-0 max-h-64 overflow-y-auto">
            {events.length === 0 ? (
              <div className="px-4 py-6">
                <p className="text-center text-xs text-ink-500">Events appear here as they happen.</p>
              </div>
            ) : (
              <ul className="divide-y divide-ink-800">
                {events.map((event) => (
                  <li key={event.id} className="px-4 py-2.5">
                    <p className="text-xs text-ink-200">{event.message}</p>
                    <p className="mt-0.5 flex items-baseline gap-2">
                      {event.taskCode && <span className="font-mono tnum text-2xs text-ink-400">{event.taskCode}</span>}
                      <span className="font-mono tnum text-2xs text-ink-500">
                        {new Date(event.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function formatCompact(amount: number): string {
  if (amount >= 100000) return `DMC ${(amount / 100000).toFixed(1)}L`;
  return `DMC ${amount.toLocaleString('en-IN')}`;
}
