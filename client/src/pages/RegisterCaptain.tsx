import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, Loader2, AlertCircle, ShieldCheck, CheckCircle2, Clock } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { cn, ThemeToggle } from '@/components/primitives';
import { OtpDigits, DevOtpHint, useResendCooldown } from '@/components/OtpDigits';

/**
 * PUBLIC CAPTAIN REGISTRATION
 *
 * Three screens in one page, because they are one errand: fill the form, confirm
 * the email, then wait for an administrator.
 *
 * Nothing here signs anybody in, and the last screen says so plainly. A captain
 * who has confirmed their address but not been approved cannot sign in yet, and a
 * form that ended with "you're all set" would send them straight to a sign-in
 * screen that refuses them.
 */

/**
 * Mirrors the server's validators field for field, including the confirm-password
 * rule and the field name `c_password` the API expects. The server checks all of
 * this again — this copy exists to answer immediately, not to be trusted.
 */
const formSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter the name you want shown').max(120),
    fullName: z.string().trim().min(2, 'Enter your full legal name').max(160),
    mobile: z
      .string()
      .trim()
      .regex(/^(?:\+?91[-\s]?|0)?[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
    email: z.string().trim().min(1, 'Enter your email').email('Enter a valid email address'),
    upiId: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/, 'Enter a valid UPI ID, e.g. name@bank'),
    password: z.string().min(8, 'Use at least 8 characters').max(128),
    c_password: z.string().min(1, 'Confirm your password'),
  })
  .refine((v) => v.password === v.c_password, {
    message: 'Passwords do not match',
    path: ['c_password'],
  });

type FormInput = z.infer<typeof formSchema>;

interface Challenge {
  registrationId: string;
  challengeId: string;
  maskedEmail: string;
  expiresAt: string;
  resendAvailableAt: string;
  devOtp?: string;
}

type Stage = { step: 'FORM' } | { step: 'OTP'; challenge: Challenge } | { step: 'WAITING' };

