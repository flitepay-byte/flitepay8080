import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Inbox, Moon, Sun, FileText, Landmark, Smartphone, Coins, RotateCcw, Search, X } from 'lucide-react';
import { useThemeStore } from '@/stores/theme.store';
import { api } from '@/lib/api';
import { REJECTION_CATEGORIES } from '@/types';
import type { TaskState, PayoutMethod, PayoutMethodType, RejectionCategory } from '@/types';
import { when } from '@/lib/datetime';

export function cn(...inputs: Array<string | undefined | false | null>): string {
  return twMerge(clsx(inputs));
}

/**
 * Fictional demo-currency (DMC) formatting with tabular figures so ledger
 * columns align. Never routed through a real ISO currency code.
 */
export function formatMoney(amount: number, options: { compact?: boolean } = {}): string {
  if (options.compact && Math.abs(amount) >= 100000) {
    return `DMC ${(amount / 100000).toFixed(2)}L`;
  }
  const grouped = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `DMC ${grouped}`;
}

/**
 * Live USDT/INR rate — see server exchangeRate.service.ts, the one thing in
 * this app that touches a real external source. `useQuery` shares a single
 * cached value (and a single background poll) across every `<Money>` and the
 * header pill rather than each instance fetching its own.
 *
 * DMC is pegged 1:1 to INR throughout the app, so the USDT/INR rate the
 * server returns *is* how many DMC one USDT is worth — no second conversion.
 */
interface UsdtRateInfo {
  /** How many DMC one USDT buys, at the live rate. */
  dmcPerUsdt: number;
  /** The source could not be reached; this is a cached or fallback figure. */
  stale: boolean;
  fetchedAt: string | null;
}

function useUsdtRate(): UsdtRateInfo | null {
  const { data } = useQuery<{ usdtInrRate: number; fetchedAt: string; stale: boolean }>({
    queryKey: ['usdt-inr-rate'],
    queryFn: () => api.get('/public/rates/usdt-inr'),
    staleTime: 55_000,
    refetchInterval: 60_000,
  });
  if (!data) return null;
  return { dmcPerUsdt: data.usdtInrRate, stale: data.stale, fetchedAt: data.fetchedAt };
}

export function formatUsdt(amount: number, usdtInrRate: number): string {
  // 1 DMC is pegged to 1 INR throughout this app; this only converts that
  // fictional rupee figure into what it would be worth in real USDT.
  const usdt = amount / usdtInrRate;
  const decimals = Math.abs(usdt) >= 1000 ? 0 : Math.abs(usdt) >= 1 ? 2 : 4;
  return usdt.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function Money({
  amount,
  className,
  compact,
  showUsdt = true,
}: {
  amount: number;
  className?: string;
  compact?: boolean;
  /** Set false only where the extra text would break a genuinely tight layout. */
  showUsdt?: boolean;
}) {
  const usdtRate = useUsdtRate();
  return (
    <span className={cn('font-mono tnum', className)}>
      {formatMoney(amount, { compact })}
      {showUsdt && usdtRate && (
        <span className="ml-1 text-2xs font-normal not-italic text-ink-500">
          (≈{formatUsdt(amount, usdtRate.dmcPerUsdt)} USDT)
        </span>
      )}
    </span>
  );
}

/**
 * The live market rate, stated the way someone holding DMC would ask it:
 * "what is one USDT worth right now?"
 *
 * Every amount in the app already carries an `≈ USDT` figure, but nothing said
 * what rate produced it. This is that rate, in one place, the same for every
 * role — a party pricing a task, a captain judging a payout, and admin
 * reconciling are all reading the same number.
 *
 * When the source cannot be reached the server serves its last good value (or
 * a fallback) and flags it. That is shown rather than hidden: a stale rate is
 * still useful, but presenting it as live would not be.
 */
export function UsdtRatePill({ className }: { className?: string }) {
  const rate = useUsdtRate();

  const value = rate
    ? rate.dmcPerUsdt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';

  const title = rate
    ? rate.stale
      ? `Live rate unavailable — showing the last known value${rate.fetchedAt ? ` from ${new Date(rate.fetchedAt).toLocaleTimeString('en-IN')}` : ''}. 1 DMC is pegged to 1 INR.`
      : `Live USDT/INR rate${rate.fetchedAt ? `, fetched ${new Date(rate.fetchedAt).toLocaleTimeString('en-IN')}` : ''}. 1 DMC is pegged to 1 INR, so 1 USDT = ${value} DMC.`
    : 'Fetching the live USDT rate';

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
        rate?.stale ? 'border-signal-amber/40 bg-signal-amber/10' : 'border-ink-700 bg-ink-850',
        className,
      )}
    >
      <Coins className={cn('h-3 w-3 shrink-0', rate?.stale ? 'text-signal-amber' : 'text-ink-400')} strokeWidth={2} />
      {/* On a narrow phone the header cannot hold the whole sentence, and the
          clipped version was worse than either alternative. The lead-in is what
          drops: the coin icon already says which side of the rate this is, so
          "94.44 DMC" next to it still reads as what one USDT is worth, and the
          full sentence stays in the tooltip. */}
      <span className="font-mono tnum text-2xs tracking-wide text-ink-300">
        <span className="hidden sm:inline">1 USDT = </span>
        <span className={cn('font-medium', rate?.stale ? 'text-signal-amber' : 'text-ink-100')}>{value}</span> DMC
      </span>
    </span>
  );
}

