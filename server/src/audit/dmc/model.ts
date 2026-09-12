/**
 * An independent model of where every DMC is, derived from the business rules
 * rather than from the application's own numbers.
 *
 * The whole point is that this file must never read a balance out of the
 * database and call it "expected". It applies the rules to the events the
 * scenario performs and keeps its own books; the reconciler then compares the
 * two. If the application and this model agree, both are probably right. If
 * they disagree, one of them is wrong and the difference says exactly where.
 *
 * ---------------------------------------------------------------------------
 * THE TWO POOLS
 * ---------------------------------------------------------------------------
 *
 * Spendable DMC is a closed loop. It is minted where real money arrives — a
 * party's registration credit, an approved party top-up, the usable half of a
 * captain's security deposit, and admin funding the commission pool — and
 * destroyed in exactly one place, when admin pays a captain real rupees for
 * DMC they hand back. In between it only moves between these holders:
 *
 *   party.dmcBalancePaise          what a party can still spend
 *   captain.dmcBalancePaise        a captain's money — capital and earnings
 *   platform.poolBalancePaise      funded, plus commission collected, less
 *                                  every captain share paid out
 *   HELD FOR REDEMPTION            a cash-out request admin has not settled
 *   TRANSACTION IN FLIGHT          a pay-in a captain has committed to and the
 *                                  party has not yet received
 *   IN FLIGHT                      committed to a task that is neither
 *                                  completed nor cancelled
 *
 * Each holder is one number, which is the point. A captain used to have three
 * balances and the platform two, and the model had to keep rules for how money
 * crossed between pockets that behaved identically. Every one of those rules
 * was a place the model and the application could disagree about something
 * that did not matter.
 *
 * Creating a task moves money from the party into flight; completing it moves
 * that money out to the captain and the pool; cancelling it moves it back to
 * the party. Settling a withdrawal moves money from a captain (or the pool)
 * back to the party that owed it, because the party has by then paid that
 * amount in real money outside the system. Nothing is ever destroyed.
 *
 * Collateral is a *separate* pool and deliberately not part of that loop. It is
 * security money a captain posts, it is never spent, and the codebase has no
 * path that reduces it — so its own invariant is simply that it equals the sum
 * of approved deposits. `lockedAmountPaise` is not a balance at all but a
 * reservation against collateral, so it is tracked separately again and must
 * never be added into a DMC total.
 */

/** Rupees are never used here. Every figure in this file is paise. */
export interface Snapshot {
  partyDmc: Map<string, number>;
  captainCollateral: Map<string, number>;
  captainDmc: Map<string, number>;
  captainLocked: Map<string, number>;
  platformPool: number;
  redemptionHeld: Map<string, number>;
  /** Committed to a pay-in or pay-out neither side has finished, keyed by transaction. */
  transactionInFlight: Map<string, number>;
  /** A pay-out's hold, out of the captain's balance while they hold the work. */
  captainHold: Map<string, number>;
  /** Committed to a task and not yet distributed or refunded, keyed by task. */
  inFlight: Map<string, number>;
  /** Everything ever minted, so the closed loop can be checked against it. */
  minted: number;
}

export interface TaskTerms {
  taskId: string;
  partyId: string;
  amountPaise: number;
  captainCommissionPaise: number;
  platformCommissionPaise: number;
}

const bump = (m: Map<string, number>, key: string, delta: number): void => {
  m.set(key, (m.get(key) ?? 0) + delta);
};

