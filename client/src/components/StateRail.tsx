import { Fragment } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { TASK_TRANSITIONS, type TaskState, type StateEvent } from '@/types';
import { cn, stateLabel } from './primitives';
import { when } from '@/lib/datetime';

/**
 * STATE RAIL
 * ----------
 * Renders the task's actual position in the state machine, not a generic
 * progress stepper. Three things are encoded that a stepper cannot show:
 *
 *   1. The happy path is the spine; terminal exits (expired, cancelled) hang
 *      below it rather than pretending to be steps.
 *   2. Legal next states from the current position are outlined, so an
 *      operator can see what can happen next without consulting the docs.
 *   3. The reject loop is drawn as a real return edge back into the pool,
 *      because a rejected task genuinely re-enters the queue.
 */

const SPINE: TaskState[] = [
  'CREATED',
  'ASSIGNED',
  'IN_PROGRESS',
  'PROOF_SUBMITTED',
  'AUDIT_PENDING',
  'COMPLETED',
];

const TONE: Record<TaskState, string> = {
  CREATED: 'text-ink-200',
  ASSIGNED: 'text-signal-cyan',
  IN_PROGRESS: 'text-signal-cyan',
  PROOF_SUBMITTED: 'text-signal-amber',
  AUDIT_PENDING: 'text-signal-amber',
  COMPLETED: 'text-signal-green',
  REJECTED: 'text-signal-red',
  REASSIGNED: 'text-signal-amber',
  EXPIRED: 'text-signal-slate',
  CANCEL_REVIEW: 'text-signal-amber',
  CANCEL_DISPUTED: 'text-signal-red',
  CANCELLED: 'text-signal-slate',
};

interface StateRailProps {
  current: TaskState;
  history?: StateEvent[];
  compact?: boolean;
}

export function StateRail({ current, history = [], compact = false }: StateRailProps) {
  const reached = new Set<TaskState>(history.map((h) => h.to));
  reached.add(current);

  const nextStates = TASK_TRANSITIONS[current] ?? [];
  const currentIndex = SPINE.indexOf(current);
  const isOffSpine = currentIndex === -1;

  return (
    <div className="w-full">
      <div className="flex items-stretch overflow-x-auto pb-1">
        {SPINE.map((state, index) => {
          const isCurrent = state === current;
          const isReached = reached.has(state);
          const isNext = nextStates.includes(state);
          // Everything before the current position on the spine counts as past.
          const isPast = !isOffSpine && index < currentIndex;
          const done = isReached || isPast;

          return (
            <Fragment key={state}>
              {index > 0 && (
                <div className="flex w-6 shrink-0 items-center px-1 pt-[13px]">
                  <div className={cn('h-px w-full', done ? 'bg-signal-cyan/50' : 'bg-ink-600')} />
                </div>
              )}
              <div className="flex shrink-0 flex-col items-center gap-1.5">
                <span
                  className={cn(
                    'flex h-[26px] items-center whitespace-nowrap rounded-full border px-2.5 text-2xs font-mono uppercase tracking-wider transition-colors',
                    isCurrent
                      ? cn('border-current bg-ink-800 font-semibold', TONE[state])
                      : done
                        ? 'border-ink-600 bg-ink-800 text-ink-200'
                        : isNext
                          ? cn('border-dashed bg-transparent', TONE[state], 'opacity-70')
                          : 'border-ink-700 bg-transparent text-ink-500',
                  )}
                >
                  {compact ? state.slice(0, 4) : stateLabel(state)}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* Branches. Shown only when they are reachable now or already taken, so
          the rail stays quiet on a healthy task. */}
      <BranchRow current={current} reached={reached} nextStates={nextStates} />
    </div>
  );
}

function BranchRow({
  current,
  reached,
  nextStates,
}: {
  current: TaskState;
  reached: Set<TaskState>;
  nextStates: TaskState[];
}) {
  const branches: TaskState[] = ['REJECTED', 'REASSIGNED', 'EXPIRED', 'CANCEL_REVIEW', 'CANCEL_DISPUTED', 'CANCELLED'];
  const visible = branches.filter((b) => reached.has(b) || nextStates.includes(b));
  if (visible.length === 0) return null;

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-dashed border-ink-700 pt-2.5">
      <span className="eyebrow">
        {nextStates.some((s) => branches.includes(s)) ? 'possible next' : 'path taken'}
      </span>
      {visible.map((state) => {
        const isCurrent = state === current;
        const taken = reached.has(state);
        return (
          <span
            key={state}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs font-mono uppercase tracking-wider',
              isCurrent
                ? cn('border-current bg-ink-800 font-semibold', TONE[state])
                : taken
                  ? 'border-ink-600 bg-ink-800 text-ink-300'
                  : cn('border-dashed opacity-70', TONE[state]),
            )}
          >
            {state === 'REASSIGNED' && <CornerDownLeft className="h-3 w-3" />}
            {stateLabel(state)}
          </span>
        );
      })}
      {reached.has('REASSIGNED') && (
        <span className="text-2xs text-ink-400">returned to the pool for another captain</span>
      )}
    </div>
  );
}

/** Chronological audit trail, shown beneath the rail on detail screens. */
export function StateHistory({ history }: { history: StateEvent[] }) {
  if (history.length === 0) {
    return <p className="text-xs text-ink-400">No state changes recorded yet.</p>;
  }

  return (
    <ol className="space-y-0">
      {history.map((event, index) => (
        <li key={`${event.to}-${event.at}-${index}`} className="relative flex gap-3 pb-4 last:pb-0">
          <div className="flex flex-col items-center">
            <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full bg-current', TONE[event.to])} />
            {index < history.length - 1 && <span className="mt-1 w-px flex-1 bg-ink-700" />}
          </div>
          <div className="min-w-0 flex-1 -mt-0.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn('font-mono text-xs uppercase tracking-wider', TONE[event.to])}>
                {stateLabel(event.to)}
              </span>
              {event.role && <span className="text-2xs text-ink-400">by {event.role.toLowerCase()}</span>}
              <span className="ml-auto font-mono tnum text-2xs text-ink-500">
                {when(event.at)}
              </span>
            </div>
            {event.reason && <p className="mt-0.5 text-xs text-ink-300">{event.reason}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
