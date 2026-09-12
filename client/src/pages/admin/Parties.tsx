import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, Plus, Ban, CheckCircle2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Money, EmptyState, ErrorState, TableSkeleton, cn } from '@/components/primitives';
import type { Paginated } from '@/types';

interface PartyRow {
  id: string;
  userId: string;
  partyCode: string;
  companyName: string;
  contactEmail: string;
  status: 'ACTIVE' | 'SUSPENDED';
  dailyLimit: number | null;
  monthlyLimit: number | null;
  dmcBalance: number;
  taskCount: number;
  taskValue: number;
  createdAt: string;
}

export function AdminParties() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [editingLimits, setEditingLimits] = useState<PartyRow | null>(null);

  const parties = useQuery<Paginated<PartyRow>>({
    queryKey: ['admin-parties'],
    queryFn: () => api.get<Paginated<PartyRow>>('/admin/parties?page=1&limit=50'),
  });

  const toggleStatus = useMutation({
    mutationFn: (row: PartyRow) =>
      api.patch(`/admin/users/${row.userId}/status`, {
        status: row.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
      }),
    onSuccess: () => {
      toast.show('success', 'Party status updated.');
      void queryClient.invalidateQueries({ queryKey: ['admin-parties'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Admin</p>
          <h1 className="font-display text-xl font-semibold text-ink-50">Parties</h1>
        </div>
        <button type="button" onClick={() => setCreating(true)} className="btn-primary">
          <Plus className="h-4 w-4" /> Add party
        </button>
      </div>

      <Panel bodyClassName={parties.data?.items.length ? 'p-0' : undefined}>
        {parties.isPending && <TableSkeleton rows={4} cols={7} />}
        {parties.isError && <ErrorState message="Could not load parties." onRetry={() => void parties.refetch()} />}
        {parties.data?.items.length === 0 && (
          <EmptyState title="No parties yet" hint="Onboard one to start creating demo tasks." />
        )}
        {parties.data && parties.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left">
                  <th className="px-4 py-2.5 eyebrow font-normal">Party</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Status</th>
                  <th className="px-4 py-2.5 eyebrow font-normal text-right">DMC balance</th>
                  <th className="px-4 py-2.5 eyebrow font-normal text-right">Tasks</th>
                  <th className="px-4 py-2.5 eyebrow font-normal text-right">Task value</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Limits (daily / monthly)</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {parties.data.items.map((party) => (
                  <tr key={party.id} className="transition-colors hover:bg-ink-850/60">
                    <td className="px-4 py-3">
                      <span className="block text-xs text-ink-50">{party.companyName}</span>
                      <span className="mt-0.5 block font-mono text-2xs text-ink-400">{party.partyCode} · {party.contactEmail}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn('h-1.5 w-1.5 rounded-full', party.status === 'ACTIVE' ? 'bg-signal-green' : 'bg-signal-red')} />
                        <span className="text-2xs text-ink-300">{party.status === 'ACTIVE' ? 'Active' : 'Suspended'}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right"><Money amount={party.dmcBalance} compact className="text-xs font-semibold text-ink-50" /></td>
                    <td className="px-4 py-3 text-right font-mono tnum text-xs text-ink-100">{party.taskCount}</td>
                    <td className="px-4 py-3 text-right"><Money showUsdt={false} amount={party.taskValue} compact className="text-xs text-ink-100" /></td>
                    <td className="px-4 py-3 text-2xs text-ink-300">
                      {party.dailyLimit != null ? <Money  amount={party.dailyLimit} compact className="text-2xs" /> : 'inherited'}
                      {' / '}
                      {party.monthlyLimit != null ? <Money amount={party.monthlyLimit} compact className="text-2xs" /> : 'inherited'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Link to={`/admin/parties/${party.id}`} className="btn-secondary px-2 py-1 text-2xs">
                          View
                        </Link>
                        <button type="button" onClick={() => setEditingLimits(party)} className="btn-secondary px-2 py-1 text-2xs">
                          Limits
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleStatus.mutate(party)}
                          disabled={toggleStatus.isPending}
                          className={cn('px-2 py-1 text-2xs', party.status === 'ACTIVE' ? 'btn-danger' : 'btn-secondary')}
                        >
                          {party.status === 'ACTIVE' ? <Ban className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
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

      {creating && <CreatePartyDialog onClose={() => setCreating(false)} />}
      {editingLimits && <LimitsDialog party={editingLimits} onClose={() => setEditingLimits(null)} />}
    </div>
  );
}

function CreatePartyDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [companyName, setCompanyName] = useState('');
  const [contactEmail, setContactEmail] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post<{ partyCode: string; defaultPassword: string }>('/admin/parties', {
        companyName: companyName.trim(),
        contactEmail: contactEmail.trim(),
      }),
    onSuccess: (result) => {
      toast.show(
        'success',
        `${result.partyCode} onboarded. Sign-in password: ${result.defaultPassword}`,
      );
      void queryClient.invalidateQueries({ queryKey: ['admin-parties'] });
      onClose();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const valid = companyName.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim());

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-ink-950/80" onClick={onClose} aria-label="Close" />
      <div className="panel relative w-full max-w-sm shadow-panel animate-slide-up">
        <header className="border-b border-ink-700 px-5 py-3.5">
          <p className="eyebrow">Onboard a demo party</p>
          <p className="mt-0.5 text-2xs text-ink-500">Creates a login and profile together.</p>
        </header>

        <div className="space-y-3.5 px-5 py-4">
          <div>
            <label htmlFor="companyName" className="field-label">Company name</label>
            <input
              id="companyName"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="field-input"
              placeholder="Demo Logistics Pvt Ltd"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="contactEmail" className="field-label">Contact email</label>
            <input
              id="contactEmail"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="field-input"
              placeholder="party2@otdms.demo"
            />
          </div>
          <p className="text-2xs leading-relaxed text-ink-500">
            The account signs in with the same demo password used everywhere in this simulation.
          </p>
        </div>

        <footer className="flex gap-2 border-t border-ink-700 px-5 py-3.5">
          <button type="button" onClick={() => create.mutate()} disabled={!valid || create.isPending} className="btn-primary flex-1">
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
        </footer>
      </div>
    </div>
  );
}

function LimitsDialog({ party, onClose }: { party: PartyRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [dailyLimit, setDailyLimit] = useState(party.dailyLimit != null ? String(party.dailyLimit) : '');
  const [monthlyLimit, setMonthlyLimit] = useState(party.monthlyLimit != null ? String(party.monthlyLimit) : '');

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/admin/parties/${party.id}/limits`, {
        dailyLimit: dailyLimit.trim() === '' ? null : Number(dailyLimit),
        monthlyLimit: monthlyLimit.trim() === '' ? null : Number(monthlyLimit),
      }),
    onSuccess: () => {
      toast.show('success', 'Party limits updated.');
      void queryClient.invalidateQueries({ queryKey: ['admin-parties'] });
      onClose();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-ink-950/80" onClick={onClose} aria-label="Close" />
      <div className="panel relative w-full max-w-sm shadow-panel animate-slide-up">
        <header className="border-b border-ink-700 px-5 py-3.5">
          <p className="eyebrow">Party limits</p>
          <p className="mt-0.5 font-display text-sm font-semibold text-ink-50">{party.companyName}</p>
        </header>

        <div className="space-y-3.5 px-5 py-4">
          <div>
            <label htmlFor="dailyLimit" className="field-label">Daily limit (DMC)</label>
            <input
              id="dailyLimit"
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
            <label htmlFor="monthlyLimit" className="field-label">Monthly limit (DMC)</label>
            <input
              id="monthlyLimit"
              type="number"
              min="0"
              step="0.01"
              value={monthlyLimit}
              onChange={(e) => setMonthlyLimit(e.target.value)}
              className="field-input font-mono tnum"
              placeholder="Leave blank to inherit system default"
            />
          </div>
          <p className="text-2xs leading-relaxed text-ink-500">
            Blank fields fall back to the global setting in Admin → Settings.
          </p>
        </div>

        <footer className="flex gap-2 border-t border-ink-700 px-5 py-3.5">
          <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary flex-1">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
        </footer>
      </div>
    </div>
  );
}
