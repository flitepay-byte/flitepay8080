/**
 * THE TRANSACTION ENGINE — a party's customer paying, or being paid.
 *
 * See types/transaction.ts for what the two directions mean. This file is the
 * money: what is held, when, and what has to be true before it moves.
 *
 * ---------------------------------------------------------------------------
 * THE ORDERING RULE
 * ---------------------------------------------------------------------------
 *
 * Every operation here claims the state change first — a compare-and-swap
 * whose filter *is* the precondition — and only then moves money. This is the
 * same rule the task flow arrived at the hard way: a commission row written
 * before the claim once left an orphan that made the ledger name the wrong
 * captain while the right one was paid. With the claim first, a losing
 * concurrent request performs exactly zero DMC movement, because it never gets
 * past the swap.
 *
 * ---------------------------------------------------------------------------
 * NO FEE COMES OUT OF THE AMOUNT
 * ---------------------------------------------------------------------------
 *
 * ₹100 paid in becomes exactly 100 DMC for the party. ₹100 paid out sends
 * exactly ₹100 to the customer. The captain's commission is paid by the
 * platform out of its funded pool at settlement — never skimmed. That is why
 * `commissionPaise` never appears in any balance arithmetic below: it is not
 * part of the amount, it is a separate payment from a separate account.
 */
import mongoose, { Types } from 'mongoose';
import {
  Transaction,
  Party,
  Captain,
  nextSequence,
  type ITransaction,
  type ICaptain,
} from '../models';
import { AppError } from '../utils/AppError';
import { isDuplicateKey } from '../utils/mongoErrors';
import { ErrorCodes } from '../utils/errorCodes';
import { recordAudit } from './audit.service';
import { getConfig } from './systemConfig.service';
import { commissionFor, captainRateFor, repriceCaptainShare } from './commission.service';
import { currentLimitPaise, withinCurrentLimit } from './captainCapacity.service';
import { payCommissionToCaptain } from './captainBalance.service';
import { collectIntoPool } from './platformAccount.service';
import { scoreCaptain, getWorkloads } from './taskRouting.service';
import { assertTransactionTransition } from './transactionStateMachine';
import { supportsTransactions } from '../config/db';
import type { TransactionDirection, TransactionState } from '../types/transaction';
import type { Role } from '../types';

export interface ActorContext {
  userId: string;
  role: Role;
  ip?: string;
}

export interface CreateTransactionInput {
  partyReference: string;
  amountPaise: number;
  callbackUrl?: string;
  /** The API key this came in on, so a retried callback returns to it. */
  createdByKeyId?: string | null;
}

/** How long a customer has to pay, or a captain has to make the transfer. */
const DEFAULT_WINDOW_MINUTES = 15;

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/**
 * Move a transaction from one state to another, atomically, with the current
 * state as the precondition.
 *
 * Returns null when somebody else got there first. Every caller treats that as
 * "do nothing at all" rather than as an error to recover from, because the
 * work has already been done by whoever won.
 */
async function claim(
  transactionId: Types.ObjectId | string,
  from: TransactionState,
  to: TransactionState,
  extra: Record<string, unknown> = {},
  actorUserId?: string,
  reason?: string,
  session?: mongoose.ClientSession,
): Promise<ITransaction | null> {
  assertTransactionTransition(from, to);
  return Transaction.findOneAndUpdate(
    { _id: transactionId, status: from },
    {
      $set: { status: to, ...extra },
      $push: {
        stateHistory: {
          from,
          to,
          at: new Date(),
          by: actorUserId ? new Types.ObjectId(actorUserId) : null,
          reason: reason ?? null,
        },
      },
    },
    session ? { new: true, session } : { new: true },
  );
}

/**
 * ---------------------------------------------------------------------------
 * ATOMICITY, AND WHAT IT ADDS TO THE CLAIM
 * ---------------------------------------------------------------------------
 *
 * The claim-then-move ordering below is correct on its own: a losing
 * concurrent request never gets past the swap, so it moves nothing. What the
 * claim cannot do is survive the process dying *between* the swap and the
 * money — the transaction would read as settled with nobody credited.
 *
 * Where the deployment can give us a real transaction (a replica set, which
 * the Compose file configures), both halves commit together or neither does,
 * and that window closes. Where it cannot — a bare single node, which is what
 * a laptop usually has — the code takes the same path it always did, because
 * a correct-but-interruptible flow is much better than refusing to run.
 *
 * So this helper is deliberately not a wrapper that *requires* transactions.
 * It runs the body either way and only adds the guarantee when it is there.
 */
