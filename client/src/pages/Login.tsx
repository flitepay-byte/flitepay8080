import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, Loader2, ShieldCheck, AlertCircle, Radar, GitBranch, FlaskConical } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore, homeRouteFor } from '@/stores/auth.store';
import { cn, ThemeToggle } from '@/components/primitives';
import type { AuthUser } from '@/types';

const credentialsSchema = z.object({
  email: z.string().min(1, 'Enter your email').email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});
type CredentialsInput = z.infer<typeof credentialsSchema>;

interface Challenge {
  challengeId: string;
  maskedEmail: string;
  expiresAt: string;
  resendAvailableAt: string;
  devOtp?: string;
}

/**
 * Two-step sign-in. Step one never returns a session; only OTP verification
 * issues the auth cookies, which matches the server's contract exactly.
 */
const PROMO_POINTS = [
  { icon: Radar, text: 'Live task and payout tracking, end to end' },
  { icon: GitBranch, text: 'Full audit trail on every state change' },
  { icon: FlaskConical, text: 'A sandboxed simulation — nothing here is real money' },
];

export function LoginPage() {
  const [challenge, setChallenge] = useState<Challenge | null>(null);

  return (
    <div className="flex min-h-dvh bg-ink-950">
      {/* Brand panel — hidden on small screens, matches the split-auth layout
          used across the rest of the console. */}
      <div className="relative hidden w-[42%] flex-col justify-between overflow-hidden bg-gradient-to-br from-brand-600 to-brand-900 px-10 py-12 text-white lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
            backgroundSize: '28px 28px',
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-white/15 ring-1 ring-white/25">
            <span className="h-2.5 w-2.5 rounded-full bg-white" />
          </span>
          <p className="font-display text-base font-bold tracking-tight">OTDMS</p>
        </div>

        <div className="relative">
          <h1 className="font-display text-3xl font-bold leading-tight tracking-tight">
            One console for the whole task lifecycle
          </h1>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/70">
            Claim, execute, audit, and reconcile — every step logged, every figure simulated.
          </p>
          <ul className="mt-8 space-y-3.5">
            {PROMO_POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-white/90">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/15">
                  <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-2xs font-mono uppercase tracking-wider text-white/50">
          {/* Educational simulation — DMC is a fictional demo currency */}
        </p>
      </div>

      <div className="relative flex flex-1 items-center justify-center px-4 py-10">
        <div className="absolute right-4 top-4 lg:right-6 lg:top-6">
          <ThemeToggle />
        </div>

        <div className="w-full max-w-[400px]">
          <div className="mb-7 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-ink-800 ring-1 ring-ink-600">
              <span className="h-2.5 w-2.5 rounded-full bg-brand-500" />
            </span>
            <div>
              <p className="font-display text-base font-bold tracking-tight text-ink-50">OTDMS</p>
              <p className="text-2xs font-mono uppercase tracking-wider text-ink-400">Operations console</p>
            </div>
          </div>

          {challenge ? (
            <OtpStep challenge={challenge} onBack={() => setChallenge(null)} />
          ) : (
            <CredentialsStep onChallenge={(c) => setChallenge(c)} />
          )}

          {/* Seeded sign-ins, for local work only. */}
          {import.meta.env.DEV && <DemoAccounts />}
        </div>
      </div>
    </div>
  );
}

function CredentialsStep({ onChallenge }: { onChallenge: (c: Challenge) => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CredentialsInput>({ resolver: zodResolver(credentialsSchema) });

  const onSubmit = async (values: CredentialsInput): Promise<void> => {
    setFormError(null);
    try {
      const challenge = await api.post<Challenge>('/auth/login', values);
      onChallenge(challenge);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        for (const [field, messages] of Object.entries(err.fieldErrors)) {
          if (field === 'email' || field === 'password') {
            setError(field, { message: messages[0] });
          }
        }
        setFormError(err.message);
        return;
      }
      setFormError('Could not reach the server. Check your connection and try again.');
    }
  };

  return (
    <div className="panel shadow-panel p-6">
      <h1 className="font-display text-lg font-semibold text-ink-50">Sign in</h1>
      <p className="mt-1 text-xs text-ink-400">
        You will be asked for a verification code after your password.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-5 space-y-4" noValidate>
        <div>
          <label htmlFor="email" className="field-label">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            className={cn('field-input', errors.email && 'border-signal-red')}
            {...register('email')}
          />
          {errors.email && (
            <p className="field-error"><AlertCircle className="h-3 w-3" />{errors.email.message}</p>
          )}
        </div>

        <div>
          <label htmlFor="password" className="field-label">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className={cn('field-input', errors.password && 'border-signal-red')}
            {...register('password')}
          />
          {errors.password && (
            <p className="field-error"><AlertCircle className="h-3 w-3" />{errors.password.message}</p>
          )}
        </div>

        {formError && (
          <div className="flex items-start gap-2 rounded-md border border-signal-red/40 bg-signal-red/10 px-3 py-2.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-red" />
            <p className="text-xs text-ink-100">{formError}</p>
          </div>
        )}

        <button type="submit" disabled={isSubmitting} className="btn-primary w-full">
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Continue <ArrowRight className="h-4 w-4" /></>}
        </button>
      </form>

      <div className="mt-4 flex items-center justify-between border-t border-ink-800 pt-3.5">
        <Link to="/forgot-password" className="text-xs text-ink-400 underline hover:text-ink-200">
          Forgot your password?
        </Link>
        <Link to="/register" className="text-xs text-brand-400 underline">
          Register as a captain
        </Link>
      </div>
    </div>
  );
}

