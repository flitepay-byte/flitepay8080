import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, Loader2, AlertCircle, KeyRound, CheckCircle2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { cn, ThemeToggle } from '@/components/primitives';
import { OtpDigits, DevOtpHint, useResendCooldown } from '@/components/OtpDigits';

/**
 * FORGOTTEN PASSWORD
 *
 * Email, then code, then a new password. The first step deliberately looks
 * identical whether or not the address has an account behind it, because the
 * server answers identically — otherwise this screen would tell anybody who asked
 * which email addresses are registered.
 *
 * A consequence worth keeping in mind while reading this: after step one there may
 * be no challenge at all. The code screen is still shown, and an unknown address
 * simply never accepts a code.
 */

const emailSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email').email('Enter a valid email address'),
});
type EmailInput = z.infer<typeof emailSchema>;

const passwordSchema = z
  .object({
    password: z.string().min(8, 'Use at least 8 characters').max(128),
    c_password: z.string().min(1, 'Confirm your password'),
  })
  .refine((v) => v.password === v.c_password, {
    message: 'Passwords do not match',
    path: ['c_password'],
  });
type PasswordInput = z.infer<typeof passwordSchema>;

interface Challenge {
  maskedEmail: string;
  challengeId?: string;
  expiresAt?: string;
  resendAvailableAt?: string;
  devOtp?: string;
}

type Stage =
  | { step: 'EMAIL' }
  | { step: 'CODE'; challenge: Challenge }
  | { step: 'PASSWORD'; challengeId: string; otp: string }
  | { step: 'DONE' };

