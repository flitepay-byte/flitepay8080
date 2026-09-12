import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import {
  Panel, Money, StatusChip, EmptyState, ErrorState, TableSkeleton, TaskSearchInput, cn,
} from '@/components/primitives';
import type { Task, Paginated } from '@/types';

type TabKey = 'ALL' | 'PENDING' | 'IN_WORK' | 'SUCCESS';

const TAB_STATES: Record<Exclude<TabKey, 'ALL'>, string[]> = {
  PENDING: ['PROOF_SUBMITTED', 'AUDIT_PENDING'],
  IN_WORK: ['ASSIGNED', 'IN_PROGRESS'],
  SUCCESS: ['COMPLETED'],
};

export function CaptainTasks() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('ALL');
  const [search, setSearch] = useState('');

  // Searched server-side rather than over the loaded page, so a task further
  // down this captain's history is still findable by name or number.
  const params = new URLSearchParams({ page: '1', limit: '25' });
  if (search) params.set('search', search);

  const tasks = useQuery<Paginated<Task>>({
    queryKey: ['captain-tasks', search],
    queryFn: () => api.get<Paginated<Task>>(`/captain/tasks?${params.toString()}`),
  });

  const allItems = tasks.data?.items ?? [];
  const visibleItems = tab === 'ALL' ? allItems : allItems.filter((t) => TAB_STATES[tab].includes(t.status));

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Captain</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">My tasks</h1>
      </div>

      <TaskSearchInput
        onChange={setSearch}
        placeholder="Task number or customer name"
        className="w-full"
      />

      <div className="grid grid-cols-4 gap-2">
        {(['ALL', 'PENDING', 'IN_WORK', 'SUCCESS'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'rounded-md border px-3 py-2 text-xs font-medium capitalize transition-colors',
              tab === key
                ? 'border-brand-500 bg-brand-500/10 text-brand-500'
                : 'border-ink-600 text-ink-300 hover:border-ink-500',
            )}
          >
            {key === 'ALL' ? 'All' : key === 'IN_WORK' ? 'In work' : key.toLowerCase()}
          </button>
        ))}
      </div>

      <Panel bodyClassName={visibleItems.length ? 'p-0' : undefined}>
        {tasks.isPending && <TableSkeleton rows={5} cols={4} />}
        {tasks.isError && <ErrorState message="Could not load your tasks." onRetry={() => void tasks.refetch()} />}
        {!tasks.isPending && visibleItems.length === 0 && (
          <EmptyState
            title={search ? 'Nothing matched' : tab === 'ALL' ? 'No tasks yet' : 'Nothing here'}
            hint={
              search
                ? 'No task of yours matches that number or customer name.'
                : tab === 'ALL'
                  ? 'Claim a task from the queue to get started.'
                  : 'No tasks in this state right now.'
            }
          />
        )}
        {visibleItems.length > 0 && (
          <ul className="divide-y divide-ink-800">
            {visibleItems.map((task) => (
              <li key={task.id} className={cn(task.releasedFromYou && 'bg-ink-900/40')}>
                <button
                  type="button"
                  onClick={() => navigate(`/captain/tasks/${task.id}`)}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-ink-850/60"
                >
                  <div className="min-w-0 flex-1">
                    <span className={cn('font-mono tnum text-sm', task.releasedFromYou ? 'text-ink-300' : 'text-ink-50')}>
                      {task.taskCode}
                    </span>
                    <p className="mt-1 text-2xs text-ink-400">{task.customerName}</p>
                    {/* Without this the row reads as a live rejection they still
                        have to answer for, rather than a closed record. */}
                    {task.releasedFromYou && (
                      <p className="mt-1 text-2xs text-ink-500">
                        No longer yours — reassigned
                        {task.releasedAt && ` on ${new Date(task.releasedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`}
                      </p>
                    )}
                  </div>
                  <StatusChip status={task.status} size="sm" />
                  <Money
                    amount={task.amount} showUsdt={false}
                    className={cn('w-24 text-right text-sm', task.releasedFromYou ? 'text-ink-400' : 'text-ink-50')}
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
