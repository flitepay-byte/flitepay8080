import { Router } from 'express';
import * as controller from '../controllers/admin.controller';
import * as registrations from '../controllers/admin/captainRegistrations.controller';
import * as apiKeys from '../controllers/admin/partyApiKeys.controller';
import {
  listRegistrationsSchema,
  registrationIdParamSchema,
  rejectRegistrationSchema,
} from '../validators/captainRegistration.validators';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/rbac.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  adminRedemptionQuerySchema,
  redemptionIdParamSchema,
  payRedemptionSchema,
  rejectRedemptionSchema,
  fundPoolSchema,
} from '../validators/captainBalance.validators';
import { csvUpload } from '../middleware/upload.middleware';
import {
  taskIdParamSchema,
  taskListQuerySchema,
  adminResolutionSchema,
} from '../validators/task.validators';
import {  updateConfigSchema,
  addDepositAddressSchema,
  depositAddressParamSchema,
  setDepositAddressActiveSchema,
  captainIdParamSchema,
  userIdParamSchema,
  auditLogQuerySchema,
  userStatusSchema,
  partyIdParamSchema,
  createPartySchema,
  updatePartyLimitsSchema,
  settingsVersionParamSchema,
  updateCaptainProfileSchema,
  createPartyApiKeySchema,
  partyApiKeyParamSchema,
  updateCallbackUrlSchema,
  integrationPdfSchema,
} from '../validators/admin.validators';
import { z } from 'zod';
import { paginationSchema } from '../validators/common.validators';
import {
  withdrawalIdParamSchema,
  withdrawalListQuerySchema,
  withdrawalPortionListQuerySchema,
  portionIdParamSchema,
  disputeWithdrawalSchema,
  requestPlatformWithdrawalSchema,
  resolveDisputeSchema,
} from '../validators/withdrawal.validators';
import { topUpIdParamSchema, rejectTopUpSchema, adminTopUpQuerySchema } from '../validators/partyTopUp.validators';
import {
  adminCollateralDepositQuerySchema,
  depositIdParamSchema,
  adminLimitPurchaseQuerySchema,
  limitPurchaseIdParamSchema,
} from '../validators/dmcPurchase.validators';

const router = Router();

router.use(requireAuth, requireRole('ADMIN'));

router.get('/dashboard', controller.dashboard);
router.get('/tasks', validate({ query: taskListQuerySchema }), controller.tasks);
// Tasks pending admin's arbitration (a rejected proof or a disputed cancellation).
router.get('/review-queue', validate({ query: paginationSchema }), controller.reviewQueue);
router.get('/tasks/:taskId', validate({ params: taskIdParamSchema }), controller.taskDetail);
// Admin never initiates a cancellation or a rejection — only party/captain
// do. These two endpoints are its only involvement: resolving a genuine
// disagreement between them, as a last resort.
router.post(
  '/tasks/:taskId/cancel/resolve',
  validate({ params: taskIdParamSchema, body: adminResolutionSchema }),
  controller.resolveCancellationDispute,
);
router.post(
  '/tasks/:taskId/reject/resolve',
  validate({ params: taskIdParamSchema, body: adminResolutionSchema }),
  controller.resolveRejection,
);

// Configuration
router.get('/settings', controller.getSettings);
// Before /settings/:version, or the literal path is read as a version number.
router.get('/settings/versions', validate({ query: paginationSchema }), controller.settingsVersions);
router.get(
  '/settings/versions/:version',
  validate({ params: settingsVersionParamSchema }),
  controller.settingsVersionDetail,
);
router.patch('/settings', validate({ body: updateConfigSchema }), controller.updateSettings);

/**
 * The USDT deposit address book. Held in settings, not the environment, so it
 * can be changed without a deployment. See usdtDeposit.service.ts.
 */
router.get('/settings/usdt-addresses', controller.listUsdtAddresses);
router.post(
  '/settings/usdt-addresses',
  validate({ body: addDepositAddressSchema }),
  controller.addUsdtAddress,
);
router.patch(
  '/settings/usdt-addresses/:address',
  validate({ params: depositAddressParamSchema, body: setDepositAddressActiveSchema }),
  controller.setUsdtAddressActive,
);

// Captains and collateral
/**
 * Captains who have applied to join.
 *
 * Approving one is what creates a captain account; there is no other route in
 * the application that does. See captainRegistration.service.ts.
 */
