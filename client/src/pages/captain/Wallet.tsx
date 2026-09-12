import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, CreditCard, Banknote } from 'lucide-react';
import { UsdtPaymentFlow } from '@/components/UsdtPaymentFlow';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Money, EmptyState, TableSkeleton, cn } from '@/components/primitives';
import type { Paginated, DmcPurchaseDto, CaptainProfile, RedemptionDto } from '@/types';
import { when } from '@/lib/datetime';
import { BuyLimitPanel } from './BuyLimitPanel';

export function CaptainWallet() {
  const toast = useToast();
  const queryClient = useQueryClient();


  const [cashOutAmount, setCashOutAmount] = useState('');

  // What they have posted today — the number the deposit below adds to, and
  // the one worth seeing before deciding how much to send.
  const profile = useQuery<CaptainProfile>({
    queryKey: ['captain-profile'],
    queryFn: () => api.get<CaptainProfile>('/captain/profile'),
  });

  const purchases = useQuery<Paginated<DmcPurchaseDto>>({
    queryKey: ['captain-dmc-purchases'],
    queryFn: () => api.get<Paginated<DmcPurchaseDto>>('/captain/dmc/purchases?page=1&limit=10'),
  });

  const redemptions = useQuery<Paginated<RedemptionDto>>({
    queryKey: ['captain-redemptions'],
    queryFn: () => api.get<Paginated<RedemptionDto>>('/captain/redemptions?page=1&limit=10'),
  });

  const cashOut = useMutation({
    mutationFn: () =>
      api.post('/captain/redemptions', { amount: Number(cashOutAmount) }),
    onSuccess: () => {
      toast.show('success', 'Cash-out requested — admin will send the transfer and confirm it here.');
      setCashOutAmount('');
      void queryClient.invalidateQueries({ queryKey: ['captain-redemptions'] });
      void queryClient.invalidateQueries({ queryKey: ['captain-profile'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });


  // How much of a deposit is held as security rather than made spendable. Comes
  // from settings via the profile, so the sentence below matches what approval
  // will actually do.
  const lockPercentage = profile.data?.terms?.collateralLockPercentage ?? 50;

  // The one account withdrawals go to. Fetched here so the form can name it
  // rather than leaving the captain to guess which of their IDs is live.
  const upiIds = useQuery<{ upiIds: { upiId: string; active: boolean }[] }>({
    queryKey: ['captain-upi-ids'],
    queryFn: () => api.get<{ upiIds: { upiId: string; active: boolean }[] }>('/captain/upi-ids'),
  });
  const activeUpi = upiIds.data?.upiIds.find((u) => u.active) ?? null;

  const dmcBalance = profile.data?.dmcBalance ?? 0;

  const parsedCashOut = Number(cashOutAmount);
  // A cash-out needs an amount they have, and somewhere to send it. The server
  // refuses without an active merchant UPI too; this only saves the round trip.
  const cashOutValid =
    cashOutAmount.trim() !== '' && parsedCashOut > 0 && parsedCashOut <= dmcBalance && Boolean(activeUpi);


  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Captain</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">My wallet</h1>
        <p className="mt-1 text-xs text-ink-400">
          Post security money, and cash your DMC back out into rupees.
        </p>
      </div>

      {/*
        Two balances, two rules. There used to be a third — commission, which
        had to be converted into DMC before it was any use — and nobody ever
        chose to leave it sitting there, so the conversion was a step with no
        decision in it. Commission now lands in the same DMC as everything
        else. What is still worth separating is security, because that is the
        one number here the captain cannot spend.
      */}
      <div className="grid gap-3 sm:grid-cols-2">
        <BalanceCard
          label="Available DMC"
          hint="Capital, earnings and commission together"
          amount={dmcBalance}
          tone="text-ink-50"
        />
        <BalanceCard
          label="Security"
          hint="Backs your limit, never spent"
          amount={profile.data?.collateralBalance ?? 0}
          tone="text-ink-200"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        <BuyLimitPanel />

        <Panel
          title="Increase security money"
          eyebrow="raises your collateral"
          action={<CreditCard className="h-4 w-4 text-ink-400" />}
        >
          <div className="mb-3.5 grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
            <div>
              <p className="eyebrow">Collateral now</p>
              <p className="mt-0.5 font-mono tnum text-sm font-semibold text-ink-50">
                <Money showUsdt={false} amount={profile.data?.collateralBalance ?? 0} />
              </p>
            </div>
            <div>
              {/* The ceiling admin approved, not a balance. It moves only when
                  the security does, or when admin sets an override. */}
              <p className="eyebrow">Limit approved by admin</p>
              <p className="mt-0.5 font-mono tnum text-sm text-ink-50">
                <Money showUsdt={false} amount={profile.data?.taskLimit ?? 0} />
              </p>
            </div>
            <div className="col-span-2 border-t border-ink-700 pt-2">
              <div className="flex items-baseline justify-between">
                {/* What they can actually pick up right now: the limit and
                    their DMC, whichever binds. Commission does not raise it. */}
                <p className="eyebrow">Current limit</p>
                <p className="font-mono tnum text-sm font-semibold text-ink-50">
                  <Money showUsdt={false} amount={profile.data?.canTakeNow ?? 0} />
                </p>
              </div>
              {/* Without this, a limit that does not match the collateral above
                  reads as money gone missing. */}
              {profile.data?.creditLimit != null && (
                <p className="mt-1 text-2xs text-ink-500">
                  Support has set your limit to{' '}
                  <Money showUsdt={false} amount={profile.data.creditLimit} className="text-2xs" /> — your security money
                  is untouched.
                </p>
              )}
            </div>
          </div>

          {/*
            Posting security, paid in USDT.

            The DMC figure is what the captain asks for; the USDT figure is
            quoted from the captain rate and the address is assigned when they
            press Pay. Nothing is credited by any of it — an administrator
            confirms the transfer, and only then is the amount split into
            collateral and spendable DMC.
          */}
          <UsdtPaymentFlow
            quotePath="/captain/payment-quote"
            createPath="/captain/dmc/purchase"
            markPaidPath={(id) => `/captain/dmc/purchases/${id}/mark-paid`}
            invalidateKeys={[['captain-dmc-purchases'], ['captain-profile'], ['captain-wallet']]}
            amountLabel="Security to add (DMC)"
          />

          <p className="mt-3 text-2xs leading-relaxed text-ink-500">
            Once an administrator confirms it, {lockPercentage}% is held as security and the rest
            becomes available DMC you can work with. Neither half is earnings — those are only ever
            made by doing the work.
          </p>
        </Panel>

        <Panel title="Deposit history" bodyClassName={purchases.data?.items.length ? 'p-0' : undefined}>
          {purchases.isPending && <TableSkeleton rows={3} cols={3} />}
          {purchases.data?.items.length === 0 && (
            <EmptyState title="No deposits yet" hint="Post security money to raise how much work you can take on." />
          )}
          {purchases.data && purchases.data.items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-left">
                    <th className="px-4 py-2.5 eyebrow font-normal">When</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">Reference</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">Status</th>
                    <th className="px-4 py-2.5 eyebrow font-normal text-right">Security</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {purchases.data.items.map((p) => (
                    <tr key={p.id} className="transition-colors hover:bg-ink-850/60">
                      <td className="px-4 py-3 font-mono tnum text-xs text-ink-300">
                        {when(p.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-2xs text-ink-400">{p.proof?.reference ?? p.simulatedPaymentRef}</span>
                      </td>
                      <td className="px-4 py-3">
                        <DepositStatusChip status={p.status} />
                        {p.rejectionReason && (
                          <p className="mt-1 max-w-[24ch] text-2xs text-signal-red">{p.rejectionReason}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Money
                          amount={p.security}
                          showUsdt={false}  
                          className={cn(
                            'text-xs font-semibold',
                            p.status === 'APPROVED' ? 'text-ink-50' : 'text-ink-400',
                          )}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-4">
        <Panel
          title="Cash out to rupees"
          eyebrow="admin sends the transfer"
          action={<Banknote className="h-4 w-4 text-ink-400" />}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (cashOutValid && !cashOut.isPending) cashOut.mutate();
            }}
            className="space-y-3.5"
          >
            <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
              <div className="flex items-baseline justify-between">
                <p className="eyebrow">Available DMC</p>
                <p className="font-mono tnum text-sm font-semibold text-ink-50">
                  <Money showUsdt={false} amount={dmcBalance} />
                </p>
              </div>
            </div>

            <div>
              <label htmlFor="cashout-amount" className="field-label">Amount (DMC)</label>
              <input
                id="cashout-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={cashOutAmount}
                onChange={(e) => setCashOutAmount(e.target.value)}
                placeholder="5000"
                className="field-input font-mono tnum"
              />
              {cashOutAmount.trim() !== '' && parsedCashOut > dmcBalance && (
                <p className="mt-1 text-2xs text-signal-red">That is more DMC than you have.</p>
              )}
            </div>

            {/*
              Where it goes is not asked here any more. It is whichever merchant
              UPI the captain has made active on their profile, so the answer to
              "which account am I paid into?" is the same every time and is
              changed in one deliberate place.
            */}
            <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
              <p className="eyebrow">Sent to</p>
              {activeUpi ? (
                <>
                  <p className="mt-0.5 break-all font-mono text-xs text-ink-100">{activeUpi.upiId}</p>
                  <p className="mt-0.5 text-2xs text-ink-500">
                    Your active merchant UPI ·{' '}
                    <Link to="/captain/profile" className="text-brand-400 underline">
                      change it on your profile
                    </Link>
                  </p>
                </>
              ) : (
                <p className="mt-0.5 text-2xs text-signal-red">
                  No active merchant UPI.{' '}
                  <Link to="/captain/profile" className="underline">
                    Add one on your profile
                  </Link>{' '}
                  before cashing out.
                </p>
              )}
            </div>

            <button type="submit" disabled={!cashOutValid || cashOut.isPending} className="btn-primary w-full">
              {cashOut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Banknote className="h-4 w-4" /> Request cash-out</>}
            </button>

            <p className="text-2xs leading-relaxed text-ink-500">
              The DMC leaves your balance as soon as you ask, so it cannot be spent twice while admin is
              paying. If the request is rejected, every paise comes straight back.
            </p>
          </form>
        </Panel>
      </div>


      <Panel title="Cash-out history" bodyClassName={redemptions.data?.items.length ? 'p-0' : undefined}>
        {redemptions.isPending && <TableSkeleton rows={3} cols={4} />}
        {redemptions.data?.items.length === 0 && (
          <EmptyState title="No cash-outs yet" hint="DMC you no longer need can be paid back to you in rupees." />
        )}
        {redemptions.data && redemptions.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left">
                  <th className="px-4 py-2.5 eyebrow font-normal">When</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Sent to</th>
                  <th className="px-4 py-2.5 eyebrow font-normal">Status</th>
                  <th className="px-4 py-2.5 eyebrow font-normal text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {redemptions.data.items.map((r) => (
                  <tr key={r.id} className="transition-colors hover:bg-ink-850/60">
                    <td className="px-4 py-3 font-mono tnum text-xs text-ink-300">
                      {when(r.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-2xs text-ink-400">
                        {r.payoutMethod === 'UPI' ? r.payoutUpiId : `${r.payoutAccountName ?? ''} · ${r.payoutIfsc ?? ''}`}
                      </span>
                      {r.paymentReference && (
                        <p className="mt-1 font-mono text-2xs text-ink-500">Ref {r.paymentReference}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <RedemptionStatusChip status={r.status} />
                      {r.rejectionReason && (
                        <p className="mt-1 max-w-[24ch] text-2xs text-signal-red">{r.rejectionReason}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Money
                        amount={r.amount}
                        showUsdt={false}
                        className={cn(
                          'text-xs font-semibold',
                          r.status === 'PAID' ? 'text-ink-50' : 'text-ink-400',
                        )}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

/** One of the captain's three balances, with the rule that governs it. */
function BalanceCard({
  label,
  hint,
  amount,
  tone,
}: {
  label: string;
  hint: string;
  amount: number;
  tone: string;
}) {
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850 px-3.5 py-3">
      <p className="eyebrow">{label}</p>
      <p className={cn('mt-1 font-mono tnum text-lg font-semibold', tone)}>
        <Money showUsdt={false} amount={amount} />
      </p>
      <p className="mt-0.5 text-2xs text-ink-500">{hint}</p>
    </div>
  );
}

/**
 * Where a cash-out stands. "Awaiting admin" is the honest label while the DMC
 * is held: the captain cannot spend it, but it has not been paid out either.
 */
function RedemptionStatusChip({ status }: { status: RedemptionDto['status'] }) {
  const style =
    status === 'PAID'
      ? 'bg-signal-green/10 text-signal-green'
      : status === 'REJECTED'
        ? 'bg-signal-red/10 text-signal-red'
        : 'bg-signal-amber/10 text-signal-amber';
  const label = status === 'PAID' ? 'Paid' : status === 'REJECTED' ? 'Rejected' : 'Awaiting admin';
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium', style)}>
      {label}
    </span>
  );
}

/**
 * Where a deposit stands. Until admin confirms it, the money is with the
 * platform but the captain's collateral has not moved — showing that plainly
 * is the difference between "waiting" and "something went wrong".
 */
function DepositStatusChip({ status }: { status: DmcPurchaseDto['status'] }) {
  const style =
    status === 'APPROVED'
      ? 'bg-signal-green/10 text-signal-green'
      : status === 'REJECTED'
        ? 'bg-signal-red/10 text-signal-red'
        : 'bg-signal-amber/10 text-signal-amber';
  const label = status === 'APPROVED' ? 'Added' : status === 'REJECTED' ? 'Rejected' : 'Awaiting admin';
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium', style)}>
      {label}
    </span>
  );
}
