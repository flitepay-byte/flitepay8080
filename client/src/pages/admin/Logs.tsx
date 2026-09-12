import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Panel, EmptyState, ErrorState, TableSkeleton, cn, Pagination } from '@/components/primitives';
import type { Paginated } from '@/types';

interface AuditLogRow {
  id: string;
  action: string;
  role: string | null;
  userId: string | null;
  targetCollection: string;
  targetId: string | null;
  ip?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

const ACTIONS = [
  'LOGIN_SUCCESS', 'LOGIN_FAILED', 'ACCOUNT_LOCKED', 'TASK_CREATED', 'TASK_CLAIMED',
  'TASK_PAYOUT_EXECUTED', 'TASK_PROOF_SUBMITTED', 'TASK_APPROVED', 'TASK_REJECTED',
  'COLLATERAL_LOCKED', 'COLLATERAL_RELEASED', 'COLLATERAL_ADJUSTED', 'COMMISSION_CREATED',
  'CONFIG_UPDATED', 'RECONCILIATION_RUN',
];

/** Colour is used only to separate failure from success at a glance. */
function actionTone(action: string): string {
  if (action.includes('FAILED') || action.includes('REJECTED') || action.includes('LOCKED')) return 'text-signal-red';
  if (action.includes('APPROVED') || action.includes('SUCCESS') || action.includes('CREATED')) return 'text-signal-green';
  if (action.includes('CONFIG') || action.includes('ADJUSTED')) return 'text-signal-amber';
  return 'text-ink-200';
}

export function AdminLogs() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ page: String(page), limit: '30' });
  if (action) params.set('action', action);

  const logs = useQuery<Paginated<AuditLogRow>>({
    queryKey: ['admin-logs', action, page],
    queryFn: () => api.get<Paginated<AuditLogRow>>(`/admin/audit-logs?${params.toString()}`),
  });

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Audit log</h1>
        <p className="mt-1 text-xs text-ink-400">Append-only. Entries cannot be edited or deleted.</p>
      </div>

      <select
        value={action}
        onChange={(e) => { setAction(e.target.value); setPage(1); }}
        aria-label="Filter by action"
        className="field-input w-auto"
      >
        <option value="">All actions</option>
        {ACTIONS.map((a) => (
          <option key={a} value={a}>{a.replace(/_/g, ' ').toLowerCase()}</option>
        ))}
      </select>

      <Panel bodyClassName={logs.data?.items.length ? 'p-0' : undefined}>
        {logs.isPending && <TableSkeleton rows={8} cols={4} />}
        {logs.isError && <ErrorState message="Could not load the log." onRetry={() => void logs.refetch()} />}
        {logs.data?.items.length === 0 && <EmptyState title="No entries match" />}
        {logs.data && logs.data.items.length > 0 && (
          <>
            <ul className="divide-y divide-ink-800">
              {logs.data.items.map((entry) => (
                <li key={entry.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <span className={cn('font-mono text-2xs uppercase tracking-wider', actionTone(entry.action))}>
                      {entry.action.replace(/_/g, ' ')}
                    </span>
                    {entry.role && <span className="text-2xs text-ink-400">{entry.role.toLowerCase()}</span>}
                    <span className="ml-auto font-mono tnum text-2xs text-ink-500">
                      {new Date(entry.timestamp).toLocaleString('en-IN', {
                        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
                      })}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-2xs text-ink-400">
                    {entry.targetCollection}
                    {entry.targetId && <span className="text-ink-500"> · {entry.targetId.slice(-8)}</span>}
                    {entry.ip && <span className="text-ink-500"> · {entry.ip}</span>}
                  </p>
                  {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                    <p className="mt-1 truncate font-mono text-2xs text-ink-500">
                      {Object.entries(entry.metadata)
                        .slice(0, 4)
                        .map(([k, v]) => `${k}=${String(v)}`)
                        .join('  ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <Pagination page={page} totalPages={logs.data.totalPages} onChange={setPage} />
          </>
        )}
      </Panel>
    </div>
  );
}