export class ExpectedLedger {
  readonly partyDmc = new Map<string, number>();
  readonly captainCollateral = new Map<string, number>();
  /** The captain's whole spendable balance: capital, earnings and commission. */
  readonly captainDmc = new Map<string, number>();
  readonly captainLocked = new Map<string, number>();
  /**
   * The platform's only balance: admin funding plus commission collected, less
   * every captain share paid out. What is left is the platform's earnings, and
   * it is never written as a figure of its own.
   */
  platformPool = 0;
  /** Taken out of a captain's balance by a redemption request, not yet resolved. */
  readonly redemptionHeld = new Map<string, number>();
  /**
   * Committed to a pay-in or pay-out that has not finished. Held by one side
   * and not yet given to the other, so it belongs to nobody's balance and must
   * still be counted somewhere.
   */
  readonly transactionInFlight = new Map<string, number>();
  /** A pay-out's hold: out of the captain's balance, not yet anyone else's. */
  readonly captainHold = new Map<string, number>();
  readonly inFlight = new Map<string, number>();
  minted = 0;

  /** Terms locked onto a task at creation — never recomputed afterwards. */
  private readonly terms = new Map<string, TaskTerms>();

  // ---------------------------------------------------------------- minting

  /** A party is registered with an opening balance. This mints DMC. */
  registerParty(partyId: string, openingPaise: number): void {
    this.partyDmc.set(partyId, openingPaise);
    this.minted += openingPaise;
  }

  registerCaptain(captainId: string): void {
    this.captainCollateral.set(captainId, 0);
    this.captainLocked.set(captainId, 0);
    this.captainDmc.set(captainId, 0);
  }

  /** Admin confirmed real money arrived, so DMC is minted for that party. */
  topUpApproved(partyId: string, amountPaise: number): void {
    bump(this.partyDmc, partyId, amountPaise);
    this.minted += amountPaise;
  }

  /** A rejected top-up must move nothing at all. */
  topUpRejected(): void {
    /* intentionally empty — asserting that nothing happens is the point */
  }

  // ------------------------------------------------------------- collateral

  /** Security money, a pool of its own: not spendable, and never minted DMC. */
  /**
   * A deposit lands in two places, not one.
   *
   * The locked half is security and stays outside the DMC loop entirely — it
   * is backing, never spendable. The usable half genuinely *mints* DMC: real
   * money came in and became working capital the captain can trade with, so it
   * counts towards everything ever minted and must be found somewhere
   * afterwards, exactly like a party's top-up.
   */
  depositApproved(captainId: string, lockedPaise: number, usablePaise: number): void {
    bump(this.captainCollateral, captainId, lockedPaise);
    bump(this.captainDmc, captainId, usablePaise);
    this.minted += usablePaise;
  }

  depositRejected(): void {
    /* nothing moves */
  }

  // ------------------------------------------------------------------ tasks

  /**
   * The party is billed the whole cost up front — the amount plus both
   * commissions — and that money is now in flight against this task.
   */
  taskCreated(t: TaskTerms): void {
    const total = t.amountPaise + t.captainCommissionPaise + t.platformCommissionPaise;
    bump(this.partyDmc, t.partyId, -total);
    this.inFlight.set(t.taskId, total);
    this.terms.set(t.taskId, t);
  }

  /**
   * Claiming a pay-out takes a hold out of the captain's DMC.
   *
   * They are committing to send that much real money. The DMC has not left the
   * system — it belongs to nobody's balance while the work is in hand — so it
   * is parked here and counted in the closed loop like any other in-flight sum.
   */
  taskClaimed(taskId: string, captainId: string): void {
    const amount = this.termsFor(taskId).amountPaise;
    bump(this.captainDmc, captainId, -amount);
    this.captainHold.set(taskId, amount);
  }

  /**
   * The hold comes back, whatever ended the captain's turn.
   *
   * Completion calls this too, and then credits the reimbursement separately —
   * which is why a finished pay-out returns twice the amount in total, and why
   * that is one movement plus one movement rather than a doubling.
   */
  collateralReleased(taskId: string, captainId: string): void {
    const held = this.captainHold.get(taskId) ?? 0;
    this.captainHold.delete(taskId);
    bump(this.captainDmc, captainId, held);
  }

