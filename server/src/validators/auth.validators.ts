import { z } from 'zod';

/** Rejects non-string inputs, which is also the NoSQL-operator defence. */
export const emailSchema = z
  .string({ required_error: 'Email is required', invalid_type_error: 'Email must be a string' })
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(254);

export const passwordSchema = z
  .string({ required_error: 'Password is required', invalid_type_error: 'Password must be a string' })
  .min(8, 'Password must be at least 8 characters')
  .max(128);

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const verifyOtpSchema = z.object({
  challengeId: z.string().trim().min(10).max(128),
  otp: z
    .string({ required_error: 'Verification code is required' })
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const resendOtpSchema = z.object({
  challengeId: z.string().trim().min(10).max(128),
  /**
   * Accepted and ignored.
   *
   * The destination now comes from the stored challenge, because taking it from
   * the request meant a challenge id was enough to have a code mailed anywhere.
   * It stays in the schema only so a client that still sends it is not rejected;
   * nothing reads the value.
   */
  email: emailSchema.optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type ResendOtpInput = z.infer<typeof resendOtpSchema>;
