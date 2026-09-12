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
export const TOPUP_STATUSES = ['AWAITING_PAYMENT', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type TopUpStatus = (typeof TOPUP_STATUSES)[number];

/**
 * A party topping up its DMC (task-creation) balance beyond the one-time
 * registration grant. Unlike a captain's self-service "Buy DMC" (an
 * instant simulated credit), this is real security money changing hands —
 * the party sends it to the platform's own account, so admin, not the
 * party, has to actually confirm receipt before any balance moves.
 */
export interface IPartyTopUpRequest extends Document {
  _id: Types.ObjectId;
  partyId: Types.ObjectId;
  amountPaise: number;
  status: TopUpStatus;

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

const partyTopUpRequestSchema = new Schema<IPartyTopUpRequest>(
  {
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    amountPaise: {
      type: Number,
      required: true,
      min: [1, 'Top-up amount must be greater than zero'],
      validate: {
        validator: Number.isInteger,
        message: 'amountPaise must be an integer (paise)',
      },
    },
    status: { type: String, enum: TOPUP_STATUSES, required: true, default: 'PENDING', index: true },

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

partyTopUpRequestSchema.index({ status: 1, createdAt: 1 });
partyTopUpRequestSchema.index({ partyId: 1, createdAt: -1 });

export const PartyTopUpRequest = model<IPartyTopUpRequest>('PartyTopUpRequest', partyTopUpRequestSchema);
