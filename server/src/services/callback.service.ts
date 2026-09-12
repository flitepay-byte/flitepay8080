/**
 * Telling a party what happened, on their own server.
 *
 * A party's checkout cannot sit and wait: the customer scans a QR and pays
 * minutes later, or a captain makes a transfer by hand. So the outcome is
 * pushed to them when it happens, and the push has to be something they can
 * trust — anyone can POST "payment successful" at a public endpoint.
 *
 * So a callback is signed exactly the way an inbound request is, with the same
 * secret and the same payload shape. The party verifies it with the code they
 * already wrote to sign their own calls, which means the security of the thing
 * does not depend on them implementing a second, different scheme correctly.
 *
 * Delivery is best-effort and never blocks the money. A settlement that has
 * already happened is not undone because a party's endpoint was down; the
 * attempt count and last error are recorded on the transaction so the failure
 * is visible, and the party can always ask us for the current state instead.
 */
import { Transaction, Task, type ITransaction, type ITask } from '../models';
import { computeSignature, signingPayload, secretForSigning } from './apiKey.service';
import { logger } from '../config/logger';
import {
  API_KEY_HEADER,
  API_TIMESTAMP_HEADER,
  API_SIGNATURE_HEADER,
} from '../middleware/apiAuth.middleware';

/** Give up on a slow endpoint rather than holding a request open. */
const TIMEOUT_MS = 5_000;

/**
 * The statuses whose callback is a party's last word on a payout.
 *
 * Named once because two things must agree about it: the sweep queries on it,
 * and the delivery record is only written when the send is one of these. When
 * they disagreed, a mid-flight callback closed the book and the ending was
 * never sent.
 */
const TERMINAL_PAYOUT_STATUSES = ['COMPLETED', 'CANCELLED', 'EXPIRED'] as const;

export interface CallbackPayload {
  event: string;
  transactionCode: string;
  reference: string;
  direction: string;
  status: string;
  amount: number;
  settlementReference: string | null;
  occurredAt: string;
}

/**
 * Sign and POST one callback, and report whether it landed.
 *
 * Shared by both directions on purpose. Two copies of this would drift, and a
 * callback whose signing or timeout differed by direction is one a party would
 * have to special-case — which defeats the point of them verifying it with the
 * same code they already wrote to sign their own calls.
 *
 * Never throws: every caller is on a money path that has already succeeded,
 * and a failed notification must not become a failed payment.
 */
async function send(
  url: string,
  payload: CallbackPayload,
  keyId: string,
  record: (delivered: boolean, error: string | null) => Promise<void>,
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));

  const secret = await secretForSigning(keyId);
  if (!secret) {
    // Unsigned is not a fallback. A party has no way to tell an unsigned
    // callback from a forged one, so not sending it is the safer failure.
    await record(false, 'Could not sign the callback');
    return false;
  }
  // The path signed is the party's own callback path, so a signature captured
  // from one endpoint cannot be replayed at another.
  const signature = computeSignature(
    secret,
    signingPayload(timestamp, 'POST', new URL(url).pathname, body),
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [API_KEY_HEADER]: keyId,
        [API_TIMESTAMP_HEADER]: timestamp,
        [API_SIGNATURE_HEADER]: signature,
      },
      body,
      signal: controller.signal,
    });

    const ok = response.ok;
    await record(ok, ok ? null : `Endpoint returned ${response.status}`);
    return ok;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ code: payload.transactionCode, err: detail }, 'Callback delivery failed');
    await record(false, detail.slice(0, 500));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Tell a party the outcome of a pay-in. */
export async function deliverCallback(
  transaction: ITransaction,
  event: string,
  keyId: string,
): Promise<boolean> {
  const url = transaction.callbackUrl;
  if (!url) return false;

  return send(
    url,
    {
      event,
      transactionCode: transaction.transactionCode,
      reference: transaction.partyReference,
      direction: transaction.direction,
      status: transaction.status,
      amount: transaction.amountPaise / 100,
      settlementReference: transaction.settlementReference ?? null,
      occurredAt: new Date().toISOString(),
    },
    keyId,
    async (delivered, error) => {
      await Transaction.updateOne(
        { _id: transaction._id },
        {
          $inc: { callbackAttempts: 1 },
          $set: { callbackDeliveredAt: delivered ? new Date() : null, callbackLastError: error },
        },
      ).catch(() => undefined);
    },
  );
}

/**
 * Everything still owed a callback: delivered never, and tried few enough
 * times that trying again is still reasonable.
 *
 * Read as a query rather than kept as a queue, so a restart loses nothing —
 * the transactions themselves are the record of what has not been told.
 */
export async function pendingCallbacks(maxAttempts = 5, limit = 50): Promise<ITransaction[]> {
  return Transaction.find({
    callbackUrl: { $ne: null },
    callbackDeliveredAt: null,
    callbackAttempts: { $lt: maxAttempts },
    status: { $in: ['SETTLED', 'EXPIRED', 'CANCELLED'] },
  })
    .sort({ updatedAt: 1 })
    .limit(limit);
}

/**
 * The same callback, for a payout carried by a task.
 *
 * Shaped identically to the transaction one: a party integrated once and
 * should not have to parse two different payloads because of a distinction
 * that exists only on our side of the wire.
 */
export async function deliverPayoutCallback(task: ITask, event: string, keyId: string): Promise<boolean> {
  const url = task.callbackUrl;
  if (!url) return false;

  const payload: CallbackPayload = {
    event,
    transactionCode: task.taskCode,
    reference: task.externalRef,
    direction: 'PAY_OUT',
    status: task.status === 'COMPLETED' ? 'SETTLED' : task.status,
    amount: task.amountPaise / 100,
    settlementReference: task.providerReference ?? null,
    occurredAt: new Date().toISOString(),
  };

  /**
   * Is this the callback that ends the story?
   *
   * Only that one may write the delivery record. A mid-lifecycle event —
   * `payout.confirmation_required`, sent when proof arrives so the party can go
   * and ask their customer — is a nudge, not an outcome. It is fire-and-forget
   * by design, since the sweep only ever sends terminal events and so never
   * retried a failed nudge anyway; but letting it stamp `callbackDeliveredAt`
   * told the sweep this party had already been given the ending when they had
   * not, and the real ending was then never sent at all.
   */
  const isTerminal = (TERMINAL_PAYOUT_STATUSES as readonly string[]).includes(task.status);

  return send(url, payload, keyId, async (delivered, error) => {
    void error;
    if (!isTerminal) return;
    await Task.updateOne(
      { _id: task._id },
      {
        $inc: { callbackAttempts: 1 },
        $set: { callbackDeliveredAt: delivered ? new Date() : null },
      },
    ).catch(() => undefined);
  });
}

/** Payouts still owed a callback, on the same terms as pay-ins. */
export async function pendingPayoutCallbacks(maxAttempts = 5, limit = 50): Promise<ITask[]> {
  return Task.find({
    origin: 'API',
    callbackUrl: { $ne: null },
    callbackDeliveredAt: null,
    callbackAttempts: { $lt: maxAttempts },
    status: { $in: [...TERMINAL_PAYOUT_STATUSES] },
  })
    .sort({ updatedAt: 1 })
    .limit(limit);
}
