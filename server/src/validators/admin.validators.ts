import { z } from 'zod';
import { AUDIT_ACTIONS, ROLES } from '../types';
import { objectIdSchema, rupeeAmountSchema, paginationSchema } from './common.validators';

const optionalRupees = rupeeAmountSchema.optional();

export const updateConfigSchema = z
  .object({
    /**
     * The new model's two directions. A captain earns on money coming in and
     * on money going out, and the rates are deliberately independent: taking
     * cash in and paying cash out are not the same job and do not cost the
     * captain the same thing.
     */
    payInPartyCommissionPercentage: z.number().min(0).max(100).optional(),
    payInCaptainCommissionPercentage: z.number().min(0).max(100).optional(),
    payOutPartyCommissionPercentage: z.number().min(0).max(100).optional(),
    payOutCaptainCommissionPercentage: z.number().min(0).max(100).optional(),
    /**
     * How much of a security deposit is locked as collateral. The remainder
     * becomes the captain's working capital. Zero and 100 are both real
     * settings — all capital, or all security.
     */
    collateralLockPercentage: z.number().min(0).max(100).optional(),
    captainDailyLimit: optionalRupees,
    captainMonthlyLimit: optionalRupees,
    partyDailyLimit: optionalRupees,
    partyMonthlyLimit: optionalRupees,
    minimumTaskAmount: optionalRupees,
    maximumTaskAmount: optionalRupees,
    taskAcceptanceMinutes: z.number().int().min(1).max(1440).optional(),
    taskCompletionMinutes: z.number().int().min(1).max(1440).optional(),
    taskMaxAgeMinutes: z.number().int().min(1).max(10080).optional(),
    taskExpiryAckMinutes: z.number().int().min(1).max(1440).optional(),
    customerConfirmationMinutes: z.number().int().min(1).max(1440).optional(),
    otpExpiryMinutes: z.number().int().min(1).max(60).optional(),
    otpResendCooldownSeconds: z.number().int().min(10).max(600).optional(),
    otpMaxAttempts: z.number().int().min(1).max(10).optional(),
    maxFailedLoginAttempts: z.number().int().min(1).max(20).optional(),
    accountLockMinutes: z.number().int().min(1).max(1440).optional(),
    proofMaxFileSizeMB: z.number().min(1).max(25).optional(),
    /**
     * What a USDT is worth in DMC, per side, as a decimal — 9.59 means one USDT
     * buys 9.59 DMC. Stored as paise of DMC per USDT.
     *
     * Two separate settings that are never derived from one another: sending one
     * leaves the other exactly as it was.
     */
    captainDmcPerUsdt: z.number().positive().max(1_000_000).optional(),
    partyDmcPerUsdt: z.number().positive().max(1_000_000).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one setting to update',
  });

export const captainIdParamSchema = z.object({ captainId: objectIdSchema });

/**
 * A settings version is a small positive integer, not an id. Coerced because
 * it arrives as a path string, and bounded so a nonsense path is refused
 * before it becomes a database query.
 */
export const settingsVersionParamSchema = z.object({
  version: z.coerce.number().int().min(1).max(1_000_000),
});
export const userIdParamSchema = z.object({ userId: objectIdSchema });

export const auditLogQuerySchema = paginationSchema.extend({
  action: z.enum(AUDIT_ACTIONS).optional(),
  role: z.enum(ROLES).optional(),
  userId: objectIdSchema.optional(),
  targetId: z.string().trim().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const userStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
});

export const partyIdParamSchema = z.object({ partyId: objectIdSchema });

export const createPartySchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is too short').max(160),
  contactEmail: z.string().trim().toLowerCase().email('Enter a valid email address'),
});

export const updatePartyLimitsSchema = z
  .object({
    dailyLimit: z.union([rupeeAmountSchema, z.null()]).optional(),
    monthlyLimit: z.union([rupeeAmountSchema, z.null()]).optional(),
    /**
     * What this party is charged, per direction. Null hands them back to the
     * SystemConfig default; zero charges them nothing, deliberately.
     *
     * Null first in the union for the same reason as the captain's ceiling
     * above: z.coerce.number() turns null into 0, and a union takes the first
     * branch that matches — so with the number first, clearing an override
     * would silently pin the party to free service instead.
     */
    payInPartyCommissionPercentage: z.union([z.null(), z.coerce.number().min(0).max(100)]).optional(),
    payOutPartyCommissionPercentage: z.union([z.null(), z.coerce.number().min(0).max(100)]).optional(),
    /**
     * The deadlines this party's tasks run on. Null hands that clock back to
     * the SystemConfig default; each of the four falls back on its own.
     *
     * There is no zero here, unlike the commission rates above: a window of no
     * time is not an arrangement anybody wants, it is a task that expires
     * before a captain can read it.
     */
    acceptanceMinutes: z.union([z.null(), z.coerce.number().int().min(1).max(1440)]).optional(),
    completionMinutes: z.union([z.null(), z.coerce.number().int().min(1).max(1440)]).optional(),
    maxAgeMinutes: z.union([z.null(), z.coerce.number().int().min(1).max(10080)]).optional(),
    expiryAckMinutes: z.union([z.null(), z.coerce.number().int().min(1).max(1440)]).optional(),
  })
  .refine(
    (v) =>
      v.dailyLimit !== undefined ||
      v.monthlyLimit !== undefined ||
      v.payInPartyCommissionPercentage !== undefined ||
      v.payOutPartyCommissionPercentage !== undefined ||
      v.acceptanceMinutes !== undefined ||
      v.completionMinutes !== undefined ||
      v.maxAgeMinutes !== undefined ||
      v.expiryAckMinutes !== undefined,
    { message: 'Provide at least one field to update' },
  );

