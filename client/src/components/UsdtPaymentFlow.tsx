import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, FileText, Loader2, X } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';

/**
 * PAYING IN USDT
 * --------------
 * One component for the three flows that take money — a captain posting
 * security, a captain buying current limit, a party topping up — because the
 * payment is the same payment in all three. What differs is what it buys and
 * which rate applies, and both of those are decided on the server.
 *
 * It walks the order the payment really happens in:
 *
 *   1. The payer says how much DMC they want. The USDT figure is quoted to them;
 *      they never type it, because a figure they typed is a figure that can
 *      disagree with the one the request records.
 *   2. "Pay" opens the request. That is what commits an address and freezes the
 *      rate — before it, nothing has been assigned and idly changing the amount
 *      costs nothing.
 *   3. The address, the network and the QR are shown. They pay from their wallet.
 *   4. "I have paid" takes the transaction hash and, optionally, a screenshot.
 *
 * None of it credits anything. The request is PENDING from step 2 onward and an
 * administrator's approval is the only thing that moves a balance.
 */

export interface PaymentQuote {
  dmc: number;
  dmcPerUsdt: number;
  usdtAmount: number;
  network: string;
  asset: string;
}

export interface OpenedRequest {
  id: string;
  amount: number;
  payment: {
    address: string | null;
    network: string | null;
    dmcPerUsdt: number | null;
    usdtAmount: number | null;
    markedPaidAt: string | null;
  };
}

interface Props {
  /** Where a quote comes from, e.g. `/captain/payment-quote`. */
  quotePath: string;
  /** Where a request is opened, e.g. `/captain/dmc/purchase`. */
  createPath: string;
  /** Builds the mark-paid path from the new request's id. */
  markPaidPath: (id: string) => string;
  /** Query keys to refresh once something has actually changed. */
  invalidateKeys: string[][];
  amountLabel?: string;
  /** Optional ceiling, enforced by the server too. */
  maxAmount?: number;
  maxAmountHint?: React.ReactNode;
  disabled?: boolean;
  disabledReason?: string;
}

type Stage =
  | { step: 'AMOUNT' }
  | { step: 'PAY'; request: OpenedRequest; qr: string | null }
  | { step: 'DONE' };

