import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Upload, FileSpreadsheet } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Metric, Money, EmptyState, ErrorState, TableSkeleton, cn } from '@/components/primitives';
import type { Paginated } from '@/types';

type ReconResult = 'MATCHED' | 'DISCREPANCY' | 'UNMATCHED_STATEMENT_ENTRY' | 'UNMATCHED_SYSTEM_TASK';

interface ReconEntry {
  reference: string;
  systemAmount: number | null;
  statementAmount: number | null;
  difference: number | null;
  taskCode: string | null;
  result: ReconResult;
  note: string | null;
}

interface ReconRun {
  runId: string;
  runCode: string;
  summary: {
    totalStatementRows: number;
    matched: number;
    discrepancy: number;
    unmatchedStatement: number;
    unmatchedSystem: number;
  };
  parseErrors: string[];
  entries: ReconEntry[];
}

interface HistoryRow {
  id: string;
  runCode: string;
  fileName: string;
  totalStatementRows: number;
  matched: number;
  discrepancy: number;
  unmatchedStatement: number;
  unmatchedSystem: number;
  createdAt: string;
}

const RESULT_STYLES: Record<ReconResult, { label: string; className: string }> = {
  MATCHED: { label: 'Matched', className: 'text-signal-green bg-signal-green/10' },
  DISCREPANCY: { label: 'Discrepancy', className: 'text-signal-red bg-signal-red/10' },
  UNMATCHED_STATEMENT_ENTRY: { label: 'Not in system', className: 'text-signal-amber bg-signal-amber/10' },
  UNMATCHED_SYSTEM_TASK: { label: 'Not in statement', className: 'text-signal-amber bg-signal-amber/10' },
};