async function atomically<T>(body: (session?: mongoose.ClientSession) => Promise<T>): Promise<T> {
  if (!(await supportsTransactions())) return body(undefined);

  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    // withTransaction retries the body on transient errors, so the body must
    // be safe to run more than once — every one below is, because a retried
    // attempt re-reads the state it claims against.
    await session.withTransaction(async () => {
      result = await body(session);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}

async function loadOrThrow(transactionId: Types.ObjectId | string): Promise<ITransaction> {
  const found = await Transaction.findById(transactionId);
  if (!found) throw AppError.notFound('Transaction not found', ErrorCodes.TRANSACTION_NOT_FOUND);
  return found;
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

async function nextCode(direction: TransactionDirection): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = direction === 'PAY_IN' ? 'PIN' : 'POUT';
  const seq = await nextSequence(`transaction:${prefix}:${year}`);
  return `${prefix}-${year}-${String(seq).padStart(6, '0')}`;
}

function assertAmount(amountPaise: number): void {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Amount must be a whole number of paise greater than zero');
  }
}

/**
 * The same reference twice is the same payment, not a second one.
 *
 * A party retrying a timed-out call, a double-clicked checkout, a webhook
 * replayed by their own infrastructure — all of these arrive as an identical
 * request, and all of them must resolve to the row that already exists. The
 * unique index on (partyId, partyReference) is what actually enforces it; this
 * turns the resulting duplicate-key error into the existing row.
 */
async function existingFor(partyId: Types.ObjectId, partyReference: string): Promise<ITransaction | null> {
  return Transaction.findOne({ partyId, partyReference });
}


/**
 * A party's customer is about to pay money in.
 *
 * Nothing moves yet: the captain who will receive the cash has not been chosen,
 * and it is their DMC — not the party's — that gets held when they are.
 */
export async function createPayIn(
  partyId: Types.ObjectId,
  input: CreateTransactionInput,
  actor: ActorContext,
): Promise<{ transaction: ITransaction; created: boolean }> {
  return createTransaction('PAY_IN', partyId, input, actor);
}

async function createTransaction(
  direction: TransactionDirection,
  partyId: Types.ObjectId,
  input: CreateTransactionInput,
  actor: ActorContext,
): Promise<{ transaction: ITransaction; created: boolean }> {
  assertAmount(input.amountPaise);
  const reference = input.partyReference?.trim();
  if (!reference) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'A reference of your own is required');
  }

  const already = await existingFor(partyId, reference);
  if (already) return { transaction: already, created: false };

  const [config, party] = await Promise.all([
    getConfig(),
    Party.findById(partyId).select('payInPartyCommissionPercentage payOutPartyCommissionPercentage').lean(),
  ]);
  const commission = commissionFor(direction, input.amountPaise, config, {
    // What this party is charged. Fixed from here — the pool is funded with
    // exactly this at settlement, and the party is credited the amount less
    // exactly this.
    party,
    // Nobody has been assigned yet, so the default stands in and the captain
    // who is assigned is re-priced at their own rate in assignCaptain below.
    captain: null,
  });

  const now = new Date();
  let transaction: ITransaction;
  try {
    transaction = await Transaction.create({
      transactionCode: await nextCode(direction),
      direction,
      partyId,
      partyReference: reference,
      amountPaise: input.amountPaise,
      partyCommissionPaise: commission.partyPaise,
      commissionPaise: commission.captainPaise,
      partyCommissionRate: commission.partyRate,
      commissionRate: commission.captainRate,
      commissionRateAgreed: commission.captainRateAgreed,
      commissionConfigVersion: commission.configVersion,
      status: 'CREATED',
      stateHistory: [{ from: null, to: 'CREATED', at: now }],
      expiresAt: new Date(now.getTime() + DEFAULT_WINDOW_MINUTES * 60_000),
      callbackUrl: input.callbackUrl ?? null,
      createdByKeyId: input.createdByKeyId ?? null,
    });
  } catch (err) {
    // Two identical calls raced. The index decided which one is real; the
    // loser returns the winner's row, which is exactly what idempotency means.
    if (isDuplicateKey(err)) {
      const winner = await existingFor(partyId, reference);
      if (winner) return { transaction: winner, created: false };
    }
    throw err;
  }

  // Nothing moves here. The captain who will hand over DMC has not been chosen
  // yet, and it is their capital — not the party's — that gets held when they
  // are. The party is charged its commission at settlement, out of the amount
  // it receives.
  await recordAudit({
    action: 'PAYIN_CREATED',
    targetCollection: 'Transaction',
    targetId: transaction._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: {
      status: 'CREATED',
      amountPaise: input.amountPaise,
      partyCommissionPaise: commission.partyPaise,
      captainCommissionPaise: commission.captainPaise,
    },
    metadata: { partyReference: reference, transactionCode: transaction.transactionCode },
  });

  return { transaction, created: true };
}

