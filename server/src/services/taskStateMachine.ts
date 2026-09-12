import { TASK_TRANSITIONS, TERMINAL_STATES, CLAIMABLE_STATES, DMC_HELD_STATES, type TaskState } from '../types';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';

/**
 * TASK STATE MACHINE
 * ------------------
 * Pure functions over the frozen transition table in types/index.ts. Every
 * state change in the system routes through assertTransition, so an illegal
 * transition cannot be reached by any code path, including admin tooling.
 */

export function canTransition(from: TaskState, to: TaskState): boolean {
  const allowed = TASK_TRANSITIONS[from];
  return allowed.includes(to);
}

export function allowedTransitions(from: TaskState): readonly TaskState[] {
  return TASK_TRANSITIONS[from];
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isClaimable(state: TaskState): boolean {
  return CLAIMABLE_STATES.includes(state);
}

/** True while the claiming captain's collateral must remain locked. */
export function holdsCollateral(state: TaskState): boolean {
  return DMC_HELD_STATES.includes(state);
}

/**
 * Throws a 409 with the legal alternatives attached, so the client can render
 * a useful message rather than a bare failure.
 */
export function assertTransition(from: TaskState, to: TaskState): void {
  if (from === to) {
    throw AppError.conflict(ErrorCodes.INVALID_STATE_TRANSITION, `Task is already in state ${from}`, {
      from,
      to,
    });
  }
  if (!canTransition(from, to)) {
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `Cannot move a task from ${from} to ${to}`,
      { from, to, allowed: allowedTransitions(from) },
    );
  }
}

/**
 * Whether a transition releases the collateral hold. Used by the collateral
 * service to decide when to decrement lockedAmount.
 */
export function releasesCollateral(from: TaskState, to: TaskState): boolean {
  return holdsCollateral(from) && !holdsCollateral(to);
}
