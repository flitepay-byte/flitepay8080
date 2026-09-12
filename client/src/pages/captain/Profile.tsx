import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Circle, Plus, User, Wallet } from 'lucide-react';
import { api, type ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, EmptyState, TableSkeleton, Money } from '@/components/primitives';
import { when } from '@/lib/datetime';
import { useAuthStore } from '@/stores/auth.store';
import type { CaptainProfile as CaptainProfileDto } from '@/types';

interface MerchantUpi {
  upiId: string;
  label: string | null;
  active: boolean;
  addedAt: string;
}

/**
 * The captain's own profile: who they are, and where they are paid.
 *
 * The payout half is the part with a rule behind it. A captain may keep several
 * merchant UPI IDs, but exactly one is active at a time and that one is where
 * every withdrawal goes — activating another switches it, and the server
 * enforces that rather than trusting this screen to.
 */
export function CaptainProfilePage() {
  const user = useAuthStore((s) => s.user);

  const profile = useQuery<CaptainProfileDto>({
    queryKey: ['captain-profile'],
    queryFn: () => api.get<CaptainProfileDto>('/captain/profile'),
  });

  return (
    <div className="space-y-4 pb-16">
      <div>
        <p className="eyebrow">Captain</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">My profile</h1>
      </div>

      <Panel title="Your details" action={<User className="h-4 w-4 text-ink-400" />}>
        {profile.isPending && <TableSkeleton rows={3} cols={2} />}
        {profile.data && (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Detail label="Name" value={profile.data.displayName} />
            <Detail label="Captain code" value={profile.data.captainCode} mono />
            <Detail label="Email" value={user?.email ?? '—'} mono />
            <Detail
              label="Status"
              value={profile.data.status}
              tone={profile.data.status === 'ACTIVE' ? 'good' : 'bad'}
            />
            <Detail
              label="Presence"
              value={profile.data.isOnline ? 'Online' : 'Offline'}
              tone={profile.data.isOnline ? 'good' : undefined}
            />
            <Detail label="Rating" value={`${profile.data.rating?.toFixed(1) ?? '—'} / 5`} mono />
          </dl>
        )}
      </Panel>

      <Panel title="Money" eyebrow="what you hold right now">
        {profile.data && (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <MoneyDetail label="Available DMC" amount={profile.data.dmcBalance} />
            <MoneyDetail label="Security posted" amount={profile.data.collateralBalance} />
            <MoneyDetail label="Held against live work" amount={profile.data.lockedAmount} />
            <MoneyDetail label="Room to take on more" amount={profile.data.availableLimit} />
          </dl>
        )}
      </Panel>

      <MerchantUpiPanel />
    </div>
  );
}

function Detail({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'good' | 'bad';
}) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd
        className={`mt-0.5 text-sm ${mono ? 'font-mono' : ''} ${
          tone === 'good' ? 'text-signal-green' : tone === 'bad' ? 'text-signal-red' : 'text-ink-50'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function MoneyDetail({ label, amount }: { label: string; amount: number }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5">
        <Money amount={amount} showUsdt={false} className="text-sm font-semibold text-ink-50" />
      </dd>
    </div>
  );
}

function MerchantUpiPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [upiId, setUpiId] = useState('');
  const [label, setLabel] = useState('');

  const upiIds = useQuery<{ upiIds: MerchantUpi[]; notice: string }>({
    queryKey: ['captain-upi-ids'],
    queryFn: () => api.get<{ upiIds: MerchantUpi[]; notice: string }>('/captain/upi-ids'),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['captain-upi-ids'] });
  };

  const add = useMutation({
    mutationFn: () =>
      api.post('/captain/upi-ids', {
        upiId: upiId.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      }),
    onSuccess: () => {
      setUpiId('');
      setLabel('');
      invalidate();
      toast.show('success', 'UPI ID added');
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const setActive = useMutation({
    mutationFn: (vars: { upiId: string; active: boolean }) =>
      api.patch(`/captain/upi-ids/${encodeURIComponent(vars.upiId)}`, { active: vars.active }),
    onSuccess: (_data, vars) => {
      invalidate();
      toast.show(
        'success',
        vars.active ? 'Withdrawals will now go here' : 'Deactivated — choose another before cashing out',
      );
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const rows = upiIds.data?.upiIds ?? [];
  const active = rows.find((u) => u.active);
  const valid = /^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/.test(upiId.trim().toLowerCase());

  return (
    <Panel
      title="Where you are paid"
      eyebrow={active ? `active: ${active.upiId}` : 'nothing active'}
      action={<Wallet className="h-4 w-4 text-ink-400" />}
    >
      {/*
        Stated before the form rather than under it. A captain who reads this
        after typing has already decided what to paste.
      */}
      <div className="mb-3.5 flex items-start gap-2 rounded-md border border-signal-amber/40 bg-signal-amber/10 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-amber" />
        <div>
          <p className="text-xs font-semibold text-signal-amber">
            {upiIds.data?.notice ?? 'Only Merchant UPI ID is allowed.'}
          </p>
          <p className="mt-0.5 text-2xs leading-relaxed text-ink-300">
            A personal UPI ID will not be paid. Only one of your IDs is active at a time, and every
            withdrawal is sent to that one.
          </p>
        </div>
      </div>

      <div className="mb-3.5 grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            className="field-input font-mono text-xs"
            placeholder="merchant@bank"
            value={upiId}
            onChange={(e) => setUpiId(e.target.value)}
          />
          <input
            className="field-input text-xs"
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn-primary gap-1.5 px-3 py-1.5 text-xs"
          disabled={!valid || add.isPending}
          onClick={() => add.mutate()}
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>

      {upiIds.isPending && <TableSkeleton rows={2} cols={2} />}

      {!upiIds.isPending && rows.length === 0 && (
        <EmptyState
          title="No UPI ID yet"
          hint="Add your merchant UPI ID. You cannot cash out until one is active."
        />
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-ink-800 rounded-md border border-ink-800">
          {rows.map((u) => (
            <li key={u.upiId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 break-all font-mono text-2xs text-ink-100">
                  {u.active ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-signal-green" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 shrink-0 text-ink-600" />
                  )}
                  {u.upiId}
                </p>
                <p className="mt-0.5 pl-5 text-2xs text-ink-500">
                  {u.label ?? 'No label'} · added {when(u.addedAt)}
                  {u.active && <span className="ml-1.5 text-signal-green">· withdrawals go here</span>}
                </p>
              </div>
              <button
                type="button"
                className={u.active ? 'btn-ghost shrink-0 px-2 py-1 text-2xs' : 'btn-primary shrink-0 px-2 py-1 text-2xs'}
                disabled={setActive.isPending}
                onClick={() => setActive.mutate({ upiId: u.upiId, active: !u.active })}
              >
                {u.active ? 'Deactivate' : 'Make active'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 && !active && (
        <p className="mt-2.5 rounded-md border border-signal-red/30 bg-signal-red/10 px-3 py-2 text-2xs text-signal-red">
          None of your UPI IDs is active, so you cannot cash out. Make one active.
        </p>
      )}
    </Panel>
  );
}