// ---------------------------------------------------------------------------
// Finding a captain
// ---------------------------------------------------------------------------

export interface AssignmentResult {
  transaction: ITransaction;
  captainId: Types.ObjectId | null;
  /** True when no captain could take it now but one might later. */
  waiting: boolean;
  /** True when nobody could ever take it — admin's problem, not a retry. */
  stalled: boolean;
}

/**
 * A pay-in needs a captain who can actually cover it, because they hand over
 * DMC in exchange for the customer's cash. A pay-out does not: the captain
 * sends real money and *receives* DMC, so any active captain will do.
 */
async function eligibleCaptains(transaction: ITransaction): Promise<{ eligible: ICaptain[]; placeable: number }> {
  const excluded = transaction.previousCaptainIds ?? [];
  const online = await Captain.find({ status: 'ACTIVE', isOnline: true, _id: { $nin: excluded } });
  const placeable = await Captain.countDocuments({ status: 'ACTIVE', _id: { $nin: excluded } });

  // Current Limit: the ceiling their security buys, and their own capital,
  // whichever binds — see captainCapacity.service.ts.
  //
  // Only a filter for routing; the binding check is in the assignment itself,
  // where it is evaluated atomically at write time. It asks the same question
  // all the same, because offering somebody work the next step will refuse
  // wastes their turn and leaves the payment looking unroutable.
  return {
    eligible: online.filter((c) => transaction.amountPaise <= currentLimitPaise(c)),
    placeable,
  };
}

/**
 * Pick the best available captain and give them the transaction.
 *
 * The state claim comes first and carries the captain's id, so two routing
 * passes running at once cannot both assign it. The pay-in hold follows, and
 * if it fails the transaction goes back to CREATED with that captain marked as
 * tried — which is a legal move, not a rollback hack.
 */
