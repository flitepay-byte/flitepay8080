import { objectIdSchema, paginationSchema, rupeeAmountSchema } from './common.validators';
import { z } from 'zod';

/**
 * A captain posting security money — the amount only.
 *
 * No reference here any more. The captain is quoted a USDT figure and an
 * address, pays, and reports the transaction afterwards through the mark-paid
 * route; asking for a reference up front asked for something nobody has yet.
 */
export const requestDepositSchema = z.object({
  amount: rupeeAmountSchema,
});

export const depositIdParamSchema = z.object({ depositId: objectIdSchema });

/**
 * A captain buying capacity outright rather than posting security.
 *
 * Shaped like the deposit above on purpose — same reference, same receipt,
 * same admin confirmation — because it is the same handshake over real money.
 * What differs is only what approval does with it, which the service decides.
 * The ceiling on `amount` is the captain's own collateral and is enforced
 * server-side, not here: this schema does not know whose captain it is.
 */
export const requestLimitPurchaseSchema = z.object({
  amount: rupeeAmountSchema,
});

export const limitPurchaseIdParamSchema = z.object({ purchaseId: objectIdSchema });

/** Admin's worklist; `ALL` switches to full history for a captain's profile. */
export const adminLimitPurchaseQuerySchema = paginationSchema.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).optional(),
  captainId: objectIdSchema.optional(),
});

/**
 * Admin's view of collateral deposits. `status: 'ALL'` switches it from the
 * pending worklist to full history, which is what a captain's profile shows.
 */
export const adminCollateralDepositQuerySchema = paginationSchema.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).optional(),
  captainId: objectIdSchema.optional(),
  search: z.string().trim().max(120).optional(),
});

/**
 * What the payer submits after sending the USDT.
 *
 * The reference is the transaction hash or UTR — it is the only thing tying a
 * transfer on the chain to this request, which is why it is required here and
 * absent when the request is first opened.
 */
export const markPaidSchema = z.object({
  providerReference: z.string().trim().min(6, 'Reference is too short').max(120),
  notes: z.string().trim().max(500).optional(),
});
