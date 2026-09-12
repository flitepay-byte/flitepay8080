import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/captain.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole, requireCaptainProfile } from '../middleware/rbac.middleware';
import { validate } from '../middleware/validate.middleware';
import { imageUpload } from '../middleware/upload.middleware';
import { claimLimiter } from '../middleware/rateLimit.middleware';
import {
  taskIdParamSchema,
  taskListQuerySchema,
  submitProofSchema,
  rejectSchema,
  cancelSchema,
  reviewCancellationSchema,
} from '../validators/task.validators';
import { paginationSchema } from '../validators/common.validators';
import {
  requestDepositSchema,
  requestLimitPurchaseSchema,
  markPaidSchema,
  depositIdParamSchema,
  limitPurchaseIdParamSchema,
} from '../validators/dmcPurchase.validators';
import { requestRedemptionSchema,
  addMerchantUpiSchema,
  merchantUpiParamSchema,
  setMerchantUpiActiveSchema,
} from '../validators/captainBalance.validators';

const router = Router();

router.use(requireAuth, requireRole('CAPTAIN'), requireCaptainProfile);

router.get('/profile', controller.profile);
router.post('/presence', validate({ body: z.object({ online: z.boolean() }) }), controller.setPresence);

router.get('/dashboard', controller.dashboard);
router.get('/queue', validate({ query: paginationSchema }), controller.queue);
router.get('/tasks', validate({ query: taskListQuerySchema }), controller.myTasks);
router.get('/tasks/:taskId', validate({ params: taskIdParamSchema }), controller.taskDetail);

router.post('/tasks/:taskId/claim', claimLimiter, validate({ params: taskIdParamSchema }), controller.claim);
router.post('/tasks/:taskId/start', validate({ params: taskIdParamSchema }), controller.start);
router.post(
  '/tasks/:taskId/reject-expired',
  validate({ params: taskIdParamSchema, body: rejectSchema }),
  controller.rejectExpired,
);
router.post(
  '/tasks/:taskId/cancel',
  validate({ params: taskIdParamSchema, body: cancelSchema }),
  controller.requestCancel,
);
router.post(
  '/tasks/:taskId/cancel-review',
  validate({ params: taskIdParamSchema, body: reviewCancellationSchema }),
  controller.reviewCancel,
);

// Multer runs before validation so the multipart body is parsed into req.body.
router.post(
  '/tasks/:taskId/proof',
  imageUpload.single('receipt'),
  validate({ params: taskIdParamSchema, body: submitProofSchema }),
  controller.submitTaskProof,
);
router.get('/tasks/:taskId/proof', validate({ params: taskIdParamSchema }), controller.taskProof);

router.get(
  '/earnings',
  validate({
    query: paginationSchema.extend({
      /** Narrows the ledger to one side of the business. Omitted means both. */
      direction: z.enum(['PAY_IN', 'PAY_OUT']).optional(),
    }),
  }),
  controller.earnings,
);


/**
 * "Pay In" — the customer payments this captain has received.
 *
 * This route used to be the captain asking a party for their earned DMC in
 * rupees, split into a portion per source party with a handshake on each. That
 * flow is gone: the tab is named for the money coming *in*, and what a captain
 * wants from it is the history of those payments.
 */
router.get(
  '/pay-ins',
  validate({ query: paginationSchema.extend({ status: z.string().trim().max(30).optional() }) }),
  controller.payInHistory,
);

// A captain posting security money to raise their collateral. Nothing is
// credited on submission — admin confirms receipt first, exactly as a party
// top-up works. See dmcPurchase.service.ts.
router.post(
  '/dmc/purchase',
  imageUpload.single('receipt'),
  validate({ body: requestDepositSchema }),
  controller.requestCollateralDeposit,
);
router.get('/dmc/purchases', validate({ query: paginationSchema }), controller.listDmcPurchases);

/**
 * "I have sent the USDT, here is the transaction."
 *
 * Credits nothing and verifies nothing — it attaches the reference and the
 * screenshot an administrator needs, and the request stays PENDING.
 */
router.post(
  '/dmc/purchases/:depositId/mark-paid',
  imageUpload.single('receipt'),
  validate({ params: depositIdParamSchema, body: markPaidSchema }),
  controller.markDepositPaidRequest,
);

// Buying capacity outright, which is a different thing from posting security:
// the whole approved amount becomes DMC and the ceiling rises with it, and no
// collateral is posted. Nothing is credited on submission — admin confirms the
// payment first. See captainLimitPurchase.service.ts.
/**
 * Where a captain sends USDT, and the QR for it.
 *
 * One pair of routes for both flows — posting security and buying limit use the
 * same pool and the same network. See usdtDeposit.service.ts.
 */
router.get('/payment-quote', controller.captainPaymentQuote);
router.get('/deposit-address/qr', controller.depositAddressQrImage);

router.get('/limit-purchase/options', controller.limitPurchaseOptions);
router.post(
  '/limit-purchase',
  imageUpload.single('receipt'),
  validate({ body: requestLimitPurchaseSchema }),
  controller.requestCapacityPurchase,
);
router.get('/limit-purchases', validate({ query: paginationSchema }), controller.listCapacityPurchases);
router.post(
  '/limit-purchases/:purchaseId/mark-paid',
  imageUpload.single('receipt'),
  validate({ params: limitPurchaseIdParamSchema, body: markPaidSchema }),
  controller.markLimitPurchasePaidRequest,
);

// What the captain has earned. Commission lands straight in their DMC now, so
// there is nothing to convert — this is the history of it.
router.get('/wallet/entries', validate({ query: paginationSchema }), controller.listWalletEntries);

// Working capital back into real rupees. Admin has to actually send the money,
// so this is a request — the deposit handshake, run backwards.
/**
 * The captain's merchant UPI IDs. Exactly one is active, and that is where every
 * withdrawal below is sent.
 */
router.get('/upi-ids', controller.listUpiIds);
router.post('/upi-ids', validate({ body: addMerchantUpiSchema }), controller.addUpiId);
router.patch(
  '/upi-ids/:upiId',
  validate({ params: merchantUpiParamSchema, body: setMerchantUpiActiveSchema }),
  controller.activateUpiId,
);

router.post('/redemptions', validate({ body: requestRedemptionSchema }), controller.requestCashOut);
router.get('/redemptions', validate({ query: paginationSchema }), controller.listCashOuts);

// Pay-ins and pay-outs the captain is carrying. A pay-in settles when the
// gateway says the customer paid; a pay-out settles when the captain says they
// sent the money, because they are the only one who can know.
router.get(
  '/transactions',
  validate({ query: paginationSchema.extend({ status: z.string().trim().max(30).optional() }) }),
  controller.myTransactions,
);
router.post(
  '/transactions/:transactionId/confirm',
  validate({
    params: z.object({ transactionId: z.string().trim().length(24) }),
    body: z.object({ reference: z.string().trim().min(4, 'Reference is too short').max(120) }),
  }),
  controller.confirmTransfer,
);
router.post(
  '/transactions/:transactionId/decline',
  validate({
    params: z.object({ transactionId: z.string().trim().length(24) }),
    body: z.object({ reason: z.string().trim().min(4).max(500) }),
  }),
  controller.declineTransaction,
);
router.post(
  '/transactions/:transactionId/dispute',
  validate({
    params: z.object({ transactionId: z.string().trim().length(24) }),
    body: z.object({ reason: z.string().trim().min(4).max(500) }),
  }),
  controller.disputeTransaction,
);

export default router;
