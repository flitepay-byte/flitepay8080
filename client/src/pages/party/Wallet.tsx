import { useQuery } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { api } from '@/lib/api';
import { UsdtPaymentFlow } from '@/components/UsdtPaymentFlow';
import { Panel, Money, EmptyState, TableSkeleton, cn } from '@/components/primitives';
import type { Paginated, PartyTopUpRequestDto, TopUpStatus } from '@/types';
import { when } from '@/lib/datetime';

const TOPUP_STATUS_STYLE: Record<TopUpStatus, string> = {
  AWAITING_PAYMENT: 'bg-ink-700/40 text-ink-300',
  PENDING: 'bg-signal-amber/10 text-signal-amber',
  APPROVED: 'bg-signal-green/10 text-signal-green',
  REJECTED: 'bg-signal-red/10 text-signal-red',
};
const TOPUP_STATUS_LABEL: Record<TopUpStatus, string> = {
  AWAITING_PAYMENT: 'Not submitted yet',
  PENDING: 'Awaiting admin',
  APPROVED: 'Confirmed',
  REJECTED: 'Rejected',
};

/**
 * DMC WALLET — this party's own balance: topping up the task-creation balance
 * beyond the registration grant, and the history of those requests.
 *
 * Money owed *out* — captains and admin cashing out — lives under Pay In.
 * Both used to be here, which put the party's incoming balance next to its
 * outgoing obligations under one heading that fit neither.
 */
export function PartyWallet() {

  const topUps = useQuery<Paginated<PartyTopUpRequestDto>>({
    queryKey: ['party-topups'],
    queryFn: () => api.get<Paginated<PartyTopUpRequestDto>>('/party/dmc/purchases?page=1&limit=10'),
  });





  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Party</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Wallet</h1>
        <p className="mt-1 text-xs text-ink-400">
          Your DMC balance for creating tasks. Requests to pay captains or admin are under Pay In.
          Simulation only — no real payment gateway is ever involved.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
        <Panel title="Top up balance" eyebrow="sent directly to admin" action={<CreditCard className="h-4 w-4 text-ink-400" />}>
          {/*
            Topping up, paid in USDT at the PARTY rate.

            The same component the captain flows use — the payment is the same
            payment — but the quote endpoint is the party's, so a party is never
            quoted a captain's rate. Nothing is credited until an administrator
            confirms the transfer.
          */}
          <UsdtPaymentFlow
            quotePath="/party/payment-quote"
            createPath="/party/top-up"
            markPaidPath={(id) => `/party/top-ups/${id}/mark-paid`}
            invalidateKeys={[['party-top-ups'], ['party-profile'], ['party-overview']]}
            amountLabel="DMC to add"
          />
        </Panel>

        <Panel title="Your requests" bodyClassName={topUps.data?.items.length ? 'p-0' : undefined}>
          {topUps.isPending && <TableSkeleton rows={3} cols={2} />}
          {topUps.data?.items.length === 0 && (
            <EmptyState title="No top-ups yet" hint="Submitted requests appear here." />
          )}
          {topUps.data && topUps.data.items.length > 0 && (
            <ul className="divide-y divide-ink-800">
              {topUps.data.items.map((t) => (
                <li key={t.id} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Money amount={t.amount} className="text-sm font-semibold text-ink-50" />
                    <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium', TOPUP_STATUS_STYLE[t.status])}>
                      {TOPUP_STATUS_LABEL[t.status]}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-2xs text-ink-500">ref {t.proof.reference}</p>
                  {t.status === 'REJECTED' && t.rejectionReason && (
                    <p className="mt-1 text-2xs text-signal-red">{t.rejectionReason}</p>
                  )}
                  <p className="mt-1 font-mono tnum text-2xs text-ink-500">
                    {when(t.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

    </div>
  );
}
