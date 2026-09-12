import { Schema, model, type Document, type Types } from 'mongoose';


/**
 * Singleton business configuration. Every value that a stakeholder might want
 * to change without a deploy lives here; nothing in the engines is hard-coded.
 * `version` increments on every change and is snapshotted into commission rows.
 */
export interface ISystemConfig extends Document {
  _id: Types.ObjectId;
  key: 'GLOBAL';
  version: number;

  /** Task state at which commission is credited. */
  commissionCreditState: 'COMPLETED';

  // ---------------------------------------------------------------------
  // New model. The captain earns on both directions of a payment, and the
  // two are set independently because they are not the same job: a pay-in
  // costs the captain only their float, while a pay-out costs them the effort
  // and risk of actually sending money out.
  // ---------------------------------------------------------------------
  /**
   * COMMISSION, AS FOUR PERCENTAGES.
   *
   * There are exactly two questions per direction — what the party is charged,
   * and what the captain is paid — and the difference between them is what the
   * platform keeps. Everything flows through the pool, which is what makes
   * that difference visible rather than implied:
   *
   *   party is charged  ->  pool  ->  captain is paid
   *                          |
   *                          `-> what is left is the platform's
   *
   * So a payout of 100 at 7% and 5% debits the party 107, puts 7 in the pool,
   * pays the captain 5 out of it, and leaves 2 behind. Nobody has to compute
   * the platform's cut anywhere — it is simply what nobody took.
   *
   * The rates that used to live here were a captain rate and a platform rate
   * applied side by side, with no relationship between them. That let a
   * captain be promised more than the party was ever charged, and the shortfall
   * came out of nowhere. Charging the party first and paying out of what
   * arrived makes that impossible to express.
   *
   * Percentages only. The old flat-amount modes are gone: a flat fee on a
   * payment is a percentage that changes with every amount, and having both
   * meant every screen had to explain which one was in force today.
   */
  payInPartyCommissionPercentage: number;
  payInCaptainCommissionPercentage: number;
  payOutPartyCommissionPercentage: number;
  payOutCaptainCommissionPercentage: number;
  /**
   * How much of a security deposit is locked as collateral, as a percentage.
   *
   * The rest becomes usable DMC immediately. At the default 50, a ₹20,000
   * deposit locks ₹10,000 and hands over ₹10,000 to work with — the split in
   * the specification. It is configurable because it is the platform's risk
   * dial: a higher number means more security held against every captain and
   * less capacity given, and that trade is a business decision, not a
   * constant to be edited in code.
   */
  collateralLockPercentage: number;
  /** DMC credited to a party's balance on registration (see admin.controller.ts::createParty). */
  partyRegistrationDmcPaise: number;

  captainDailyLimitPaise: number;
  captainMonthlyLimitPaise: number;
  partyDailyLimitPaise: number;
  partyMonthlyLimitPaise: number;

  minimumTaskAmountPaise: number;
  maximumTaskAmountPaise: number;

  /**
   * TASK CLOCKS. A task is offered to one captain at a time (see
   * taskRouting.service.ts): that captain has `taskAcceptanceMinutes` to
   * accept before the offer passes to the next-best captain, and once claimed
   * has `taskCompletionMinutes` to finish. `taskMaxAgeMinutes` is the hard
   * ceiling measured from task creation — past it the task expires and the
   * party is refunded, however far routing got. Any captain may override the
   * first two on their own profile; see Captain.ts.
   */
  taskAcceptanceMinutes: number;
  taskCompletionMinutes: number;
  taskMaxAgeMinutes: number;
  /**
   * Grace given to a captain whose task expired, to say why before the system
   * takes it back. Their explanation is worth waiting for, but not forever: a
   * captain who has already abandoned one task may simply never return, and
   * the task cannot sit frozen with the party's DMC tied up in it.
   */
  taskExpiryAckMinutes: number;
  /**
   * How long the party has to come back with their customer's answer after a
   * captain submits proof, before the payout approves itself.
   *
   * OTDMS never speaks to the customer — the party does, through whatever
   * channel they already use — so this is the party's window, not the
   * customer's. Long enough to reach a person, short enough that a captain
   * who has already sent real money is not left waiting indefinitely on
   * somebody who may simply never look.
   */
  customerConfirmationMinutes: number;
  otpExpiryMinutes: number;
  otpResendCooldownSeconds: number;
  otpMaxAttempts: number;
  maxFailedLoginAttempts: number;
  accountLockMinutes: number;

