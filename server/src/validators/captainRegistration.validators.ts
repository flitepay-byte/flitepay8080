import { z } from 'zod';
import { emailSchema, passwordSchema } from './auth.validators';

/**
 * The same shape the withdrawal and payout validators use, so a UPI id means
 * one thing everywhere in this system rather than three slightly different
 * things depending on which form it was typed into.
 */
export const upiIdSchema = z
  .string({ required_error: 'UPI ID is required' })
  .trim()
  .toLowerCase()
  .max(120)
  .regex(/^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/, 'Enter a valid UPI ID, e.g. name@bank');

/**
 * Ten digits, optionally with a +91 or 0 in front, which is what people
 * actually type. Stored without the prefix so two captains who wrote the same
 * number differently are still the same number.
 */
export const mobileSchema = z
  .string({ required_error: 'Mobile number is required' })
  .trim()
  .regex(/^(?:\+?91[-\s]?|0)?[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number')
  .transform((v) => v.replace(/^(?:\+?91[-\s]?|0)/, ''));

export const registerCaptainSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(120),
    fullName: z.string().trim().min(2, 'Full name is too short').max(160),
    mobile: mobileSchema,
    email: emailSchema,
    upiId: upiIdSchema,
    password: passwordSchema,
    // Named as the requirements name it, so the form field and the API field
    // are the same word.
    c_password: z.string({ required_error: 'Confirm your password' }),
  })
  // Checked on the server as well as in the form. A mismatch that only the
  // browser catches is a mismatch the API still accepts.
  .refine((v) => v.password === v.c_password, {
    message: 'Passwords do not match',
    path: ['c_password'],
  });

export const verifyRegistrationSchema = z.object({
  challengeId: z.string().trim().min(10).max(128),
  otp: z
    .string({ required_error: 'Verification code is required' })
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const resendRegistrationSchema = z.object({
  challengeId: z.string().trim().min(10).max(128),
});

export const registrationIdParamSchema = z.object({
  registrationId: z.string().trim().length(24, 'Invalid registration id'),
});

export const rejectRegistrationSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason').max(500),
});

export const listRegistrationsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z
    .enum(['PENDING_EMAIL', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ALL'])
    .default('PENDING_APPROVAL'),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({
    challengeId: z.string().trim().min(10).max(128),
    otp: z
      .string({ required_error: 'Verification code is required' })
      .trim()
      .regex(/^\d{6}$/, 'Enter the 6-digit code'),
    password: passwordSchema,
    c_password: z.string({ required_error: 'Confirm your password' }),
  })
  .refine((v) => v.password === v.c_password, {
    message: 'Passwords do not match',
    path: ['c_password'],
  });

export type RegisterCaptainBody = z.infer<typeof registerCaptainSchema>;
export type VerifyRegistrationBody = z.infer<typeof verifyRegistrationSchema>;
export type ResendRegistrationBody = z.infer<typeof resendRegistrationSchema>;
export type RejectRegistrationBody = z.infer<typeof rejectRegistrationSchema>;
export type ListRegistrationsQuery = z.infer<typeof listRegistrationsSchema>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
