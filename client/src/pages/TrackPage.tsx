import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Check, Loader2, PackageSearch, Clock, AlertTriangle } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { cn, Money } from '@/components/primitives';
import type { TrackingResult } from '@/types';
import { when, whenWithYear } from '@/lib/datetime';

/**
 * PUBLIC TRACKING — no sign-in.
 * Shows only what the server's allow-listed projection returns: reference,
 * amount, status, and timeline. Operational detail is not available here by
 * design, not merely hidden in the markup.
 */
export function TrackPage() {
  const { referenceId } = useParams<{ referenceId?: string }>();
  const navigate = useNavigate();
  const [input, setInput] = useState(referenceId ?? '');

  const query = useQuery<TrackingResult, ApiRequestError>({
    queryKey: ['track', referenceId],
    queryFn: () => api.get<TrackingResult>(`/public/track/${encodeURIComponent(referenceId as string)}`),
    enabled: Boolean(referenceId),
    retry: false,
  });

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const trimmed = input.trim();
    if (trimmed) navigate(`/track/${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="flex min-h-dvh flex-col bg-ink-950">
      <header className="border-b border-ink-800 bg-ink-900">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2.5 px-4">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-ink-800 ring-1 ring-ink-600">
            <span className="h-2 w-2 rounded-full bg-signal-cyan" />
          </span>
          <p className="font-display text-sm font-bold tracking-tight text-ink-50">OTDMS</p>
          <span className="ml-auto text-2xs font-mono uppercase tracking-wider text-ink-400">Track a request</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
        <h1 className="font-display text-xl font-semibold text-ink-50">Where is my request?</h1>
        <p className="mt-1 text-sm text-ink-400">
          Enter the reference number you were given.
        </p>

        <form onSubmit={submit} className="mt-5 flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="DEMO-REF-013"
            aria-label="Reference number"
            className="field-input font-mono flex-1"
          />
          <button type="submit" className="btn-primary shrink-0">
            <Search className="h-4 w-4" />
            <span className="hidden sm:inline">Track</span>
          </button>
        </form>

        <div className="mt-6">
          {!referenceId && (
            <div className="panel flex flex-col items-center px-4 py-12 text-center">
              <PackageSearch className="h-8 w-8 text-ink-500" strokeWidth={1.5} />
              <p className="mt-3 text-sm text-ink-300">Enter a reference above to see its progress.</p>
            </div>
          )}

          {referenceId && query.isPending && (
            <div className="panel flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-ink-400" />
            </div>
          )}

          {referenceId && query.isError && (
            <div className="panel px-4 py-10 text-center">
              <p className="font-display text-sm font-medium text-ink-100">
                No record found for {referenceId}
              </p>
              <p className="mt-1.5 text-xs text-ink-400">
                Check the reference and try again. It may take a few minutes for a new request to appear.
              </p>
            </div>
          )}

          {query.data && <TrackingCard result={query.data} />}
        </div>
      </main>

      <footer className="border-t border-ink-800 px-4 py-4">
        <p className="mx-auto max-w-2xl text-2xs text-ink-500">
          Demonstration system. All records shown are fictional.
        </p>
      </footer>
    </div>
  );
}

function TrackingCard({ result }: { result: TrackingResult }) {
  const activeIndex = result.timeline.findIndex((s) => !s.complete);
  const currentStep = activeIndex === -1 ? result.timeline.length - 1 : Math.max(0, activeIndex - 1);

  return (
    <div className="panel shadow-panel animate-slide-up">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-700 px-5 py-4">
        <div>
          <p className="eyebrow">Reference</p>
          <p className="mt-0.5 font-mono tnum text-base text-ink-50">{result.reference}</p>
        </div>
        <div className="text-right">
          <p className="eyebrow">Amount</p>
          <Money amount={result.amount} className="mt-0.5 block text-base text-ink-50" />
        </div>
      </div>

      <div className="px-5 py-5">
        <p className="eyebrow">Status</p>
        <p className="mt-1 font-display text-lg font-semibold text-ink-50">{result.statusLabel}</p>

        {/*
          The one thing somebody waiting on money actually wants to know, and
          the one thing a status word does not tell them. Without a time they
          refresh, worry, and chase the seller over a payment that was never
          late in the first place.
        */}
        {result.paid && (
          <div className="mt-3 rounded-md border border-signal-green/40 bg-signal-green/10 px-3 py-2.5">
            <p className="text-xs font-medium text-signal-green">The money has been sent</p>
            <p className="mt-1 text-2xs leading-relaxed text-ink-300">
              Your bank may take a little longer to show it in your account.
            </p>
          </div>
        )}

        {!result.paid && result.expectedBy && !result.isLate && (
          <div className="mt-3 rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs text-ink-200">
              <Clock className="h-3.5 w-3.5 text-ink-400" />
              Expected by{' '}
              <span className="font-mono tnum text-ink-50">
                {when(result.expectedBy)}
              </span>
            </p>
            <p className="mt-1 text-2xs text-ink-500">
              Most payments arrive well before this.
            </p>
          </div>
        )}

        {/*
          Late is said plainly, and it names the seller rather than us. The
          person who owes them this money is the business they bought from —
          we are the rails, we have no account of who they are, and sending
          them to us would be sending them somewhere that cannot help.
        */}
        {result.isLate && (
          <div className="mt-3 rounded-md border border-signal-amber/40 bg-signal-amber/10 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-signal-amber">
              <AlertTriangle className="h-3.5 w-3.5" />
              This is taking longer than expected
            </p>
            <p className="mt-1 text-2xs leading-relaxed text-ink-300">
              It is still being worked on. If it has not arrived, contact the business you paid or bought
              from and give them this reference — they can raise it with us.
            </p>
          </div>
        )}

        <ol className="mt-5 space-y-0">
          {result.timeline.map((step, index) => {
            const isCurrent = index === currentStep && step.complete;
            return (
              <li key={step.key} className="relative flex gap-3 pb-5 last:pb-0">
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                      step.complete
                        ? 'border-signal-green bg-signal-green text-ink-950'
                        : 'border-ink-600 bg-ink-850',
                    )}
                  >
                    {step.complete && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                  {index < result.timeline.length - 1 && (
                    <span className={cn('mt-1 w-px flex-1', step.complete ? 'bg-signal-green/40' : 'bg-ink-700')} />
                  )}
                </div>
                <div className="min-w-0 flex-1 pb-1">
                  <p
                    className={cn(
                      'text-sm',
                      step.complete ? 'text-ink-100' : 'text-ink-500',
                      isCurrent && 'font-semibold text-ink-50',
                    )}
                  >
                    {step.label}
                  </p>
                  {step.at && (
                    <p className="mt-0.5 font-mono tnum text-2xs text-ink-500">
                      {whenWithYear(step.at)}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="border-t border-ink-700 px-5 py-3">
        <p className="font-mono tnum text-2xs text-ink-500">
          Last updated {new Date(result.lastUpdated).toLocaleString('en-IN')}
        </p>
      </div>
    </div>
  );
}