router.get(
  '/captain-registrations',
  validate({ query: listRegistrationsSchema }),
  registrations.list,
);
router.post(
  '/captain-registrations/:registrationId/approve',
  validate({ params: registrationIdParamSchema }),
  registrations.approve,
);
router.post(
  '/captain-registrations/:registrationId/reject',
  validate({ params: registrationIdParamSchema, body: rejectRegistrationSchema }),
  registrations.reject,
);

router.get('/captains', validate({ query: paginationSchema }), controller.listCaptains);
router.get('/captains/:captainId', validate({ params: captainIdParamSchema }), controller.captainDetail);
// No route writes a captain's collateral. It is their own security money,
// posted by buying DMC (see dmcPurchase.service.ts) and returned the same way.
// Admin's lever on what a captain may take on is the claim ceiling, set
// through the profile route below — which moves no money.
router.get(
  '/captains/:captainId/collateral-integrity',
  validate({ params: captainIdParamSchema }),
  controller.collateralIntegrity,
);

// Parties
router.get('/payments/summary', controller.paymentsSummary);
// Before /parties/:partyId, or the literal path is swallowed as an id.
router.get('/commission/party-rates', controller.partyCommissionRates);
/**
 * A party's API access.
 *
 * The same service the party's own dashboard calls — see
 * controllers/admin/partyApiKeys.controller.ts for why an administrator needs a
 * door to it at all.
 */
router.get('/parties/:partyId/api-keys', validate({ params: partyIdParamSchema }), apiKeys.list);
router.post(
  '/parties/:partyId/api-keys',
  validate({ params: partyIdParamSchema, body: createPartyApiKeySchema }),
  apiKeys.create,
);
router.delete(
  '/parties/:partyId/api-keys/:keyId',
  validate({ params: partyApiKeyParamSchema }),
  apiKeys.revoke,
);
router.patch(
  '/parties/:partyId/api-keys/:keyId/callback-url',
  validate({ params: partyApiKeyParamSchema, body: updateCallbackUrlSchema }),
  apiKeys.updateCallbackUrl,
);
router.get(
  '/parties/:partyId/api-keys/:keyId/integration',
  validate({ params: partyApiKeyParamSchema }),
  apiKeys.integrationDetails,
);
// POST rather than GET: the secret travels in the body so it stays out of the
// URL, and therefore out of access logs and browser history.
router.post(
  '/parties/:partyId/api-keys/:keyId/integration.pdf',
  validate({ params: partyApiKeyParamSchema, body: integrationPdfSchema }),
  apiKeys.integrationPdf,
);

router.get('/parties', validate({ query: paginationSchema }), controller.listParties);
router.get('/parties/:partyId', validate({ params: partyIdParamSchema }), controller.partyDetail);
router.post('/parties', validate({ body: createPartySchema }), controller.createParty);
router.patch(
  '/parties/:partyId/limits',
  validate({ params: partyIdParamSchema, body: updatePartyLimitsSchema }),
  controller.updatePartyLimits,
);

// Captains
router.patch(
  '/captains/:captainId/profile',
  validate({ params: captainIdParamSchema, body: updateCaptainProfileSchema }),
  controller.updateCaptainProfile,
);

// Users
router.get('/users', validate({ query: paginationSchema }), controller.listUsers);
router.patch(
  '/users/:userId/status',
  validate({ params: userIdParamSchema, body: userStatusSchema }),
  controller.setUserStatus,
);
router.post('/users/:userId/unlock', validate({ params: userIdParamSchema }), controller.unlock);

// Ledger and audit trail
// The platform's own earnings, both directions. The two lists behind it are
// the ordinary payment lists filtered to their terminal state — nothing is
// recorded twice just to be counted here.
router.get('/commissions/summary', controller.commissionsSummary);
router.get('/commissions', validate({ query: paginationSchema }), controller.commissions);
router.get('/audit-logs', validate({ query: auditLogQuerySchema }), controller.auditLogs);

// Reconciliation
router.post('/reconciliation', csvUpload.single('file'), controller.runReconciliation);
router.get('/reconciliation', validate({ query: paginationSchema }), controller.reconciliationHistory);

// Admin's own DMC wallet — cashing out earned platform commission, the same
// two-sided handshake as a captain's Pay In (see adminWithdrawal.service.ts).
router.get('/wallet', controller.platformWallet);
router.get('/withdrawals', validate({ query: withdrawalListQuerySchema }), controller.listWithdrawals);
router.post('/withdrawals', validate({ body: requestPlatformWithdrawalSchema }), controller.requestWithdrawal);
router.post(
  '/withdrawals/:withdrawalId/cancel',
  validate({ params: withdrawalIdParamSchema }),
  controller.cancelWithdrawal,
);
// Admin's own withdrawal's individual party-slices — full source detail, since it's admin's own withdrawal.
router.get(
  '/withdrawal-portions',
  validate({ query: withdrawalPortionListQuerySchema }),
  controller.listWithdrawalPortions,
);
router.post(
  '/withdrawal-portions/:portionId/confirm',
  validate({ params: portionIdParamSchema }),
  controller.confirmWithdrawal,
);
router.post(
  '/withdrawal-portions/:portionId/dispute',
  validate({ params: portionIdParamSchema, body: disputeWithdrawalSchema }),
  controller.disputeWithdrawal,
);

