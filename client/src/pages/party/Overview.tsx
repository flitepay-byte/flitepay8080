import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, Upload, TrendingUp, Bell } from 'lucide-react';
import { api } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { Panel, Metric, Money, Skeleton, ErrorState, cn, stateLabel } from '@/components/primitives';
import type { TaskState } from '@/types';

interface PartyDashboard {
  byStatus: Record<string, number>;
  totalTasks: number;
  totalValue: number;
  completedValue: number;
  dmcBalance: number;
}

const ORDER: TaskState[] = [
  'CREATED', 'ASSIGNED', 'IN_PROGRESS', 'AUDIT_PENDING',
  'COMPLETED', 'REJECTED', 'REASSIGNED', 'EXPIRED', 'CANCELLED',
];

const TONE: Record<string, string> = {
  CREATED: 'bg-ink-400',
  ASSIGNED: 'bg-signal-cyan',
  IN_PROGRESS: 'bg-signal-cyan',
  AUDIT_PENDING: 'bg-signal-amber',
  COMPLETED: 'bg-signal-green',
  REJECTED: 'bg-signal-red',
  REASSIGNED: 'bg-signal-amber',
  EXPIRED: 'bg-signal-slate',
  CANCELLED: 'bg-signal-slate',
};

export function PartyOverview() {
  const { events } = useSocket();
  const dashboard = useQuery<PartyDashboard>({
    queryKey: ['party-dashboard'],
    queryFn: () => api.get<PartyDashboard>('/party/dashboard'),
  });

  const data = dashboard.data;
  const max = data ? Math.max(1, ...Object.values(data.byStatus)) : 1;
  const completedCount = data?.byStatus['COMPLETED'] ?? 0;
  const conversionRate = data && data.totalTasks > 0 ? Math.round((completedCount / data.totalTasks) * 100) : 0;
  const inFlight =
    (data?.byStatus['ASSIGNED'] ?? 0) + (data?.byStatus['IN_PROGRESS'] ?? 0) + (data?.byStatus['AUDIT_PENDING'] ?? 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Party</p>
          <h1 className="font-display text-xl font-semibold text-ink-50">Overview</h1>
        </div>
        <div className="flex gap-2">
          <Link to="/party/import" className="btn-secondary">
            <Upload className="h-4 w-4" /> Import
          </Link>
          <Link to="/party/tasks" className="btn-primary">
            <Plus className="h-4 w-4" /> New task
          </Link>
        </div>
      </div>

      {dashboard.isError && <ErrorState message="Could not load metrics." onRetry={() => void dashboard.refetch()} />}

      {dashboard.isPending ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="overflow-hidden rounded-panel bg-gradient-to-br from-brand-600 to-brand-900 px-5 py-5 text-white shadow-panel">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-2xs font-mono uppercase tracking-wider text-white/60">Total value moved</p>
              <p className="mt-1 font-display text-3xl font-bold tnum"><Money amount={data?.totalValue ?? 0} /></p>
              {/* <p className="mt-1 text-xs text-white/70">across {data?.totalTasks ?? 0} demo tasks</p> */}
            </div>
            <div className="rounded-full bg-white/15 p-2.5">
              <TrendingUp className="h-5 w-5" />
            </div>
          </div>

          <div className="mt-5 border-t border-white/15 pt-4">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-white/70">Completion rate</span>
              <span className="font-mono tnum font-semibold">{conversionRate}%</span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/15">
              <div className="h-full rounded-full bg-white transition-all" style={{ width: `${conversionRate}%` }} />
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {dashboard.isPending ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[86px]" />)
        ) : (
          <>
            <Metric label="DMC balance" value={<Money amount={data?.dmcBalance ?? 0} compact />} tone="cyan" />
            <Metric label="Completed value" value={<Money amount={data?.completedValue ?? 0} compact />} tone="green" />
            <Metric label="In flight" value={inFlight} />
            <Metric label="Total tasks" value={data?.totalTasks ?? 0} />
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Live activity" eyebrow={`${events.length} recent`} action={<Bell className="h-4 w-4 text-ink-400" />} bodyClassName="p-0 max-h-64 overflow-y-auto">
          {events.length === 0 ? (
            <div className="px-4 py-6">
              <p className="text-center text-xs text-ink-500">Events appear here as your tasks move.</p>
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

        <Panel title="Tasks by state">
        {dashboard.isPending && <Skeleton className="h-40" />}
        {data && (
          <ul className="space-y-2.5">
            {ORDER.filter((s) => data.byStatus[s]).map((state) => (
              <li key={state}>
                <Link
                  to={`/party/tasks?status=${state}`}
                  className="flex items-center gap-3 rounded-md py-1 transition-colors hover:bg-ink-850"
                >
                  <span className="w-28 shrink-0 text-xs text-ink-300">{stateLabel(state)}</span>
                  <div className="h-5 flex-1 overflow-hidden rounded bg-ink-850">
                    <div
                      className={cn('h-full rounded', TONE[state] ?? 'bg-ink-400')}
                      style={{ width: `${Math.max(2, ((data.byStatus[state] ?? 0) / max) * 100)}%` }}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right font-mono tnum text-xs text-ink-100">
                    {data.byStatus[state] ?? 0}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
