import { z } from 'zod';
import { objectIdSchema, rupeeAmountSchema, paginationSchema } from './common.validators';
import { TOPUP_STATUSES } from '../models/PartyTopUpRequest';

/**
 * A party topping up — the amount only.
 *
 * Same two-step shape as a captain's deposit, and for the same reason: the
 * reference describes a transfer that has not happened yet when the request is
 * opened. The party rate is applied server-side; it is never sent by the client.
 */
export const requestTopUpSchema = z.object({
  amount: rupeeAmountSchema,
});

export const rejectTopUpSchema = z.object({
  reason: z.string().trim().min(5, 'A reason of at least 5 characters is required').max(500),
});

export const topUpIdParamSchema = z.object({ topUpId: objectIdSchema });

/**
 * Admin's view of party top-ups. `status: 'ALL'` switches it from the pending
 * review queue to full history, which is what a party's profile and the
 * transactions page show.
 */
export const adminTopUpQuerySchema = paginationSchema.extend({
  status: z.enum([...TOPUP_STATUSES, 'ALL']).optional(),
  partyId: objectIdSchema.optional(),
  search: z.string().trim().max(120).optional(),
});
