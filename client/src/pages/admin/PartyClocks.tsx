import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, cn } from '@/components/primitives';

/**
 * The four deadlines this party's tasks run on.
 *
 * They live on the party because the party is the one making a promise to a
 * customer — a food order and a bank transfer are not the same promise, and
 * only the party knows which they are making. Whichever captain picks the work
 * up is held to the window their party set; a captain has no clock of their
 * own, and the setting that used to be on their profile has been removed.
 *
 * Blank means the system default from Admin → Settings, and each of the four
 * falls back on its own — setting a shorter completion window does not drag
 * the other three along with it.
 */
interface DefaultClocks {
  taskAcceptanceMinutes: number;
  taskCompletionMinutes: number;
  taskMaxAgeMinutes: number;
  taskExpiryAckMinutes: number;
}

export interface PartyClocks {
  acceptanceMinutes: number | null;
  completionMinutes: number | null;
  maxAgeMinutes: number | null;
  expiryAckMinutes: number | null;
}

type ClockKey = keyof PartyClocks;

const CLOCKS: Array<{
  key: ClockKey;
  label: string;
  hint: string;
  fallback: keyof DefaultClocks;
  max: number;
}> = [
  {
    key: 'acceptanceMinutes',
    label: 'Time to accept',
    hint: 'How long the captain it is offered to has to answer before it passes on.',
    fallback: 'taskAcceptanceMinutes',
    max: 1440,
  },
  {
    key: 'completionMinutes',
    label: 'Time to complete',
    hint: 'How long the captain who claimed it has to finish, from the moment they claim.',
    fallback: 'taskCompletionMinutes',
    max: 1440,
  },
  {
    key: 'maxAgeMinutes',
    label: 'Give up after',
    hint: 'From creation. Past this an unclaimed task is cancelled and you are refunded in full.',
    fallback: 'taskMaxAgeMinutes',
    max: 10080,
  },
  {
    key: 'expiryAckMinutes',
    label: 'Reclaim expired after',
    hint: 'Grace for a captain whose task expired to say what went wrong, before it is taken back.',
    fallback: 'taskExpiryAckMinutes',
    max: 1440,
  },
];

export function PartyClocksPanel({
  partyId,
  clocks,
}: {
  partyId: string;
  clocks: PartyClocks;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [draft, setDraft] = useState<Record<ClockKey, string>>({
    acceptanceMinutes: clocks.acceptanceMinutes?.toString() ?? '',
    completionMinutes: clocks.completionMinutes?.toString() ?? '',
    maxAgeMinutes: clocks.maxAgeMinutes?.toString() ?? '',
    expiryAckMinutes: clocks.expiryAckMinutes?.toString() ?? '',
  });

  const defaults = useQuery<DefaultClocks>({
    queryKey: ['admin-settings'],
    queryFn: () => api.get<DefaultClocks>('/admin/settings'),
  });

  const parse = (raw: string, max: number): number | null | 'INVALID' => {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    // No zero: a window of no time is not an arrangement, it is a task that
    // expires before a captain can read it.
    if (!Number.isInteger(n) || n < 1 || n > max) return 'INVALID';
    return n;
  };

  const parsed = CLOCKS.map((c) => ({ ...c, value: parse(draft[c.key], c.max) }));
  const invalid = parsed.some((c) => c.value === 'INVALID');

  const save = useMutation({
    mutationFn: () =>
      api.patch(
        `/admin/parties/${partyId}/limits`,
        Object.fromEntries(
          parsed.filter((c) => c.value !== 'INVALID').map((c) => [c.key, c.value]),
        ),
      ),
    onSuccess: () => {
      toast.show('success', 'Task clocks updated for this party.');
      void queryClient.invalidateQueries({ queryKey: ['admin-party-detail', partyId] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  return (
    <Panel title="Task clocks" eyebrow="deadlines for this party's tasks">
      <div className="space-y-3.5">
        <p className="text-2xs text-ink-500">
          Every task this party creates runs on these, and the captain who takes it is held to
          them. Blank uses the system default.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {parsed.map((clock) => {
            const fallback = defaults.data?.[clock.fallback] ?? null;
            const raw = draft[clock.key];
            return (
              <div key={clock.key}>
                <label htmlFor={`clock-${clock.key}`} className="field-label">
                  {clock.label} (min)
                </label>
                <input
                  id={`clock-${clock.key}`}
                  type="number"
                  min="1"
                  max={clock.max}
                  step="1"
                  value={raw}
                  onChange={(e) => setDraft((d) => ({ ...d, [clock.key]: e.target.value }))}
                  placeholder={fallback != null ? `${fallback} (default)` : 'default'}
                  className={cn(
                    'field-input font-mono tnum',
                    clock.value === 'INVALID' && 'border-signal-red',
                  )}
                />
                {clock.value === 'INVALID' ? (
                  <p className="mt-1 text-2xs text-signal-red">
                    Whole minutes, 1 to {clock.max.toLocaleString('en-IN')}.
                  </p>
                ) : raw.trim() === '' ? (
                  <p className="mt-1 text-2xs text-ink-500">
                    {fallback != null ? `Using the ${fallback} min default` : 'Using the default'}
                  </p>
                ) : null}
                <p className="mt-1 text-2xs text-ink-500">{clock.hint}</p>
              </div>
            );
          })}
        </div>

        {/* Said plainly, because it is the question admin will ask next. */}
        <p className="text-2xs text-ink-500">
          Applies to tasks created from now on. Work already in flight keeps the windows it
          started with, so nobody's countdown moves under them.
        </p>

        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={invalid || save.isPending}
          className="btn-primary w-full"
        >
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save task clocks'}
        </button>
      </div>
    </Panel>
  );
}
