import {
  TRANSACTION_TRANSITIONS,
  TRANSACTION_TERMINAL_STATES,
  TRANSACTION_HELD_STATES,
  TRANSACTION_ROUTABLE_STATES,
  type TransactionState,
} from '../types/transaction';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';

/**
 * TRANSACTION STATE MACHINE
 * -------------------------
 * Pure functions over the frozen table in types/transaction.ts, mirroring the
 * task state machine exactly. Every state change routes through
 * `assertTransactionTransition`, so an illegal move cannot be reached by any
 * code path — and the money rules below are stated once here rather than
 * re-derived at each call site, which is how the task flow avoided a hold
 * being released twice or not at all.
 */

export function canTransitionTransaction(from: TransactionState, to: TransactionState): boolean {
  return TRANSACTION_TRANSITIONS[from].includes(to);
}

export function allowedTransactionTransitions(from: TransactionState): readonly TransactionState[] {
  return TRANSACTION_TRANSITIONS[from];
}

export function isTransactionTerminal(state: TransactionState): boolean {
  return TRANSACTION_TERMINAL_STATES.includes(state);
}

export function isTransactionRoutable(state: TransactionState): boolean {
  return TRANSACTION_ROUTABLE_STATES.includes(state);
}

/** True while whatever was put aside for this transaction is still put aside. */
export function transactionHoldsFunds(state: TransactionState): boolean {
  return TRANSACTION_HELD_STATES.includes(state);
}

/**
 * Whether this move ends the hold. Asked once, here, so no caller has to
 * remember which of the eight states hold and which do not.
 */
export function releasesTransactionHold(from: TransactionState, to: TransactionState): boolean {
  return transactionHoldsFunds(from) && !transactionHoldsFunds(to);
}

export function assertTransactionTransition(from: TransactionState, to: TransactionState): void {
  if (from === to) {
    throw AppError.conflict(ErrorCodes.INVALID_STATE_TRANSITION, `Transaction is already in state ${from}`, {
      from,
      to,
    });
  }
  if (!canTransitionTransaction(from, to)) {
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `Cannot move a transaction from ${from} to ${to}`,
      { from, to, allowed: allowedTransactionTransitions(from) },
    );
  }
}
