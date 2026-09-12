import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, Receipt } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel, Money } from '@/components/primitives';
import {
  PeriodSelector,
  PeriodStat,
  DEFAULT_PERIOD,
  type Period,
  type PeriodTotals,
} from '@/components/PeriodStat';
import { PaymentsListSection } from './PaymentsList';
import type { AdminTransactionDto, Task } from '@/types';
import { when } from '@/lib/datetime';

/**
 * What the platform itself earned, on money coming in and money going out.
 *
 * This screen used to list what *captains* earned, which was already answered
 * twice over — on Transactions, where every payment names its captain and fee,
 * and on each captain's own profile. Repeating it here told admin nothing new
 * and left the one figure only admin cares about — the platform's own margin —
 * with no home at all.
 *
 * The platform's cut is what nobody else took: the party's charge less the
 * captain's share. Never its own percentage, so the three figures on every row
 * add back to the charge exactly.
 *
 * Nothing is recorded twice to build this. Both numbers were already on rows
 * that existed — `adminCommission` on a completed task, and the subtraction on
 * a settled pay-in — so these lists are the ordinary payment lists, filtered
 * to the state in which the money actually landed.
 */
interface CommissionSummary {
  payIn: PeriodTotals;
  payOut: PeriodTotals;
  combined: PeriodTotals;
  basis: { payIn: string; payOut: string; rule: string; timezone: string };
}

/** A pay-out row, as the admin task list returns it. */
interface AdminPayOut extends Task {
  partyName: string | null;
  captainName: string | null;
}