/**
 * State colour mapping. Each state is assigned by what it means operationally:
 * amber where someone is waited on, cyan while work is in flight, green when
 * settled, red on failure, slate for inert terminal states.
 */
const STATE_STYLES: Record<TaskState, { dot: string; text: string; bg: string; label: string }> = {
  CREATED: { dot: 'bg-ink-300', text: 'text-ink-200', bg: 'bg-ink-700/60', label: 'Created' },
  ASSIGNED: { dot: 'bg-signal-cyan', text: 'text-signal-cyan', bg: 'bg-signal-cyan/10', label: 'Assigned' },
  IN_PROGRESS: { dot: 'bg-signal-cyan', text: 'text-signal-cyan', bg: 'bg-signal-cyan/10', label: 'In progress' },
  PROOF_SUBMITTED: { dot: 'bg-signal-amber', text: 'text-signal-amber', bg: 'bg-signal-amber/10', label: 'Proof submitted' },
  AUDIT_PENDING: { dot: 'bg-signal-amber', text: 'text-signal-amber', bg: 'bg-signal-amber/10', label: 'Awaiting audit' },
  COMPLETED: { dot: 'bg-signal-green', text: 'text-signal-green', bg: 'bg-signal-green/10', label: 'Completed' },
  REJECTED: { dot: 'bg-signal-red', text: 'text-signal-red', bg: 'bg-signal-red/10', label: 'Rejected' },
  REASSIGNED: { dot: 'bg-signal-amber', text: 'text-signal-amber', bg: 'bg-signal-amber/10', label: 'Reassigned' },
  EXPIRED: { dot: 'bg-signal-slate', text: 'text-signal-slate', bg: 'bg-signal-slate/10', label: 'Expired' },
  CANCEL_REVIEW: { dot: 'bg-signal-amber', text: 'text-signal-amber', bg: 'bg-signal-amber/10', label: 'Cancel — awaiting review' },
  CANCEL_DISPUTED: { dot: 'bg-signal-red', text: 'text-signal-red', bg: 'bg-signal-red/10', label: 'Cancel disputed' },
  CANCELLED: { dot: 'bg-signal-slate', text: 'text-signal-slate', bg: 'bg-signal-slate/10', label: 'Cancelled' },
};

export function StatusChip({ status, size = 'md' }: { status: TaskState; size?: 'sm' | 'md' }) {
  const style = STATE_STYLES[status] ?? STATE_STYLES.CREATED;
  const live = status === 'IN_PROGRESS' || status === 'AUDIT_PENDING';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap',
        style.bg,
        style.text,
        size === 'sm' ? 'px-2 py-0.5 text-2xs' : 'px-2.5 py-1 text-xs',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', style.dot, live && 'animate-pulse-dot')} />
      {style.label}
    </span>
  );
}

export function stateLabel(status: TaskState): string {
  return STATE_STYLES[status]?.label ?? status;
}

/**
 * A payment reference as the captain reported it.
 *
 * Nothing in this system issues these — the captain pays the customer outside
 * the app and types in what their bank gave them. It is rendered as plain
 * monospace text rather than dressed up as a settlement record, because that
 * is exactly what it is not: an unverified claim, checked by the party against
 * their own record and by admin against the bank statement.
 */
export function PaymentRef({ reference }: { reference: string | null }) {
  if (!reference) return <span className="text-ink-400 text-sm">—</span>;
  return <span className="font-mono tnum text-xs text-ink-100">{reference}</span>;
}

