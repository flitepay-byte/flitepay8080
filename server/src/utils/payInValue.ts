/**
 * What counts as a pay-in that actually moved.
 *
 * The sibling of taskValue.ts, for the other direction. That one deliberately
 * counts work in flight, because a party that has created a task has committed
 * the amount and watching it appear is the point. A pay-in is the opposite
 * case: nothing has been committed by the party at all until the customer
 * pays, and until then there is only an expectation.
 *
 * So the rule is narrower here, and the settlement behaviour is what sets it.
 * `settle()` in transaction.service.ts is the one place a party's balance is
 * credited for a pay-in, and it is reachable only as the move into SETTLED.
 * Everything else — waiting for a captain, waiting for the customer, confirmed
 * but not yet settled, expired, cancelled, disputed — has moved the party
 * nothing, and several of them never will.
 *
 * SETTLED is terminal and never reversed, so a figure built on it only ever
 * grows for the right reason.
 *
 * The amount counted is the payment itself, not the payment less the party's
 * commission. That matches what the pay-out side counts: a task contributes
 * the amount sent to the customer, not the amount plus the fee the party was
 * billed. Both directions measure the movement; neither measures the billing.
 */

/** The only state in which a pay-in has moved money to the party. */
export const SETTLED_PAY_IN_STATES = ['SETTLED'] as const;

/**
 * A `$sum` expression for use inside `$group`, valuing only settled pay-ins.
 *
 * An expression rather than a `$match`, for the same reason as the task side:
 * the same aggregation can then count every row while valuing only some of
 * them, without running the query twice.
 */
export const sumSettledPayInValuePaise = {
  $sum: { $cond: [{ $in: ['$status', SETTLED_PAY_IN_STATES] }, '$amountPaise', 0] },
} as const;
