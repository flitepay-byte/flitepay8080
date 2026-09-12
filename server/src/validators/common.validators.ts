import { z } from 'zod';
import { Types } from 'mongoose';
import { rupeesToPaise } from '../utils/money';

export const objectIdSchema = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v), { message: 'Invalid identifier' });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
});

/** Accepts a rupee amount from the API boundary and converts it to paise. */
export const rupeeAmountSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    try {
      const paise = rupeesToPaise(value);
      if (paise <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Amount must be greater than zero' });
        return z.NEVER;
      }
      return paise;
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'Invalid amount',
      });
      return z.NEVER;
    }
  });

export const referenceSchema = z
  .string()
  .trim()
  .min(3, 'Reference is too short')
  .max(64, 'Reference is too long')
  .regex(/^[A-Za-z0-9._\-/]+$/, 'Reference may only contain letters, numbers, and . _ - /');

export type PaginationInput = z.infer<typeof paginationSchema>;
