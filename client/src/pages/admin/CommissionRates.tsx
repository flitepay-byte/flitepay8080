import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, cn } from '@/components/primitives';
import type { ReactNode } from 'react';

/**
 * One account's own commission rates, for both directions.
 *
 * Used on the party profile to set what that party is *charged*, and on the
 * captain profile to set what that captain is *paid*. Deliberately one
 * component taking one side at a time rather than one form showing both:
 * a party's profile has no business stating a captain's earnings, and a
 * captain's has no business stating the margin on their own work. Which half
 * a screen edits is decided by its caller, and neither can reach the other's.
 *
 * Blank means "no rate agreed for this account", and the system default
 * applies. Zero is a different answer — charged nothing, or paid nothing, on
 * purpose — so the two are never collapsed into one another here or on the
 * server.
 */
interface DefaultRates {
  payInPartyCommissionPercentage: number;
  payInCaptainCommissionPercentage: number;
  payOutPartyCommissionPercentage: number;
  payOutCaptainCommissionPercentage: number;
}

export interface AccountRates {
  payInCommissionPercentage: number | null;
  payOutCommissionPercentage: number | null;
}

interface PartyRateRow {
  id: string;
  companyName: string;
  partyCode: string;
  payIn: number;
  payOut: number;
}

interface PartyRates {
  defaults: { payIn: number; payOut: number };
  parties: PartyRateRow[];
}

