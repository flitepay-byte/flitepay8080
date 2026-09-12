import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel, Money, StatusChip, EmptyState, ErrorState, Skeleton, Pagination } from '@/components/primitives';
import { TASK_STATES, type Task, type Paginated, type TaskState } from '@/types';
import { PartyTopUpsPanel } from './MoneyPanels';
import { ApiIntegrationPanel } from './ApiIntegrationPanel';
import { CommissionRatesPanel } from './CommissionRates';
import { PartyClocksPanel } from './PartyClocks';
import { PartyPayInsPanel } from './PartyPayIns';

interface PartyDetailResponse {
  id: string;
  partyCode: string;
  companyName: string;
  contactEmail: string;
  status: 'ACTIVE' | 'SUSPENDED';
  dailyLimit: number | null;
  monthlyLimit: number | null;
  /**
   * What this party is charged, per direction; null means the system default.
   * Only their charge — what a captain earns is on the captain's profile.
   */
  payInCommissionPercentage: number | null;
  payOutCommissionPercentage: number | null;
  /**
   * The deadlines this party's tasks run on; null means the system default.
   * They are the party's alone — a captain has no clock of their own.
   */
  acceptanceMinutes: number | null;
  completionMinutes: number | null;
  maxAgeMinutes: number | null;
  expiryAckMinutes: number | null;
  dmcBalance: number;
  taskCount: number;
  taskValue: number;
  createdAt: string;
}

export function AdminPartyDetail() {
  const navigate = useNavigate();
  const { partyId } = useParams<{ partyId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = (searchParams.get('status') as TaskState | null) ?? '';
  const [page, setPage] = useState(1);

  const detail = useQuery<PartyDetailResponse>({
    queryKey: ['admin-party-detail', partyId],
    queryFn: () => api.get<PartyDetailResponse>(`/admin/parties/${partyId}`),
    enabled: Boolean(partyId),
  });

  const taskParams = new URLSearchParams({ page: String(page), limit: '10', partyId: partyId ?? '' });
  if (status) taskParams.set('status', status);

  const tasks = useQuery<Paginated<Task>>({
    queryKey: ['admin-party-tasks', partyId, status, page],
    queryFn: () => api.get<Paginated<Task>>(`/admin/tasks?${taskParams.toString()}`),
    enabled: Boolean(partyId),
  });

  return (
    <div className="space-y-5">
      <div>
        <Link to="/admin/parties" className="btn-ghost -ml-2 px-2 py-1 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" /> Parties
        </Link>
        <p className="eyebrow mt-2">Party</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">{detail.data?.companyName ?? '—'}</h1>
      </div>

      {detail.isPending && <Skeleton className="h-96" />}
      {detail.isError && <ErrorState message="Could not load this party." onRetry={() => void detail.refetch()} />}
      {detail.data && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Profile">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Field label="Party code" value={detail.data.partyCode} mono />
                <Field label="Contact email" value={detail.data.contactEmail} mono />
                <Field label="Status" value={detail.data.status === 'ACTIVE' ? 'Active' : 'Suspended'} />
                <Field
                  label="Onboarded"
                  value={new Date(detail.data.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                />
                <Field label="Daily limit" value={detail.data.dailyLimit != null ? `DMC ${detail.data.dailyLimit.toLocaleString('en-IN')}` : 'Inherited'} />
                <Field label="Monthly limit" value={detail.data.monthlyLimit != null ? `DMC ${detail.data.monthlyLimit.toLocaleString('en-IN')}` : 'Inherited'} />
              </dl>
            </Panel>

            <div className="grid grid-cols-3 gap-4">
              <Panel bodyClassName="text-center py-6">
                <p className="eyebrow">DMC balance</p>
                <p className="mt-1.5 font-mono tnum text-2xl font-semibold text-ink-50">
                  <Money amount={detail.data.dmcBalance} showUsdt={false} compact />
                </p>
              </Panel>
              <Panel bodyClassName="text-center py-6">
                <p className="eyebrow">Total tasks</p>
                <p className="mt-1.5 font-mono tnum text-2xl font-semibold text-ink-50">{detail.data.taskCount}</p>
              </Panel>
              <Panel bodyClassName="text-center py-6">
                <p className="eyebrow">Total value</p>
                <p className="mt-1.5 font-mono tnum text-2xl font-semibold text-ink-50">
                  <Money amount={detail.data.taskValue} showUsdt={false} compact />
                </p>
              </Panel>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <CommissionRatesPanel
              side="PARTY_CHARGED"
              endpoint={`/admin/parties/${partyId}/limits`}
              invalidateKey={['admin-party-detail', partyId]}
              rates={detail.data}
            />
            <PartyClocksPanel partyId={partyId ?? ''} clocks={detail.data} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-display text-sm font-semibold text-ink-50">Tasks from this party</p>
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

          {/* This party's own money-in history — the same panel the
              Funds & deposits page shows, scoped to them.

              There used to be a per-party commission editor here. Every party
              is now priced by the one pair of rates on Settings: what the
              party is charged, and what the captain takes out of it. Two
              parties on different terms could not be reconciled against a
              single pool without storing the difference somewhere nobody would
              have looked. */}
          {/* Money in, with the captain who took each payment. Pay-outs are the
              task table above and are left exactly as they were. */}
          {partyId && <PartyPayInsPanel partyId={partyId} />}

          {partyId && <PartyTopUpsPanel partyId={partyId} title="DMC top-ups" />}
          {partyId && <ApiIntegrationPanel partyId={partyId} />}
        </>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={`mt-0.5 truncate text-xs text-ink-100 ${mono ? 'font-mono tnum' : ''}`}>{value}</dd>
    </div>
  );
}
