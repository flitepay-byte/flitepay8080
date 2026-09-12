import { Schema, model, type Document } from 'mongoose';

/**
 * The platform's balance. Kept separate from SystemConfig, which holds
 * settings, not money: this is a mutable balance, that is immutable
 * configuration.
 *
 * There is one, and it is the pool. Admin funds it with real money, every
 * party's commission flows into it, and every captain's share is paid out of
 * it — so what is left in it is the platform's, without ever being computed
 * as a separate figure. That is the property worth having: the party's charge,
 * the captain's share and the platform's remainder cannot disagree, because
 * only two of them are ever written and the third is what is left.
 *
 * There used to be a second balance holding "commission earned", credited
 * beside the pool at completion. It said the same thing twice and the two
 * could drift, so it is gone.
 *
 * Because it is one pot, it drains as well as fills, and the rate it drains at
 * is the platform's actual cost of running. It is the one balance admin has to
 * watch: when it empties, captain commissions stop being payable.
 */
export interface IPlatformAccount extends Document {
  key: 'GLOBAL';
  /**
   * Admin-funded DMC plus every party commission collected, less every
   * captain share paid out. What remains is what the platform has made.
   */
  poolBalancePaise: number;
  /** Everything ever funded into the pool, so spend can be read off against it. */
  poolFundedTotalPaise: number;
  createdAt: Date;
  updatedAt: Date;
}

const platformAccountSchema = new Schema<IPlatformAccount>(
  {
    key: { type: String, enum: ['GLOBAL'], default: 'GLOBAL', unique: true, required: true },
    // Guarded at zero: a commission that would overdraw the pool must be
    // refused, not allowed to go negative and invent DMC.
    poolBalancePaise: { type: Number, required: true, default: 0, min: 0 },
    poolFundedTotalPaise: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, optimisticConcurrency: true },
);

export const PlatformAccount = model<IPlatformAccount>('PlatformAccount', platformAccountSchema);