export function AdminReconciliation() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [run, setRun] = useState<ReconRun | null>(null);
  const [filter, setFilter] = useState<ReconResult | ''>('');

  const history = useQuery<Paginated<HistoryRow>>({
    queryKey: ['admin-recon-history'],
    queryFn: () => api.get<Paginated<HistoryRow>>('/admin/reconciliation?page=1&limit=10'),
  });

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('file', file as File);
      return api.upload<ReconRun>('/admin/reconciliation', form);
    },
    onSuccess: (data) => {
      setRun(data);
      setFile(null);
      toast.show('success', `${data.summary.matched} matched, ${data.summary.discrepancy} with differences.`);
      void queryClient.invalidateQueries({ queryKey: ['admin-recon-history'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const visibleEntries = run?.entries.filter((e) => !filter || e.result === filter) ?? [];

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Reconciliation</h1>
        <p className="mt-1 text-xs text-ink-400">
          Compare a statement against completed tasks to find differences.
        </p>
      </div>

      <Panel title="Upload a statement" eyebrow="csv with reference and amount columns">
        <div className="flex flex-wrap items-center gap-3">
          <label
            className={cn(
              'flex flex-1 cursor-pointer items-center gap-2.5 rounded-md border border-dashed px-3 py-2.5 transition-colors',
              file ? 'border-signal-green/50 bg-signal-green/5' : 'border-ink-600 hover:border-ink-500',
            )}
          >
            <Upload className="h-4 w-4 shrink-0 text-ink-400" />
            <span className="min-w-0 flex-1 truncate text-xs text-ink-200">
              {file ? file.name : 'Choose a .csv file'}
            </span>
            <input type="file" accept=".csv" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button type="button" onClick={() => upload.mutate()} disabled={!file || upload.isPending} className="btn-primary">
            {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Run reconciliation'}
          </button>
        </div>
        <p className="mt-2 font-mono text-2xs text-ink-500">reference,amount</p>
      </Panel>

      {run && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Matched" value={run.summary.matched} tone="green" />
            <Metric label="Differences" value={run.summary.discrepancy} tone={run.summary.discrepancy > 0 ? 'red' : 'default'} />
            <Metric label="Not in system" value={run.summary.unmatchedStatement} tone="amber" />
            <Metric label="Not in statement" value={run.summary.unmatchedSystem} tone="amber" />
          </div>

          {run.parseErrors.length > 0 && (
            <div className="rounded-panel border border-signal-amber/40 bg-signal-amber/10 px-4 py-3">
              <p className="text-xs font-medium text-signal-amber">
                {run.parseErrors.length} row(s) could not be read
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {run.parseErrors.slice(0, 5).map((error) => (
                  <li key={error} className="font-mono text-2xs text-ink-300">{error}</li>
                ))}
              </ul>
            </div>
          )}

          <Panel
            title={`Results — ${run.runCode}`}
            action={
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as ReconResult | '')}
                aria-label="Filter results"
                className="field-input w-auto py-1 text-xs"
              >
                <option value="">All</option>
                {Object.entries(RESULT_STYLES).map(([key, style]) => (
                  <option key={key} value={key}>{style.label}</option>
                ))}
              </select>
            }
            bodyClassName="p-0"
          >
            {visibleEntries.length === 0 ? (
              <EmptyState title="Nothing in this category" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-800 text-left">
                      <th className="px-4 py-2.5 eyebrow font-normal">Reference</th>
                      <th className="px-4 py-2.5 eyebrow font-normal">Result</th>
                      <th className="px-4 py-2.5 eyebrow font-normal text-right">System</th>
                      <th className="px-4 py-2.5 eyebrow font-normal text-right">Statement</th>
                      <th className="px-4 py-2.5 eyebrow font-normal text-right">Difference</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-800">
                    {visibleEntries.map((entry, index) => {
                      const style = RESULT_STYLES[entry.result];
                      return (
                        <tr key={`${entry.reference}-${index}`} className="transition-colors hover:bg-ink-850/60">
                          <td className="px-4 py-3">
                            <span className="block font-mono tnum text-xs text-ink-50">{entry.reference}</span>
                            {entry.taskCode && <span className="mt-0.5 block font-mono text-2xs text-ink-400">{entry.taskCode}</span>}
                          </td>
                          <td className="px-4 py-3">
                            <span className={cn('inline-block rounded-full px-2 py-0.5 text-2xs font-medium', style.className)}>
                              {style.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {entry.systemAmount != null ? <Money amount={entry.systemAmount} className="text-xs text-ink-200" /> : <span className="text-xs text-ink-500">—</span>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {entry.statementAmount != null ? <Money amount={entry.statementAmount} className="text-xs text-ink-200" /> : <span className="text-xs text-ink-500">—</span>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {entry.difference != null && entry.difference !== 0 ? (
                              <Money amount={entry.difference} className="text-xs font-semibold text-signal-red" />
                            ) : (
                              <span className="text-xs text-ink-500">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      <Panel title="Previous runs" bodyClassName={history.data?.items.length ? 'p-0' : undefined}>
        {history.isPending && <TableSkeleton rows={3} cols={4} />}
        {history.isError && <ErrorState message="Could not load history." onRetry={() => void history.refetch()} />}
        {history.data?.items.length === 0 && (
          <EmptyState title="No runs yet" hint="Upload a statement above to compare it." />
        )}
        {history.data && history.data.items.length > 0 && (
          <ul className="divide-y divide-ink-800">
            {history.data.items.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <FileSpreadsheet className="h-4 w-4 shrink-0 text-ink-400" />
                <div className="min-w-0 flex-1">
                  <span className="block font-mono tnum text-xs text-ink-50">{row.runCode}</span>
                  <span className="mt-0.5 block truncate text-2xs text-ink-400">{row.fileName}</span>
                </div>
                <div className="flex gap-3 font-mono tnum text-2xs">
                  <span className="text-signal-green">{row.matched} matched</span>
                  {row.discrepancy > 0 && <span className="text-signal-red">{row.discrepancy} differ</span>}
                </div>
                <span className="font-mono tnum text-2xs text-ink-500">
                  {new Date(row.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
