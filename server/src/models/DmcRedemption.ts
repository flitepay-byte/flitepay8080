import { Schema, model, type Document, type Types } from 'mongoose';

export const REDEMPTION_STATUSES = ['PENDING', 'PAID', 'REJECTED'] as const;
export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];

/**
 * A captain turning DMC back into real rupees.
 *
 * This is the only door out of the system, and it is the mirror of a security
 * deposit: real money left the captain to create DMC, and here real money goes
 * back to them and that DMC is destroyed. Because a rupee has to physically
 * move — a bank transfer somebody makes by hand — admin is the side that
 * confirms it, exactly as admin confirms the money arriving on the way in. A
 * captain cannot mark their own payment as received.
 *
 * The DMC is taken out of the captain's balance the moment they ask, not when
 * admin pays. Leaving it spendable while the request sits in the queue would
 * let a captain ask for ₹10,000 in cash and spend the same ₹10,000 on a
 * pay-in before admin got to it, and the platform would have paid out money
 * twice against one balance. Held here, it is out of reach but not yet gone:
 * a rejected request gives every paise back.
 */
export interface IDmcRedemption extends Document {
  _id: Types.ObjectId;
  captainId: Types.ObjectId;
  /** Held out of the captain's DMC balance from the moment the request is made. */
  amountPaise: number;
  /**
   * How much of this withdrawal came out of retained commission rather than
   * working capital.
   *
   * Recorded because it has to be given back exactly if the request is
   * refused. Current Limit subtracts retained fee, so refunding the balance
   * without restoring this would leave the captain able to take on work
   * backed by profit they did not, in the end, withdraw.
   */
  commissionConsumedPaise: number;
  status: RedemptionStatus;

  /** Where the captain wants the rupees sent. Admin needs it to pay. */
  payoutMethod: 'UPI' | 'BANK';
  payoutUpiId?: string | null;
  payoutAccountName?: string | null;
  payoutAccountNumber?: string | null;
  payoutIfsc?: string | null;

  /** What admin entered after actually sending the money. */
  paymentReference?: string | null;
  paymentNotes?: string | null;

  rejectionReason?: string | null;
  decidedBy?: Types.ObjectId | null;
  decidedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const dmcRedemptionSchema = new Schema<IDmcRedemption>(
  {
    captainId: { type: Schema.Types.ObjectId, ref: 'Captain', required: true, index: true },
    amountPaise: {
      type: Number,
      required: true,
      min: [1, 'Redemption amount must be greater than zero'],
      validate: { validator: Number.isInteger, message: 'amountPaise must be an integer (paise)' },
    },
    commissionConsumedPaise: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'commissionConsumedPaise must be an integer (paise)' },
    },
    status: { type: String, enum: REDEMPTION_STATUSES, required: true, default: 'PENDING', index: true },

    payoutMethod: { type: String, enum: ['UPI', 'BANK'], required: true },
    payoutUpiId: { type: String, default: null, trim: true, maxlength: 120 },
    payoutAccountName: { type: String, default: null, trim: true, maxlength: 120 },
    payoutAccountNumber: { type: String, default: null, trim: true, maxlength: 40 },
    payoutIfsc: { type: String, default: null, trim: true, uppercase: true, maxlength: 20 },

    paymentReference: { type: String, default: null, trim: true, maxlength: 64 },
    paymentNotes: { type: String, default: null, maxlength: 500 },

    rejectionReason: { type: String, default: null, maxlength: 500 },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

dmcRedemptionSchema.index({ status: 1, createdAt: 1 });
dmcRedemptionSchema.index({ captainId: 1, createdAt: -1 });

export const DmcRedemption = model<IDmcRedemption>('DmcRedemption', dmcRedemptionSchema);
