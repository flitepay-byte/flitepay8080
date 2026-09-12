import { z } from 'zod';
import { objectIdSchema, paginationSchema, rupeeAmountSchema } from './common.validators';

/**
 * Asking to be paid real rupees for DMC.
 *
 * The destination is refined rather than made a plain optional set, because a
 * request admin cannot actually pay is worse than no request at all: it sits in
 * the queue holding the captain's money while somebody works out where to send
 * it. Whichever method is chosen, everything needed to make that transfer has
 * to be present here.
 */
export const requestRedemptionSchema = z
  .object({
    amount: rupeeAmountSchema,
    method: z.enum(['UPI', 'BANK']),
    upiId: z.string().trim().min(3).max(120).optional(),
    accountName: z.string().trim().min(2).max(120).optional(),
    accountNumber: z.string().trim().min(6).max(40).optional(),
    ifsc: z.string().trim().min(6).max(20).optional(),
  })
  .refine((v) => v.method !== 'UPI' || !!v.upiId, {
    message: 'A UPI ID is required to be paid by UPI',
    path: ['upiId'],
  })
  .refine((v) => v.method !== 'BANK' || (!!v.accountName && !!v.accountNumber && !!v.ifsc), {
    message: 'Account name, account number and IFSC are all required for a bank transfer',
    path: ['accountNumber'],
  });

export const redemptionIdParamSchema = z.object({ redemptionId: objectIdSchema });

/** Admin recording that the rupees actually went out. */
export const payRedemptionSchema = z.object({
  reference: z.string().trim().min(4, 'Reference is too short').max(64),
  notes: z.string().trim().max(500).optional(),
});

export const rejectRedemptionSchema = z.object({
  reason: z.string().trim().min(4, 'Give a reason the captain can act on').max(500),
});

/** Admin's queue and history of cash-out requests. */
export const adminRedemptionQuerySchema = paginationSchema.extend({
  status: z.enum(['PENDING', 'PAID', 'REJECTED', 'ALL']).optional(),
  captainId: objectIdSchema.optional(),
});

/**
 * Admin putting real money behind the commission the platform pays captains.
 * The reference is optional here — unlike a captain's deposit there is no
 * counterparty claiming the money arrived, admin is recording their own act.
 */
export const fundPoolSchema = z.object({
  amount: rupeeAmountSchema,
  reference: z.string().trim().max(64).optional(),
});

/**
 * Adding a merchant UPI ID.
 *
 * The format is checked; that it is a *merchant* account is not, because nothing
 * in a UPI string says so. The screens state the requirement and an
 * administrator verifies it when they pay — see captainUpi.service.ts.
 */
export const addMerchantUpiSchema = z.object({
  upiId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/, 'Enter a valid UPI ID, e.g. name@bank'),
  label: z.string().trim().max(80).optional(),
});

export const merchantUpiParamSchema = z.object({
  upiId: z.string().trim().min(3).max(160),
});

export const setMerchantUpiActiveSchema = z.object({ active: z.boolean() });
