/**
 * THE NEW MODEL'S TRANSACTION — the party's own users paying and being paid.
 *
 * A task was work the platform handed a captain. A transaction is a payment a
 * party's customer makes or receives, and the platform is the rails rather
 * than the employer. The two never mix: a party integrates our API into its
 * own site, its users never see us, and we never learn who they are beyond
 * what the party tells us in the call.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * PAY_IN — the party's customer pays money in.
 *   The customer scans a QR and pays a captain in real rupees. The captain
 *   therefore *gives up* DMC and the party receives it. The captain's DMC is
 *   held from the moment they are assigned, because a captain with ₹10,000 of
 *   capital must not be able to accept five ₹10,000 pay-ins at once and owe
 *   DMC they do not have.
 *
 * A payout is deliberately not here. It cannot be automated — see the note on
 * TRANSACTION_DIRECTIONS — so it is carried by a task instead.
 *
 * Neither direction charges the party or the customer anything. ₹100 in is
 * exactly 100 DMC to the party; ₹100 out sends exactly ₹100. The captain's
 * commission is paid by the platform out of its funded pool, never skimmed
 * off the amount — so the number the customer sees and the number the party
 * sees are the same number.
 */

/**
 * Only one direction lives here.
 *
 * A pay-in can be automated: the captain has a merchant account, so a gateway
 * can mint a dynamic QR against it and the customer scans. A payout has no
 * equivalent — the person receiving the money has an ordinary personal
 * account, so somebody has to make the transfer by hand.
 *
 * That is what a task already is, so a payout is a task (see Task.ts). The
 * direction is kept as a one-member union rather than dropped, because it is
 * what the party's API reports and what a second rail would slot into.
 */
export const TRANSACTION_DIRECTIONS = ['PAY_IN'] as const;
export type TransactionDirection = (typeof TRANSACTION_DIRECTIONS)[number];

export const TRANSACTION_STATES = [
  /** Accepted from the party, waiting for a captain. */
  'CREATED',
  /** A captain has it. Their DMC (pay-in) is now held. */
  'ASSIGNED',
  /**
   * The customer's side is live: a QR has been issued (pay-in), or the captain
   * has been given the beneficiary details and is making the transfer
   * (pay-out). Money is expected to move outside the system now.
   */
  'AWAITING_CUSTOMER',
  /**
   * Real money has moved and somebody says so — the gateway webhook for a
   * pay-in, the captain's own UTR for a pay-out. Not yet final: this is the
   * claim, not the settlement.
   */
  'CONFIRMED',
  /** DMC has moved and commission is paid. Terminal, and never reversed. */
  'SETTLED',
  /**
   * Nobody paid in time. Whatever was held goes back. Terminal.
   */
  'EXPIRED',
  /**
   * Something went wrong and it was abandoned before any money moved —
   * the party cancelled, or no captain could ever take it. Terminal.
   */
  'CANCELLED',
  /**
   * The two sides disagree about whether the money arrived. Admin decides,
   * and until they do the held DMC stays held.
   */
  'DISPUTED',
] as const;
export type TransactionState = (typeof TRANSACTION_STATES)[number];

/**
 * The legal moves, frozen. Every state change routes through
 * `assertTransactionTransition`, so an illegal one cannot be reached by any
 * path — including admin tooling and the audit harness.
 *
 * SETTLED, EXPIRED and CANCELLED are terminal and have no way out. That is
 * what makes settlement safe to pay commission on: a settled transaction can
 * never afterwards be cancelled, so a payment made at settlement never needs
 * clawing back.
 */
export const TRANSACTION_TRANSITIONS: Readonly<Record<TransactionState, readonly TransactionState[]>> =
  Object.freeze({
    CREATED: ['ASSIGNED', 'CANCELLED', 'EXPIRED'],
    // Back to CREATED when the assigned captain drops it or times out, so it
    // can be offered to somebody else without losing the party's request.
    ASSIGNED: ['AWAITING_CUSTOMER', 'CREATED', 'CANCELLED', 'EXPIRED'],
    AWAITING_CUSTOMER: ['CONFIRMED', 'EXPIRED', 'DISPUTED'],
    // Confirmation settles it. It cannot be un-confirmed into a refund path:
    // once the gateway or the captain says the money moved, the disagreement
    // is a dispute for admin, not a silent reversal.
    CONFIRMED: ['SETTLED', 'DISPUTED'],
    SETTLED: [],
    EXPIRED: [],
    CANCELLED: [],
    // Admin either believes the money moved (settle it) or does not (release
    // the hold and expire it).
    DISPUTED: ['SETTLED', 'EXPIRED'],
  });

/** Terminal states — nothing moves after these. */
export const TRANSACTION_TERMINAL_STATES: readonly TransactionState[] = ['SETTLED', 'EXPIRED', 'CANCELLED'];

/** States in which a captain may still be found for the transaction. */
export const TRANSACTION_ROUTABLE_STATES: readonly TransactionState[] = ['CREATED'];

/**
 * States in which whatever was held is still held.
 *
 * For a pay-in that is the captain's working capital, held from assignment;
 * for a pay-out it is the party's, held from creation. Leaving a hold in place
 * through DISPUTED is deliberate — an argument about whether money arrived is
 * exactly when the DMC must not be spendable by either side.
 */
export const TRANSACTION_HELD_STATES: readonly TransactionState[] = [
  'ASSIGNED',
  'AWAITING_CUSTOMER',
  'CONFIRMED',
  'DISPUTED',
];