export function RegisterCaptainPage() {
  const [stage, setStage] = useState<Stage>({ step: 'FORM' });

  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink-950 px-4 py-10">
      <div className="absolute right-4 top-4 lg:right-6 lg:top-6">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-[460px]">
        <div className="mb-7 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-ink-800 ring-1 ring-ink-600">
            <span className="h-2.5 w-2.5 rounded-full bg-brand-500" />
          </span>
          <div>
            <p className="font-display text-base font-bold tracking-tight text-ink-50">OTDMS</p>
            <p className="text-2xs font-mono uppercase tracking-wider text-ink-400">Captain registration</p>
          </div>
        </div>

        {stage.step === 'FORM' && (
          <FormStep onChallenge={(challenge) => setStage({ step: 'OTP', challenge })} />
        )}
        {stage.step === 'OTP' && (
          <OtpStep
            challenge={stage.challenge}
            onVerified={() => setStage({ step: 'WAITING' })}
            onBack={() => setStage({ step: 'FORM' })}
          />
        )}
        {stage.step === 'WAITING' && <WaitingStep />}

        <p className="mt-5 text-center text-xs text-ink-400">
          Already have an account?{' '}
          <Link to="/login" className="text-brand-400 underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

function FormStep({ onChallenge }: { onChallenge: (c: Challenge) => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormInput>({ resolver: zodResolver(formSchema) });

  const onSubmit = async (values: FormInput): Promise<void> => {
    setFormError(null);
    try {
      onChallenge(await api.post<Challenge>('/auth/captain/register', values));
    } catch (err) {
      if (err instanceof ApiRequestError) {
        for (const [field, messages] of Object.entries(err.fieldErrors)) {
          if (field in formSchema._def.schema.shape) {
            setError(field as keyof FormInput, { message: messages[0] });
          }
        }
        setFormError(err.message);
        return;
      }
      setFormError('Could not reach the server. Check your connection and try again.');
    }
  };

  const field = (
    id: keyof FormInput,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
    hint?: string,
  ) => (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input
        id={id}
        className={cn('field-input', errors[id] && 'border-signal-red')}
        {...props}
        {...register(id)}
      />
      {hint && !errors[id] && <p className="mt-1 text-2xs text-ink-500">{hint}</p>}
      {errors[id] && (
        <p className="field-error">
          <AlertCircle className="h-3 w-3" />
          {errors[id]?.message}
        </p>
      )}
    </div>
  );

  return (
    <div className="panel shadow-panel p-6">
      <h1 className="font-display text-lg font-semibold text-ink-50">Register as a captain</h1>
      <p className="mt-1 text-xs text-ink-400">
        We will email you a code to confirm your address. An administrator then reviews your
        registration before your account opens.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-5 space-y-3.5" noValidate>
        {field('name', 'Name', { autoFocus: true, autoComplete: 'nickname' }, 'Shown on your dashboard')}
        {field('fullName', 'Full name', { autoComplete: 'name' }, 'Your legal name, as on your records')}
        {field(
          'mobile',
          'Mobile',
          { type: 'tel', autoComplete: 'tel', inputMode: 'numeric' },
          'A contact number only — codes are always sent to your email',
        )}
        {field('email', 'Email', { type: 'email', autoComplete: 'email' }, 'This is what you sign in with')}
        {field(
          'upiId',
          'UPI ID (merchant)',
          { autoComplete: 'off', placeholder: 'name@bank' },
          'Where you are paid',
        )}
        {field('password', 'Password', { type: 'password', autoComplete: 'new-password' }, 'At least 8 characters')}
        {field('c_password', 'Confirm password', { type: 'password', autoComplete: 'new-password' })}

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

function OtpStep({
  challenge,
  onVerified,
  onBack,
}: {
  challenge: Challenge;
  onVerified: () => void;
  onBack: () => void;
}) {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [current, setCurrent] = useState(challenge);
  const cooldown = useResendCooldown(current.resendAvailableAt);

  const submit = async (code: string): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/auth/captain/register/verify', { challengeId: current.challengeId, otp: code });
      onVerified();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Verification failed. Try again.');
      setDigits(Array(6).fill(''));
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async (): Promise<void> => {
    setError(null);
    try {
      // No email is sent with this: the server mails the address the challenge
      // was created for, whatever a caller might ask for.
      const next = await api.post<Challenge>('/auth/captain/register/resend', {
        challengeId: current.challengeId,
      });
      setCurrent({ ...current, ...next });
      setDigits(Array(6).fill(''));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send a new code.');
    }
  };

  return (
    <div className="panel shadow-panel p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-brand-500" />
        <h1 className="font-display text-lg font-semibold text-ink-50">Confirm your email</h1>
      </div>
      <p className="mt-1 text-xs text-ink-400">
        Enter the 6-digit code sent to{' '}
        <span className="font-mono text-ink-200">{current.maskedEmail}</span>
      </p>

      <div className="mt-5">
        <OtpDigits
          digits={digits}
          onChange={setDigits}
          onComplete={(code) => void submit(code)}
          invalid={Boolean(error)}
          disabled={submitting}
        />
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-signal-red/40 bg-signal-red/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-red" />
          <p className="text-xs text-ink-100">{error}</p>
        </div>
      )}

      {submitting && (
        <p className="mt-3 flex items-center justify-center gap-2 text-xs text-ink-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking
        </p>
      )}

      {/* Development only. The API sends `devOtp` outside production and
          nowhere else, so this is empty in a real deployment either way —
          the guard says so rather than leaving it to be inferred. */}
      {import.meta.env.DEV && <DevOtpHint otp={current.devOtp} />}

      <div className="mt-5 flex items-center justify-between">
        <button type="button" onClick={onBack} className="btn-ghost px-2 text-xs">
          Change my details
        </button>
        <button
          type="button"
          onClick={() => void resend()}
          disabled={cooldown > 0}
          className="btn-ghost px-2 text-xs disabled:opacity-40"
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Send a new code'}
        </button>
      </div>
    </div>
  );
}

/**
 * The honest ending.
 *
 * Confirming an email does not open an account, so this does not offer a way in.
 * It says what has happened, what happens next, and that signing in will not work
 * until an administrator has decided.
 */
function WaitingStep() {
  return (
    <div className="panel shadow-panel p-6">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-signal-green" />
        <h1 className="font-display text-lg font-semibold text-ink-50">Email confirmed</h1>
      </div>

      <div className="mt-4 flex items-start gap-2.5 rounded-md border border-signal-amber/30 bg-signal-amber/10 px-3 py-3">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-signal-amber" />
        <div>
          <p className="text-xs font-medium text-ink-100">Waiting for an administrator</p>
          <p className="mt-1 text-2xs leading-relaxed text-ink-300">
            Your registration is with an administrator now. You will not be able to sign in until it is
            approved. If it is turned down, you will be told why and can register again.
          </p>
        </div>
      </div>

      <p className="mt-4 text-2xs leading-relaxed text-ink-400">
        Once you are approved, sign in with the email and password you just chose. Your balance and your
        limit both start at zero — you raise them yourself by posting security money from your dashboard,
        which an administrator confirms.
      </p>
    </div>
  );
}