export const updateCaptainProfileSchema = z
  .object({
    displayName: z.string().trim().min(2, 'Name is too short').max(120).optional(),
    dailyLimit: z.union([rupeeAmountSchema, z.null()]).optional(),
    monthlyLimit: z.union([rupeeAmountSchema, z.null()]).optional(),
    /**
     * The ceiling on live work, standing in for the captain's collateral.
     * Null puts them back on their collateral, which is where they start.
     * Zero is a real value — it stops them claiming without touching a rupee
     * of the security they posted.
     */
    // Null first: z.coerce.number() happily turns null into 0, and a union
    // takes the first branch that matches — so with the number first, clearing
    // the ceiling silently pinned the captain to zero instead of handing them
    // back their collateral.
    creditLimit: z.union([z.null(), z.coerce.number().min(0)]).optional(),
    /**
     * How much to move the ceiling by, rather than what to move it to.
     *
     * This is how admin grants more room in practice: they decide the
     * captain has earned another 2,000, not that the captain's ceiling
     * should now read 2,000. Sending the total instead meant admin had to
     * read the current figure, add to it themselves, and type the sum —
     * and a stale screen then silently cut the ceiling instead of raising
     * it. Negative is allowed so a grant can be taken back the same way.
     */
    creditLimitAdd: z.coerce.number().finite().optional(),
    /**
     * What this captain is paid, per direction. Null hands them back to the
     * SystemConfig default; zero means they work that direction for nothing.
     * Never a party rate — what a party is charged is set on the party.
     */
    payInCaptainCommissionPercentage: z.union([z.null(), z.coerce.number().min(0).max(100)]).optional(),
    payOutCaptainCommissionPercentage: z.union([z.null(), z.coerce.number().min(0).max(100)]).optional(),
  })
  .refine(
    (v) =>
      v.displayName !== undefined ||
      v.dailyLimit !== undefined ||
      v.monthlyLimit !== undefined ||
      v.creditLimit !== undefined ||
      v.creditLimitAdd !== undefined ||
      v.payInCaptainCommissionPercentage !== undefined ||
      v.payOutCaptainCommissionPercentage !== undefined,
    { message: 'Provide at least one field to update' },
  )
  .refine((v) => !(v.creditLimit !== undefined && v.creditLimitAdd !== undefined), {
    message: 'Send either a new limit or an amount to add, not both',
    path: ['creditLimitAdd'],
  });

/**
 * Adding a USDT deposit address.
 *
 * Deliberately not validated against a TRON address format. The demo runs on
 * placeholders, and a format check would reject them — and a real address that
 * passes a regex is not thereby correct, so the check would buy confidence it
 * cannot justify. An administrator pastes what their wallet gave them.
 */
export const addDepositAddressSchema = z.object({
  address: z.string().trim().min(4, 'Address is too short').max(120),
  label: z.string().trim().max(80).optional(),
});

export const depositAddressParamSchema = z.object({
  address: z.string().trim().min(4).max(120),
});

/** Retiring or reinstating one. Retired addresses are kept, never deleted. */
export const setDepositAddressActiveSchema = z.object({
  active: z.boolean(),
});

/**
 * An administrator issuing a party's API key.
 *
 * The same two fields the party's own form takes, because it is the same
 * operation reached through a different door.
 */
export const createPartyApiKeySchema = z.object({
  label: z.string().trim().min(1, 'Give the key a name so you can tell them apart').max(80),
  callbackUrl: z.string().url('Enter a full URL, starting https://').max(500).optional(),
});

export const partyApiKeyParamSchema = z.object({
  partyId: z.string().trim().length(24, 'Invalid party id'),
  keyId: z.string().trim().min(8).max(64),
});

/** Null clears it, which is how a party with no endpoint yet is represented. */
export const updateCallbackUrlSchema = z.object({
  callbackUrl: z.union([z.string().url('Enter a full URL, starting https://').max(500), z.null()]),
});

/**
 * The secret for the PDF, if the administrator still has it on screen.
 *
 * Optional on purpose: a download taken later produces a correct document with
 * the credential left out, rather than failing.
 */
export const integrationPdfSchema = z.object({
  secret: z.string().trim().min(16).max(256).optional(),
});
