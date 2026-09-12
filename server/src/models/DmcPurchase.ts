import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * `AWAITING_PAYMENT` is a draft: quoted, with an address assigned, and not yet
 * paid. It exists so that pressing Pay puts nothing in front of an
 * administrator — every query that looks for work filters on PENDING, so a
 * draft is invisible to all of them without any of them being changed.
 *
 * A request becomes PENDING when the payer submits the transaction reference,
 * and from there the approval flow is exactly what it always was.
 */
export const DEPOSIT_STATUSES = ['AWAITING_PAYMENT', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

/**
 * A captain posting security money to raise their collateral.
 *
 * This is real money leaving the captain and arriving at the platform, so it
 * is a request rather than a purchase: the captain says what they sent and
 * attaches proof, and nothing moves until admin confirms the money actually
 * arrived. The same handshake a party top-up goes through, for the same
 * reason — the side that receives the money is the side that confirms it.
 *
 * It used to be an instant self-service credit, which meant a captain could
 * raise their own collateral without anyone checking that a rupee had moved.
 *
 * A deposit lands in two places: part is locked as security and part becomes
 * working capital the captain can trade with. The split is recorded on the row
 * itself rather than only derived from the current settings, because the
 * percentage is an admin setting that can change — without this, nothing would
 * say how a deposit taken last month was actually split, and a dispute about
 * it could not be settled from the records.
 *
 * Neither half is earnings. A captain's withdrawable balance is only ever made
 * by completing work, never bought.
 */
export interface IDmcPurchase extends Document {
  _id: Types.ObjectId;
  captainId: Types.ObjectId;
  amountPaise: number;
  securityPaise: number;
  balancePaise: number;
  /** How the security was split when admin approved it. Absent while pending. */
  collateralCreditedPaise?: number | null;
  dmcCreditedPaise?: number | null;
  simulatedPaymentRef: string;
  status: DepositStatus;

  /**
   * THE PAYMENT, AS IT WAS QUOTED
   *
   * Address, network, rate and USDT amount are all written when the request is
   * created and never afterwards. An administrator changing a rate or retiring an
   * address must not alter what somebody was already told to pay, and a transfer
   * arriving at an address has to map back to exactly one request.
   */
  depositAddress?: string | null;
  depositNetwork?: string | null;
  /** Paise of DMC per USDT, as applied to this request. */
  dmcPaisePerUsdt?: number | null;
  usdtAmountMicros?: number | null;
  /**
   * When the payer said they had sent it. Not a credit and not a verification —
   * it only means there is now a reference for an administrator to check.
   */
  markedPaidAt?: Date | null;
  /** Supplied when the payer marks the request paid, not when it is created. */
  proofReference?: string | null;
  proofNotes?: string | null;
  proofReceiptUrl?: string | null;
  proofReceiptFileName?: string | null;
  proofReceiptMimeType?: string | null;

  rejectionReason?: string | null;
  decidedBy?: Types.ObjectId | null;
  decidedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const dmcPurchaseSchema = new Schema<IDmcPurchase>(
  {
    captainId: { type: Schema.Types.ObjectId, ref: 'Captain', required: true },
    amountPaise: {
      type: Number,
      required: true,
      min: [1, 'Deposit amount must be greater than zero'],
      validate: {
        validator: Number.isInteger,
        message: 'amountPaise must be an integer (paise)',
      },
    },
    securityPaise: { type: Number, required: true, min: 0 },
    balancePaise: { type: Number, required: true, min: 0 },
    collateralCreditedPaise: { type: Number, default: null, min: 0 },
    dmcCreditedPaise: { type: Number, default: null, min: 0 },
    simulatedPaymentRef: { type: String, required: true, trim: true, maxlength: 64 },
    status: { type: String, enum: DEPOSIT_STATUSES, required: true, default: 'PENDING', index: true },

    // What the captain says they sent. Admin checks this against the platform
    // account before crediting anything.
    depositAddress: { type: String, default: null, trim: true, maxlength: 120 },
    depositNetwork: { type: String, default: null, trim: true, maxlength: 40 },
    dmcPaisePerUsdt: { type: Number, default: null, min: 1 },
    usdtAmountMicros: { type: Number, default: null, min: 0 },
    markedPaidAt: { type: Date, default: null },
    proofReference: { type: String, default: null, trim: true, maxlength: 200 },
    proofNotes: { type: String, default: null, maxlength: 500 },
    proofReceiptUrl: { type: String, default: null },
    proofReceiptFileName: { type: String, default: null },
    proofReceiptMimeType: { type: String, default: null },

    rejectionReason: { type: String, default: null, maxlength: 500 },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

dmcPurchaseSchema.index({ captainId: 1, createdAt: -1 });
dmcPurchaseSchema.index({ status: 1, createdAt: 1 });

export const DmcPurchase = model<IDmcPurchase>('DmcPurchase', dmcPurchaseSchema);
