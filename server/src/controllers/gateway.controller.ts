/**
 * The webhook the (simulated) UPI gateway calls when a customer pays.
 *
 * This endpoint is public by necessity — a provider cannot log in — which
 * makes it the most dangerous surface in the system: an unauthenticated POST
 * that moves money. Two things stand between it and abuse.
 *
 * The signature proves the call came from the provider. Without it this would
 * be a public "credit this party" button, and no amount of care elsewhere
 * would matter.
 *
 * The state machine proves the call is legal. A webhook for a transaction that
 * is already settled, or that expired, or that was never opened to a customer,
 * changes nothing at all — gateways retry, duplicate and occasionally deliver
 * out of order, and every one of those has to be safe.
 */
import type { Request, Response } from 'express';
import { asyncHandler, ok } from '../utils/http';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { Transaction, ApiKey } from '../models';
import { confirmMovement, settle } from '../services/transaction.service';
import { verifyGatewayWebhook, gatewayWebhookSignature } from '../services/upiGateway.service';
import { deliverCallback } from '../services/callback.service';
import { logger } from '../config/logger';
import { env, isProd } from '../config/env';

export const GATEWAY_SIGNATURE_HEADER = 'x-gateway-signature';

export const upiWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.headers[GATEWAY_SIGNATURE_HEADER];
  const provided = Array.isArray(signature) ? signature[0] : signature;

  // Verified against the exact bytes received, not a re-serialisation of the
  // parsed body — the provider signed what they sent.
  if (!verifyGatewayWebhook(req.rawBody ?? '', provided)) {
    throw AppError.unauthorized('Invalid gateway signature', ErrorCodes.UNAUTHENTICATED);
  }

  const body = req.body as {
    orderId: string;
    status: 'PAID' | 'FAILED';
    reference?: string;
  };

  const transaction = await Transaction.findOne({ gatewayOrderId: body.orderId });
  if (!transaction) {
    throw AppError.notFound('No transaction for that order', ErrorCodes.TRANSACTION_NOT_FOUND);
  }

  if (body.status !== 'PAID') {
    // A failed attempt is not an expiry: the customer may simply try again
    // before the window closes, and closing it for them would be wrong.
    logger.info({ orderId: body.orderId }, 'Gateway reported a failed payment attempt');
    return ok(res, { acknowledged: true, status: transaction.status });
  }

  const confirmed = await confirmMovement(transaction._id, body.reference ?? body.orderId);
  const settled = confirmed.status === 'SETTLED' ? confirmed : await settle(confirmed._id);

  // Told to the party after the money has moved, and never in a way that can
  // fail the settlement — see callback.service.ts.
  if (settled.callbackUrl) {
    const key = await ApiKey.findOne({ partyId: settled.partyId, status: 'ACTIVE' }).lean();
    if (key) void deliverCallback(settled, 'transaction.settled', key.keyId);
  }

  return ok(res, { acknowledged: true, status: settled.status });
});

/**
 * Stand in for the customer paying.
 *
 * There is no real UPI rail here, so nothing will ever deliver the webhook
 * above on its own — which left the demo with a QR nobody could pay and a
 * captain waiting forever for money that had no way to arrive.
 *
 * This signs a webhook as the simulated gateway would and delivers it through
 * exactly the same handler, so the path being demonstrated is the real one
 * rather than a shortcut around it.
 *
 * Refused outright in production. The whole reason the webhook is signed is
 * that an unauthenticated endpoint which credits a party is a public "give me
 * money" button — and an endpoint that *forges* the signature for you is that
 * same button with extra steps. The guard is here rather than only on the
 * route so it cannot be lost by a routing change.
 */
export const simulateCustomerPayment = asyncHandler(async (req: Request, res: Response) => {
  // Production refuses this unless it has been turned on deliberately, so the
  // route is absent by default exactly as it was before.
  if (isProd && !env.ALLOW_PAYMENT_SIMULATION) {
    throw AppError.notFound('Not found', ErrorCodes.NOT_FOUND);
  }

  const { orderId } = req.body as { orderId: string };
  const transaction = await Transaction.findOne({ gatewayOrderId: orderId });
  if (!transaction) {
    throw AppError.notFound('No transaction for that order', ErrorCodes.TRANSACTION_NOT_FOUND);
  }

  const body = JSON.stringify({
    orderId,
    status: 'PAID',
    reference: `SIMUPI-${Date.now().toString(36).toUpperCase()}`,
  });

  // Delivered over HTTP to our own webhook rather than by calling the handler
  // directly, so the signature check, the state machine and the callback all
  // run exactly as they would for the real provider.
  const response = await fetch(`${req.protocol}://${req.get('host')}${env.API_PREFIX}/api/gateway/upi/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [GATEWAY_SIGNATURE_HEADER]: gatewayWebhookSignature(body),
    },
    body,
  });

  const outcome = (await response.json().catch(() => ({}))) as { data?: { status?: string } };
  if (!response.ok) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'The simulated payment was refused');
  }

  return ok(
    res,
    { simulated: true, status: outcome.data?.status ?? 'UNKNOWN' },
    'Simulated the customer paying',
  );
});