export async function assignCaptain(transactionId: Types.ObjectId | string): Promise<AssignmentResult> {
  const transaction = await loadOrThrow(transactionId);
  if (transaction.status !== 'CREATED') {
    return { transaction, captainId: transaction.captainId ?? null, waiting: false, stalled: false };
  }

  const { eligible, placeable } = await eligibleCaptains(transaction);
  if (eligible.length === 0) {
    // Nobody now, versus nobody ever. The first is a wait; the second needs a
    // human, and telling them apart is the whole reason placeable is counted.
    return { transaction, captainId: null, waiting: placeable > 0, stalled: placeable === 0 };
  }

  const workloads = await getWorkloads(eligible.map((c) => c._id));
  const best = eligible
    .map((captain) => ({
      captain,
      score: scoreCaptain(
        captain,
        transaction.amountPaise,
        workloads.get(String(captain._id)) ?? { pending: 0, inProgress: 0, awaitingAudit: 0 },
      ),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.captain.lastOfferedAt?.getTime() ?? 0) - (b.captain.lastOfferedAt?.getTime() ?? 0);
    })[0];
  if (!best) return { transaction, captainId: null, waiting: placeable > 0, stalled: placeable === 0 };

  // The claim and the hold commit together where transactions are available,
  // so a crash between them cannot leave a captain assigned work their capital
  // was never committed to. Where they are not, the compensating path below
  // does the same job a moment later.
  /**
   * Price the chosen captain's half of a charge the party has already been
   * quoted. The pool is `partyCommissionPaise` and does not move: it is what
   * funds the pool at settlement and what the party's credit is netted
   * against. Only its division moves, at this captain's own rate.
   */
  const config = await getConfig();
  const priced = repriceCaptainShare(
    transaction.partyCommissionPaise,
    transaction.amountPaise,
    // Their own rate first; failing that, the default this payment was priced
    // under when it was created, not the one in force now. The agreed rate
    // rather than the paid one, so an earlier cap is never mistaken for the
    // agreement itself.
    captainRateFor(transaction.direction, config, best.captain, transaction.commissionRateAgreed),
    transaction.partyCommissionRate,
  );

  const assignment = await atomically(async (session) => {
    const won = await claim(
      transaction._id,
      'CREATED',
      'ASSIGNED',
      {
        captainId: best.captain._id,
        // Written with the assignment rather than after it, so the row is
        // never briefly owned by one captain and priced for another.
        commissionPaise: priced.captainPaise,
        commissionRate: priced.captainRate,
        commissionRateAgreed: priced.captainRateAgreed,
      },
      undefined,
      undefined,
      session,
    );
    if (!won) return { claimed: null, held: true };

    // The DMC leaves their balance, and the amount must be within their
    // Current Limit — one rule, evaluated by the server against the stored
    // document, so a concurrent assignment cannot slip past it.
    //
    // It used to ask only whether they held the DMC and whether the amount was
    // under the ceiling, neither of which subtracts commission they have
    // already earned. See captainCapacity.service.ts.
    const held = await Captain.findOneAndUpdate(
      {
        _id: best.captain._id,
        status: 'ACTIVE',
        ...withinCurrentLimit(transaction.amountPaise),
      },
      { $inc: { dmcBalancePaise: -transaction.amountPaise } },
      session ? { session } : {},
    );
    return { claimed: won, held: held != null };
  });

  // Inside nothing in particular on purpose — this is routing bookkeeping, not
  // money, and it is recorded only once the assignment has actually stuck.
  if (assignment.claimed) {
    await Captain.updateOne({ _id: best.captain._id }, { $set: { lastOfferedAt: new Date() } });
  }

  const claimed = assignment.claimed;
  if (!claimed) {
    // Somebody else assigned it in the moment we spent choosing.
    const current = await loadOrThrow(transaction._id);
    return { transaction: current, captainId: current.captainId ?? null, waiting: false, stalled: false };
  }

  {
    if (!assignment.held) {
      // Their capital went elsewhere between the ranking and the hold. Put the
      // transaction back and do not offer it to them again.
      const released = await Transaction.findOneAndUpdate(
        { _id: transaction._id, status: 'ASSIGNED' },
        {
          $set: { status: 'CREATED', captainId: null },
          $addToSet: { previousCaptainIds: best.captain._id },
          $push: {
            stateHistory: {
              from: 'ASSIGNED',
              to: 'CREATED',
              at: new Date(),
              reason: 'Captain could no longer cover the amount',
            },
          },
        },
        { new: true },
      );
      return {
        transaction: released ?? claimed,
        captainId: null,
        waiting: placeable > 1,
        stalled: false,
      };
    }
  }

  return { transaction: claimed, captainId: best.captain._id, waiting: false, stalled: false };
}

// ---------------------------------------------------------------------------
// The customer's side
// ---------------------------------------------------------------------------

/**
 * The customer can now act: a QR exists for them to scan, or the captain has
 * the beneficiary details and is making the transfer.
 */
export async function openToCustomer(
  transactionId: Types.ObjectId | string,
  details: { gatewayOrderId?: string; gatewayQrPayload?: string } = {},
): Promise<ITransaction> {
  const claimed = await claim(transactionId, 'ASSIGNED', 'AWAITING_CUSTOMER', {
    gatewayOrderId: details.gatewayOrderId ?? null,
    gatewayQrPayload: details.gatewayQrPayload ?? null,
  });
  if (!claimed) {
    const current = await loadOrThrow(transactionId);
    // Already open is success, not a conflict — the gateway retries.
    if (current.status === 'AWAITING_CUSTOMER') return current;
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `This transaction is ${current.status} and cannot be opened to the customer`,
    );
  }
  return claimed;
}

