/**
 * What counts as value that actually moved.
 *
 * A task's amount is not money the party has spent — it is money the party has
 * committed. If the task is cancelled the DMC goes straight back to their
 * balance (see refundPartyForCancelledTask), so counting it in a running total
 * says a party moved 10,000 DMC that is still sitting in their wallet. The
 * figure only ever grows, and it disagrees with the balance beside it.
 *
 * So a cancelled task contributes nothing. Everything else does, including
 * work still in flight: a party that has just created a task has committed
 * that amount, and watching it appear is the point of the number.
 *
 * This is deliberately not "completed only". That would be the stricter
 * reading of "moved", but it would leave the total at zero while a day's work
 * is underway, which is not what anyone is looking at the tile for.
 *
 * Per-state breakdowns are the exception and should keep using the raw sum —
 * the value sitting in CANCELLED is exactly what that row is reporting.
 */

/** States whose amount is excluded, because the party got the DMC back. */
export const REFUNDED_STATES = ['CANCELLED'] as const;

/**
 * A `$sum` expression for use inside `$group`, counting only value that was
 * not refunded. Kept as an expression rather than a `$match` so the same
 * aggregation can still count every task while valuing only some of them.
 */
export const sumMovedValuePaise = {
  $sum: { $cond: [{ $in: ['$status', REFUNDED_STATES] }, 0, '$amountPaise'] },
} as const;
