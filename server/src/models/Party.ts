import { Schema, model, type Document, type Types } from 'mongoose';

export interface IParty extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  partyCode: string;
  companyName: string;
  contactEmail: string;
  /** Optional per-party overrides; null means "inherit from SystemConfig". */
  dailyLimitPaise?: number | null;
  monthlyLimitPaise?: number | null;
  /**
   * What this party is charged, per direction, as a percentage of the amount.
   * Null means the SystemConfig default, which is where every party starts.
   *
   * Zero is a real setting and is not the same as null: it means this party is
   * charged nothing, deliberately, and must not quietly fall back to the
   * default the day someone raises it.
   *
   * Only the charge is here. What a captain earns is set on the captain, and
   * neither profile carries the other's half — see commission.service.ts.
   */
  payInPartyCommissionPercentage?: number | null;
  payOutPartyCommissionPercentage?: number | null;
  /**
   * The deadlines this party's tasks run on. Null means the SystemConfig
   * default, and each falls back on its own.
   *
   * They live here rather than on the captain because the party is the one
   * making a promise to a customer: they know what their own customers will
   * wait for, and a captain holding a longer window than the party agreed
   * would mean the promise on screen and the deadline actually enforced were
   * two different numbers. See taskClocks.service.ts.
   */
  acceptanceMinutes?: number | null;
  completionMinutes?: number | null;
  maxAgeMinutes?: number | null;
  expiryAckMinutes?: number | null;
  /**
   * DMC spending capacity for creating tasks — credited on registration and
   * on top-up (see dmcPurchase.service.ts::purchasePartyDmc), debited by the
   * full task cost (amount + both commissions) at task creation, and
   * credited back when a captain's earnings against one of this party's
   * tasks are settled via Pay In. Distinct from a captain's collateral: a
   * party's balance isn't "locked" against a specific task, it's simply
   * spent and later restored.
   */
  dmcBalancePaise: number;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: Date;
  updatedAt: Date;
}

const partySchema = new Schema<IParty>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    partyCode: { type: String, required: true, unique: true, uppercase: true, trim: true },
    companyName: { type: String, required: true, trim: true, maxlength: 160 },
    contactEmail: { type: String, required: true, lowercase: true, trim: true },
    dailyLimitPaise: { type: Number, default: null, min: 0 },
    monthlyLimitPaise: { type: Number, default: null, min: 0 },
    payInPartyCommissionPercentage: { type: Number, default: null, min: 0, max: 100 },
    payOutPartyCommissionPercentage: { type: Number, default: null, min: 0, max: 100 },
    acceptanceMinutes: { type: Number, default: null, min: 1, max: 1440 },
    completionMinutes: { type: Number, default: null, min: 1, max: 1440 },
    maxAgeMinutes: { type: Number, default: null, min: 1, max: 10080 },
    expiryAckMinutes: { type: Number, default: null, min: 1, max: 1440 },
    dmcBalancePaise: { type: Number, required: true, default: 0, min: 0 },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE', index: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

export const Party = model<IParty>('Party', partySchema);