/**
 * Somebody says the money moved: the gateway for a pay-in, the captain for a
 * pay-out. This is a claim, not the settlement — settlement is the next step
 * and moves the DMC.
 */
export async function confirmMovement(
  transactionId: Types.ObjectId | string,
  settlementReference: string,
  actor?: ActorContext,
): Promise<ITransaction> {
  const reference = settlementReference?.trim();
  if (!reference) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'A payment reference is required');
  }

  const claimed = await claim(
    transactionId,
    'AWAITING_CUSTOMER',
    'CONFIRMED',
    { settlementReference: reference, confirmedAt: new Date() },
    actor?.userId,
  );
  if (!claimed) {
    const current = await loadOrThrow(transactionId);
    // A gateway that sends the same webhook twice must not be an error: the
    // second delivery describes a state we are already in.
    if (current.status === 'CONFIRMED' || current.status === 'SETTLED') return current;
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `This transaction is ${current.status} and cannot be confirmed`,
    );
  }
  return claimed;
}

/**
 * A captain hands back a pay-in they cannot take.
 *
 * Without this the only way out is the fifteen-minute expiry, and until it
 * fires the captain's capital is committed to work they have already said they
 * cannot do — so they cannot take anything else either. That is the captain
 * being punished for being honest, and it makes them sit on a dead transaction
 * rather than release it.
 *
 * The transaction goes back to CREATED for somebody else, with this captain
 * recorded so routing does not immediately hand it back to them.
 */
export async function declineAsCaptain(
  transactionId: Types.ObjectId | string,
  captainId: Types.ObjectId,
  reason: string,
  actor?: ActorContext,
): Promise<ITransaction> {
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Say why, so routing can learn from it');
  }

  const before = await loadOrThrow(transactionId);
  if (String(before.captainId) !== String(captainId)) {
    throw AppError.notFound('Transaction not found', ErrorCodes.TRANSACTION_NOT_FOUND);
  }
  // Only before the customer has been given anything to act on. Once a QR is
  // live, somebody may already be paying it, and pulling the captain out from
  // under a payment in flight is how money ends up with nobody.
  if (before.status !== 'ASSIGNED') {
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      before.status === 'AWAITING_CUSTOMER'
        ? 'The customer already has this to pay — it can only be disputed or left to expire'
        : `This transaction is ${before.status} and cannot be handed back`,
    );
  }

  // Claim first, carrying the exclusion, so a losing caller moves no money —
  // and inside a transaction where one is available, so the hand-back and the
  // refund cannot come apart.
  const released = await atomically(async (session) => {
    const won = await Transaction.findOneAndUpdate(
      { _id: transactionId, status: 'ASSIGNED', captainId },
      {
        $set: { status: 'CREATED', captainId: null },
        $addToSet: { previousCaptainIds: captainId },
        $push: {
          stateHistory: {
            from: 'ASSIGNED',
            to: 'CREATED',
            at: new Date(),
            by: actor?.userId ? new Types.ObjectId(actor.userId) : null,
            reason: trimmed,
          },
        },
      },
      session ? { new: true, session } : { new: true },
    );
    if (!won) return null;

    // Only a pay-in held anything from the captain; a pay-out never did.
    if (won.direction === 'PAY_IN') {
      await Captain.updateOne(
        { _id: captainId },
        { $inc: { dmcBalancePaise: won.amountPaise } },
        session ? { session } : {},
      );
    }
    return won;
  });
  if (!released) {
    const current = await loadOrThrow(transactionId);
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `This transaction is ${current.status} and cannot be handed back`,
    );
  }

  return released;
}

// ---------------------------------------------------------------------------
// Settlement — the only place DMC actually changes hands
// ---------------------------------------------------------------------------

