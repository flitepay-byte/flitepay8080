import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save } from 'lucide-react';
import { UsdtAddressesPanel } from './UsdtSettingsPanel';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, ErrorState, Skeleton, cn } from '@/components/primitives';
import { SettingsVersionsPanel } from './SettingsVersions';

interface ConfigView {
  version: number;
  /**
   * Two questions per direction: what the party is charged, and what the
   * captain is paid out of it. The platform keeps the difference, so there is
   * deliberately no third rate to set — it could only ever contradict these.
   */
  payInPartyCommissionPercentage: number;
  payInCaptainCommissionPercentage: number;
  payOutPartyCommissionPercentage: number;
  payOutCaptainCommissionPercentage: number;
  /**
   * What a USDT is worth in DMC, per side. Two settings, never one: a captain
   * buying capacity and a party topping up trade on different terms, and moving
   * one says nothing about the other.
   */
  captainDmcPerUsdt: number;
  partyDmcPerUsdt: number;
  /** How much of a security deposit is locked rather than made usable. */
  collateralLockPercentage: number;
  captainDailyLimit: number;
  captainMonthlyLimit: number;
  partyDailyLimit: number;
  partyMonthlyLimit: number;
  minimumTaskAmount: number;
  maximumTaskAmount: number;
  taskAcceptanceMinutes: number;
  taskCompletionMinutes: number;
  taskMaxAgeMinutes: number;
  taskExpiryAckMinutes: number;
  customerConfirmationMinutes: number;
  otpExpiryMinutes: number;
  otpResendCooldownSeconds: number;
  otpMaxAttempts: number;
  maxFailedLoginAttempts: number;
  accountLockMinutes: number;
}

/**
 * Every business rule is editable here. Nothing in the engines is hard-coded,
 * so a rate change is a settings edit rather than a deploy.
 */
