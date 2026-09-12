import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel, EmptyState, ErrorState, TableSkeleton } from '@/components/primitives';
import type { Paginated } from '@/types';

/**
 * One of the two payment lists, with its own search and its own paging.
 *
 * Both rails behave the same way and neither should have to reimplement it, but
 * they are separate lists over separate collections — a pay-in is a Transaction
 * and a pay-out is a Task — so what is shared here is the behaviour, never the
 * data. Each caller brings its own endpoint and its own columns.
 *
 * The paging is deliberately two-stage. A payments screen is opened to answer
 * "what happened recently", and the ten most recent answer that on their own;
 * fifty rows of history to scroll past is a cost paid by everyone to serve the
 * few who came looking for something older. So it opens at ten, and "See all"
 * is the moment somebody says they want the history — from then on it pages
 * fifty at a time.
 *
 * Searching expands the list on its own. Somebody typing a UTR is already past
 * "what happened recently", and showing them ten matches with a See-all button
 * would be asking them to ask twice.
 */
const PREVIEW = 10;
const FULL = 50;

export function PaymentsListSection<T>({
  title,
  eyebrow,
  action,
  endpoint,
  queryKey,
  placeholder,
  columns,
  renderRow,
  rowKey,
  onRowClick,
  statuses,
  emptyTitle,
  emptyHint,
}: {
  title: string;
  eyebrow: string;
  action?: ReactNode;
  /** Path without paging or search — those are appended here. */
  endpoint: string;
  queryKey: string;
  placeholder: string;
  columns: Array<{ label: string; align?: 'right' }>;
  renderRow: (row: T) => ReactNode;
  rowKey: (row: T) => string;
  /** Where a row leads. Omitted where the row has no page of its own. */
  onRowClick?: (row: T) => void;
  /** The states this rail can be in. Omitted leaves the filter off entirely. */
  statuses?: Array<{ value: string; label: string }>;
  emptyTitle: string;
  emptyHint?: string;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);

  const searching = search.trim().length > 0;
  // Searching, or narrowing to one state, is itself a request for the whole
  // history rather than the recent few — so either opens the list.
  const showAll = expanded || searching || status !== '';
  const limit = showAll ? FULL : PREVIEW;

  // A new term or state has its own first page; keeping the old one would show
  // an empty page three of a two-page result and read as "nothing found".
  useEffect(() => setPage(1), [search, status]);

  const query = useQuery<Paginated<T>>({
    queryKey: [queryKey, search, status, limit, page],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (searching) params.set('search', search.trim());
      if (status) params.set('status', status);
      const join = endpoint.includes('?') ? '&' : '?';
      return api.get<Paginated<T>>(`${endpoint}${join}${params.toString()}`);
    },
    // Rows stay put while the next page loads, so paging does not blink.
    placeholderData: keepPreviousData,
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = query.data?.totalPages ?? 1;
  const more = !showAll && total > PREVIEW;

  return (
    <Panel title={title} eyebrow={eyebrow} action={action} bodyClassName="p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-4 py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={placeholder}
            className="field-input pl-8"
            aria-label={placeholder}
          />
        </div>
        {statuses && (
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label={`Filter ${title.toLowerCase()} by state`}
            className="field-input w-auto"
          >
            <option value="">All states</option>
            {statuses.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        )}
        {total > 0 && (
          <span className="font-mono tnum text-2xs text-ink-500">
            {showAll
              ? `${total.toLocaleString('en-IN')} total`
              : `${Math.min(PREVIEW, total)} of ${total.toLocaleString('en-IN')}`}
          </span>
        )}
      </div>

      {query.isPending && <TableSkeleton rows={4} cols={columns.length} />}
      {query.isError && (
        <ErrorState message={`Could not load ${title.toLowerCase()}.`} onRetry={() => void query.refetch()} />
      )}
      {!query.isPending && !query.isError && items.length === 0 && (
        <EmptyState
          title={searching || status ? 'Nothing matches that' : emptyTitle}
          {...(searching
            ? { hint: 'Try a code, a reference, a UTR, or a name.' }
            : status
              ? { hint: 'Nothing is in that state right now.' }
              : emptyHint
                ? { hint: emptyHint }
                : {})}
        />
      )}

      {items.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left">
                  {columns.map((c) => (
                    <th
                      key={c.label}
                      className={`px-4 py-2.5 eyebrow font-normal${c.align === 'right' ? ' text-right' : ''}`}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {items.map((row) => (
                  <tr
                    key={rowKey(row)}
                    {...(onRowClick ? { onClick: () => onRowClick(row) } : {})}
                    className={`transition-colors hover:bg-ink-850/60${onRowClick ? ' cursor-pointer' : ''}`}
                  >
                    {renderRow(row)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {more && (
            <div className="border-t border-ink-800 px-4 py-2.5">
              <button type="button" onClick={() => setExpanded(true)} className="btn-secondary w-full text-xs">
                See all {total.toLocaleString('en-IN')}
              </button>
            </div>
          )}

          {showAll && totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-ink-800 px-4 py-2.5">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="btn-secondary px-3 py-1 text-2xs"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Previous
              </button>
              <span className="font-mono tnum text-2xs text-ink-400">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="btn-secondary px-3 py-1 text-2xs"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