  /**
   * Completion distributes exactly what was committed, and every paise of the
   * commission goes through the pool.
   *
   * The party's whole charge lands in the pool; the captain's share is paid
   * out of it into their spendable DMC, together with the amount they laid
   * out; what nobody took stays in the pool as the platform's. Modelled as one
   * net movement here because the two halves always sum to the charge — and
   * writing it that way is what makes it impossible for the model to disagree
   * with itself about the platform's cut.
   */
  taskCompleted(taskId: string, captainId: string): void {
    const t = this.termsFor(taskId);
    bump(this.captainDmc, captainId, t.amountPaise + t.captainCommissionPaise);
    this.platformPool += t.platformCommissionPaise;
    this.inFlight.delete(taskId);
  }

  /** Cancellation returns the whole commitment, commissions included. */
  taskCancelled(taskId: string): void {
    const t = this.termsFor(taskId);
    bump(this.partyDmc, t.partyId, this.inFlight.get(taskId) ?? 0);
    void t;
    this.inFlight.delete(taskId);
  }

  // -------------------------------------------------- the commission pool

  /**
   * Admin puts real money behind the commission it promises captains. That
   * mints DMC exactly as a party's top-up does, because the same thing
   * happened: rupees arrived and DMC was created to represent them.
   */
  poolFunded(amountPaise: number): void {
    this.platformPool += amountPaise;
    this.minted += amountPaise;
  }

  /**
   * A captain earns commission. Nothing is created here — it moves out of the
   * pool and into the captain's balance, which is the whole reason the pool
   * exists. Commission that minted its own DMC would be commission paid with
   * money nobody ever put in.
   */
  commissionPaidFromPool(captainId: string, amountPaise: number): void {
    this.platformPool -= amountPaise;
    bump(this.captainDmc, captainId, amountPaise);
  }

  // --------------------------------------------------------- redemptions

  /**
   * Asking to be paid in rupees takes the DMC out of reach immediately. It is
   * held rather than destroyed: admin has not paid yet, and a rejection has to
   * be able to give it back.
   */
  redemptionRequested(redemptionId: string, captainId: string, amountPaise: number): void {
    bump(this.captainDmc, captainId, -amountPaise);
    this.redemptionHeld.set(redemptionId, amountPaise);
  }

  /**
   * Admin sent the rupees, so the DMC that stood for them is destroyed. This
   * is the only place anything is ever un-minted, and it is the exact mirror of
   * the deposit that minted it.
   */
  redemptionPaid(redemptionId: string): void {
    const held = this.redemptionHeld.get(redemptionId) ?? 0;
    this.redemptionHeld.delete(redemptionId);
    this.minted -= held;
  }

  /** No rupees were sent, so every paise held goes back to the captain. */
  redemptionRejected(redemptionId: string, captainId: string): void {
    const held = this.redemptionHeld.get(redemptionId) ?? 0;
    this.redemptionHeld.delete(redemptionId);
    bump(this.captainDmc, captainId, held);
  }

  // -------------------------------------------------------- transactions

  /**
   * A pay-in reaches a captain. They will hand the customer's cash to nobody —
   * they *receive* it — so the DMC they owe in exchange leaves their balance
   * now and sits in flight until the party is given it.
   */
  payInAssigned(transactionId: string, captainId: string, amountPaise: number): void {
    bump(this.captainDmc, captainId, -amountPaise);
    this.transactionInFlight.set(transactionId, amountPaise);
  }

  /**
   * The party receives what the captain gave up, less the fee it is charged
   * for the service — which goes to the pool the captain is then paid from.
   *
   * The amount itself is never touched: the customer paid it in full and the
   * captain gave it up in full. The fee is charged on top of that movement,
   * which is why it is a separate figure here rather than a smaller transfer.
   */
  payInSettled(
    transactionId: string,
    partyId: string,
    partyCommissionPaise = 0,
    captainId?: string,
  ): void {
    const held = this.transactionInFlight.get(transactionId) ?? 0;
    this.transactionInFlight.delete(transactionId);
    bump(this.partyDmc, partyId, held - partyCommissionPaise);
    this.platformPool += partyCommissionPaise;
    void captainId;
  }