/** Banner shown wherever a captain is about to report a payment they made. */
export function SimulationNotice({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-start gap-2.5 rounded-panel border border-sim-dim bg-sim-wash px-3.5 py-2.5', className)}>
      <span className="mt-0.5 text-2xs font-mono font-semibold uppercase tracking-wider text-sim">sim</span>
      <p className="text-xs leading-relaxed text-sim-fg">
        This is demonstration data — no real money moves through this app and no bank or payment service is
        contacted by it. The reference you enter is your own record of the payment, not something issued here.
      </p>
    </div>
  );
}

export interface ProofInfo {
  id: string;
  taskId: string;
  captainId: string;
  providerReference: string;
  notes: string | null;
  receipt: { fileName: string | null; url: string; mimeType: string | null; sizeBytes: number | null } | null;
  submittedAt: string;
}

/** Notes and the uploaded receipt (image or PDF) a captain submitted as proof. */
export function ProofPanel({ proof }: { proof: ProofInfo | null }) {
  if (!proof) {
    return <p className="text-xs text-ink-500">No proof submitted yet.</p>;
  }
  const isImage = proof.receipt?.mimeType?.startsWith('image/');

  return (
    <div className="space-y-3">
      {proof.notes && <p className="text-xs leading-relaxed text-ink-200">{proof.notes}</p>}

      {proof.receipt ? (
        isImage ? (
          <a
            href={proof.receipt.url}
            target="_blank"
            rel="noreferrer"
            className="block overflow-hidden rounded-md border border-ink-700 bg-ink-950"
          >
            <img src={proof.receipt.url} alt={proof.receipt.fileName ?? 'Receipt'} className="max-h-64 w-full object-contain" />
          </a>
        ) : (
          <a
            href={proof.receipt.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2.5 rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5 text-xs text-brand-500 transition-colors hover:bg-ink-800"
          >
            <FileText className="h-4 w-4 shrink-0" />
            <span className="truncate">{proof.receipt.fileName ?? 'Receipt'}</span>
          </a>
        )
      ) : (
        <p className="text-2xs text-ink-500">No file attached.</p>
      )}

      <p className="text-2xs text-ink-500">
        Submitted {when(proof.submittedAt)}
      </p>
    </div>
  );
}

const PAYOUT_TYPE_META: Record<PayoutMethodType, { label: string; icon: typeof Landmark; tone: string }> = {
  BANK: { label: 'Bank transfer', icon: Landmark, tone: 'text-signal-cyan' },
  UPI: { label: 'UPI', icon: Smartphone, tone: 'text-signal-green' },
  USDT: { label: 'USDT', icon: Coins, tone: 'text-signal-amber' },
};

/**
 * How the beneficiary is fictionally paid — visible to the party, the
 * assigned captain, and admin alike, so a captain knows what a real payout
 * would have targeted even though nothing here ever touches a real rail.
 */
export function PayoutMethodPanel({ payoutMethod }: { payoutMethod: PayoutMethod | null }) {
  if (!payoutMethod) {
    return <p className="text-xs text-ink-500">No payout method on file.</p>;
  }
  const meta = PAYOUT_TYPE_META[payoutMethod.type];
  const Icon = meta.icon;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className={cn('h-4 w-4', meta.tone)} />
        <span className={cn('text-xs font-semibold', meta.tone)}>{meta.label}</span>
      </div>

      {payoutMethod.type === 'BANK' && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <PayoutField label="Bank" value={payoutMethod.bankName} />
          <PayoutField label="Account holder" value={payoutMethod.accountHolderName} />
          <PayoutField label="Account number" value={payoutMethod.accountNumber} mono />
          <PayoutField label="IFSC code" value={payoutMethod.ifscCode} mono />
        </dl>
      )}

      {payoutMethod.type === 'UPI' && (
        <div className="space-y-3">
          <PayoutField label="UPI ID" value={payoutMethod.upiId} mono />
          {payoutMethod.screenshotUrl ? (
            <a
              href={payoutMethod.screenshotUrl}
              target="_blank"
              rel="noreferrer"
              className="block overflow-hidden rounded-md border border-ink-700 bg-ink-950"
            >
              <img
                src={payoutMethod.screenshotUrl}
                alt={payoutMethod.screenshotFileName ?? 'UPI screenshot'}
                className="max-h-64 w-full object-contain"
              />
            </a>
          ) : (
            <p className="text-2xs text-ink-500">No screenshot attached.</p>
          )}
        </div>
      )}

      {payoutMethod.type === 'USDT' && (
        <dl>
          <PayoutField label="Wallet address" value={payoutMethod.walletAddress} mono />
        </dl>
      )}
    </div>
  );
}

function PayoutField({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-xs text-ink-100', mono && 'font-mono tnum')}>{value ?? '—'}</dd>
    </div>
  );
}

