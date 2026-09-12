import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, Pencil, Ban, CheckCircle2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Money, EmptyState, ErrorState, TableSkeleton, cn } from '@/components/primitives';
import { RatingStars, BadgeRow } from '@/components/Rating';
import type { CaptainProfile, Paginated } from '@/types';

export function AdminCaptains() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adjusting, setAdjusting] = useState<CaptainProfile | null>(null);
  const [editing, setEditing] = useState<CaptainProfile | null>(null);

  const captains = useQuery<Paginated<CaptainProfile>>({
    queryKey: ['admin-captains'],
    queryFn: () => api.get<Paginated<CaptainProfile>>('/admin/captains?page=1&limit=50'),
  });

  const toggleStatus = useMutation({
    mutationFn: (row: CaptainProfile) =>
      api.patch(`/admin/users/${row.userId}/status`, {
        status: row.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
      }),
    onSuccess: () => {
      toast.show('success', 'Captain status updated.');
      void queryClient.invalidateQueries({ queryKey: ['admin-captains'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Captains</h1>
      </div>

      <Panel bodyClassName={captains.data?.items.length ? 'p-0' : undefined}>
        {captains.isPending && <TableSkeleton rows={4} cols={9} />}
        {captains.isError && <ErrorState message="Could not load captains." onRetry={() => void captains.refetch()} />}
        {captains.data?.items.length === 0 && <EmptyState title="No captains yet" />}
        {captains.data && captains.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left">
                  <th className="px-4 py-2.5 eyebrow font-normal">Captain</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Rating</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Presence</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Status</th>
                  {/* The captain's own four numbers, under the captain's own
                      names, so a support call does not have to translate
                      between two vocabularies. */}
                  <th className="px-4 py-2.5 eyebrow font-normal text-right">Security</th>
                  <th className="px-4 py-2.5 eyebrow font-normal text-right">Approved limit</th>
                  <th className="px-4 py-2.5 eyebrow font-normal text-right">Available DMC</th>
                  <th className="px-4 py-2.5 eyebrow font-normal text-right">Current limit</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {captains.data.items.map((captain) => (
                  <tr key={captain.id} className="transition-colors hover:bg-ink-850/60">
                    <td className="px-4 py-3">
                      <span className="block text-xs text-ink-50">{captain.displayName}</span>
                      <span className="mt-0.5 block font-mono text-2xs text-ink-400">{captain.captainCode}</span>
                    </td>
                    <td className="px-4 py-3">
                      <RatingStars rating={captain.rating} />
                      <BadgeRow badges={captain.badges} className="mt-1" />
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn('h-1.5 w-1.5 rounded-full', captain.isOnline ? 'bg-signal-green' : 'bg-ink-500')} />
                        <span className="text-2xs text-ink-300">{captain.isOnline ? 'Online' : 'Offline'}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn('h-1.5 w-1.5 rounded-full', captain.status === 'ACTIVE' ? 'bg-signal-green' : 'bg-signal-red')} />
                        <span className="text-2xs text-ink-300">{captain.status === 'ACTIVE' ? 'Active' : 'Suspended'}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right"><Money amount={captain.collateralBalance} showUsdt={false} className="text-xs text-ink-100" /></td>
                    <td className="px-4 py-3 text-right">
                      <Money amount={captain.taskLimit} showUsdt={false} className="text-xs text-ink-100" />
                      {/* Whether admin has actually decided this number, or it
                          is still the captain's security standing in for one.
                          The figure alone cannot tell those apart, and only
                          one of them is a decision admin made. */}
                      <span className="mt-0.5 block text-2xs text-ink-500">
                        {captain.creditLimit != null ? 'set by admin' : 'from security'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right"><Money amount={captain.dmcBalance} showUsdt={false} className="text-xs text-ink-100" /></td>
                    <td className="px-4 py-3 text-right"><Money amount={captain.canTakeNow} showUsdt={false} className="text-xs text-signal-cyan" /></td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Link to={`/admin/captains/${captain.id}`} className="btn-secondary px-2 py-1 text-2xs">
                          View
                        </Link>
                        <button type="button" onClick={() => setAdjusting(captain)} className="btn-secondary px-2 py-1 text-2xs">
                          Set limit
                        </button>
                        <button type="button" onClick={() => setEditing(captain)} className="btn-secondary px-2 py-1 text-2xs">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleStatus.mutate(captain)}
                          disabled={toggleStatus.isPending}
                          className={cn('px-2 py-1 text-2xs', captain.status === 'ACTIVE' ? 'btn-danger' : 'btn-secondary')}
                        >
                          {captain.status === 'ACTIVE' ? <Ban className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {adjusting && <CaptainLimitDialog captain={adjusting} onClose={() => setAdjusting(null)} />}
      {editing && <EditProfileDialog captain={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EditProfileDialog({ captain, onClose }: { captain: CaptainProfile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(captain.displayName);
  const [dailyLimit, setDailyLimit] = useState(captain.dailyLimitOverride != null ? String(captain.dailyLimitOverride) : '');
  const [monthlyLimit, setMonthlyLimit] = useState(
    captain.monthlyLimitOverride != null ? String(captain.monthlyLimitOverride) : '',
  );

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/admin/captains/${captain.id}/profile`, {
        displayName: displayName.trim(),
        dailyLimit: dailyLimit.trim() === '' ? null : Number(dailyLimit),
        monthlyLimit: monthlyLimit.trim() === '' ? null : Number(monthlyLimit),
      }),
    onSuccess: () => {
      toast.show('success', 'Captain profile updated.');
      void queryClient.invalidateQueries({ queryKey: ['admin-captains'] });
      onClose();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const valid = displayName.trim().length >= 2;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-ink-950/80" onClick={onClose} aria-label="Close" />
      <div className="panel relative w-full max-w-sm shadow-panel animate-slide-up">
        <header className="border-b border-ink-700 px-5 py-3.5">
          <p className="eyebrow">Edit profile</p>
          <p className="mt-0.5 font-mono text-2xs text-ink-500">{captain.captainCode}</p>
        </header>

        <div className="space-y-3.5 px-5 py-4">
          <div>
            <label htmlFor="displayName" className="field-label">Display name</label>
            <input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="field-input"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="captainDailyLimit" className="field-label">Daily limit (DMC)</label>
            <input
              id="captainDailyLimit"
              type="number"
              min="0"
              step="0.01"
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              className="field-input font-mono tnum"
              placeholder="Leave blank to inherit system default"
            />
          </div>
          <div>
            <label htmlFor="captainMonthlyLimit" className="field-label">Monthly limit (DMC)</label>
            <input
              id="captainMonthlyLimit"
              type="number"
              min="0"
              step="0.01"
              value={monthlyLimit}
              onChange={(e) => setMonthlyLimit(e.target.value)}
              className="field-input font-mono tnum"
              placeholder="Leave blank to inherit system default"
            />
          </div>
        </div>

        <footer className="flex gap-2 border-t border-ink-700 px-5 py-3.5">
          <button type="button" onClick={() => save.mutate()} disabled={!valid || save.isPending} className="btn-primary flex-1">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Sets how much live work a captain may hold at once.
 *
 * This used to adjust their collateral directly, which it had no business
 * doing: that is the captain's own security money, posted by buying DMC and
 * returned the same way. The limit is the lever that actually belongs to
 * admin — it changes what they can take on, and moves not a rupee.
 */
function CaptainLimitDialog({ captain, onClose }: { captain: CaptainProfile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState('');

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/admin/captains/${captain.id}/profile`, body),
    onSuccess: () => {
      toast.show('success', 'Approved limit updated. Their security money is unchanged.');
      void queryClient.invalidateQueries({ queryKey: ['admin-captains'] });
      onClose();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const parsed = Number(value);
  const empty = value.trim() === '';
  const invalid = !empty && !Number.isFinite(parsed);
  const nextLimit = empty || invalid ? captain.taskLimit : captain.taskLimit + parsed;
  const wouldGoNegative = nextLimit < 0;

  // Raising the ceiling does not hand the captain capital. When their DMC is
  // what binds, Current limit stays where it is until they hold more — so say
  // so here rather than let admin grant room that changes nothing on screen.
  const capitalBinds = captain.canTakeNow < captain.taskLimit;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-ink-950/80" onClick={onClose} aria-label="Close" />
      <div className="panel relative w-full max-w-sm shadow-panel animate-slide-up">
        <header className="border-b border-ink-700 px-5 py-3.5">
          <p className="eyebrow">Add to approved limit</p>
          <p className="mt-0.5 font-display text-sm font-semibold text-ink-50">{captain.displayName}</p>
        </header>

        <div className="space-y-3.5 px-5 py-4">
          <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-ink-400">Security</span>
              <Money amount={captain.collateralBalance} className="text-ink-100" />
            </div>
            <div className="mt-1 flex items-baseline justify-between text-xs">
              <span className="text-ink-400">Approved limit now</span>
              <Money amount={captain.taskLimit} className="text-ink-100" />
            </div>
            <div className="mt-1 flex items-baseline justify-between text-xs">
              <span className="text-ink-400">Current limit</span>
              <Money amount={captain.canTakeNow} className="text-signal-cyan" />
            </div>
            <p className="mt-1.5 text-2xs text-ink-500">
              Their security money. Nothing here changes it — only what they may take on.
            </p>
          </div>

          <div>
            <label htmlFor="captain-limit" className="field-label">Add to limit (DMC)</label>
            <input
              id="captain-limit"
              type="number"
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="2,000"
              className={cn('field-input font-mono tnum', (invalid || wouldGoNegative) && 'border-signal-red')}
              autoFocus
            />
            {!empty && !invalid && !wouldGoNegative && (
              <p className="mt-1 text-2xs text-ink-300">
                Approved limit becomes{' '}
                <Money amount={nextLimit} showUsdt={false} className="text-2xs font-semibold text-ink-50" />
              </p>
            )}
            {wouldGoNegative && (
              <p className="mt-1 text-2xs text-signal-red">
                That takes the approved limit below zero. The most you can take back is{' '}
                <Money amount={captain.taskLimit} showUsdt={false} className="text-2xs" />.
              </p>
            )}
            <p className="mt-1 text-2xs text-ink-500">
              Added to what they already have. Negative takes a grant back.
            </p>
          </div>

          {capitalBinds && (
            <p className="text-2xs text-signal-amber">
              Their own DMC is what binds right now, not the ceiling — so Current limit stays at{' '}
              <Money amount={captain.canTakeNow} showUsdt={false} className="text-2xs" /> until they
              hold more, however much room you grant here.
            </p>
          )}
        </div>

        <footer className="flex flex-wrap gap-2 border-t border-ink-700 px-5 py-3.5">
          <button
            type="button"
            onClick={() => save.mutate({ creditLimitAdd: parsed })}
            disabled={empty || invalid || wouldGoNegative || save.isPending}
            className="btn-primary flex-1"
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add to limit'}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          {/* Still reachable, because a grant sometimes has to be undone
              wholesale rather than subtracted: this puts them back on the
              security they posted, which is where every captain starts. */}
          <button
            type="button"
            onClick={() => save.mutate({ creditLimit: null })}
            disabled={save.isPending}
            className="btn-secondary w-full text-2xs"
          >
            Reset to their security ({captain.collateralBalance.toLocaleString('en-IN')})
          </button>
        </footer>
      </div>
    </div>
  );
}