  /**
   * WHAT A USDT IS WORTH, IN DMC — one rate for captains, one for parties.
   *
   * Held in paise of DMC per USDT, so "1 USDT = 9.59 DMC" is 959. That reuses the
   * unit the rest of the system already stores money in rather than inventing a
   * second one to get wrong.
   *
   * The two are deliberately independent and must never be substituted for one
   * another: a captain buying capacity and a party topping up are different
   * trades on different terms, and changing one is not a statement about the
   * other. Every request snapshots whichever applied to it, so a later change
   * cannot alter what somebody was already told to pay.
   */
  captainDmcPaisePerUsdt: number;
  partyDmcPaisePerUsdt: number;
  /**
   * The TRC20 addresses payments are sent to, managed here rather than in the
   * environment so an administrator can add or retire one without a deployment.
   * Retiring sets `active` to false rather than deleting, because requests
   * already assigned to an address still have to name it.
   */
  usdtDepositAddresses: { address: string; label?: string | null; active: boolean; addedAt: Date }[];
  proofMaxFileSizeMB: number;
  proofAllowedMimeTypes: string[];

  /** Simulation knobs for MockPayoutProvider. */

  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const systemConfigSchema = new Schema<ISystemConfig>(
  {
    key: { type: String, enum: ['GLOBAL'], default: 'GLOBAL', unique: true, required: true },
    version: { type: Number, default: 1, min: 1 },

    commissionCreditState: { type: String, enum: ['COMPLETED'], default: 'COMPLETED' },
    // The platform's own cut, charged to the party on top of the captain's.
    // Mirrors the captain's shape above so the two read the same way on the
    // settings screen and in the ledger.

    // New model: 1% in, 2% out, matching the worked example in the spec.
    // All zero by default. A rate is a commercial decision, and a seeded one
    // is a decision nobody made — see the seed, which starts everything empty
    // for the same reason.
    payInPartyCommissionPercentage: { type: Number, default: 0, min: 0, max: 100 },
    payInCaptainCommissionPercentage: { type: Number, default: 0, min: 0, max: 100 },
    payOutPartyCommissionPercentage: { type: Number, default: 0, min: 0, max: 100 },
    payOutCaptainCommissionPercentage: { type: Number, default: 0, min: 0, max: 100 },
    collateralLockPercentage: { type: Number, default: 50, min: 0, max: 100 },
    partyRegistrationDmcPaise: { type: Number, default: 2_000_000, min: 0 },

    captainDailyLimitPaise: { type: Number, default: 50_000_000, min: 0 },
    captainMonthlyLimitPaise: { type: Number, default: 1_000_000_000, min: 0 },
    partyDailyLimitPaise: { type: Number, default: 100_000_000, min: 0 },
    partyMonthlyLimitPaise: { type: Number, default: 2_000_000_000, min: 0 },

    minimumTaskAmountPaise: { type: Number, default: 10_000, min: 1 },
    maximumTaskAmountPaise: { type: Number, default: 20_000_000, min: 1 },

    taskAcceptanceMinutes: { type: Number, default: 5, min: 1, max: 1440 },
    taskCompletionMinutes: { type: Number, default: 30, min: 1, max: 1440 },
    taskMaxAgeMinutes: { type: Number, default: 40, min: 1, max: 10080 },
    taskExpiryAckMinutes: { type: Number, default: 10, min: 1, max: 1440 },
    customerConfirmationMinutes: { type: Number, default: 30, min: 1, max: 1440 },
    otpExpiryMinutes: { type: Number, default: 5, min: 1, max: 60 },
    otpResendCooldownSeconds: { type: Number, default: 60, min: 10, max: 600 },
    otpMaxAttempts: { type: Number, default: 5, min: 1, max: 10 },
    maxFailedLoginAttempts: { type: Number, default: 5, min: 1, max: 20 },
    accountLockMinutes: { type: Number, default: 15, min: 1, max: 1440 },

    // 959 paise = 9.59 DMC per USDT; 1020 = 10.20. Independent by design.
    captainDmcPaisePerUsdt: { type: Number, default: 959, min: 1 },
    partyDmcPaisePerUsdt: { type: Number, default: 1020, min: 1 },
    usdtDepositAddresses: {
      type: [
        new Schema(
          {
            address: { type: String, required: true, trim: true, maxlength: 120 },
            label: { type: String, default: null, trim: true, maxlength: 80 },
            active: { type: Boolean, default: true },
            addedAt: { type: Date, default: Date.now },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    proofMaxFileSizeMB: { type: Number, default: 5, min: 1, max: 25 },
    proofAllowedMimeTypes: {
      type: [String],
      default: ['image/jpeg', 'image/png', 'application/pdf'],
    },

    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

systemConfigSchema.pre('validate', function (next) {
  if (this.minimumTaskAmountPaise > this.maximumTaskAmountPaise) {
    next(new Error('minimumTaskAmount cannot exceed maximumTaskAmount'));
    return;
  }
  next();
});

export const SystemConfig = model<ISystemConfig>('SystemConfig', systemConfigSchema);
