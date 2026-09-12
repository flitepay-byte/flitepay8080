import { z } from 'zod';
import { objectIdSchema, rupeeAmountSchema, paginationSchema } from './common.validators';
import { WITHDRAWAL_STATUSES, REQUEST_STATUSES } from '../models';

/**
 * A withdrawal says how much, and nothing about where.
 *
 * The destination is the captain's active merchant UPI, read from their profile
 * — a destination sent per request could name an account that is not theirs and
 * made the answer to "where am I paid?" different on every withdrawal.
 */
export const requestWithdrawalSchema = z.object({
  amount: rupeeAmountSchema,
});

export const fulfillWithdrawalSchema = z.object({
  providerReference: z.string().trim().min(6, 'Reference is too short').max(64),
  notes: z.string().trim().max(500).optional(),
});

export const disputeWithdrawalSchema = z.object({
  reason: z.string().trim().min(5, 'A reason of at least 5 characters is required').max(500),
});

export const withdrawalIdParamSchema = z.object({ withdrawalId: objectIdSchema });
export const portionIdParamSchema = z.object({ portionId: objectIdSchema });

/** Filters the parent request list — parents only ever carry a RequestStatus, never a portion's finer-grained status. */
export const withdrawalListQuerySchema = paginationSchema.extend({
  status: z.enum(REQUEST_STATUSES).optional(),
});

/** Filters a portion list (captain's own portions, or a party's own portions). */
export const withdrawalPortionListQuerySchema = paginationSchema.extend({
  status: z.enum(WITHDRAWAL_STATUSES).optional(),
});


/** Admin cashing out platform commission — same handshake as a captain's Pay In, no destination handle needed. */
export const requestPlatformWithdrawalSchema = z.object({
  amount: rupeeAmountSchema,
});

/** Admin's last-resort ruling on a disputed withdrawal portion — two options, as everywhere else. */
export const resolveDisputeSchema = z.object({
  decision: z.enum(['SETTLE', 'RETRY']),
});