  /** Nobody paid. The captain gets their capital back, whole. */
  payInReleased(transactionId: string, captainId: string): void {
    const held = this.transactionInFlight.get(transactionId) ?? 0;
    this.transactionInFlight.delete(transactionId);
    bump(this.captainDmc, captainId, held);
  }

  /**
   * A payout is requested. The party's DMC is committed immediately, for the
   * same reason a task bills at creation: money promised to somebody else may
   * not also be spendable.
   */
  payOutCreated(transactionId: string, partyId: string, amountPaise: number): void {
    bump(this.partyDmc, partyId, -amountPaise);
    this.transactionInFlight.set(transactionId, amountPaise);
  }

  /** The captain sent real rupees and takes the party's DMC in exchange. */
  payOutSettled(transactionId: string, captainId: string): void {
    const held = this.transactionInFlight.get(transactionId) ?? 0;
    this.transactionInFlight.delete(transactionId);
    bump(this.captainDmc, captainId, held);
  }

  /** Nothing was sent, so the party gets every paise back. */
  payOutReleased(transactionId: string, partyId: string): void {
    const held = this.transactionInFlight.get(transactionId) ?? 0;
    this.transactionInFlight.delete(transactionId);
    bump(this.partyDmc, partyId, held);
  }

  // ------------------------------------------------------------ withdrawals

    /** The same handshake, drawn from the pool, which is the platform's balance. */
  platformWithdrawalSettled(partyId: string, amountPaise: number): void {
    this.platformPool -= amountPaise;
    bump(this.partyDmc, partyId, amountPaise);
  }

  /** A withdrawal sent back for another attempt must move nothing. */
  withdrawalRetried(): void {
    /* nothing moves */
  }

  // ---------------------------------------------------------------- reading

  termsFor(taskId: string): TaskTerms {
    const t = this.terms.get(taskId);
    if (!t) throw new Error(`No recorded terms for task ${taskId}`);
    return t;
  }

  hasTerms(taskId: string): boolean {
    return this.terms.has(taskId);
  }

  totalInFlight(): number {
    let sum = 0;
    for (const v of this.inFlight.values()) sum += v;
    return sum;
  }

  totalPartyDmc(): number {
    let sum = 0;
    for (const v of this.partyDmc.values()) sum += v;
    return sum;
  }

  totalCaptainDmc(): number {
    let sum = 0;
    for (const v of this.captainDmc.values()) sum += v;
    return sum;
  }

  totalRedemptionHeld(): number {
    let sum = 0;
    for (const v of this.redemptionHeld.values()) sum += v;
    return sum;
  }

  totalTransactionInFlight(): number {
    let sum = 0;
    for (const v of this.transactionInFlight.values()) sum += v;
    return sum;
  }

  totalCaptainHold(): number {
    let sum = 0;
    for (const v of this.captainHold.values()) sum += v;
    return sum;
  }

  /**
   * The closed loop. Everything minted must be sitting in exactly one of the
   * places money can be, and nowhere else.
   */
  closedLoopResidual(): number {
    return this.minted - (
      this.totalPartyDmc() +
      this.totalCaptainDmc() +
      this.totalRedemptionHeld() +
      this.totalTransactionInFlight() +
      this.totalCaptainHold() +
      this.platformPool +
      this.totalInFlight()
    );
  }

  snapshot(): Snapshot {
    return {
      partyDmc: new Map(this.partyDmc),
      captainCollateral: new Map(this.captainCollateral),
      captainDmc: new Map(this.captainDmc),
      captainLocked: new Map(this.captainLocked),
      platformPool: this.platformPool,
      redemptionHeld: new Map(this.redemptionHeld),
      transactionInFlight: new Map(this.transactionInFlight),
      captainHold: new Map(this.captainHold),
      inFlight: new Map(this.inFlight),
      minted: this.minted,
    };
  }
}
