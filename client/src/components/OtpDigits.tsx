import { useEffect, useRef, useState } from 'react';
import { cn } from '@/components/primitives';

/**
 * The six-box code entry, shared by the flows that were added together:
 * captain registration and a forgotten password.
 *
 * Sign-in keeps its own copy. Pulling that one out here as well would mean
 * editing a screen that already works, for no behavioural gain, inside a change
 * that is about something else.
 */
export function OtpDigits({
  digits,
  onChange,
  onComplete,
  invalid = false,
  disabled = false,
}: {
  digits: string[];
  onChange: (next: string[]) => void;
  onComplete: (code: string) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  const setDigit = (index: number, value: string): void => {
    const clean = value.replace(/\D/g, '');

    if (!clean) {
      const next = [...digits];
      next[index] = '';
      onChange(next);
      return;
    }

    // Handles a whole code pasted into any one box.
    if (clean.length > 1) {
      const spread = clean.slice(0, 6).split('');
      const next = Array<string>(6).fill('');
      spread.forEach((d, i) => {
        next[i] = d;
      });
      onChange(next);
      inputs.current[Math.min(spread.length, 5)]?.focus();
      if (spread.length === 6) onComplete(spread.join(''));
      return;
    }

    const next = [...digits];
    next[index] = clean;
    onChange(next);
    if (index < 5) inputs.current[index + 1]?.focus();
    if (next.every((d) => d !== '')) onComplete(next.join(''));
  };

  return (
    <div className="flex justify-between gap-2">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => {
            inputs.current[index] = el;
          }}
          value={digit}
          onChange={(e) => setDigit(index, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[index] && index > 0) {
              inputs.current[index - 1]?.focus();
            }
          }}
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={6}
          aria-label={`Digit ${index + 1}`}
          disabled={disabled}
          className={cn(
            'h-12 w-full min-w-0 rounded-md border bg-ink-850 text-center font-mono tnum text-lg text-ink-50 transition-colors',
            invalid ? 'border-signal-red' : 'border-ink-600 focus:border-brand-500',
          )}
        />
      ))}
    </div>
  );
}

/** Shown outside production, where the API echoes the code back. */
export function DevOtpHint({ otp }: { otp?: string }) {
  if (!otp) return null;
  return (
    <div className="mt-4 rounded-md border border-signal-amber/40 bg-signal-amber/10 px-3 py-2.5">
      <p className="text-2xs font-mono uppercase tracking-wider text-signal-amber">demo mode</p>
      <p className="mt-0.5 text-xs text-ink-100">
        Code <span className="font-mono tnum font-semibold text-ink-50">{otp}</span> — shown because no mail
        is actually sent.
      </p>
    </div>
  );
}

/** Seconds until a new code may be requested; zero once the cooldown has passed. */
export function useResendCooldown(resendAvailableAt: string | undefined): number {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!resendAvailableAt) {
      setRemaining(0);
      return;
    }
    const tick = (): void => {
      setRemaining(Math.max(0, Math.ceil((new Date(resendAvailableAt).getTime() - Date.now()) / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [resendAvailableAt]);

  return remaining;
}
