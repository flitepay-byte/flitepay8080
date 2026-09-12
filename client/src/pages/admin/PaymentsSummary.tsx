import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel } from '@/components/primitives';
import {
  PeriodSelector,
  PeriodStat,
  DEFAULT_PERIOD,
  type Period,
  type PeriodTotals,
} from '@/components/PeriodStat';

/**
 * What has actually moved through the two rails.
 *
 * Every figure here counts money that reached the other end — a settled
 * pay-in, a completed pay-out — and nothing else. Attempts that expired or
 * were cancelled moved nothing, and counting them under a heading that says
 * "total" would answer a question nobody asked.
 *
 * The windows are measured by when the money landed, not when the payment was
 * raised: a pay-in taken overnight belongs to the morning it settled. Days are
 * IST days, and "Last 7 days" ends today rather than yesterday, so it always
 * contains Today rather than running alongside it.
 *
 * The wording comes from the server's own `basis` rather than being written
 * again here — a heading and the arithmetic behind it should not be able to
 * drift apart.
 *
 * One period governs both rails. Pay-in and pay-out are read against each
 * other, and a control on each panel would let them fall out of step — showing
 * today's pay-in beside the month's pay-out, which compares nothing.
 */
interface Summary {
  payIn: PeriodTotals;
  payOut: PeriodTotals;
  basis: { payIn: string; payOut: string; timezone: string };
}

export function PaymentsSummary() {
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);

  const summary = useQuery<Summary>({
    queryKey: ['admin-payments-summary'],
    queryFn: () => api.get<Summary>('/admin/payments/summary'),
    refetchInterval: 60_000,
  });

  const rails: Array<{
    key: 'payIn' | 'payOut';
    label: string;
    icon: typeof ArrowDownToLine;
    tone: string;
  }> = [
    { key: 'payIn', label: 'Pay-in', icon: ArrowDownToLine, tone: 'text-signal-cyan' },
    { key: 'payOut', label: 'Pay-out', icon: ArrowUpFromLine, tone: 'text-signal-amber' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow">Money that moved</p>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {rails.map(({ key, label, icon: Icon, tone }) => (
          <Panel
            key={key}
            title={`Total ${label}`}
            eyebrow={summary.data?.basis[key] ?? 'money that actually moved'}
            action={<Icon className={`h-4 w-4 ${tone}`} />}
          >
            <PeriodStat data={summary.data?.[key]} period={period} tone={tone} />
          </Panel>
        ))}
      </div>
    </div>
  );
}
