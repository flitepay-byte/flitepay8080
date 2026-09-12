/**
 * A stand-in for the UPI gateway, so the rest of the system can be built and
 * tested end to end before a real provider is wired in.
 *
 * This is deliberately a *simulation* and says so everywhere it can: the QR
 * payload is a real UPI deep link in shape but points at a captain handle that
 * settles nothing, and no money moves anywhere outside this codebase. Nothing
 * here should ever be mistaken for a payment rail.
 *
 * What matters is that the seam is honest. A real gateway does exactly three
 * things for us — mint an order id, hand back something the customer can scan,
 * and call us back when they pay — so those are the three things this exposes,
 * with the same shapes and the same failure modes. Replacing it later is a
 * matter of swapping this file, not of rewriting the transaction engine.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { Captain, type ITransaction } from '../models';
import { env } from '../config/env';
import { paiseToRupees } from '../utils/money';

export interface IssuedQr {
  gatewayOrderId: string;
  /** What the customer's UPI app would open. */
  payload: string;
}

/**
 * Mint an order and a QR for a pay-in.
 *
 * The captain's own UPI handle is what the customer would really pay, because
 * that is the whole mechanic: the customer's money goes to the captain, and
 * the captain gives up DMC in exchange. Using a platform handle here would
 * quietly turn the model into one where we hold the money.
 */
export async function issueQrForTransaction(transaction: ITransaction): Promise<IssuedQr> {
  const gatewayOrderId = `SIMGW-${randomBytes(8).toString('hex').toUpperCase()}`;

  const captain = transaction.captainId
    ? await Captain.findById(transaction.captainId).select('captainCode displayName').lean()
    : null;

  // Shaped like a real UPI intent so a scanner behaves believably, but the
  // handle is unmistakably a simulation one — nobody can pay this by accident.
  const params = new URLSearchParams({
    pa: `${(captain?.captainCode ?? 'CAPTAIN').toLowerCase()}@otdms-simulation`,
    pn: captain?.displayName ?? 'OTDMS Captain',
    am: paiseToRupees(transaction.amountPaise).toFixed(2),
    cu: 'INR',
    tn: `Simulated payment ${transaction.transactionCode}`,
    tr: gatewayOrderId,
  });

  return { gatewayOrderId, payload: `upi://pay?${params.toString()}` };
}

/**
 * The signature a real gateway would put on its webhook, reproduced so the
 * verification path is exercised rather than stubbed out.
 *
 * If the webhook were trusted unsigned, the endpoint would be a public "credit
 * this party" button — which is exactly the bug this simulation exists to stop
 * us from shipping when the real gateway arrives.
 */
export function gatewayWebhookSignature(body: string): string {
  return createHmac('sha256', gatewaySecret()).update(body).digest('hex');
}

export function verifyGatewayWebhook(body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = gatewayWebhookSignature(body);
  if (expected.length !== signature.length) return false;
  // Constant-time comparison, same reason as everywhere else: a wrong
  // signature must not be guessable a byte at a time.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * The simulated provider's own secret. Derived from the deployment's key so it
 * is stable across restarts without being another thing to configure — when a
 * real gateway replaces this, its secret comes from that provider instead.
 */
function gatewaySecret(): string {
  return createHmac('sha256', env.API_SECRET_ENCRYPTION_KEY).update('upi-gateway-simulation').digest('hex');
}
