import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Check, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';

export interface DepositAddressView {
  address: string;
  network: string;
  asset: string;
  qrDataUrl: string;
}

/**
 * Where to send the USDT.
 *
 * Shared by the two forms that take money — posting security and buying current
 * limit — because the payment is the same payment; only what it buys differs.
 *
 * The network is stated twice on purpose, once as a label and once as a warning.
 * USDT exists on several chains, the addresses look similar enough to paste
 * confidently, and a transfer sent over the wrong one does not bounce — it is
 * simply gone. That is the one mistake this panel exists to prevent.
 */
export function UsdtDepositAddress({ note }: { note?: string }) {
  const [copied, setCopied] = useState(false);

  const deposit = useQuery<DepositAddressView>({
    queryKey: ['captain-deposit-address'],
    queryFn: () => api.get<DepositAddressView>('/captain/deposit-address'),
    // The assignment is stable for the life of the form; refetching would only
    // risk showing one address while the captain is mid-transfer to another.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const copy = (): void => {
    if (!deposit.data) return;
    void navigator.clipboard.writeText(deposit.data.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (deposit.isPending) {
    return (
      <div className="mb-3.5 h-40 animate-pulse rounded-md border border-ink-700 bg-ink-850" />
    );
  }

  if (deposit.isError || !deposit.data) {
    return (
      <div className="mb-3.5 flex items-start gap-2 rounded-md border border-signal-red/40 bg-signal-red/10 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-red" />
        <p className="text-2xs text-ink-100">
          No deposit address is available right now. Contact an administrator before sending anything.
        </p>
      </div>
    );
  }

  const { address, network, asset, qrDataUrl } = deposit.data;

  return (
    <div className="mb-3.5 rounded-md border border-ink-700 bg-ink-850 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="eyebrow">Send {asset} to</p>
        <span className="rounded-full bg-brand-600/15 px-2 py-0.5 text-2xs font-medium text-brand-400">
          {network}
        </span>
      </div>

      <div className="mt-2.5 flex flex-wrap items-start gap-3">
        <img
          src={qrDataUrl}
          alt={`QR code for the ${network} deposit address`}
          className="h-28 w-28 shrink-0 rounded-md bg-white p-1.5"
        />

        <div className="min-w-0 flex-1">
          <p className="break-all font-mono text-2xs leading-relaxed text-ink-100">{address}</p>
          <button
            type="button"
            onClick={copy}
            className="btn-ghost mt-1.5 gap-1.5 px-2 py-1 text-2xs"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-signal-green" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" /> Copy address
              </>
            )}
          </button>
        </div>
      </div>

      <div className="mt-2.5 flex items-start gap-2 rounded-md border border-signal-amber/30 bg-signal-amber/10 px-2.5 py-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-amber" />
        <p className="text-2xs leading-relaxed text-signal-amber">
          Send only {asset} on <span className="font-semibold">{network}</span>. Anything sent over a
          different network cannot be recovered.
        </p>
      </div>

      <p className="mt-2 text-2xs leading-relaxed text-ink-500">
        {note ??
          'Send the payment first, then submit this form with the transaction reference. Nothing changes until an administrator confirms the money arrived.'}
      </p>
    </div>
  );
}

/** The address a submitted request was told to pay to, shown on its history row. */
export function DepositAddressLine({
  address,
  network,
}: {
  address?: string | null;
  network?: string | null;
}) {
  if (!address) return null;
  return (
    <p className="mt-0.5 break-all font-mono text-2xs text-ink-500">
      {network ? `${network} · ` : ''}
      {address}
    </p>
  );
}
