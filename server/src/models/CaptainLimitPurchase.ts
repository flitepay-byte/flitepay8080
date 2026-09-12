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
export const LIMIT_PURCHASE_STATUSES = ['AWAITING_PAYMENT', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type LimitPurchaseStatus = (typeof LIMIT_PURCHASE_STATUSES)[number];

/**
 * A captain buying more room to work with.
 *
 * Distinct from a security deposit, and the distinction is the whole point.
 * Security is posted once and split: half becomes collateral the captain
 * cannot spend, half becomes DMC they can. This is not that. Here the captain
 * pays for capacity directly, so the whole approved amount becomes DMC and the
 * approved ceiling rises by the same figure — and the collateral is not touched
 * at all, because no new security has been posted.
 *
 * Capped at the collateral the captain has already posted. Capacity bought
 * against nothing would be capacity with no security behind it, so the amount
 * of security they hold is the amount of extra room they may buy.
 *
 * Nothing about this row changes a balance until admin approves it. A request
 * is a claim that real money was sent, and a claim is not money: the reference
 * and the receipt are what admin checks against their own bank before deciding.
 * Pending and rejected requests move nothing, which is the same handshake every
 * other real-money inflow in this system uses.
 *
 * The figures the approval actually applied are written onto the row, so a row
 * can always answer what it did rather than what the settings said at the time.
 */
export interface ICaptainLimitPurchase extends Document {
  _id: Types.ObjectId;
  captainId: Types.ObjectId;
  /** How much extra capacity the captain is buying. */
  amountPaise: number;
  /**
   * The collateral they held when the request was made.
   *
   * Recorded because it is the cap the request was checked against. A captain
   * whose collateral falls afterwards should not have an approved request
   * silently re-judged against the newer, smaller figure — nor should a stale
   * pending request be waved through on a cap it never met.
   */
  collateralAtRequestPaise: number;

  /** What admin checks against the bank before believing any of this. */
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

  status: LimitPurchaseStatus;
  /**
   * What the approval actually credited, written by the claim that approved it.
   * Null until then — a pending request has credited nothing.
   */
  creditedPaise?: number | null;

  rejectionReason?: string | null;
  decidedBy?: Types.ObjectId | null;
  decidedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const captainLimitPurchaseSchema = new Schema<ICaptainLimitPurchase>(
  {
    captainId: { type: Schema.Types.ObjectId, ref: 'Captain', required: true, index: true },
    amountPaise: {
      type: Number,
      required: true,
      min: [1, 'Purchase amount must be greater than zero'],
      validate: { validator: Number.isInteger, message: 'amountPaise must be an integer (paise)' },
    },
    collateralAtRequestPaise: { type: Number, required: true, min: 0 },

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

    status: { type: String, enum: LIMIT_PURCHASE_STATUSES, required: true, default: 'PENDING', index: true },
    creditedPaise: { type: Number, default: null, min: 0 },

    rejectionReason: { type: String, default: null, maxlength: 500 },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The admin queue reads oldest-pending-first; a captain reads their own newest.
captainLimitPurchaseSchema.index({ status: 1, createdAt: 1 });
captainLimitPurchaseSchema.index({ captainId: 1, createdAt: -1 });

export const CaptainLimitPurchase = model<ICaptainLimitPurchase>(
  'CaptainLimitPurchase',
  captainLimitPurchaseSchema,
);