function OtpStep({ challenge, onBack }: { challenge: Challenge; onBack: () => void }) {
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [current, setCurrent] = useState(challenge);
  const [cooldown, setCooldown] = useState(0);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  useEffect(() => {
    const tick = (): void => {
      const remaining = Math.max(0, Math.ceil((new Date(current.resendAvailableAt).getTime() - Date.now()) / 1000));
      setCooldown(remaining);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [current.resendAvailableAt]);

  const submit = async (code: string): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<{ user: AuthUser }>('/auth/verify-otp', {
        challengeId: current.challengeId,
        otp: code,
      });
      setUser(result.user);
      navigate(homeRouteFor(result.user.role), { replace: true });
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Verification failed. Try again.';
      setError(message);
      setDigits(Array(6).fill(''));
      inputs.current[0]?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const setDigit = (index: number, value: string): void => {
    const clean = value.replace(/\D/g, '');
    if (!clean) {
      const next = [...digits];
      next[index] = '';
      setDigits(next);
      return;
    }
    // Handles paste of a full code into any box.
    if (clean.length > 1) {
      const spread = clean.slice(0, 6).split('');
      const next = Array(6).fill('');
      spread.forEach((d, i) => (next[i] = d));
      setDigits(next);
      const filled = Math.min(spread.length, 5);
      inputs.current[filled]?.focus();
      if (spread.length === 6) void submit(spread.join(''));
      return;
    }
    const next = [...digits];
    next[index] = clean;
    setDigits(next);
    if (index < 5) inputs.current[index + 1]?.focus();
    if (next.every((d) => d !== '')) void submit(next.join(''));
  };

  const onKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  const resend = async (): Promise<void> => {
    setError(null);
    try {
      const next = await api.post<Challenge>('/auth/resend-otp', {
        challengeId: current.challengeId,
      });
      setCurrent({ ...current, ...next });
      setDigits(Array(6).fill(''));
      inputs.current[0]?.focus();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send a new code.');
    }
  };

  return (
    <div className="panel shadow-panel p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-brand-500" />
        <h1 className="font-display text-lg font-semibold text-ink-50">Verify it is you</h1>
      </div>
      <p className="mt-1 text-xs text-ink-400">
        Enter the 6-digit code sent to <span className="font-mono text-ink-200">{current.maskedEmail}</span>
      </p>

      <div className="mt-5 flex justify-between gap-2">
        {digits.map((digit, index) => (
          <input
            key={index}
            ref={(el) => {
              inputs.current[index] = el;
            }}
            value={digit}
            onChange={(e) => setDigit(index, e.target.value)}
            onKeyDown={(e) => onKeyDown(index, e)}
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            maxLength={6}
            aria-label={`Digit ${index + 1}`}
            disabled={submitting}
            className={cn(
              'h-12 w-full min-w-0 rounded-md border bg-ink-850 text-center font-mono tnum text-lg text-ink-50 transition-colors',
              error ? 'border-signal-red' : 'border-ink-600 focus:border-brand-500',
            )}
          />
        ))}
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-signal-red/40 bg-signal-red/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-red" />
          <p className="text-xs text-ink-100">{error}</p>
        </div>
      )}

      {submitting && (
        <p className="mt-3 flex items-center justify-center gap-2 text-xs text-ink-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Verifying
        </p>
      )}

      {/* Development affordance: the API echoes the code outside production so
          the prototype is usable without an inbox. */}
    {/* {current.devOtp && (
        <div className="mt-4 rounded-md border border-signal-amber/40 bg-signal-amber/10 px-3 py-2.5">
          <p className="text-2xs font-mono uppercase tracking-wider text-signal-amber">demo mode</p>
          <p className="mt-0.5 text-xs text-ink-100">
            Code <span className="font-mono tnum font-semibold text-ink-50">{current.devOtp}</span> — shown because
            no mail is actually sent.
          </p>
        </div>
      )}*/}

      <div className="mt-5 flex items-center justify-between">
        <button type="button" onClick={onBack} className="btn-ghost px-2 text-xs">
          Use a different account
        </button>
        <button
          type="button"
          onClick={resend}
          disabled={cooldown > 0}
          className="btn-ghost px-2 text-xs disabled:opacity-40"
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Send a new code'}
        </button>
      </div>
    </div>
  );
}

function DemoAccounts() {
  const accounts = [{ role: 'Admin', email: 'pradue243@gmail.com' }];
  return (
    <div className="mt-5 rounded-panel border border-ink-800 bg-ink-900/60 px-4 py-3">
      <p className="eyebrow">Seeded demo accounts</p>
      <ul className="mt-2 space-y-1">
        {accounts.map((account) => (
          <li key={account.email} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-ink-300">{account.role}</span>
            <span className="font-mono text-ink-200">{account.email}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-2xs text-ink-500">
        Password <span className="font-mono text-ink-400">Demo@12345</span>. All data is fictional.
      </p>
    </div>
  );
}
