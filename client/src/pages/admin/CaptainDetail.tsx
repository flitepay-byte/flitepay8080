import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Money, StatusChip, EmptyState, ErrorState, Skeleton, cn, Pagination } from '@/components/primitives';
import { RatingStars, BadgeRow } from '@/components/Rating';
import { CommissionRatesPanel } from './CommissionRates';
import { STATUS_STYLE, STATUS_LABEL } from './Payments';
import {
  TASK_STATES,
  type Task,
  type Paginated,
  type TaskState,
  type CaptainBadge,
  type AdminTransactionDto,
} from '@/types';
import { CaptainDepositsPanel } from './MoneyPanels';
import { CaptainLimitPurchasesPanel } from './LimitPurchasesPanel';

interface CaptainDetailResponse {
  id: string;
  captainCode: string;
  displayName: string;
  collateralBalance: number;
  /**
   * What this captain is paid, per direction; null means the system default.
   * Only their share — what a party is charged is on the party's profile.
   */
  payInCommissionPercentage: number | null;
  payOutCommissionPercentage: number | null;
  /** The ceiling admin approved. Fixed; nothing the captain does moves it. */
  taskLimit: number;
  /** What they may still take on: the ceiling and their capital, whichever binds. */
  canTakeNow: number;
  dmcBalance: number;
  isOnline: boolean;
  status: 'ACTIVE' | 'SUSPENDED';
  totalTasksCompleted: number;
  creditLimit: number | null;
  dailyLimitOverride: number | null;
  monthlyLimitOverride: number | null;
  rating: number;
  successRate: number;
  onTimeRate: number;
  badges: CaptainBadge[];
  totalTasksOnTime: number;
  totalTasksExpired: number;
  totalProofsRejected: number;
  totalRejectionsUpheldByAdmin: number;
  totalOffersMissed: number;
  meanAcceptSeconds: number | null;
}

