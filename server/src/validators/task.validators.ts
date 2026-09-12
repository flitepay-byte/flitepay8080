import { z } from 'zod';
import { objectIdSchema, rupeeAmountSchema, paginationSchema } from './common.validators';
import { TASK_STATES } from '../types';
import { REJECTION_CATEGORY_KEYS } from '../utils/rejectionCategories';

/**
 * How the party wants their (fictional) beneficiary paid. Exactly one shape
 * per task, chosen via the `payoutType` discriminant — this is what a
 * captain and admin see alongside the task, never the party's `externalRef`.
 * Multipart form fields all arrive as strings, so every value here is a
 * plain string rather than a coerced type.
 */
const bankPayoutSchema = z.object({
  payoutType: z.literal('BANK'),
  // Free text rather than a fixed list: the party may name any bank, and the
  // IFSC code below is what actually identifies it for a real transfer.
  bankName: z.string().trim().min(2, 'Enter the bank name, e.g. SBI or HDFC Bank').max(80),
  accountNumber: z
    .string()
    .trim()
    .min(6, 'Account number looks too short')
    .max(30, 'Account number looks too long')
    .regex(/^[0-9]+$/, 'Account number must contain digits only'),
  ifscCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code, e.g. HDFC0001234'),
  accountHolderName: z.string().trim().min(1, 'Account holder name is required').max(160),
});

const upiPayoutSchema = z.object({
  payoutType: z.literal('UPI'),
  upiId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/, 'Enter a valid UPI ID, e.g. name@bank'),
});

const usdtPayoutSchema = z.object({
  payoutType: z.literal('USDT'),
  walletAddress: z
    .string()
    .trim()
    .min(20, 'Wallet address looks too short')
    .max(64, 'Wallet address looks too long')
    .regex(/^[A-Za-z0-9]+$/, 'Wallet address may only contain letters and numbers'),
});

export const payoutMethodSchema = z.discriminatedUnion('payoutType', [
  bankPayoutSchema,
  upiPayoutSchema,
  usdtPayoutSchema,
]);
export type PayoutMethodFormInput = z.infer<typeof payoutMethodSchema>;

export const createTaskSchema = z
  .object({
    customerName: z.string().trim().min(1, 'Customer name is required').max(160),
    amount: rupeeAmountSchema,
    /**
     * The party's own reference for this order, if they have one. Unique per
     * party, which is what makes a repeated submission safe: a double-clicked
     * button or a client retry after a timeout carries the same reference and
     * is refused as a duplicate rather than creating a second task and billing
     * for it twice. Omitted, the server generates one.
     */
    externalRef: z.string().trim().min(1).max(120).optional(),
  })
  .and(payoutMethodSchema);

export const taskIdParamSchema = z.object({ taskId: objectIdSchema });

export const taskListQuerySchema = paginationSchema.extend({
  status: z.enum(TASK_STATES).optional(),
  /**
   * Only the tasks whose money the captain currently has committed. A set of
   * states rather than one, so it cannot be expressed through `status` — and
   * naming the question rather than the states keeps the answer in one place
   * if the set ever changes.
   */
  holding: z.coerce.boolean().optional(),
  search: z.string().trim().max(120).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Admin-only scoping to one party's or captain's tasks; ignored by the party's own list endpoint. */
  partyId: objectIdSchema.optional(),
  captainId: objectIdSchema.optional(),
});

export const submitProofSchema = z.object({
  providerReference: z.string().trim().min(6, 'Reference is too short').max(64),
  notes: z.string().trim().max(500).optional(),
});

export const rejectSchema = z.object({
  reason: z.string().trim().min(5, 'A rejection reason of at least 5 characters is required').max(500),
  // The free text is for admin; the category is what a later captain is told,
  // so it is required rather than inferred from the party's wording.
  category: z.enum(REJECTION_CATEGORY_KEYS, { errorMap: () => ({ message: 'Choose a rejection reason' }) }),
});

export const cancelSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

/** Whichever side did NOT request a cancellation reviews it — this is their decision. */
export const reviewCancellationSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().min(3).max(500).optional(),
});

/**
 * Admin's last-resort decision on a genuine disagreement — either a disputed
 * cancellation or a rejected proof. APPROVE leaves the task as it is;
 * REASSIGN releases the current captain and returns it to the open pool.
 */
export const adminResolutionSchema = z.object({
  decision: z.enum(['APPROVE', 'REASSIGN']),
});

export const confirmImportSchema = z.object({ batchId: objectIdSchema });

export const trackParamSchema = z.object({
  referenceId: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9._\-/]+$/, 'Invalid reference format'),
});