export function CommissionRatesPanel({
  side,
  endpoint,
  invalidateKey,
  rates,
}: {
  /** Which half of the bargain this profile owns. */
  side: 'PARTY_CHARGED' | 'CAPTAIN_PAID';
  /** The PATCH this profile's settings go to. */
  endpoint: string;
  /** The detail query to refresh once they land. */
  invalidateKey: unknown[];
  rates: AccountRates;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const charged = side === 'PARTY_CHARGED';

  const [payIn, setPayIn] = useState(rates.payInCommissionPercentage?.toString() ?? '');
  const [payOut, setPayOut] = useState(rates.payOutCommissionPercentage?.toString() ?? '');

  // The defaults, so a blank field can say what will actually apply rather
  // than leave admin to go and look it up on another screen.
  const defaults = useQuery<DefaultRates>({
    queryKey: ['admin-settings'],
    queryFn: () => api.get<DefaultRates>('/admin/settings'),
  });

  /**
   * Only on the captain's side, and only to warn.
   *
   * A rate above a party's charge is not a mistake to be blocked — 6% is a
   * perfectly good agreement for a party billed 7%, and the same captain also
   * takes work from a party billed 5%. It cannot be validated at save time,
   * because there is no single party to validate against. What admin can be
   * told is which parties it will be trimmed on, before they save it rather
   * than after a captain queries their pay.
   */
  const exposure = useQuery<PartyRates>({
    queryKey: ['admin-party-rates'],
    queryFn: () => api.get<PartyRates>('/admin/commission/party-rates'),
    enabled: !charged,
  });

  const fieldFor = (direction: 'payIn' | 'payOut'): string =>
    charged
      ? `${direction}PartyCommissionPercentage`
      : `${direction}CaptainCommissionPercentage`;

  const defaultFor = (direction: 'payIn' | 'payOut'): number | null => {
    const d = defaults.data;
    if (!d) return null;
    if (charged) {
      return direction === 'payIn'
        ? d.payInPartyCommissionPercentage
        : d.payOutPartyCommissionPercentage;
    }
    return direction === 'payIn'
      ? d.payInCaptainCommissionPercentage
      : d.payOutCaptainCommissionPercentage;
  };

  const parse = (raw: string): number | null | 'INVALID' => {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) return 'INVALID';
    return n;
  };

  const parsedIn = parse(payIn);
  const parsedOut = parse(payOut);
  const invalid = parsedIn === 'INVALID' || parsedOut === 'INVALID';

  const save = useMutation({
    mutationFn: () =>
      api.patch(endpoint, {
        [fieldFor('payIn')]: parsedIn === 'INVALID' ? undefined : parsedIn,
        [fieldFor('payOut')]: parsedOut === 'INVALID' ? undefined : parsedOut,
      }),
    onSuccess: () => {
      toast.show('success', charged ? 'Party commission updated.' : 'Captain commission updated.');
      void queryClient.invalidateQueries({ queryKey: invalidateKey });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  return (
    <Panel
      title={charged ? 'Party is charged' : 'Captain is paid'}
      eyebrow={charged ? 'what we take from this party' : 'what we pay this captain'}
    >
      <div className="space-y-3.5">
        <p className="text-2xs text-ink-500">
          {charged
            ? 'Charged on top of the amount, per direction. Blank uses the system default.'
            : 'Paid out of what the party was charged, per direction. Blank uses the system default.'}
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <RateField
            id={`${side}-pay-in`}
            label="Pay-in (%)"
            value={payIn}
            onChange={setPayIn}
            fallback={defaultFor('payIn')}
            invalid={parsedIn === 'INVALID'}
          />
          <RateField
            id={`${side}-pay-out`}
            label="Pay-out (%)"
            value={payOut}
            onChange={setPayOut}
            fallback={defaultFor('payOut')}
            invalid={parsedOut === 'INVALID'}
          />
        </div>

        {!charged && (
          <>
            {/* Said here rather than discovered from a payment that came out
                smaller than the rate promised. */}
            <p className="text-2xs text-ink-500">
              Capped by what the party was charged: a captain on a higher rate than their party is
              billed earns the party's charge, never more.
            </p>
            <CapWarning
              rates={exposure.data}
              payIn={parsedIn === 'INVALID' ? null : (parsedIn ?? defaultFor('payIn'))}
              payOut={parsedOut === 'INVALID' ? null : (parsedOut ?? defaultFor('payOut'))}
            />
          </>
        )}

        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={invalid || save.isPending}
          className="btn-primary w-full"
        >
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save commission'}
        </button>
      </div>
    </Panel>
  );
}

/**
 * Which parties would trim this captain's rate, named.
 *
 * A count alone ("3 parties charge less") sends admin off to check which; the
 * names are the whole reason this is useful, and there are few enough parties
 * for that to stay readable. It is a warning, never a block: the save is
 * legitimate and the cap protects the books either way.
 */
function CapWarning({
  rates,
  payIn,
  payOut,
}: {
  rates: PartyRates | undefined;
  payIn: number | null;
  payOut: number | null;
}) {
  if (!rates) return null;

  /**
   * One direction at a time. `pick` is what makes this readable: the same
   * party has two different charges, and a line about pay-in must name the
   * pay-in one — reaching for the wrong half is the obvious way to get this
   * subtly and invisibly wrong.
   */
  const line = (
    label: 'Pay-in' | 'Pay-out',
    rate: number | null,
    pick: (p: PartyRateRow) => number,
  ): ReactNode => {
    if (rate == null) return null;
    const hit = rates.parties.filter((p) => pick(p) < rate);
    if (hit.length === 0) return null;

    const names = hit.map((p) => `${p.companyName} (${pick(p)}%)`).join(', ');
    const total = rates.parties.length;
    return (
      <li key={label}>
        <span className="font-medium">
          {label} at {rate}%
        </span>{' '}
        is above what {hit.length} of {total} {total === 1 ? 'party charges' : 'parties charge'}:{' '}
        {names}. On their work this captain earns the party's rate.
      </li>
    );
  };

  const anyHit =
    (payIn != null && rates.parties.some((p) => p.payIn < payIn)) ||
    (payOut != null && rates.parties.some((p) => p.payOut < payOut));
  if (!anyHit) return null;

  return (
    <div className="rounded-md border border-signal-amber/40 bg-signal-amber/10 px-3 py-2.5">
      <p className="text-2xs font-medium text-signal-amber">This rate will be trimmed on some work</p>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-2xs text-ink-200">
        {line('Pay-in', payIn, (p) => p.payIn)}
        {line('Pay-out', payOut, (p) => p.payOut)}
      </ul>
      <p className="mt-1.5 text-2xs text-ink-500">
        You can still save this — the captain is simply paid the party's charge on those payments,
        and the ledger records the rate they were actually paid at.
      </p>
    </div>
  );
}

function RateField({
  id,
  label,
  value,
  onChange,
  fallback,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  fallback: number | null;
  invalid: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="field-label">{label}</label>
      <input
        id={id}
        type="number"
        min="0"
        max="100"
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={fallback != null ? `${fallback} (default)` : 'default'}
        className={cn('field-input font-mono tnum', invalid && 'border-signal-red')}
      />
      {invalid ? (
        <p className="mt-1 text-2xs text-signal-red">Enter a percentage between 0 and 100.</p>
      ) : value.trim() === '' ? (
        <p className="mt-1 text-2xs text-ink-500">
          {fallback != null ? `Using the ${fallback}% default` : 'Using the system default'}
        </p>
      ) : (
        // Zero is a real setting and reads like an empty field, so it says so.
        <p className="mt-1 text-2xs text-ink-300">
          {Number(value) === 0 ? 'Set to zero — nothing is charged or paid' : 'Set for this account'}
        </p>
      )}
    </div>
  );
}