export function AdminCaptainDetail() {
  const navigate = useNavigate();
  const { captainId } = useParams<{ captainId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = (searchParams.get('status') as TaskState | null) ?? '';
  const [page, setPage] = useState(1);

  const detail = useQuery<CaptainDetailResponse>({
    queryKey: ['admin-captain-detail', captainId],
    queryFn: () => api.get<CaptainDetailResponse>(`/admin/captains/${captainId}`),
    enabled: Boolean(captainId),
  });

  const taskParams = new URLSearchParams({ page: String(page), limit: '10', captainId: captainId ?? '' });
  if (status) taskParams.set('status', status);

  const tasks = useQuery<Paginated<Task>>({
    queryKey: ['admin-captain-tasks', captainId, status, page],
    queryFn: () => api.get<Paginated<Task>>(`/admin/tasks?${taskParams.toString()}`),
    enabled: Boolean(captainId),
  });

  return (
    <div className="space-y-5">
      <div>
        <Link to="/admin/captains" className="btn-ghost -ml-2 px-2 py-1 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" /> Captains
        </Link>
        <p className="eyebrow mt-2">Captain</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">{detail.data?.displayName ?? '—'}</h1>
      </div>

      {detail.isPending && <Skeleton className="h-96" />}
      {detail.isError && <ErrorState message="Could not load this captain." onRetry={() => void detail.refetch()} />}
      {detail.data && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Profile">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Field label="Captain code" value={detail.data.captainCode} mono />
                <Field
                  label="Status"
                  value={
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn('h-1.5 w-1.5 rounded-full', detail.data.status === 'ACTIVE' ? 'bg-signal-green' : 'bg-signal-red')} />
                      {detail.data.status === 'ACTIVE' ? 'Active' : 'Suspended'}
                    </span>
                  }
                />
                <Field
                  label="Presence"
                  value={
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn('h-1.5 w-1.5 rounded-full', detail.data.isOnline ? 'bg-signal-green' : 'bg-ink-500')} />
                      {detail.data.isOnline ? 'Online' : 'Offline'}
                    </span>
                  }
                />
                <Field label="Tasks completed" value={String(detail.data.totalTasksCompleted)} />
                <Field
                  label="Approved limit"
                  value={
                    detail.data.creditLimit != null
                      ? `DMC ${detail.data.creditLimit.toLocaleString('en-IN')} (set)`
                      : `DMC ${detail.data.collateralBalance.toLocaleString('en-IN')} (collateral)`
                  }
                />
                <Field label="Daily limit" value={detail.data.dailyLimitOverride != null ? `DMC ${detail.data.dailyLimitOverride.toLocaleString('en-IN')}` : 'Inherited'} />
                <Field label="Monthly limit" value={detail.data.monthlyLimitOverride != null ? `DMC ${detail.data.monthlyLimitOverride.toLocaleString('en-IN')}` : 'Inherited'} />
              </dl>
            </Panel>

            <div className="grid grid-cols-3 gap-3">
              <Panel bodyClassName="text-center py-6">
                <p className="eyebrow">Security</p>
                <p className="mt-1.5 font-mono tnum text-lg font-semibold text-ink-50"><Money showUsdt={false} amount={detail.data.collateralBalance} compact /></p>
              </Panel>
              <Panel bodyClassName="text-center py-6">
                <p className="eyebrow">Available DMC</p>
                <p className="mt-1.5 font-mono tnum text-lg font-semibold text-ink-50"><Money showUsdt={false} amount={detail.data.dmcBalance} compact /></p>
              </Panel>
              <Panel bodyClassName="text-center py-6">
                {/* What they can still pick up. This panel showed the
                    ceiling instead, which never moves — so it told admin
                    the captain was free to take on their whole limit no
                    matter how much of it was already committed. */}
                <p className="eyebrow">Current limit</p>
                <p className="mt-1.5 font-mono tnum text-lg font-semibold text-brand-500">
                  <Money showUsdt={false} amount={detail.data.canTakeNow} compact />
                </p>
              </Panel>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Performance" eyebrow="what routing scores them on">
              <div className="space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <RatingStars rating={detail.data.rating} />
                  <BadgeRow badges={detail.data.badges} />
                </div>
                <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
                  <Field label="Success rate" value={`${Math.round(detail.data.successRate * 100)}%`} />
                  <Field label="On-time rate" value={`${Math.round(detail.data.onTimeRate * 100)}%`} />
                  <Field
                    label="Avg accept"
                    value={detail.data.meanAcceptSeconds != null ? `${detail.data.meanAcceptSeconds}s` : '—'}
                  />
                  <Field label="Expired" value={String(detail.data.totalTasksExpired)} />
                  <Field label="Rejected" value={String(detail.data.totalProofsRejected)} />
                  <Field label="Upheld by admin" value={String(detail.data.totalRejectionsUpheldByAdmin)} />
                  <Field label="Missed offers" value={String(detail.data.totalOffersMissed)} />
                  <Field label="On time" value={String(detail.data.totalTasksOnTime)} />
                </dl>
              </div>
            </Panel>

            <CaptainLimitForm captainId={captainId ?? ''} detail={detail.data} />
            <CommissionRatesPanel
              side="CAPTAIN_PAID"
              endpoint={`/admin/captains/${captainId}/profile`}
              invalidateKey={['admin-captain-detail', captainId]}
              rates={detail.data}
            />
          </div>

          {/* Both directions, because a captain does both and admin is the
              only role that can see either. Money out first: it is the side
              with a person waiting on it. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-display text-sm font-semibold text-ink-50">Money out — pay-outs</p>
              <p className="mt-0.5 text-2xs text-ink-500">
                Tasks this captain carried out: they sent real money and took DMC in exchange.
              </p>
            </div>
            <select
              value={status}
              onChange={(e) => {
                const next = e.target.value;
                setSearchParams(next ? { status: next } : {});
                setPage(1);
              }}
              aria-label="Filter by state"
              className="field-input w-auto"
            >
              <option value="">All states</option>
              {TASK_STATES.map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>
              ))}
            </select>
          </div>

          <Panel bodyClassName={tasks.data?.items.length ? 'p-0' : undefined}>
            {tasks.isPending && <Skeleton className="h-48" />}
            {tasks.isError && <ErrorState message="Could not load tasks." onRetry={() => void tasks.refetch()} />}
            {tasks.data?.items.length === 0 && (
              <EmptyState title="No tasks match" hint={status ? 'Try clearing the state filter.' : undefined} />
            )}
            {tasks.data && tasks.data.items.length > 0 && (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-ink-800 text-left">
                        <th className="px-4 py-2.5 eyebrow font-normal">Task</th>
                        <th className="px-4 py-2.5 eyebrow font-normal">Beneficiary</th>
                        <th className="px-4 py-2.5 eyebrow font-normal">State</th>
                        <th className="px-4 py-2.5 eyebrow font-normal text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-800">
                      {tasks.data.items.map((task) => (
                        <tr
                          key={task.id}
                          onClick={() => navigate(`/admin/tasks/${task.id}`)}
                          className="cursor-pointer transition-colors hover:bg-ink-850/60"
                        >
                          <td className="px-4 py-3 font-mono tnum text-xs text-ink-50">{task.taskCode}</td>
                          <td className="px-4 py-3 text-xs text-ink-200">{task.customerName}</td>
                          <td className="px-4 py-3"><StatusChip status={task.status} size="sm" /></td>
                          <td className="px-4 py-3 text-right"><Money amount={task.amount} className="text-xs text-ink-50" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} totalPages={tasks.data.totalPages} onChange={setPage} />
              </>
            )}
          </Panel>

          {captainId && <CaptainPayInsPanel captainId={captainId} />}
          {captainId && <CaptainDepositsPanel captainId={captainId} title="Security deposits" />}
          {captainId && <CaptainLimitPurchasesPanel captainId={captainId} title="Limit purchases" />}
        </>
      )}
    </div>
  );
}

/**
 * The other half of what a captain does.
 *
 * The task list above is only their pay-outs. A pay-in is a transaction, not a
 * task, so it appears nowhere on this page unless it is fetched separately —
 * which meant admin could open a captain's profile, see no activity, and be
 * looking at someone who had taken twenty payments that morning.
 *
 * The party is named here on purpose. A captain must never learn whose money
 * they handled, but admin is the one role that may see across that boundary,
 * and settling an argument between the two sides is impossible without it.
 */
function CaptainPayInsPanel({ captainId }: { captainId: string }) {
  const [page, setPage] = useState(1);

  const payIns = useQuery<Paginated<AdminTransactionDto>>({
    queryKey: ['admin-captain-payins', captainId, page],
    queryFn: () =>
      api.get<Paginated<AdminTransactionDto>>(
        `/admin/transactions?page=${page}&limit=10&captainId=${captainId}`,
      ),
  });

  return (
    <>
      <div>
        <p className="font-display text-sm font-semibold text-ink-50">Money in — pay-ins</p>
        <p className="mt-0.5 text-2xs text-ink-500">
          Payments this captain received from a party&apos;s customer, giving up DMC in exchange.
        </p>
      </div>

      <Panel bodyClassName={payIns.data?.items.length ? 'p-0' : undefined}>
        {payIns.isPending && <Skeleton className="h-32" />}
        {payIns.isError && (
          <ErrorState message="Could not load pay-ins." onRetry={() => void payIns.refetch()} />
        )}
        {payIns.data?.items.length === 0 && (
          <EmptyState title="No pay-ins yet" hint="This captain has not received any customer payments." />
        )}
        {payIns.data && payIns.data.items.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-left">
                    <th className="px-4 py-2.5 eyebrow font-normal">Payment</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">Party</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">State</th>
                    <th className="px-4 py-2.5 eyebrow font-normal text-right">Amount</th>
                    <th className="px-4 py-2.5 eyebrow font-normal text-right">Their fee</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {payIns.data.items.map((t) => (
                    <tr key={t.id}>
                      <td className="px-4 py-3 font-mono tnum text-xs text-ink-50">{t.code}</td>
                      <td className="px-4 py-3 text-xs text-ink-200">{t.partyName ?? t.partyCode ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className={cn(
                          'inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium',
                          STATUS_STYLE[t.status],
                        )}>
                          {STATUS_LABEL[t.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Money amount={t.amount} className="text-xs text-ink-50" />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Money
                          amount={t.commission}
                          className={cn('text-xs', t.commissionPaid ? 'text-signal-green' : 'text-signal-amber')}
                        />
                        {/* Owed but unpaid is a real state: the pool could not
                            cover the fee. Saying so is the only way admin
                            finds out they owe somebody. */}
                        {!t.commissionPaid && t.commission > 0 && (
                          <p className="text-2xs text-signal-amber">unpaid</p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={payIns.data.totalPages} onChange={setPage} />
          </>
        )}
      </Panel>
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-xs text-ink-100', mono && 'font-mono tnum')}>{value}</dd>
    </div>
  );
}

/**
 * How much live work this captain may hold at once.
 *
 * Normally that is the security they posted, and most captains should stay
 * that way. Setting a limit here lets admin extend trust past what a proven
 * captain has posted, or hold a shaky one back — without touching their money,
 * which is the point: the collateral is theirs, and a limit decision is not a
 * reason to move it.
 */
function CaptainLimitForm({ captainId, detail }: { captainId: string; detail: CaptainDetailResponse }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState('');

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/admin/captains/${captainId}/profile`, body),
    onSuccess: () => {
      toast.show('success', 'Approved limit updated. Their security money is unchanged.');
      setValue('');
      void queryClient.invalidateQueries({ queryKey: ['admin-captain-detail', captainId] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const parsed = Number(value);
  const empty = value.trim() === '';
  const invalid = !empty && !Number.isFinite(parsed);
  const nextLimit = empty || invalid ? detail.taskLimit : detail.taskLimit + parsed;
  const wouldGoNegative = nextLimit < 0;

  // A ceiling is not capital. Where the captain's own DMC is what binds, more
  // room changes nothing they can see, so admin is told before granting it.
  const capitalBinds = detail.canTakeNow < detail.taskLimit;

  return (
    <Panel title="Approved limit" eyebrow="added to what they already have">
      <div className="space-y-3.5">
        <dl className="grid grid-cols-3 gap-x-4 gap-y-2">
          <div>
            <dt className="eyebrow">Security</dt>
            <dd className="mt-0.5 font-mono tnum text-sm text-ink-100">
              DMC {detail.collateralBalance.toLocaleString('en-IN')}
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Approved now</dt>
            <dd className="mt-0.5 font-mono tnum text-sm text-ink-100">
              DMC {detail.taskLimit.toLocaleString('en-IN')}
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Current limit</dt>
            <dd className="mt-0.5 font-mono tnum text-sm text-signal-cyan">
              DMC {detail.canTakeNow.toLocaleString('en-IN')}
            </dd>
          </div>
        </dl>

        <div>
          <label htmlFor="creditLimit" className="field-label">Add to limit (DMC)</label>
          <input
            id="creditLimit"
            type="number"
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="2,000"
            className={cn('field-input font-mono tnum', (invalid || wouldGoNegative) && 'border-signal-red')}
          />
          {!empty && !invalid && !wouldGoNegative && (
            <p className="mt-1 text-2xs text-ink-300">
              Approved limit becomes{' '}
              <span className="font-mono tnum font-semibold text-ink-50">
                DMC {nextLimit.toLocaleString('en-IN')}
              </span>
            </p>
          )}
          {wouldGoNegative && (
            <p className="mt-1 text-2xs text-signal-red">
              That takes the approved limit below zero. The most you can take back is DMC{' '}
              {detail.taskLimit.toLocaleString('en-IN')}.
            </p>
          )}
          <p className="mt-1 text-2xs text-ink-500">
            Added to the {detail.taskLimit.toLocaleString('en-IN')} they already have — this does not
            replace it. Negative takes a grant back. Their security money is not touched either way.
          </p>
        </div>

        {capitalBinds && (
          <p className="text-2xs text-signal-amber">
            Their own DMC is what binds right now, not the ceiling — so Current limit stays at DMC{' '}
            {detail.canTakeNow.toLocaleString('en-IN')} until they hold more, however much room you
            grant here.
          </p>
        )}

        <button
          type="button"
          onClick={() => save.mutate({ creditLimitAdd: parsed })}
          disabled={empty || invalid || wouldGoNegative || save.isPending}
          className="btn-primary w-full"
        >
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add to approved limit'}
        </button>

        {/* Still reachable, because a grant sometimes has to be undone
            wholesale rather than subtracted down. */}
        <button
          type="button"
          onClick={() => save.mutate({ creditLimit: null })}
          disabled={save.isPending}
          className="btn-secondary w-full text-2xs"
        >
          Reset to their security ({detail.collateralBalance.toLocaleString('en-IN')})
        </button>
      </div>
    </Panel>
  );
}