/**
 * Move the money.
 *
 * The claim comes first, so this can be called twice — by the webhook and by a
 * sweep, say — and settle once. Everything after the claim runs exactly once
 * for exactly one caller.
 *
 * What moves depends on the direction, and in both cases the held amount is
 * simply handed to the other side. Nothing is created and nothing is skimmed:
 * a pay-in gives the party what the captain gave up, a pay-out gives the
 * captain what the party gave up.
 */
export async function settle(
  transactionId: Types.ObjectId | string,
  actor?: ActorContext,
): Promise<ITransaction> {
  const before = await loadOrThrow(transactionId);
  const from = before.status === 'DISPUTED' ? 'DISPUTED' : 'CONFIRMED';

  const outcome = await atomically(async (session) => {
    const won = await claim(transactionId, from, 'SETTLED', { settledAt: new Date() }, actor?.userId, undefined, session);
    if (!won) return null;

    // The captain's DMC was taken at assignment and becomes the party's now,
    // less the commission the party is charged for the service. The customer
    // still paid exactly the amount and the captain still gave up exactly the
    // amount — the fee is the party's, charged on top of the movement rather
    // than skimmed out of it.
    await Party.updateOne(
      { _id: won.partyId },
      { $inc: { dmcBalancePaise: won.amountPaise - won.partyCommissionPaise } },
      session ? { session } : {},
    );
    // What the party was charged funds the pool the captain is paid from.
    if (won.partyCommissionPaise > 0) {
      await collectIntoPool(won.partyCommissionPaise, session);
    }


    // Commission last, and only at settlement: a fee paid before the work is
    // done is a fee that has to be clawed back when it is not. SETTLED is
    // terminal, so this payment can never need reversing.
    let paid = false;
    if (won.captainId && won.commissionPaise > 0) {
      paid = await payCommissionToCaptain(won.captainId, won.commissionPaise, session, won.transactionCode);
    } else if (won.commissionPaise === 0) {
      paid = true;
    }
    if (paid !== won.commissionPaid) {
      await Transaction.updateOne({ _id: won._id }, { $set: { commissionPaid: paid } }, session ? { session } : {});
      won.commissionPaid = paid;
    }
    return won;
  });

  if (!outcome) {
    const current = await loadOrThrow(transactionId);
    if (current.status === 'SETTLED') return current;
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `This transaction is ${current.status} and cannot be settled`,
    );
  }
  const claimed = outcome;
  const commissionPaid = claimed.commissionPaid;

  await recordAudit({
    action: 'TRANSACTION_SETTLED',
    targetCollection: 'Transaction',
    targetId: claimed._id,
    userId: actor?.userId,
    role: actor?.role ?? 'ADMIN',
    ip: actor?.ip,
    newState: {
      status: 'SETTLED',
      amountPaise: claimed.amountPaise,
      commissionPaise: claimed.commissionPaise,
      commissionPaid,
    },
    metadata: { transactionCode: claimed.transactionCode, direction: claimed.direction },
  });

  return claimed;
}

// ---------------------------------------------------------------------------
// The ways it can end without settling
// ---------------------------------------------------------------------------

/**
 * Give back whatever was held.
 *
 * Which side gets it back is decided by direction, and *whether* anything is
 * held is decided by the state it is leaving — a pay-in that never reached a
 * captain never held anything, and refunding it would create DMC.
 */
async function releaseHold(
  transaction: ITransaction,
  heldFrom: TransactionState,
  session?: mongoose.ClientSession,
): Promise<void> {
  const wasHeld = ['ASSIGNED', 'AWAITING_CUSTOMER', 'CONFIRMED', 'DISPUTED'].includes(heldFrom);
  if (!wasHeld || !transaction.captainId) return;

  await Captain.updateOne(
    { _id: transaction.captainId },
    { $inc: { dmcBalancePaise: transaction.amountPaise } },
    session ? { session } : {},
  );
}