export function AdminSettings() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<ConfigView>>({});

  const settings = useQuery<ConfigView>({
    queryKey: ['admin-settings'],
    queryFn: () => api.get<ConfigView>('/admin/settings'),
  });

  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (patch: Partial<ConfigView>) => api.patch('/admin/settings', patch),
    onSuccess: () => {
      toast.show('success', 'Settings saved.');
      void queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-settings-versions'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  if (settings.isPending) return <Skeleton className="h-96" />;
  if (settings.isError || !settings.data) {
    return <ErrorState message="Could not load settings." onRetry={() => void settings.refetch()} />;
  }

  const set = <K extends keyof ConfigView>(key: K, value: ConfigView[K]): void =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.data);

  const submit = (): void => {
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(draft)) {
      if (key === 'version') continue;
      if (settings.data && value !== settings.data[key as keyof ConfigView]) patch[key] = value;
    }
    if (Object.keys(patch).length > 0) save.mutate(patch);
  };

  return (
    <div className="space-y-5 pb-20">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Admin</p>
          <h1 className="font-display text-xl font-semibold text-ink-50">Settings</h1>
        </div>
        <span className="font-mono tnum text-2xs text-ink-400">version {settings.data.version}</span>
      </div>

      <Panel title="USDT conversion" eyebrow="what one USDT buys, per side">
        <p className="mb-3.5 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-2xs leading-relaxed text-ink-400">
          These are independent. Changing one leaves the other exactly as it was, and every payment
          request keeps the rate that applied when it was made — so changing a rate here never alters
          what somebody has already been told to pay.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="captain-rate" className="field-label">
              Captain · 1 USDT buys
            </label>
            <div className="flex items-center gap-2">
              <input
                id="captain-rate"
                type="number"
                step="0.01"
                min="0.01"
                className="field-input font-mono tnum"
                value={draft.captainDmcPerUsdt ?? 0}
                onChange={(e) => set('captainDmcPerUsdt', Number(e.target.value))}
              />
              <span className="shrink-0 text-2xs text-ink-400">DMC</span>
            </div>
            <p className="mt-1 text-2xs text-ink-500">
              Security deposits and current-limit purchases.
            </p>
          </div>
          <div>
            <label htmlFor="party-rate" className="field-label">
              Party · 1 USDT buys
            </label>
            <div className="flex items-center gap-2">
              <input
                id="party-rate"
                type="number"
                step="0.01"
                min="0.01"
                className="field-input font-mono tnum"
                value={draft.partyDmcPerUsdt ?? 0}
                onChange={(e) => set('partyDmcPerUsdt', Number(e.target.value))}
              />
              <span className="shrink-0 text-2xs text-ink-400">DMC</span>
            </div>
            <p className="mt-1 text-2xs text-ink-500">Party top-ups.</p>
          </div>
        </div>
      </Panel>

      <UsdtAddressesPanel />

      <Panel title="Commission" eyebrow="charged to the party, shared with the captain">
        <div className="space-y-5">
          <p className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-2xs leading-relaxed text-ink-400">
            The party is charged one rate on top of the amount, and that whole charge goes into the pool.
            The captain&apos;s share is paid out of it. Whatever is left in the pool is the platform&apos;s
            — it is never set as a rate of its own, which is what stops the three figures from
            disagreeing.
          </p>

          <div className="grid gap-5 sm:grid-cols-2">
            <DirectionRates
              title="Money out (pay-out)"
              hint="The captain hands over cash and takes DMC in exchange"
              partyRate={draft.payOutPartyCommissionPercentage ?? 0}
              onPartyRate={(v) => set('payOutPartyCommissionPercentage', v)}
              captainRate={draft.payOutCaptainCommissionPercentage ?? 0}
              onCaptainRate={(v) => set('payOutCaptainCommissionPercentage', v)}
            />
            <DirectionRates
              title="Money in (pay-in)"
              hint="The captain receives the customer&apos;s payment and gives up DMC"
              partyRate={draft.payInPartyCommissionPercentage ?? 0}
              onPartyRate={(v) => set('payInPartyCommissionPercentage', v)}
              captainRate={draft.payInCaptainCommissionPercentage ?? 0}
              onCaptainRate={(v) => set('payInCaptainCommissionPercentage', v)}
            />
          </div>

          {/* The number nobody could see before: what a party is actually
              billed, and how it splits. */}
          <CostBreakdown
            partyRate={draft.payOutPartyCommissionPercentage ?? 0}
            captainRate={draft.payOutCaptainCommissionPercentage ?? 0}
          />

          <p className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-2xs text-ink-400">
            Both rates are locked onto a task when it is created, because the party is billed the whole
            cost up front. Changing them affects only tasks created from now on.
          </p>
        </div>
      </Panel>

      <Panel title="Security deposit split" eyebrow="what a captain&apos;s deposit buys">
        <div className="space-y-4">
          <NumberField
            label="Locked as security"
            suffix="%"
            step={1}
            value={draft.collateralLockPercentage ?? 50}
            onChange={(v) => set('collateralLockPercentage', v)}
            hint="The rest becomes available DMC the captain can use straight away"
          />

          {/* A percentage on its own does not answer the question an admin is
              actually asking, which is what a real deposit turns into. */}
          <div className="grid grid-cols-2 gap-3 rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5 text-xs">
            <div>
              <p className="eyebrow">DMC 20,000 posted becomes</p>
              <p className="mt-1 font-mono tnum text-ink-50">
                {(20000 * (draft.collateralLockPercentage ?? 50) / 100).toLocaleString('en-IN')} security
              </p>
            </div>
            <div>
              <p className="eyebrow">&nbsp;</p>
              <p className="mt-1 font-mono tnum text-signal-green">
                {(20000 - 20000 * (draft.collateralLockPercentage ?? 50) / 100).toLocaleString('en-IN')} capital
              </p>
            </div>
          </div>

          <p className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-2xs leading-relaxed text-ink-400">
            Deposits already approved keep the split they were given. Each one records its own halves, so
            changing this never rewrites history.
          </p>
        </div>
      </Panel>

      <Panel title="Task limits">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Minimum task amount" prefix="DMC" value={draft.minimumTaskAmount ?? 0} onChange={(v) => set('minimumTaskAmount', v)} />
          <NumberField label="Maximum task amount" prefix="DMC" value={draft.maximumTaskAmount ?? 0} onChange={(v) => set('maximumTaskAmount', v)} />
          <NumberField label="Captain daily limit" prefix="DMC" value={draft.captainDailyLimit ?? 0} onChange={(v) => set('captainDailyLimit', v)} />
          <NumberField label="Captain monthly limit" prefix="DMC" value={draft.captainMonthlyLimit ?? 0} onChange={(v) => set('captainMonthlyLimit', v)} />
          <NumberField label="Party daily limit" prefix="DMC" value={draft.partyDailyLimit ?? 0} onChange={(v) => set('partyDailyLimit', v)} />
          <NumberField label="Party monthly limit" prefix="DMC" value={draft.partyMonthlyLimit ?? 0} onChange={(v) => set('partyMonthlyLimit', v)} />
        </div>
      </Panel>

      <Panel title="Task clocks" eyebrow="defaults — a party's profile can set its own four">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField
            label="Time to accept"
            suffix="min"
            value={draft.taskAcceptanceMinutes ?? 0}
            onChange={(v) => set('taskAcceptanceMinutes', v)}
            hint="How long an offered captain has before it passes on"
          />
          <NumberField
            label="Time to complete"
            suffix="min"
            value={draft.taskCompletionMinutes ?? 0}
            onChange={(v) => set('taskCompletionMinutes', v)}
            hint="Counted from the claim; after this the task expires"
          />
          <NumberField
            label="Give up after"
            suffix="min"
            value={draft.taskMaxAgeMinutes ?? 0}
            onChange={(v) => set('taskMaxAgeMinutes', v)}
            hint="Unclaimed this long from creation, the task is cancelled and the party refunded"
          />
          <NumberField
            label="Reclaim expired after"
            suffix="min"
            value={draft.taskExpiryAckMinutes ?? 0}
            onChange={(v) => set('taskExpiryAckMinutes', v)}
            hint="Grace for a captain to explain an expiry before the task is taken back"
          />
        </div>
      </Panel>

      {/* Its own panel, because it is the one window on this page that is not
          a default. The four above are each party's promise to their own
          customers and a party can set its own; this is how long the platform
          itself waits before deciding, so it is the same for everybody. */}
      <Panel title="Customer confirmation" eyebrow="global — the same for every party and captain">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Confirmation window"
            suffix="min"
            value={draft.customerConfirmationMinutes ?? 0}
            onChange={(v) => set('customerConfirmationMinutes', v)}
            hint="After a captain submits proof, how long the party has to relay their customer's answer"
          />
          <p className="self-center text-2xs leading-relaxed text-ink-500">
            Nothing back by then and the payout approves itself, recorded as such. The length is
            fixed onto each task when it is created, so changing this never shortens a window
            somebody is already waiting inside.
          </p>
        </div>
      </Panel>

      <Panel title="Login timing and access">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Code validity" suffix="min" value={draft.otpExpiryMinutes ?? 0} onChange={(v) => set('otpExpiryMinutes', v)} />
          <NumberField label="Resend cooldown" suffix="sec" value={draft.otpResendCooldownSeconds ?? 0} onChange={(v) => set('otpResendCooldownSeconds', v)} />
          <NumberField label="Code attempts allowed" value={draft.otpMaxAttempts ?? 0} onChange={(v) => set('otpMaxAttempts', v)} />
          <NumberField label="Failed sign-ins before lock" value={draft.maxFailedLoginAttempts ?? 0} onChange={(v) => set('maxFailedLoginAttempts', v)} />
          <NumberField label="Lock duration" suffix="min" value={draft.accountLockMinutes ?? 0} onChange={(v) => set('accountLockMinutes', v)} />
        </div>
      </Panel>

      {/* After the form, because it is a record of what the form has been. */}
      <SettingsVersionsPanel />

      {/* Sticky so the action stays reachable on a long form. */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-700 bg-ink-900/95 px-4 py-3 backdrop-blur lg:pl-60">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-ink-300">You have unsaved changes.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setDraft(settings.data)} className="btn-secondary">
                Discard
              </button>
              <button type="button" onClick={submit} disabled={save.isPending} className="btn-primary">
                {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Save className="h-4 w-4" /> Save changes</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NumberField({
  label, value, onChange, prefix, suffix, step = 1, hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  prefix?: string;
  suffix?: string;
  step?: number;
  hint?: string;
}) {
  const id = label.replace(/\s+/g, '-').toLowerCase();
  return (
    <div>
      <label htmlFor={id} className="field-label">{label}</label>
      <div className="relative">
        {prefix && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-ink-400">{prefix}</span>}
        <input
          id={id}
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className={cn('field-input font-mono tnum', prefix && 'pl-11', suffix && 'pr-12')}
        />
        {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-2xs text-ink-400">{suffix}</span>}
      </div>
      {hint && <p className="mt-1 text-2xs text-ink-500">{hint}</p>}
    </div>
  );
}

/**
 * What a task actually costs the party, at the rates currently in the form.
 *
 * The two commissions are set independently and neither screen ever showed
 * their sum, so it was easy to set a captain rate carefully while the
 * platform's own cut — the larger of the two — sat unexamined at whatever the
 * database happened to default to. Worked examples make the split obvious
 * before it is saved.
 */
/**
 * What a payment of each size actually costs, and where the charge goes.
 *
 * A percentage on its own does not answer the question an admin is asking,
 * which is "what does this cost my party and what do I make on it". The
 * platform column is the subtraction, shown rather than configured.
 */
function CostBreakdown({ partyRate, captainRate }: { partyRate: number; captainRate: number }) {
  const samples = [500, 5000, 50000];
  const round = (n: number): number => Math.round(n * 100) / 100;
  const dmc = (n: number): string => round(n).toLocaleString('en-IN');

  return (
    <div className="overflow-x-auto rounded-md border border-ink-700">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-ink-700 bg-ink-850 text-left">
            <th className="px-3 py-2 eyebrow font-normal">Pay-out</th>
            <th className="px-3 py-2 eyebrow font-normal text-right">Party pays</th>
            <th className="px-3 py-2 eyebrow font-normal text-right">Captain gets</th>
            <th className="px-3 py-2 eyebrow font-normal text-right">You keep</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {samples.map((amount) => {
            const charge = (amount * partyRate) / 100;
            // Capped at the charge, exactly as the engine caps it — a rate pair
            // that promises more than it collects pays the captain the whole
            // charge and the platform nothing, rather than inventing DMC.
            const captain = Math.min((amount * captainRate) / 100, charge);
            return (
              <tr key={amount}>
                <td className="px-3 py-2 font-mono tnum text-ink-200">DMC {dmc(amount)}</td>
                <td className="px-3 py-2 text-right font-mono tnum font-semibold text-ink-50">
                  {dmc(amount + charge)}
                </td>
                <td className="px-3 py-2 text-right font-mono tnum text-ink-300">{dmc(amount + captain)}</td>
                <td className="px-3 py-2 text-right font-mono tnum text-signal-green">
                  {dmc(charge - captain)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One direction's two rates. Pay-in and pay-out are laid out identically on
 * purpose: the only interesting question here is how they differ, and
 * identical controls make the difference the only thing that stands out.
 */
function DirectionRates({
  title,
  hint,
  partyRate,
  onPartyRate,
  captainRate,
  onCaptainRate,
}: {
  title: string;
  hint: string;
  partyRate: number;
  onPartyRate: (value: number) => void;
  captainRate: number;
  onCaptainRate: (value: number) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-medium text-ink-100">{title}</p>
        <p className="mt-0.5 text-2xs text-ink-500">{hint}</p>
      </div>

      <NumberField
        label="Party is charged"
        suffix="%"
        step={0.01}
        value={partyRate}
        onChange={onPartyRate}
        hint="On top of the amount. Goes into the pool."
      />
      <NumberField
        label="Captain is paid"
        suffix="%"
        step={0.01}
        value={captainRate}
        onChange={onCaptainRate}
        hint="Out of that pool. Never more than the party was charged."
      />

      {captainRate > partyRate && (
        <p className="rounded-md border border-signal-amber/40 bg-signal-amber/10 px-3 py-2 text-2xs text-signal-amber">
          The captain is promised more than the party is charged, so their share is capped at the charge
          and the platform keeps nothing on this direction.
        </p>
      )}
    </div>
  );
}
