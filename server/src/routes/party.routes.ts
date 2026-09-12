import { Router } from 'express';
import * as controller from '../controllers/party.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole, requirePartyProfile } from '../middleware/rbac.middleware';
import { validate } from '../middleware/validate.middleware';
import { csvUpload, imageUpload } from '../middleware/upload.middleware';
import {
  createTaskSchema,
  taskIdParamSchema,
  taskListQuerySchema,
  confirmImportSchema,
  cancelSchema,
  rejectSchema,
  reviewCancellationSchema,
} from '../validators/task.validators';
import { paginationSchema, objectIdSchema } from '../validators/common.validators';
import { portionIdParamSchema, withdrawalPortionListQuerySchema, fulfillWithdrawalSchema } from '../validators/withdrawal.validators';
import { requestTopUpSchema, topUpIdParamSchema } from '../validators/partyTopUp.validators';
import { markPaidSchema } from '../validators/dmcPurchase.validators';
import { z } from 'zod';

const router = Router();

// Every route below is authenticated and restricted to the PARTY role.
router.use(requireAuth, requireRole('PARTY'), requirePartyProfile);

router.get('/dashboard', controller.dashboard);
// Multer runs before validation so the multipart body (payout method fields,
// and an optional UPI screenshot) is parsed into req.body/req.file first.
router.post(
  '/tasks',
  imageUpload.single('screenshot'),
  validate({ body: createTaskSchema }),
  controller.create,
);
router.get('/tasks', validate({ query: taskListQuerySchema }), controller.list);
router.get('/tasks/:taskId', validate({ params: taskIdParamSchema }), controller.detail);
router.post(
  '/tasks/:taskId/cancel',
  validate({ params: taskIdParamSchema, body: cancelSchema }),
  controller.cancel,
);
router.post(
  '/tasks/:taskId/cancel-review',
  validate({ params: taskIdParamSchema, body: reviewCancellationSchema }),
  controller.reviewCancel,
);

// Audit desk — the party decides whether their own captain's proof is good.
router.get('/audit-queue', validate({ query: paginationSchema }), controller.auditQueue);
// Captain-requested cancellations awaiting this party's decision — the audit
// desk's second queue. See party.controller.ts::cancelReviewQueue.
router.get('/cancel-review-queue', validate({ query: paginationSchema }), controller.cancelReviewQueue);
router.get('/audit/:taskId', validate({ params: taskIdParamSchema }), controller.auditDetail);
router.post('/audit/:taskId/approve', validate({ params: taskIdParamSchema }), controller.auditApprove);
// The party relaying what their customer said. Beside approve/reject because
// it is the same decision, reached by asking somebody rather than by reading
// the proof themselves — and it goes through the same service the API does.
router.post(
  '/audit/:taskId/confirm',
  validate({
    params: taskIdParamSchema,
    body: z.object({
      received: z.boolean(),
      reason: z.string().trim().min(5, 'Say what your customer reported').max(500).optional(),
    }),
  }),
  controller.confirmPayout,
);
router.post(
  '/audit/:taskId/reject',
  validate({ params: taskIdParamSchema, body: rejectSchema }),
  controller.auditReject,
);

router.post('/imports/preview', csvUpload.single('file'), controller.previewImport);
router.post('/imports/confirm', validate({ body: confirmImportSchema }), controller.confirmImport);
router.get(
  '/imports/:batchId/errors.csv',
  validate({ params: z.object({ batchId: objectIdSchema }), query: paginationSchema.partial() }),
  controller.downloadErrorReport,
);

// The party sending real money in to buy DMC. Nothing is credited here: the
// party says what they sent and attaches proof, and admin confirms the money
// actually arrived before any balance moves. See partyTopUp.service.ts.
router.post(
  '/dmc/purchase',
  imageUpload.single('receipt'),
  validate({ body: requestTopUpSchema }),
  controller.requestTopUp,
);

/** The party's half of the same handshake: paid, with a reference to check. */
/** What DMC costs a party, at the party rate. */
router.get('/payment-quote', controller.partyPaymentQuote);

router.post(
  '/top-ups/:topUpId/mark-paid',
  imageUpload.single('receipt'),
  validate({ params: topUpIdParamSchema, body: markPaidSchema }),
  controller.markTopUpPaidRequest,
);
router.get('/dmc/purchases', validate({ query: paginationSchema }), controller.listOwnTopUps);

// Admin's withdrawal portions directed at this party — admin cashing out the
// commission this party was charged, paid back to admin in real money.
router.get(
  '/admin-withdrawal-portions',
  validate({ query: withdrawalPortionListQuerySchema }),
  controller.listAdminWithdrawalPool,
);
router.post(
  '/admin-withdrawal-portions/:portionId/pay',
  imageUpload.single('receipt'),
  validate({ params: portionIdParamSchema, body: fulfillWithdrawalSchema }),
  controller.submitAdminPayInProof,
);

// The credentials the party's own server calls our API with. Issued and
// revoked from the dashboard, because that is where a person is signed in —
// the API itself is for servers and has no way to bootstrap its own access.
router.post(
  '/api-keys',
  validate({
    body: z.object({
      label: z.string().trim().min(1).max(80),
      callbackUrl: z.string().url().max(500).optional(),
    }),
  }),
  controller.createApiKey,
);
router.get('/api-keys', controller.listApiKeysForParty);
router.delete(
  '/api-keys/:keyId',
  validate({ params: z.object({ keyId: z.string().trim().min(8).max(64) }) }),
  controller.revokeApiKeyForParty,
);

router.get(
  '/transactions',
  validate({
    query: paginationSchema.extend({
      direction: z.enum(['PAY_IN', 'PAY_OUT']).optional(),
      status: z.string().trim().max(30).optional(),
    }),
  }),
  controller.listTransactions,
);

router.post(
  '/transactions/:reference/dispute',
  validate({
    params: z.object({ reference: z.string().trim().min(1).max(120) }),
    body: z.object({ reason: z.string().trim().min(4).max(500) }),
  }),
  controller.disputeTransaction,
);

export default router;
