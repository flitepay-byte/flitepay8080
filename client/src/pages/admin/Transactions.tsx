import { useState } from 'react';
import { TaskSearchInput } from '@/components/primitives';
import { PartyTopUpsPanel, CaptainDepositsPanel } from './MoneyPanels';
import { CaptainLimitPurchasesPanel } from './LimitPurchasesPanel';

/**
 * ADMIN → FUNDS & DEPOSITS, at /admin/funds.
 *
 * The file and its export still say Transactions — which is now the name of a
 * different screen entirely, so trust this line over the filename.
 *
 * Money moving between the platform and the people on either side of it.
 *
 * Three separate handshakes, each with its own two sides, shown together
 * because they are the same question asked three ways — who is owed what, and
 * has it actually been paid. Splitting them across three screens meant
 * checking three places to answer "is anybody waiting on money".
 *
 * One search box drives all three. Somebody looking for a name does not know
 * or care which of the three lists it will turn up in, and making them pick
 * first would be asking them to already know the answer.
 *
 * Admin's own commission is deliberately not here — it lives in My wallet,
 * because it is the platform's money rather than a movement between two other
 * parties.
 */
export function AdminTransactions() {
  const [search, setSearch] = useState('');

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Funds &amp; deposits</h1>
        <p className="mt-1 text-xs text-ink-400">
          Captains cashing out, captains posting security, and parties topping up. Admin&apos;s own commission
          lives in My wallet.
        </p>
      </div>

      <TaskSearchInput
        onChange={setSearch}
        placeholder="Captain or party name"
        label="Search transactions by captain or party"
        className="w-full"
      />
      <PartyTopUpsPanel search={search} />
      <CaptainDepositsPanel search={search} />
      <CaptainLimitPurchasesPanel />
    </div>
  );
}
