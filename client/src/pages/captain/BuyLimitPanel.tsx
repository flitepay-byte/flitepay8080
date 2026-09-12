import { useQuery } from '@tanstack/react-query';
import { TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel, Money, EmptyState } from '@/components/primitives';
import { when } from '@/lib/datetime';
import { UsdtPaymentFlow } from '@/components/UsdtPaymentFlow';
import { DepositAddressLine } from '@/components/UsdtDepositAddress';
import type { Paginated, LimitPurchaseDto, LimitPurchaseOptionsDto } from '@/types';

/**
 * Buying more room to work with.
 *
 * Sits beside "Increase security money" and is deliberately not the same
 * thing, so the panel says which is which rather than leaving the captain to
 * work it out. Security is split in half — half locked as collateral, half
 * spendable. This is not split: the whole amount becomes limit and DMC, and no
 * collateral is posted, which is exactly why it is capped at the security they
 * have already put up.
 *
 * The maximum is served by the API rather than worked out here, so the ceiling
 * on this form is the ceiling the request is actually judged against.
 */
export function BuyLimitPanel() {

  const options = useQuery<LimitPurchaseOptionsDto>({
    queryKey: ['captain-limit-purchase-options'],
    queryFn: () => api.get<LimitPurchaseOptionsDto>('/captain/limit-purchase/options'),
  });

  const history = useQuery<Paginated<LimitPurchaseDto>>({
    queryKey: ['captain-limit-purchases'],
    queryFn: () => api.get<Paginated<LimitPurchaseDto>>('/captain/limit-purchases?page=1&limit=10'),
  });


  const max = options.data?.maxPurchase ?? 0;

  return (
    <Panel
      title="Increase current limit"
      eyebrow="does not touch your collateral"
      action={<TrendingUp className="h-4 w-4 text-ink-400" />}
    >
      <div className="mb-3.5 grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
        <div>
          <p className="eyebrow">Collateral</p>
          <p className="mt-0.5 font-mono tnum text-sm font-semibold text-ink-50">
            <Money showUsdt={false} amount={options.data?.collateral ?? 0} />
          </p>
        </div>
        <div>
          <p className="eyebrow">Most you can buy</p>
          <p className="mt-0.5 font-mono tnum text-sm font-semibold text-signal-cyan">
            <Money showUsdt={false} amount={max} />
          </p>
        </div>
      </div>

      <p className="mb-3 text-2xs leading-relaxed text-ink-400">
        Paying for limit is not the same as posting security. Security is split in half — half locked
        as collateral, half yours to work with. This is not split: the whole amount raises your limit
        and your DMC, and your collateral stays exactly where it is. That is why you can only buy up
        to the security you have already put up.
      </p>

      {options.data?.hasPending && (
        <p className="mb-3 rounded-md border border-signal-amber/30 bg-signal-amber/10 px-3 py-2 text-2xs text-signal-amber">
          You already have a request waiting on admin. It has not changed your limit yet.
        </p>
      )}

      {/*
        Buying capacity, paid in USDT at the captain rate — the same flow as a
        security deposit, because it is the same payment. What differs is only
        what approval does with it.
      */}
      <UsdtPaymentFlow
        quotePath="/captain/payment-quote"
        createPath="/captain/limit-purchase"
        markPaidPath={(id) => `/captain/limit-purchases/${id}/mark-paid`}
        invalidateKeys={[
          ['captain-limit-purchases'],
          ['captain-limit-purchase-options'],
          ['captain-profile'],
        ]}
        amountLabel="Limit to buy (DMC)"
        maxAmount={max}
        maxAmountHint={
          <p className="text-2xs text-signal-red">
            At most <Money showUsdt={false} amount={max} className="text-2xs" /> — the security you
            have posted.
          </p>
        }
        disabled={Boolean(options.data?.hasPending)}
        disabledReason="You already have a request waiting on an administrator."
      />

      {/* The captain's own history, so a pending request is visibly pending. */}
      <div className="mt-4 border-t border-ink-800 pt-3">
        <p className="eyebrow mb-2">Your requests</p>
        {history.data?.items.length === 0 && (
          <EmptyState title="Nothing yet" hint="Requests you send appear here with their status." />
        )}
        {history.data && history.data.items.length > 0 && (
          <ul className="space-y-2">
            {history.data.items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Money showUsdt={false} amount={p.amount} className="text-xs text-ink-100" />
                  <span
                    className={`text-2xs ${
                      p.status === 'APPROVED'
                        ? 'text-signal-green'
                        : p.status === 'REJECTED'
                          ? 'text-signal-red'
                          : 'text-signal-amber'
                    }`}
                  >
                    {p.status === 'PENDING'
                      ? 'Waiting on admin — not counted yet'
                      : p.status === 'APPROVED'
                        ? 'Added to your limit'
                        : 'Rejected'}
                  </span>
                </span>
                <span className="font-mono tnum text-2xs text-ink-500">{when(p.createdAt)}</span>
                <DepositAddressLine address={p.payment?.address} network={p.payment?.network} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
