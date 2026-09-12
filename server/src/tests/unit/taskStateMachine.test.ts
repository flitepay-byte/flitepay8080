import {
  canTransition,
  assertTransition,
  isTerminal,
  isClaimable,
  holdsCollateral,
  releasesCollateral,
  allowedTransitions,
} from '../../services/taskStateMachine';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { TASK_STATES, type TaskState } from '../../types';

describe('task state machine', () => {
  describe('specified transitions are allowed', () => {
    const legal: Array<[TaskState, TaskState]> = [
      ['CREATED', 'ASSIGNED'],
      ['ASSIGNED', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'PROOF_SUBMITTED'],
      ['PROOF_SUBMITTED', 'AUDIT_PENDING'],
      ['AUDIT_PENDING', 'COMPLETED'],
      ['AUDIT_PENDING', 'REJECTED'],
      // Admin's two moves on a rejection admin is arbitrating.
      ['REJECTED', 'REASSIGNED'],
      ['REJECTED', 'COMPLETED'],
      ['IN_PROGRESS', 'EXPIRED'],
      ['EXPIRED', 'REJECTED'],
      ['CREATED', 'CANCELLED'],
      ['REASSIGNED', 'CANCELLED'],
      ['ASSIGNED', 'CANCEL_REVIEW'],
      ['CANCEL_REVIEW', 'CANCELLED'],
      ['CANCEL_REVIEW', 'CANCEL_DISPUTED'],
      // Admin's two moves on a cancellation dispute: leave it as it was, or
      // reassign it to the pool. Never a direct CANCELLED from here.
      ['CANCEL_DISPUTED', 'ASSIGNED'],
      ['CANCEL_DISPUTED', 'IN_PROGRESS'],
      ['CANCEL_DISPUTED', 'REASSIGNED'],
    ];

    it.each(legal)('%s -> %s', (from, to) => {
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    });
  });

  describe('unspecified transitions are rejected', () => {
    const illegal: Array<[TaskState, TaskState]> = [
      ['CREATED', 'COMPLETED'],
      ['CREATED', 'PROOF_SUBMITTED'],
      ['ASSIGNED', 'COMPLETED'],
      ['IN_PROGRESS', 'COMPLETED'],
      ['COMPLETED', 'REJECTED'],
      ['COMPLETED', 'IN_PROGRESS'],
      ['CANCELLED', 'ASSIGNED'],
      ['EXPIRED', 'IN_PROGRESS'],
      ['AUDIT_PENDING', 'IN_PROGRESS'],
      ['PROOF_SUBMITTED', 'COMPLETED'],
      // A captain holding the task must review a cancellation — it can no
      // longer jump straight to CANCELLED.
      ['ASSIGNED', 'CANCELLED'],
      ['IN_PROGRESS', 'CANCELLED'],
      // Once work has started, the task can no longer be cancelled by anyone —
      // only completed or expired.
      ['IN_PROGRESS', 'CANCEL_REVIEW'],
      ['CANCEL_DISPUTED', 'PROOF_SUBMITTED'],
      // A disputed cancellation is never directly CANCELLED — only admin's
      // APPROVE (back to its pre-dispute state) or REASSIGN (to the pool).
      ['CANCEL_DISPUTED', 'CANCELLED'],
    ];

    it.each(illegal)('%s -> %s is blocked', (from, to) => {
      expect(canTransition(from, to)).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(AppError);
    });

    it('attaches the legal alternatives to the error', () => {
      try {
        assertTransition('CREATED', 'COMPLETED');
        fail('expected a throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        const appErr = err as AppError;
        expect(appErr.errorCode).toBe(ErrorCodes.INVALID_STATE_TRANSITION);
        expect(appErr.statusCode).toBe(409);
        expect(appErr.details['allowed']).toEqual(['ASSIGNED', 'CANCELLED']);
      }
    });
  });

  it('rejects a self-transition', () => {
    expect(() => assertTransition('CREATED', 'CREATED')).toThrow(AppError);
  });

  it('treats COMPLETED and CANCELLED as terminal, but not EXPIRED', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    // Expiry is recoverable: the captain records a reason, which rejects and
    // reassigns the task rather than losing it.
    expect(isTerminal('EXPIRED')).toBe(false);
    expect(isTerminal('AUDIT_PENDING')).toBe(false);
  });

  it('allows no outbound transition from any terminal state', () => {
    for (const state of TASK_STATES) {
      if (isTerminal(state)) {
        expect(allowedTransitions(state)).toHaveLength(0);
      }
    }
  });

  it('marks only CREATED and REASSIGNED as claimable', () => {
    expect(isClaimable('CREATED')).toBe(true);
    expect(isClaimable('REASSIGNED')).toBe(true);
    expect(isClaimable('ASSIGNED')).toBe(false);
    expect(isClaimable('COMPLETED')).toBe(false);
  });

  it('holds collateral for exactly the in-flight states', () => {
    expect(holdsCollateral('ASSIGNED')).toBe(true);
    expect(holdsCollateral('IN_PROGRESS')).toBe(true);
    expect(holdsCollateral('PROOF_SUBMITTED')).toBe(true);
    expect(holdsCollateral('AUDIT_PENDING')).toBe(true);
    // A rejection pending admin's review, or a cancellation under review or
    // dispute, doesn't release the captain's stake until it is decided.
    expect(holdsCollateral('REJECTED')).toBe(true);
    expect(holdsCollateral('CANCEL_REVIEW')).toBe(true);
    expect(holdsCollateral('CANCEL_DISPUTED')).toBe(true);
    expect(holdsCollateral('CREATED')).toBe(false);
    expect(holdsCollateral('COMPLETED')).toBe(false);
  });

  it('releases collateral on completion, expiry and cancellation, but not on rejection alone', () => {
    expect(releasesCollateral('AUDIT_PENDING', 'COMPLETED')).toBe(true);
    // A rejection now sits pending admin review with the stake still locked —
    // only admin's REASSIGN (or overruling APPROVE, via COMPLETED) frees it.
    expect(releasesCollateral('AUDIT_PENDING', 'REJECTED')).toBe(false);
    expect(releasesCollateral('REJECTED', 'COMPLETED')).toBe(true);
    expect(releasesCollateral('REJECTED', 'REASSIGNED')).toBe(true);
    expect(releasesCollateral('IN_PROGRESS', 'EXPIRED')).toBe(true);
    expect(releasesCollateral('IN_PROGRESS', 'CANCELLED')).toBe(true);
    expect(releasesCollateral('CANCEL_DISPUTED', 'REASSIGNED')).toBe(true);
    // Still in flight: the hold must persist.
    expect(releasesCollateral('ASSIGNED', 'IN_PROGRESS')).toBe(false);
    expect(releasesCollateral('IN_PROGRESS', 'PROOF_SUBMITTED')).toBe(false);
    expect(releasesCollateral('CANCEL_DISPUTED', 'ASSIGNED')).toBe(false);
  });

  it('never lets a terminal state be re-entered from anywhere', () => {
    expect(canTransition('COMPLETED', 'ASSIGNED')).toBe(false);
    expect(canTransition('EXPIRED', 'ASSIGNED')).toBe(false);
    expect(canTransition('CANCELLED', 'ASSIGNED')).toBe(false);
  });
});