interface CancelInfo {
  status: TaskState;
  cancelInitiatedBy: 'PARTY' | 'CAPTAIN' | null;
  cancelReason: string | null;
  cancelReviewDecision: 'APPROVED' | 'REJECTED' | null;
  cancelReviewDecisionReason: string | null;
  adminCancelResolution: 'APPROVED' | 'REASSIGNED' | null;
}

/**
 * Read-only summary of a cancellation's progress, shown on all three roles'
 * task detail pages. Whichever side did NOT ask for it is the reviewer —
 * never admin, until (if) that review is disputed.
 */
export function CancelInfoPanel({ task }: { task: CancelInfo }) {
  if (!task.cancelInitiatedBy) return null;
  const initiator = task.cancelInitiatedBy === 'CAPTAIN' ? 'Captain' : 'Party';
  const reviewer = task.cancelInitiatedBy === 'CAPTAIN' ? 'Party' : 'Captain';

  return (
    <div className="space-y-2.5 rounded-panel border border-signal-amber/40 bg-signal-amber/10 px-4 py-3.5">
      <div>
        <p className="eyebrow text-signal-amber">Cancellation requested by {initiator}</p>
        {task.cancelReason && <p className="mt-1 text-xs text-ink-100">{task.cancelReason}</p>}
      </div>
      {task.cancelReviewDecision && (
        <div className="border-t border-signal-amber/20 pt-2.5">
          <p className="text-2xs text-ink-300">
            {reviewer}{' '}
            <span className={task.cancelReviewDecision === 'APPROVED' ? 'text-signal-green' : 'text-signal-red'}>
              {task.cancelReviewDecision === 'APPROVED' ? 'approved' : 'disputed'}
            </span>{' '}
            the cancellation
          </p>
          {task.cancelReviewDecisionReason && (
            <p className="mt-0.5 text-xs text-ink-100">{task.cancelReviewDecisionReason}</p>
          )}
        </div>
      )}
      {task.adminCancelResolution && (
        <div className="border-t border-signal-amber/20 pt-2.5">
          <p className="text-2xs text-ink-300">
            Admin{' '}
            <span className={task.adminCancelResolution === 'APPROVED' ? 'text-signal-cyan' : 'text-signal-slate'}>
              {task.adminCancelResolution === 'APPROVED' ? 'kept the task as it was' : 'returned it to the pool'}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}

interface RejectionInfo {
  rejectionReason: string | null;
  rejectionCategory?: RejectionCategory | null;
  status: TaskState;
  adminRejectionResolution: 'APPROVED' | 'REASSIGNED' | null;
}

/**
 * Read-only summary of a party's rejection of the captain's proof, and (once
 * it exists) admin's resolution of it. Shown on all three roles' task detail
 * pages wherever a rejection has happened.
 */
export function RejectionInfoPanel({ task }: { task: RejectionInfo }) {
  if (!task.rejectionReason) return null;

  const categoryLabel =
    REJECTION_CATEGORIES.find((c) => c.value === task.rejectionCategory)?.label ?? null;

  return (
    <div className="space-y-2.5 rounded-panel border border-signal-red/40 bg-signal-red/10 px-4 py-3.5">
      <div>
        <p className="eyebrow text-signal-red">Rejection reason</p>
        {categoryLabel && <p className="mt-1 text-xs font-medium text-ink-50">{categoryLabel}</p>}
        <p className="mt-1 text-xs text-ink-100">{task.rejectionReason}</p>
      </div>
      {task.status === 'REJECTED' && !task.adminRejectionResolution && (
        <p className="border-t border-signal-red/20 pt-2.5 text-2xs text-ink-300">
          Awaiting admin's review — the captain still holds this task.
        </p>
      )}
      {task.adminRejectionResolution && (
        <div className="border-t border-signal-red/20 pt-2.5">
          <p className="text-2xs text-ink-300">
            Admin{' '}
            <span className={task.adminRejectionResolution === 'APPROVED' ? 'text-signal-green' : 'text-signal-slate'}>
              {task.adminRejectionResolution === 'APPROVED' ? 'overruled the rejection — task complete' : 'returned the task to the pool'}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The search box above every task list — party, captain and admin all use this
 * one, so "search" looks and behaves the same wherever someone finds it.
 *
 * Typing is debounced rather than firing a request per keystroke: these lists
 * are paginated server-side, and a five-character task code should cost one
 * query, not five. The typed text stays local so the field never stutters
 * while a request is in flight.
 */
export function TaskSearchInput({
  onChange,
  placeholder = 'Task number or customer name',
  label = 'Search tasks',
  delayMs = 300,
  className,
}: {
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  delayMs?: number;
  className?: string;
}) {
  const [text, setText] = useState('');
  // Held in a ref so an inline arrow from the caller does not restart the
  // timer on every render — only actual typing should.
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    const timer = setTimeout(() => latest.current(text.trim()), delayMs);
    return () => clearTimeout(timer);
  }, [text, delayMs]);

  return (
    <div className={cn('relative min-w-[200px] flex-1', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={cn('field-input pl-9', text && 'pr-9')}
      />
      {text && (
        <button
          type="button"
          onClick={() => setText('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-400 transition-colors hover:text-ink-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * What a captain is told about an earlier failed attempt on the task they are
 * being offered or now hold.
 *
 * Deliberately not the party's rejection text: that was written about a
 * different captain's work, and a captain who inherits the task is entitled to
 * the lesson but not to the complaint. The server sends a fixed sentence drawn
 * from the category the party picked, so this renders whatever it is given
 * without deciding anything itself.
 */
export function ReattemptNotice({
  reassignmentCount,
  guidance,
}: {
  reassignmentCount: number;
  guidance?: string | null;
}) {
  if (reassignmentCount < 1) return null;

  return (
    <div className="flex items-start gap-2.5 rounded-panel border border-signal-amber/40 bg-signal-amber/10 px-3.5 py-3">
      <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-signal-amber" />
      <div className="min-w-0">
        <p className="text-xs font-medium text-signal-amber">
          Attempt {reassignmentCount + 1} — an earlier captain did not complete this
        </p>
        {guidance && <p className="mt-1 text-xs text-ink-100">{guidance}</p>}
      </div>
    </div>
  );
}

/**
 * The initiating form shared by party and admin — the fields are identical,
 * only the endpoint they post to differs, so callers own the mutation.
 */
export function CancelRequestForm({
  onSubmit,
  pending,
}: {
  onSubmit: (reason: string) => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary w-full">
        Cancel this task
      </button>
    );
  }

  return (
    <div className="panel space-y-3 p-4">
      <div>
        <label htmlFor="cancel-reason" className="field-label">Reason</label>
        <textarea
          id="cancel-reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="field-input resize-none"
          placeholder="Why this task should be cancelled"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onSubmit(reason.trim())}
          disabled={reason.trim().length < 3 || pending}
          className="btn-danger flex-1"
        >
          {pending ? 'Cancelling…' : 'Confirm cancellation'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-secondary">
          Back
        </button>
      </div>
    </div>
  );
}

export function Panel({
  title,
  eyebrow,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('panel shadow-panel', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-ink-700 px-4 py-3">
          <div className="min-w-0">
            {eyebrow && <p className="eyebrow mb-0.5">{eyebrow}</p>}
            {title && <h2 className="font-display text-sm font-semibold text-ink-50 truncate">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'amber' | 'green' | 'cyan' | 'red';
}) {
  const tones = {
    default: 'text-ink-50',
    amber: 'text-signal-amber',
    green: 'text-signal-green',
    cyan: 'text-signal-cyan',
    red: 'text-signal-red',
  };
  return (
    <div className="panel px-4 py-3.5">
      <p className="eyebrow">{label}</p>
      <p className={cn('mt-1.5 font-display text-2xl font-semibold tnum', tones[tone])}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <Inbox className="h-8 w-8 text-ink-500" strokeWidth={1.5} />
      <p className="mt-3 font-display text-sm font-medium text-ink-200">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-xs text-ink-400">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <AlertCircle className="h-7 w-7 text-signal-red" strokeWidth={1.5} />
      <p className="mt-3 text-sm text-ink-200">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-secondary mt-4">
          Try again
        </button>
      )}
    </div>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-full border border-ink-700 bg-ink-900 text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-50',
        className,
      )}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-ink-700/60', className)} />;
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cn('h-9 flex-1', c === 0 && 'max-w-[160px]')} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Previous / Next over a paged list, with the position between them.
 *
 * Renders nothing at all for a single page: a pager that is always visible but
 * usually inert reads as broken, and the position is not worth stating when
 * there is only one.
 */
export function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-ink-800 px-4 py-2.5">
      <button type="button" onClick={() => onChange(page - 1)} disabled={page <= 1} className="btn-ghost px-2 py-1 text-xs">
        Previous
      </button>
      <span className="font-mono tnum text-2xs text-ink-400">Page {page} of {totalPages}</span>
      <button type="button" onClick={() => onChange(page + 1)} disabled={page >= totalPages} className="btn-ghost px-2 py-1 text-xs">
        Next
      </button>
    </div>
  );
}