router.post(
  '/withdrawal-portions/:portionId/resolve',
  validate({ params: portionIdParamSchema, body: resolveDisputeSchema }),
  controller.resolveOwnPortionDispute,
);

// Parties topping up their DMC balance — real money sent directly to admin,
// so admin confirms it, not a shared pool. See partyTopUp.service.ts.
router.get('/dmc-topups', validate({ query: adminTopUpQuerySchema }), controller.topUpQueue);

// Captains' security-money deposits. Nothing was credited when the captain
// submitted; confirming here is what actually moves their collateral.
router.get(
  '/collateral-deposits',
  validate({ query: adminCollateralDepositQuerySchema }),
  controller.collateralDepositQueue,
);
router.post(
  '/collateral-deposits/:depositId/approve',
  validate({ params: depositIdParamSchema }),
  controller.approveCollateralDeposit,
);
router.post(
  '/collateral-deposits/:depositId/reject',
  validate({ params: depositIdParamSchema, body: rejectTopUpSchema }),
  controller.rejectCollateralDeposit,
);

// Captains buying capacity outright. Same handshake as a deposit — nothing was
// credited on submission — but approval applies the whole amount to their DMC
// and their ceiling, and leaves the collateral alone.
router.get(
  '/limit-purchases',
  validate({ query: adminLimitPurchaseQuerySchema }),
  controller.limitPurchaseQueue,
);
router.post(
  '/limit-purchases/:purchaseId/approve',
  validate({ params: limitPurchaseIdParamSchema }),
  controller.approveLimitPurchaseRequest,
);
router.post(
  '/limit-purchases/:purchaseId/reject',
  validate({ params: limitPurchaseIdParamSchema, body: rejectTopUpSchema }),
  controller.rejectLimitPurchaseRequest,
);
router.post(
  '/dmc-topups/:topUpId/approve',
  validate({ params: topUpIdParamSchema }),
  controller.approveTopUpRequest,
);
router.post(
  '/dmc-topups/:topUpId/reject',
  validate({ params: topUpIdParamSchema, body: rejectTopUpSchema }),
  controller.rejectTopUpRequest,
);

// Captains cashing DMC back out into rupees. Admin sends the transfer by hand
// and confirms it here; until then the captain's DMC is held, not spent.
router.get('/redemptions', validate({ query: adminRedemptionQuerySchema }), controller.redemptionQueue);
router.post(
  '/redemptions/:redemptionId/pay',
  validate({ params: redemptionIdParamSchema, body: payRedemptionSchema }),
  controller.payRedemption,
);
router.post(
  '/redemptions/:redemptionId/reject',
  validate({ params: redemptionIdParamSchema, body: rejectRedemptionSchema }),
  controller.declineRedemption,
);

// Real money funding the pool that captain commission is paid from.
router.post('/platform/pool/fund', validate({ body: fundPoolSchema }), controller.fundCommissionPoolEndpoint);

// Pay-ins and pay-outs. Admin is the only role that sees both counterparties,
// because they are the one who has to settle an argument between them.
router.get(
  '/transactions',
  validate({
    query: paginationSchema.extend({
      // Only one direction exists here — a payout is a task, not a transaction
      // (see types/transaction.ts). Kept as an enum so the filter still reads
      // as a choice rather than looking like a field nobody uses.
      direction: z.enum(['PAY_IN']).optional(),
      status: z.string().trim().max(30).optional(),
      search: z.string().trim().max(120).optional(),
      /** Scopes the list to one captain, for their profile page. */
      captainId: z.string().trim().length(24).optional(),
      partyId: z.string().trim().length(24).optional(),
    }),
  }),
  controller.transactionList,
);
router.post(
  '/transactions/:transactionId/resolve-dispute',
  validate({
    params: z.object({ transactionId: z.string().trim().length(24) }),
    body: z.object({
      decision: z.enum(['SETTLE', 'RELEASE']),
      reason: z.string().trim().min(4, 'Give a reason both sides can read').max(500),
    }),
  }),
  controller.resolveTransactionDispute,
);

export default router;