export function AdminCommissions() {
  // One period across all three cards. The combined figure is the sum of the
  // other two, so letting them be read over different windows would put a
  // total on screen that its own parts do not add up to.
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);

  const summary = useQuery<CommissionSummary>({
    queryKey: ['admin-commissions-summary'],
    queryFn: () => api.get<CommissionSummary>('/admin/commissions/summary'),
  });

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Platform commission</h1>
        <p className="mt-1 text-xs text-ink-400">
          What the platform kept on each payment — the party&apos;s charge, less the captain&apos;s
          share.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow">What the platform kept</p>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <EarnedCard
          label="Total kept"
          eyebrow="both directions"
          data={summary.data?.combined}
          period={period}
          tone="text-ink-50"
        />
        <EarnedCard
          label="From pay-in"
          eyebrow={summary.data?.basis.payIn}
          data={summary.data?.payIn}
          period={period}
          tone="text-signal-cyan"
          icon={<ArrowDownToLine className="h-4 w-4 text-signal-cyan" />}
        />
        <EarnedCard
          label="From pay-out"
          eyebrow={summary.data?.basis.payOut}
          data={summary.data?.payOut}
          period={period}
          tone="text-signal-amber"
          icon={<ArrowUpFromLine className="h-4 w-4 text-signal-amber" />}
        />
      </div>

      <PaymentsListSection<AdminTransactionDto>
        title="Pay-in commission"
        eyebrow="settled pay-ins, newest first"
        action={<ArrowDownToLine className="h-4 w-4 text-signal-cyan" />}
        // Settled only: a pay-in still in flight has been quoted, not earned.
        endpoint="/admin/transactions?direction=PAY_IN&status=SETTLED"
        queryKey="admin-commission-payins"
        placeholder="Our code, the party's reference, a UTR, or a name"
        columns={[
          { label: 'When' },
          { label: 'Reference' },
          { label: 'Party' },
          { label: 'Amount', align: 'right' },
          { label: 'Party charged', align: 'right' },
          { label: 'Captain took', align: 'right' },
          { label: 'Platform kept', align: 'right' },
        ]}
        rowKey={(t) => t.id}
        renderRow={(t) => (
          <>
            <td className="px-4 py-3 font-mono tnum text-xs text-ink-300">{when(t.createdAt)}</td>
            <td className="px-4 py-3 font-mono text-2xs text-ink-300">{t.code}</td>
            <td className="px-4 py-3 text-xs text-ink-200">{t.partyName ?? '—'}</td>
            <td className="px-4 py-3 text-right">
              <Money amount={t.amount} showUsdt={false} className="text-xs text-ink-300" />
            </td>
            <td className="px-4 py-3 text-right">
              <Money amount={t.partyCharge} showUsdt={false} className="text-xs text-ink-200" />
            </td>
            <td className="px-4 py-3 text-right">
              <Money amount={t.commission} showUsdt={false} className="text-xs text-ink-400" />
            </td>
            <td className="px-4 py-3 text-right">
              <Money
                amount={t.platformCommission}
                showUsdt={false}
                className="text-xs font-semibold text-signal-green"
              />
            </td>
          </>
        )}
        emptyTitle="Nothing earned on pay-ins yet"
        emptyHint="A pay-in contributes once it settles."
      />

      <PaymentsListSection<AdminPayOut>
        title="Pay-out commission"
        eyebrow="completed pay-outs, newest first"
        action={<ArrowUpFromLine className="h-4 w-4 text-signal-amber" />}
        // Completed only: nobody is credited until the work is done.
        endpoint="/admin/tasks?status=COMPLETED"
        queryKey="admin-commission-payouts"
        placeholder="Task code, the party's reference, a UTR, or a name"
        columns={[
          { label: 'When' },
          { label: 'Reference' },
          { label: 'Party' },
          { label: 'Amount', align: 'right' },
          { label: 'Party charged', align: 'right' },
          { label: 'Captain took', align: 'right' },
          { label: 'Platform kept', align: 'right' },
        ]}
        rowKey={(t) => t.id}
        renderRow={(t) => (
          <>
            <td className="px-4 py-3 font-mono tnum text-xs text-ink-300">{when(t.createdAt)}</td>
            <td className="px-4 py-3 font-mono text-2xs text-ink-300">{t.taskCode}</td>
            <td className="px-4 py-3 text-xs text-ink-200">{t.partyName ?? '—'}</td>
            <td className="px-4 py-3 text-right">
              <Money amount={t.amount} showUsdt={false} className="text-xs text-ink-300" />
            </td>
            <td className="px-4 py-3 text-right">
              <Money amount={t.partyCharge} showUsdt={false} className="text-xs text-ink-200" />
            </td>
            <td className="px-4 py-3 text-right">
              <Money amount={t.commission ?? 0} showUsdt={false} className="text-xs text-ink-400" />
            </td>
            <td className="px-4 py-3 text-right">
              <Money
                amount={t.adminCommission ?? 0}
                showUsdt={false}
                className="text-xs font-semibold text-signal-green"
              />
            </td>
          </>
        )}
        emptyTitle="Nothing earned on pay-outs yet"
        emptyHint="A pay-out contributes once the party approves the proof."
      />

      {summary.data && (
        <p className="text-2xs text-ink-500">
          {summary.data.basis.rule}. Counted where the money landed, in {summary.data.basis.timezone}.
          A captain&apos;s own earnings are on Transactions and on their profile.
        </p>
      )}
    </div>
  );
}

/**
 * One rail's earnings for the chosen period.
 *
 * The card keeps its own framing — which rail, in which colour — and hands the
 * figures to the shared component, so this screen and the Transactions summary
 * present the same kind of number in the same way.
 */
function EarnedCard({
  label,
  eyebrow,
  data,
  period,
  tone,
  icon,
}: {
  label: string;
  eyebrow?: string;
  data?: PeriodTotals;
  period: Period;
  tone: string;
  icon?: React.ReactNode;
}) {
  return (
    <Panel title={label} eyebrow={eyebrow} action={icon ?? <Receipt className="h-4 w-4 text-ink-400" />}>
      <PeriodStat data={data} period={period} tone={tone} />
    </Panel>
  );
}