export function UsdtPaymentFlow({
  quotePath,
  createPath,
  markPaidPath,
  invalidateKeys,
  amountLabel = 'Amount (DMC)',
  maxAmount,
  maxAmountHint,
  disabled = false,
  disabledReason,
}: Props) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState<Stage>({ step: 'AMOUNT' });

  const parsed = Number(amount);
  const amountValid = amount.trim() !== '' && Number.isFinite(parsed) && parsed > 0;
  const overMax = amountValid && maxAmount !== undefined && parsed > maxAmount;

  /**
   * The live quote. Debounced by TanStack's key rather than a timer: a new
   * amount is a new key, and only the latest one is kept.
   */
  const quote = useQuery<PaymentQuote>({
    queryKey: ['payment-quote', quotePath, amountValid ? parsed : 0],
    queryFn: () =>
      api.get<PaymentQuote>(`${quotePath}?amountPaise=${Math.round(parsed * 100)}`),
    enabled: amountValid && !overMax,
    staleTime: 30_000,
  });

  const invalidate = (): void => {
    for (const key of invalidateKeys) void queryClient.invalidateQueries({ queryKey: key });
  };

  const open = useMutation({
    mutationFn: () => api.post<OpenedRequest>(createPath, { amount: parsed }),
    onSuccess: async (request) => {
      invalidate();
      let qr: string | null = null;
      if (request.payment.address) {
        try {
          const view = await api.get<{ qrDataUrl: string }>(
            `/captain/deposit-address/qr?address=${encodeURIComponent(request.payment.address)}`,
          );
          qr = view.qrDataUrl;
        } catch {
          // A missing QR is not a reason to hide the address — the address is
          // the thing that matters and it is shown as text either way.
          qr = null;
        }
      }
      setStage({ step: 'PAY', request, qr });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  if (stage.step === 'PAY') {
    return (
      <PayStep
        request={stage.request}
        qr={stage.qr}
        markPaidPath={markPaidPath}
        onPaid={() => {
          invalidate();
          setAmount('');
          setStage({ step: 'DONE' });
        }}
        onCancel={() => {
          setAmount('');
          setStage({ step: 'AMOUNT' });
        }}
      />
    );
  }

  if (stage.step === 'DONE') {
    return (
      <div className="rounded-md border border-signal-green/30 bg-signal-green/10 px-3 py-3">
        <p className="flex items-center gap-1.5 text-xs font-medium text-signal-green">
          <Check className="h-3.5 w-3.5" /> Sent for verification
        </p>
        <p className="mt-1 text-2xs leading-relaxed text-ink-300">
          An administrator will check the transaction. Nothing changes in your account until they
          approve it.
        </p>
        <button
          type="button"
          className="btn-ghost mt-2 px-2 py-1 text-2xs"
          onClick={() => setStage({ step: 'AMOUNT' })}
        >
          Make another payment
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="usdt-amount" className="field-label">
          {amountLabel}
        </label>
        <input
          id="usdt-amount"
          type="number"
          step="0.01"
          min="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="2000"
          className="field-input font-mono tnum"
          disabled={disabled}
        />
        {overMax && maxAmountHint && <div className="mt-1">{maxAmountHint}</div>}
      </div>

      {/* What they will actually send. Quoted, never typed. */}
      <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="eyebrow">You pay</p>
          {quote.data && (
            <span className="text-2xs text-ink-500">
              1 USDT = {quote.data.dmcPerUsdt} DMC
            </span>
          )}
        </div>
        <p className="mt-1 font-mono tnum text-lg font-semibold text-ink-50">
          {quote.isFetching && amountValid ? (
            <Loader2 className="h-4 w-4 animate-spin text-ink-400" />
          ) : quote.data && !overMax ? (
            <>
              {quote.data.usdtAmount}{' '}
              <span className="text-xs font-normal text-ink-400">{quote.data.asset}</span>
            </>
          ) : (
            <span className="text-sm font-normal text-ink-500">—</span>
          )}
        </p>
        <p className="mt-0.5 text-2xs text-ink-500">
          {quote.data ? quote.data.network : 'TRON (TRC20)'}
        </p>
      </div>

      {disabled && disabledReason && (
        <p className="rounded-md border border-signal-amber/30 bg-signal-amber/10 px-3 py-2 text-2xs text-signal-amber">
          {disabledReason}
        </p>
      )}

      <button
        type="button"
        className="btn-primary w-full py-2 text-xs"
        disabled={!amountValid || overMax || disabled || open.isPending || !quote.data}
        onClick={() => open.mutate()}
      >
        {open.isPending ? 'Opening…' : 'Pay'}
      </button>
      <p className="text-2xs text-ink-500">
        The address is assigned when you press Pay, and the rate is fixed at that moment.
      </p>
    </div>
  );
}

function PayStep({
  request,
  qr,
  markPaidPath,
  onPaid,
  onCancel,
}: {
  request: OpenedRequest;
  qr: string | null;
  markPaidPath: (id: string) => string;
  onPaid: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  const markPaid = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('providerReference', reference.trim());
      if (notes.trim()) form.append('notes', notes.trim());
      if (receipt) form.append('receipt', receipt);
      return api.upload(markPaidPath(request.id), form);
    },
    onSuccess: () => {
      toast.show('success', 'Marked as paid — an administrator will verify it');
      onPaid();
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const { address, network, usdtAmount, dmcPerUsdt } = request.payment;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-ink-700 bg-ink-850 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="eyebrow">Send exactly</p>
          <span className="rounded-full bg-brand-600/15 px-2 py-0.5 text-2xs font-medium text-brand-400">
            {network ?? 'TRON (TRC20)'}
          </span>
        </div>
        <p className="mt-1 font-mono tnum text-lg font-semibold text-ink-50">
          {usdtAmount} <span className="text-xs font-normal text-ink-400">USDT</span>
        </p>
        <p className="mt-0.5 text-2xs text-ink-500">
          for {request.amount} DMC{dmcPerUsdt ? ` · 1 USDT = ${dmcPerUsdt} DMC` : ''}
        </p>

        <div className="mt-3 flex flex-wrap items-start gap-3">
          {qr && (
            <img
              src={qr}
              alt={`QR code for the ${network ?? 'TRON'} deposit address`}
              className="h-28 w-28 shrink-0 rounded-md bg-white p-1.5"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="eyebrow">To this address</p>
            <p className="mt-0.5 break-all font-mono text-2xs leading-relaxed text-ink-100">
              {address}
            </p>
            <button
              type="button"
              onClick={() => {
                if (!address) return;
                void navigator.clipboard.writeText(address).then(() => setCopied(true));
              }}
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
            Send only USDT on <span className="font-semibold">{network ?? 'TRON (TRC20)'}</span>.
            Anything sent over a different network cannot be recovered.
          </p>
        </div>
      </div>

      {!confirming ? (
        <>
          <button
            type="button"
            className="btn-primary w-full py-2 text-xs"
            onClick={() => setConfirming(true)}
          >
            Payment successful — mark as paid
          </button>
          <button type="button" className="btn-ghost w-full py-1.5 text-2xs" onClick={onCancel}>
            I will pay later
          </button>
        </>
      ) : (
        <div className="space-y-3 rounded-md border border-ink-700 bg-ink-850 p-3">
          <div>
            <label htmlFor="usdt-txid" className="field-label">
              Transaction hash / UTR
            </label>
            <input
              id="usdt-txid"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="TXID from your wallet"
              className="field-input font-mono text-xs"
            />
            <p className="mt-1 text-2xs text-ink-500">
              This is what an administrator checks the transfer against.
            </p>
          </div>

          <div>
            <label htmlFor="usdt-notes" className="field-label">
              Notes (optional)
            </label>
            <input
              id="usdt-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="field-input text-xs"
            />
          </div>

          {receipt ? (
            <div className="flex items-center justify-between rounded-md border border-ink-700 bg-ink-900 px-3 py-2">
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-200">
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{receipt.name}</span>
              </span>
              <button
                type="button"
                onClick={() => setReceipt(null)}
                className="btn-ghost shrink-0 p-1"
                aria-label="Remove file"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-ink-700 px-3 py-3 text-xs text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200">
              <FileText className="h-3.5 w-3.5" />
              Attach a screenshot (optional)
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
              />
            </label>
          )}

          <button
            type="button"
            className="btn-primary w-full py-2 text-xs"
            disabled={reference.trim().length < 6 || markPaid.isPending}
            onClick={() => markPaid.mutate()}
          >
            {markPaid.isPending ? 'Sending…' : 'Submit for verification'}
          </button>
          <p className="text-2xs text-ink-500">
            Nothing is credited by this. An administrator confirms the transfer first.
          </p>
        </div>
      )}
    </div>
  );
}
