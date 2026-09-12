import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History, X, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel, EmptyState, ErrorState, TableSkeleton, Pagination, cn } from '@/components/primitives';
import type { Paginated } from '@/types';
import { whenWithYear as when } from '@/lib/datetime';

/**
 * Every version the settings have been, and what each one was.
 *
 * The list shows only what each version changed, because that is what somebody
 * scanning for "when did commission move" is looking for — thirty unchanged
 * fields per row would bury the one line that answers it. Opening a version
 * fetches the whole state, which is the question the diff cannot answer: what
 * everything else was at the time.
 *
 * The oldest version kept has no changes against it. It was copied as a
 * starting point rather than made by an edit, and on a database that predates
 * this history it is simply the version that was live when recording began —
 * the ones before it were overwritten while nothing was keeping them.
 */
const PER_PAGE = 10;

interface VersionRow {
  version: number;
  changes: Record<string, { from: unknown; to: unknown }>;
  changedCount: number;
  changedBy: string | null;
  at: string;
  isCurrent: boolean;
}

interface VersionList extends Paginated<VersionRow> {
  currentVersion: number;
}

interface VersionDetail {
  version: number;
  settings: Record<string, unknown>;
  changes: Record<string, { from: unknown; to: unknown }>;
  changedBy: string | null;
  at: string;
}

/** A settings key as a person would say it: payOutCaptain… → "Pay out captain commission percentage". */
function fieldLabel(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1').replace(/\s+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Values are mixed types — numbers, strings, arrays — so nothing is assumed. */
function show(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function SettingsVersionsPanel() {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);

  const versions = useQuery<VersionList>({
    queryKey: ['admin-settings-versions', page],
    queryFn: () => api.get<VersionList>(`/admin/settings/versions?page=${page}&limit=${PER_PAGE}`),
  });

  const items = versions.data?.items ?? [];

  return (
    <>
      <Panel
        title="Version history"
        eyebrow="what the settings were, and when"
        action={<History className="h-4 w-4 text-ink-400" />}
        bodyClassName={items.length ? 'p-0' : undefined}
      >
        {versions.isPending && <TableSkeleton rows={4} cols={4} />}
        {versions.isError && (
          <ErrorState message="Could not load the version history." onRetry={() => void versions.refetch()} />
        )}
        {!versions.isPending && !versions.isError && items.length === 0 && (
          <EmptyState title="No versions recorded" hint="A version is kept each time settings are saved." />
        )}

        {items.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-left">
                    <th className="px-4 py-2.5 eyebrow font-normal">Version</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">Changed</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">By</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {items.map((v) => (
                    <tr
                      key={v.version}
                      onClick={() => setOpen(v.version)}
                      className="cursor-pointer transition-colors hover:bg-ink-850/60"
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono tnum text-xs text-ink-50">v{v.version}</span>
                        {v.isCurrent && (
                          <span className="ml-1.5 rounded-full bg-signal-green/10 px-1.5 py-0.5 text-2xs font-medium text-signal-green">
                            in force
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-ink-200">
                        {v.changedCount === 0 ? (
                          // Not an edit — the point at which recording began.
                          <span className="text-ink-500">Starting point</span>
                        ) : (
                          <>
                            {Object.keys(v.changes).slice(0, 2).map(fieldLabel).join(', ')}
                            {v.changedCount > 2 && (
                              <span className="text-ink-500"> +{v.changedCount - 2} more</span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-ink-300">{v.changedBy ?? 'System'}</td>
                      <td className="px-4 py-3 font-mono tnum text-2xs text-ink-400">{when(v.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={versions.data?.totalPages ?? 1} onChange={setPage} />
          </>
        )}
      </Panel>

      {open !== null && <VersionDialog version={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * One version in full.
 *
 * What changed is shown first and separately from the rest: somebody opening
 * v7 almost always wants to know what v7 *did*, and having to find those two
 * fields among thirty unchanged ones is the problem the audit log already had.
 */
function VersionDialog({ version, onClose }: { version: number; onClose: () => void }) {
  const detail = useQuery<VersionDetail>({
    queryKey: ['admin-settings-version', version],
    queryFn: () => api.get<VersionDetail>(`/admin/settings/versions/${version}`),
  });

  const changed = Object.entries(detail.data?.changes ?? {});
  const settings = Object.entries(detail.data?.settings ?? {}).filter(
    ([k]) => !['version', 'createdAt', 'updatedAt', 'updatedBy'].includes(k),
  );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-ink-950/80" onClick={onClose} aria-label="Close" />
      <div className="panel relative flex max-h-[85vh] w-full max-w-lg flex-col shadow-panel animate-slide-up">
        <header className="flex items-start justify-between gap-3 border-b border-ink-700 px-5 py-3.5">
          <div>
            <p className="eyebrow">Settings v{version}</p>
            {detail.data && (
              <p className="mt-0.5 text-2xs text-ink-500">
                {when(detail.data.at)} · {detail.data.changedBy ?? 'System'}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="btn-ghost px-2 py-1" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {detail.isPending && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-ink-500" />
            </div>
          )}
          {detail.isError && <ErrorState message="Could not load this version." onRetry={() => void detail.refetch()} />}

          {detail.data && (
            <div className="space-y-4">
              {changed.length > 0 && (
                <div>
                  <p className="eyebrow">What this version changed</p>
                  <ul className="mt-1.5 space-y-1.5">
                    {changed.map(([key, { from, to }]) => (
                      <li key={key} className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2">
                        <p className="text-2xs text-ink-300">{fieldLabel(key)}</p>
                        <p className="mt-0.5 font-mono tnum text-xs">
                          <span className="text-signal-red line-through">{show(from)}</span>
                          <span className="mx-1.5 text-ink-500">→</span>
                          <span className="text-signal-green">{show(to)}</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <p className="eyebrow">Everything, as it stood</p>
                <dl className="mt-1.5 divide-y divide-ink-800 rounded-md border border-ink-700">
                  {settings.map(([key, value]) => (
                    <div key={key} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                      <dt className="text-2xs text-ink-400">{fieldLabel(key)}</dt>
                      <dd
                        className={cn(
                          'shrink-0 font-mono tnum text-2xs',
                          key in (detail.data?.changes ?? {}) ? 'text-signal-green' : 'text-ink-200',
                        )}
                      >
                        {show(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
