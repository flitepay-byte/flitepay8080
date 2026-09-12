import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Power, Wallet } from 'lucide-react';
import { api, type ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, EmptyState } from '@/components/primitives';

interface DepositAddress {
  address: string;
  label: string | null;
  active: boolean;
  addedAt: string;
}

/**
 * The USDT deposit address book.
 *
 * Lives in settings rather than the environment so an address can be added or
 * retired without a deployment.
 *
 * Retiring is not deleting, and the panel says so: requests already assigned to
 * an address still expect their payment there, and a row pointing at an address
 * nobody can look up is a payment nobody can trace. Retiring only stops it being
 * handed to new requests.
 */
export function UsdtAddressesPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');

  const addresses = useQuery<{ addresses: DepositAddress[] }>({
    queryKey: ['admin-usdt-addresses'],
    queryFn: () => api.get<{ addresses: DepositAddress[] }>('/admin/settings/usdt-addresses'),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin-usdt-addresses'] });
  };

  const add = useMutation({
    mutationFn: () =>
      api.post('/admin/settings/usdt-addresses', {
        address: address.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      }),
    onSuccess: () => {
      setAddress('');
      setLabel('');
      invalidate();
      toast.show('success', 'Address added');
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const toggle = useMutation({
    mutationFn: (vars: { address: string; active: boolean }) =>
      api.patch(`/admin/settings/usdt-addresses/${encodeURIComponent(vars.address)}`, {
        active: vars.active,
      }),
    onSuccess: () => {
      invalidate();
      toast.show('success', 'Address updated');
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const rows = addresses.data?.addresses ?? [];
  const activeCount = rows.filter((a) => a.active).length;

  return (
    <Panel
      title="USDT deposit addresses"
      eyebrow={`${activeCount} in use · TRON (TRC20)`}
      action={<Wallet className="h-4 w-4 text-ink-400" />}
    >
      <p className="mb-3 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-2xs leading-relaxed text-ink-400">
        A new payment request is assigned one of the addresses in use, at random. Retiring an address
        stops it being handed out but changes nothing about requests already assigned to it — their
        payment is still expected there.
      </p>

      <div className="mb-3.5 grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            className="field-input font-mono text-xs"
            placeholder="TRC20 address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
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
          disabled={address.trim().length < 4 || add.isPending}
          onClick={() => add.mutate()}
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>

      {rows.length === 0 && (
        <EmptyState
          title="No addresses yet"
          hint="Add at least one before captains or parties can be given somewhere to pay."
        />
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-ink-800 rounded-md border border-ink-800">
          {rows.map((a) => (
            <li key={a.address} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0">
                <p className="break-all font-mono text-2xs text-ink-100">{a.address}</p>
                <p className="mt-0.5 text-2xs text-ink-500">
                  {a.label ?? 'No label'}
                  {' · '}
                  <span className={a.active ? 'text-signal-green' : 'text-ink-500'}>
                    {a.active ? 'in use' : 'retired'}
                  </span>
                </p>
              </div>
              <button
                type="button"
                className="btn-ghost shrink-0 gap-1.5 px-2 py-1 text-2xs"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ address: a.address, active: !a.active })}
              >
                <Power className="h-3 w-3" />
                {a.active ? 'Retire' : 'Put back in use'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