/** Nobody paid in time. */
export async function expire(
  transactionId: Types.ObjectId | string,
  reason = 'Nobody completed the payment in time',
  actor?: ActorContext,
): Promise<ITransaction> {
  const before = await loadOrThrow(transactionId);
  // Already there. Returning it is the honest answer — a sweep running twice,
  // or both sides raising the same dispute, has not failed at anything. The
  // check has to be here rather than after the claim, because the state
  // machine rejects a move to the state you are already in.
  if (before.status === 'EXPIRED') return before;
  const from = before.status;

  const claimed = await atomically(async (session) => {
    const won = await claim(
      transactionId,
      from,
      'EXPIRED',
      { failureReason: reason },
      actor?.userId,
      reason,
      session,
    );
    if (!won) return null;
    // Inside the same transaction as the claim, so the hold can never be
    // released twice, nor left held against a transaction already closed.
    await releaseHold(won, from, session);
    return won;
  });

  if (!claimed) {
    const current = await loadOrThrow(transactionId);
    if (current.status === 'EXPIRED') return current;
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `This transaction is ${current.status} and cannot be expired`,
    );
  }
  return claimed;
}

/** The party changed its mind, before anybody's money moved. */
export async function cancel(
  transactionId: Types.ObjectId | string,
  reason: string,
  actor?: ActorContext,
): Promise<ITransaction> {
  const before = await loadOrThrow(transactionId);
  // Already there. Returning it is the honest answer — a sweep running twice,
  // or both sides raising the same dispute, has not failed at anything. The
  // check has to be here rather than after the claim, because the state
  // machine rejects a move to the state you are already in.
  if (before.status === 'CANCELLED') return before;
  const from = before.status;

  const claimed = await atomically(async (session) => {
    const won = await claim(
      transactionId,
      from,
      'CANCELLED',
      { failureReason: reason },
      actor?.userId,
      reason,
      session,
    );
    if (!won) return null;
    // Inside the same transaction as the claim, so the hold can never be
    // released twice, nor left held against a transaction already closed.
    await releaseHold(won, from, session);
    return won;
  });

  if (!claimed) {
    const current = await loadOrThrow(transactionId);
    if (current.status === 'CANCELLED') return current;
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `This transaction is ${current.status} and cannot be cancelled`,
    );
  }
  return claimed;
}

/**
 * The two sides disagree about whether the money arrived. Nothing moves and
 * nothing is released: the hold stays exactly where it is until admin decides,
 * because an argument about money is the worst possible moment to let either
 * side spend it.
 */
export async function dispute(
  transactionId: Types.ObjectId | string,
  reason: string,
  actor?: ActorContext,
): Promise<ITransaction> {
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'A reason is required to raise a dispute');
  }
  const before = await loadOrThrow(transactionId);
  // Already disputed. Both sides can raise one, and the second to arrive has
  // not failed at anything — it is the same dispute. The check has to be here
  // rather than after the claim, because the state machine rejects a move to
  // the state you are already in.
  if (before.status === 'DISPUTED') return before;

  const claimed = await claim(
    transactionId,
    before.status,
    'DISPUTED',
    { disputeReason: trimmed },
    actor?.userId,
    trimmed,
  );
  if (!claimed) {
    const current = await loadOrThrow(transactionId);
    if (current.status === 'DISPUTED') return current;
    throw AppError.conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `This transaction is ${current.status} and cannot be disputed`,
    );
  }
  return claimed;
}

/**
 * Admin's decision on a dispute. Exactly two answers, because there are only
 * two things that can be true: the money moved, or it did not.
 */
export async function resolveDispute(
  transactionId: Types.ObjectId | string,
  decision: 'SETTLE' | 'RELEASE',
  reason: string,
  actor: ActorContext,
): Promise<ITransaction> {
  const before = await loadOrThrow(transactionId);
  if (before.status !== 'DISPUTED') {
    throw AppError.conflict(ErrorCodes.INVALID_STATE_TRANSITION, 'This transaction is not disputed');
  }
  if (decision === 'SETTLE') return settle(transactionId, actor);
  return expire(transactionId, reason, actor);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function findByReference(
  partyId: Types.ObjectId,
  partyReference: string,
): Promise<ITransaction | null> {
  return Transaction.findOne({ partyId, partyReference });
}

/** Everything a captain is currently carrying. */
export async function listForCaptain(
  captainId: Types.ObjectId,
  statuses?: TransactionState[],
): Promise<ITransaction[]> {
  const filter: mongoose.FilterQuery<ITransaction> = { captainId };
  if (statuses?.length) filter.status = { $in: statuses };
  return Transaction.find(filter).sort({ createdAt: -1 });
}