export function ForgotPasswordPage() {
  const [stage, setStage] = useState<Stage>({ step: 'EMAIL' });

  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink-950 px-4 py-10">
      <div className="absolute right-4 top-4 lg:right-6 lg:top-6">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-[400px]">
        <div className="mb-7 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-ink-800 ring-1 ring-ink-600">
            <span className="h-2.5 w-2.5 rounded-full bg-brand-500" />
          </span>
          <div>
            <p className="font-display text-base font-bold tracking-tight text-ink-50">OTDMS</p>
            <p className="text-2xs font-mono uppercase tracking-wider text-ink-400">Password reset</p>
          </div>
        </div>

        {stage.step === 'EMAIL' && (
          <EmailStep onSent={(challenge) => setStage({ step: 'CODE', challenge })} />
        )}
        {stage.step === 'CODE' && (
          <CodeStep
            challenge={stage.challenge}
            onVerified={(challengeId, otp) => setStage({ step: 'PASSWORD', challengeId, otp })}
            onBack={() => setStage({ step: 'EMAIL' })}
          />
        )}
        {stage.step === 'PASSWORD' && (
          <PasswordStep
            challengeId={stage.challengeId}
            otp={stage.otp}
            onDone={() => setStage({ step: 'DONE' })}
            onExpired={() => setStage({ step: 'EMAIL' })}
          />
        )}
        {stage.step === 'DONE' && <DoneStep />}

        <p className="mt-5 text-center text-xs text-ink-400">
          <Link to="/login" className="text-brand-400 underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

function EmailStep({ onSent }: { onSent: (c: Challenge) => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EmailInput>({ resolver: zodResolver(emailSchema) });

  const onSubmit = async (values: EmailInput): Promise<void> => {
    setFormError(null);
    try {
      onSent(await api.post<Challenge>('/auth/forgot-password', values));
    } catch (err) {
      setFormError(
        err instanceof ApiRequestError ? err.message : 'Could not reach the server. Try again.',
      );
    }
  };

  return (
    <div className="panel shadow-panel p-6">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-brand-500" />
        <h1 className="font-display text-lg font-semibold text-ink-50">Forgot your password</h1>
      </div>
      <p className="mt-1 text-xs text-ink-400">
        Enter your email and we will send you a code to set a new password.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-5 space-y-4" noValidate>
        <div>
          <label htmlFor="email" className="field-label">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            className={cn('field-input', errors.email && 'border-signal-red')}
            {...register('email')}
          />
          {errors.email && (
            <p className="field-error">
              <AlertCircle className="h-3 w-3" />
              {errors.email.message}
            </p>
          )}
        </div>

        {formError && (
          <div className="flex items-start gap-2 rounded-md border border-signal-red/40 bg-signal-red/10 px-3 py-2.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-red" />
            <p className="text-xs text-ink-100">{formError}</p>
          </div>
        )}

        <button type="submit" disabled={isSubmitting} className="btn-primary w-full">
          {isSubmitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              Send me a code <ArrowRight className="h-4 w-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}

function CodeStep({
  challenge,
  onVerified,
  onBack,
}: {
  challenge: Challenge;
  onVerified: (challengeId: string, otp: string) => void;
  onBack: () => void;
}) {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(challenge);
  const cooldown = useResendCooldown(current.resendAvailableAt);

  /**
   * The code is carried forward rather than checked here.
   *
   * Verifying consumes the challenge, and the server takes the code and the new
   * password in one call — so checking it now would spend the code and leave
   * nothing to reset the password with.
   */
  const accept = (code: string): void => {
    if (!current.challengeId) {
      setError('That code is not valid. Check the email address and try again.');
      setDigits(Array(6).fill(''));
      return;
    }
    onVerified(current.challengeId, code);
  };

  const resend = async (): Promise<void> => {
    setError(null);
    if (!current.challengeId) return;
    try {
      const next = await api.post<Challenge>('/auth/resend-otp', { challengeId: current.challengeId });
      setCurrent({ ...current, ...next });
      setDigits(Array(6).fill(''));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send a new code.');
    }
  };

  return (
    <div className="panel shadow-panel p-6">
      <h1 className="font-display text-lg font-semibold text-ink-50">Enter your code</h1>
      <p className="mt-1 text-xs text-ink-400">
        If <span className="font-mono text-ink-200">{current.maskedEmail}</span> has an account, we have
        sent it a 6-digit code.
      </p>

      <div className="mt-5">
        <OtpDigits
          digits={digits}
          onChange={setDigits}
          onComplete={accept}
          invalid={Boolean(error)}
        />
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-signal-red/40 bg-signal-red/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-red" />
          <p className="text-xs text-ink-100">{error}</p>
        </div>
      )}

      {/* Development only. The API sends `devOtp` outside production and
          nowhere else, so this is empty in a real deployment either way —
          the guard says so rather than leaving it to be inferred. */}
      {import.meta.env.DEV && <DevOtpHint otp={current.devOtp} />}

      <div className="mt-5 flex items-center justify-between">
        <button type="button" onClick={onBack} className="btn-ghost px-2 text-xs">
          Use a different email
        </button>
        <button
          type="button"
          onClick={() => void resend()}
          disabled={cooldown > 0 || !current.challengeId}
          className="btn-ghost px-2 text-xs disabled:opacity-40"
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Send a new code'}
        </button>
      </div>
    </div>
  );
}

function PasswordStep({
  challengeId,
  otp,
  onDone,
  onExpired,
}: {
  challengeId: string;
  otp: string;
  onDone: () => void;
  onExpired: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PasswordInput>({ resolver: zodResolver(passwordSchema) });

  const onSubmit = async (values: PasswordInput): Promise<void> => {
    setFormError(null);
    try {
      await api.post('/auth/reset-password', { challengeId, otp, ...values });
      onDone();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        for (const [field, messages] of Object.entries(err.fieldErrors)) {
          if (field === 'password' || field === 'c_password') {
            setError(field, { message: messages[0] });
          }
        }
        // A code that has expired or been used up cannot be salvaged from here —
        // they need a fresh one, so send them back rather than leaving them on a
        // form that will keep failing.
        if (err.errorCode === 'OTP_EXPIRED' || err.errorCode === 'OTP_MAX_ATTEMPTS') {
          onExpired();
          return;
        }
        setFormError(err.message);
        return;
      }
      setFormError('Could not reach the server. Try again.');
    }
  };

  return (
    <div className="panel shadow-panel p-6">
      <h1 className="font-display text-lg font-semibold text-ink-50">Choose a new password</h1>
      <p className="mt-1 text-xs text-ink-400">
        Anyone signed in to your account elsewhere will be signed out.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-5 space-y-4" noValidate>
        <div>
          <label htmlFor="password" className="field-label">
            New password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            className={cn('field-input', errors.password && 'border-signal-red')}
            {...register('password')}
          />
          {errors.password ? (
            <p className="field-error">
              <AlertCircle className="h-3 w-3" />
              {errors.password.message}
            </p>
          ) : (
            <p className="mt-1 text-2xs text-ink-500">At least 8 characters</p>
          )}
        </div>

        <div>
          <label htmlFor="c_password" className="field-label">
            Confirm new password
          </label>
          <input
            id="c_password"
            type="password"
            autoComplete="new-password"
            className={cn('field-input', errors.c_password && 'border-signal-red')}
            {...register('c_password')}
          />
          {errors.c_password && (
            <p className="field-error">
              <AlertCircle className="h-3 w-3" />
              {errors.c_password.message}
            </p>
          )}
        </div>

        {formError && (
          <div className="flex items-start gap-2 rounded-md border border-signal-red/40 bg-signal-red/10 px-3 py-2.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-red" />
            <p className="text-xs text-ink-100">{formError}</p>
          </div>
        )}

        <button type="submit" disabled={isSubmitting} className="btn-primary w-full">
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Change my password'}
        </button>
      </form>
    </div>
  );
}

function DoneStep() {
  const navigate = useNavigate();
  return (
    <div className="panel shadow-panel p-6">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-signal-green" />
        <h1 className="font-display text-lg font-semibold text-ink-50">Password changed</h1>
      </div>
      <p className="mt-2 text-xs text-ink-400">
        Sign in with your new password. You will be asked for a verification code as usual.
      </p>
      <button
        type="button"
        className="btn-primary mt-5 w-full"
        onClick={() => navigate('/login', { replace: true })}
      >
        Go to sign in
      </button>
    </div>
  );
}
