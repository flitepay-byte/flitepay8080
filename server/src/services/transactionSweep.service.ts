/**
 * The three things that would otherwise leave a transaction stuck forever.
 *
 * Everything the transaction engine does is triggered by somebody: a party
 * calls, a gateway calls back, a captain confirms. That leaves three gaps
 * where nobody is going to call, and money sits in them.
 *
 *   A payout with no captain free. The party's DMC is already held, so this is
 *   not merely a delay — their money is out of reach until somebody picks it
 *   up, and nobody will ask again on their own.
 *
 *   A window that has closed. A customer who never paid, or a captain who
 *   never sent the transfer, leaves a hold that has to come back.
 *
 *   A callback nobody received. The party's endpoint was down when we called,
 *   and their order is stuck at "awaiting payment" for a payment that settled.
 *
 * All three are read as queries over the transactions themselves rather than
 * kept as in-memory queues, so a restart loses nothing: the rows *are* the
 * record of what still needs doing.
 */
import type { Types } from 'mongoose';
import { Transaction, ApiKey } from '../models';
import { assignCaptain, expire } from './transaction.service';
import { deliverCallback, deliverPayoutCallback, pendingPayoutCallbacks } from './callback.service';
import { logger } from '../config/logger';

export interface SweepResult {
  routed: number;
  expired: number;
  callbacksDelivered: number;
}

/** How many attempts before a party's endpoint is treated as not coming back. */
const MAX_CALLBACK_ATTEMPTS = 5;

/**
 * Try again to place transactions nobody could take.
 *
 * Pay-ins are deliberately left out: a pay-in that found no captain was
 * refused outright at the API, because a customer is standing at a checkout
 * and there is nothing to show them. Only payouts wait, and only payouts are
 * retried here.
 */
export async function routeWaitingPayouts(limit = 50): Promise<number> {
  const waiting = await Transaction.find({
    direction: 'PAY_OUT',
    status: 'CREATED',
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select('_id');

  let routed = 0;
  for (const transaction of waiting) {
    try {
      const result = await assignCaptain(transaction._id);
      if (result.captainId) routed += 1;
    } catch (err) {
      // One bad transaction must not stop the rest of the queue.
      logger.error({ err, transactionId: String(transaction._id) }, 'Could not route a waiting payout');
    }
  }
  return routed;
}

/**
 * Release the holds on transactions whose window has closed.
 *
 * DISPUTED is excluded on purpose. A dispute has no deadline: it is waiting on
 * an admin decision, and expiring it on a timer would quietly decide it in the
 * party's favour without anybody having looked.
 */
export async function expireOverdueTransactions(limit = 100): Promise<number> {
  const overdue = await Transaction.find({
    status: { $in: ['CREATED', 'ASSIGNED', 'AWAITING_CUSTOMER'] },
    expiresAt: { $lte: new Date() },
  })
    .sort({ expiresAt: 1 })
    .limit(limit)
    .select('_id');

  let expired = 0;
  for (const transaction of overdue) {
    try {
      await expire(transaction._id, 'The payment window closed before it completed');
      expired += 1;
    } catch (err) {
      // A losing race here is normal: the gateway may have confirmed it in the
      // moment between the query and the claim, and that confirmation wins.
      logger.debug({ err, transactionId: String(transaction._id) }, 'Transaction was resolved before it expired');
    }
  }
  return expired;
}

/**
 * Try undelivered callbacks again.
 *
 * Only for transactions that have actually finished — a callback for something
 * still in flight would be telling the party about a state that is about to
 * change, which is worse than telling them nothing.
 */
/**
 * Which key a retried callback should be signed and addressed with.
 *
 * The one that created the row, always — a party running a staging key and a
 * live key has two different callback endpoints, and picking whichever key came
 * back first would deliver a production retry to staging. The original delivery
 * always used the right key; only the retry was guessing.
 *
 * A revoked key is still used. The party made the call with it and is expecting
 * the answer to it; refusing to finish the conversation because the credential
 * has since been rotated would strand a settled payment with nobody told. What
 * is refused is a key that no longer exists at all.
 *
 * The fallback covers rows written before the key was recorded, and only those.
 */
// Exported so the decision can be tested directly. Observing it through a
// delivery attempt is not possible: the key only shows up in a header on an
// outbound request to a host that does not exist during a test.
export async function callbackKeyFor(
  createdByKeyId: string | null | undefined,
  partyId: Types.ObjectId,
): Promise<string | null> {
  if (createdByKeyId) {
    const own = await ApiKey.findOne({ keyId: createdByKeyId }).select('keyId').lean();
    if (own) return own.keyId;
  }
  const fallback = await ApiKey.findOne({ partyId, status: 'ACTIVE' }).select('keyId').lean();
  return fallback?.keyId ?? null;
}

export async function retryPendingCallbacks(limit = 50): Promise<number> {
  const pending = await Transaction.find({
    callbackUrl: { $ne: null },
    callbackDeliveredAt: null,
    callbackAttempts: { $lt: MAX_CALLBACK_ATTEMPTS },
    status: { $in: ['SETTLED', 'EXPIRED', 'CANCELLED'] },
  })
    .sort({ updatedAt: 1 })
    .limit(limit);

  let delivered = 0;
  for (const transaction of pending) {
    const keyId = await callbackKeyFor(transaction.createdByKeyId, transaction.partyId);
    if (!keyId) continue;

    const ok = await deliverCallback(transaction, `transaction.${transaction.status.toLowerCase()}`, keyId);
    if (ok) delivered += 1;
  }

  // Payouts are carried by tasks rather than transactions (see the payout API
  // for why), so they are a second query — but the same obligation. A party
  // whose refund settled and who was never told is stuck in exactly the same
  // way whichever collection the row happened to live in.
  for (const task of await pendingPayoutCallbacks(MAX_CALLBACK_ATTEMPTS, limit)) {
    const keyId = await callbackKeyFor(task.createdByKeyId, task.partyId);
    if (!keyId) continue;

    const ok = await deliverPayoutCallback(task, `transaction.${task.status.toLowerCase()}`, keyId);
    if (ok) delivered += 1;
  }

  return delivered;
}

/** One pass of all three. */
export async function sweepTransactions(): Promise<SweepResult> {
  // Expiry first, but only because releasing a hold promptly is the more
  // urgent of the two — it does not free capacity for the routing pass below.
  // A payout needs no working capital from its captain, so a captain holding a
  // dead pay-in was never the reason a payout went unplaced.
  const expired = await expireOverdueTransactions();
  const routed = await routeWaitingPayouts();
  const callbacksDelivered = await retryPendingCallbacks();
  return { routed, expired, callbacksDelivered };
}
