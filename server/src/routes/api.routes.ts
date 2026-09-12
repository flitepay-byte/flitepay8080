import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/api.controller';
import * as gateway from '../controllers/gateway.controller';
import { requireApiKey } from '../middleware/apiAuth.middleware';
import { validate } from '../middleware/validate.middleware';
import { apiLimiter, gatewayWebhookLimiter } from '../middleware/rateLimit.middleware';
import { rupeeAmountSchema } from '../validators/common.validators';

/**
 * THE PARTY-FACING API.
 *
 * Signed, not sessioned — see apiKey.service.ts. Mounted separately from the
 * dashboard routes so the two cannot share a middleware by accident: a change
 * to how a browser authenticates must never silently change how a party's
 * server does.
 */
const router = Router();

const referenceSchema = z
  .string()
  .trim()
  .min(1, 'A reference of your own is required')
  .max(120);

const payInSchema = z.object({
  reference: referenceSchema,
  amount: rupeeAmountSchema,
  callbackUrl: z.string().url().max(500).optional(),
});

/**
 * A payout needs somewhere to send the money, and refusing it here rather than
 * deeper down means the party gets a field-level error instead of a generic
 * one — the difference between fixing an integration in a minute and an hour.
 */
const payOutSchema = z.object({
  reference: referenceSchema,
  amount: rupeeAmountSchema,
  callbackUrl: z.string().url().max(500).optional(),
  beneficiary: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      upiId: z.string().trim().min(3).max(120).optional(),
      accountNumber: z.string().trim().min(6).max(40).optional(),
      ifsc: z.string().trim().min(6).max(20).optional(),
    })
    .refine((b) => !!b.upiId || (!!b.accountNumber && !!b.ifsc), {
      message: 'Give either a UPI ID, or an account number with its IFSC',
    }),
});

const referenceParamSchema = z.object({ reference: referenceSchema });

router.post('/payin', apiLimiter, requireApiKey, validate({ body: payInSchema }), controller.payIn);
router.post('/payout', apiLimiter, requireApiKey, validate({ body: payOutSchema }), controller.payOut);
router.get(
  '/transactions',
  apiLimiter,
  requireApiKey,
  validate({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      direction: z.enum(['PAY_IN', 'PAY_OUT']).optional(),
      status: z.string().trim().max(30).optional(),
      before: z.string().trim().max(40).optional(),
    }),
  }),
  controller.listTransactions,
);
router.get(
  '/transactions/:reference',
  apiLimiter,
  requireApiKey,
  validate({ params: referenceParamSchema }),
  controller.getTransaction,
);
router.post(
  '/transactions/:reference/dispute',
  apiLimiter,
  requireApiKey,
  validate({
    params: referenceParamSchema,
    body: z.object({ reason: z.string().trim().min(4, 'Say what went wrong').max(500) }),
  }),
  controller.disputeTransaction,
);
// The inbound half of payout.confirmation_required: the party telling us what
// their customer said. Reusing the reference the party already holds, so no
// identifier of ours has to be stored to answer us.
router.post(
  '/payouts/:reference/confirm',
  apiLimiter,
  requireApiKey,
  validate({
    params: referenceParamSchema,
    body: z.object({
      received: z.boolean(),
      reason: z.string().trim().min(5, 'Say what your customer reported').max(500).optional(),
    }),
  }),
  controller.confirmPayout,
);
router.post(
  '/transactions/:reference/replay-callback',
  apiLimiter,
  requireApiKey,
  validate({ params: referenceParamSchema }),
  controller.replayCallback,
);
router.get('/balance', apiLimiter, requireApiKey, controller.balance);

/**
 * The gateway's own webhook. Authenticated by the provider's signature rather
 * than by an API key, because the caller is the payment provider and not a
 * party — see gateway.controller.ts for why this endpoint is the one that most
 * needs its signature checked.
 */
router.post('/gateway/upi/webhook', gatewayWebhookLimiter, gateway.upiWebhook);

/**
 * Stands in for the customer paying, because there is no real UPI rail here
 * and nothing would otherwise ever deliver the webhook above. Refused in
 * production — see the handler, which guards itself rather than trusting this
 * route to stay the only way in.
 */
router.post(
  '/gateway/upi/simulate-payment',
  gatewayWebhookLimiter,
  validate({ body: z.object({ orderId: z.string().trim().min(4).max(120) }) }),
  gateway.simulateCustomerPayment,
);

export default router;
