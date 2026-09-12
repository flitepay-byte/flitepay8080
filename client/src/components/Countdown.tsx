import { useEffect, useState } from 'react';
import { Clock, AlertTriangle } from 'lucide-react';
import { cn } from '@/components/primitives';

/**
 * A live countdown to a deadline.
 *
 * Ticks locally rather than polling the server: the deadline itself is a fixed
 * timestamp the server already sent, so there is nothing to re-fetch, and a
 * per-second request per visible task would be absurd. The server remains the
 * only authority on what actually happens at zero — this just shows the clock.
 */

function remainingMs(deadline: string): number {
  return new Date(deadline).getTime() - Date.now();
}

/** m:ss under an hour, h:mm:ss above it. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function useCountdown(deadline: string | null | undefined): number | null {
  const [ms, setMs] = useState<number | null>(() => (deadline ? remainingMs(deadline) : null));

  useEffect(() => {
    if (!deadline) {
      setMs(null);
      return;
    }
    setMs(remainingMs(deadline));
    const id = setInterval(() => setMs(remainingMs(deadline)), 1000);
    return () => clearInterval(id);
  }, [deadline]);

  return ms;
}

export function Countdown({
  deadline,
  label,
  /** Below this many seconds the countdown turns red — the "hurry up" threshold. */
  urgentBelowSeconds = 60,
  expiredLabel = 'Time up',
  className,
}: {
  deadline: string | null | undefined;
  label?: string;
  urgentBelowSeconds?: number;
  expiredLabel?: string;
  className?: string;
}) {
  const ms = useCountdown(deadline);
  if (ms === null) return null;

  const expired = ms <= 0;
  const urgent = !expired && ms <= urgentBelowSeconds * 1000;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium tabular-nums',
        expired
          ? 'bg-signal-red/10 text-signal-red'
          : urgent
            ? 'bg-signal-red/10 text-signal-red'
            : 'bg-signal-cyan/10 text-signal-cyan',
        className,
      )}
      // The visible text ticks every second; a screen reader announcing that
      // would be unusable, so the live value is exposed once as a title.
      title={expired ? expiredLabel : `${label ? `${label}: ` : ''}${formatRemaining(ms)} remaining`}
    >
      {expired ? <AlertTriangle className="h-3 w-3" /> : <Clock className={cn('h-3 w-3', urgent && 'animate-pulse-dot')} />}
      {label && <span className="font-normal opacity-80">{label}</span>}
      <span className="font-mono">{expired ? expiredLabel : formatRemaining(ms)}</span>
    </span>
  );
}
