import { Schema, model, type Document, type Types } from 'mongoose';
import {
  TRANSACTION_DIRECTIONS,
  TRANSACTION_STATES,
  type TransactionDirection,
  type TransactionState,
} from '../types/transaction';

/**
 * One payment a party's customer makes or receives through us.
 *
 * See types/transaction.ts for what the two directions mean and why each one
 * holds the DMC it holds. This file is the record: what the party asked for,
 * who is carrying it, what actually happened, and enough of a trail that any
 * of it can be argued about afterwards.
 *
 * The party's own reference is the anchor. Their users live in their system,
 * not ours, so `partyReference` is how a row here is matched to an order over
 * there — and it is unique per party, which is what makes a retried API call
 * idempotent rather than a second payment.
 */
export interface ITransactionStateChange {
  from: TransactionState | null;
  to: TransactionState;
  at: Date;
  by?: Types.ObjectId | null;
  reason?: string | null;
}

export interface ITransaction extends Document {
  _id: Types.ObjectId;
  transactionCode: string;
  direction: TransactionDirection;
  partyId: Types.ObjectId;
  captainId?: Types.ObjectId | null;

  /**
   * The party's own id for this payment. Unique per party, so the same call
   * made twice — a retry, a double-click, a webhook replay — resolves to this
   * one row instead of creating a second payment.
   */
  partyReference: string;

  /** Exactly what the customer pays or receives. No fee is taken from it. */
  amountPaise: number;

  /**
   * BOTH SIDES OF THE COMMISSION, LOCKED AT CREATION.
   *
   * `partyCommissionPaise` is what the party is charged on top of the amount;
   * it goes to the pool. `commissionPaise` is what the captain is paid out of
   * that pool. The difference is the platform's, and is never stored — it is
   * simply what nobody took, which is the only way the three can never fail to
   * add up.
   *
   * Both are fixed when the transaction is created and never recomputed. A
   * rate changed afterwards must not alter what either side was already
   * promised.
   */
  partyCommissionPaise: number;
  commissionPaise: number;
  partyCommissionRate: number;
  /** The rate the captain was actually paid at — see commission.service.ts. */
  commissionRate: number;
  /**
   * What admin had agreed with the captain, before the cap.
   *
   * Equal to the paid rate above on almost every row. It differs when this
   * party is charged less than the captain is promised, and then this is the
   * only record that the shortfall was a cap rather than a mistake — which is
   * exactly what a captain querying their pay will want answered.
   */
  commissionRateAgreed: number;
  commissionConfigVersion: number;
  /** False when the pool could not cover it — the captain is owed, unpaid. */
  commissionPaid: boolean;

  status: TransactionState;
  stateHistory: ITransactionStateChange[];

  /**
   * PAY_OUT only: where the party wants the money sent. Supplied by the party
   * in the API call, because the customer is theirs and not ours — we store it
   * because the captain has to be told where to transfer, and because a
   * dispute about a payout is a dispute about this.
   */
  beneficiaryName?: string | null;
  beneficiaryUpiId?: string | null;
  beneficiaryAccountNumber?: string | null;
  beneficiaryIfsc?: string | null;

  /** PAY_IN only: what the customer scans, and what the gateway called it. */
  gatewayOrderId?: string | null;
  gatewayQrPayload?: string | null;

  /**
   * The proof that real money moved: the gateway's reference for a pay-in, the
   * captain's UTR for a pay-out.
   */
  settlementReference?: string | null;
  confirmedAt?: Date | null;
  settledAt?: Date | null;

  disputeReason?: string | null;
  failureReason?: string | null;

  /** Everyone who has held it, so a re-routed transaction is not offered back. */
  previousCaptainIds: Types.ObjectId[];

  /** When the customer's side stops being valid. */
  expiresAt: Date;

  /** Where the party wants to be told the outcome, and how that is going. */
  /**
   * The API key whose call created this, kept so a retried callback goes back to
   * the same key and the same callback URL.
   *
   * Null for anything not created through the partner API — a task a party
   * raised from its dashboard has no key behind it and nothing to call back to.
   *
   * Without this a retry had to pick any of the party's live keys, which for a
   * party running staging and production side by side meant a production retry
   * could be delivered to the staging endpoint.
   */
  createdByKeyId?: string | null;
  callbackUrl?: string | null;
  callbackDeliveredAt?: Date | null;
  callbackAttempts: number;
  callbackLastError?: string | null;

  createdAt: Date;
  updatedAt: Date;
}

const stateChangeSchema = new Schema<ITransactionStateChange>(
  {
    from: { type: String, enum: [...TRANSACTION_STATES, null], default: null },
    to: { type: String, enum: TRANSACTION_STATES, required: true },
    at: { type: Date, required: true, default: Date.now },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, default: null, maxlength: 500 },
  },
  { _id: false },
);

const transactionSchema = new Schema<ITransaction>(
  {
    transactionCode: { type: String, required: true, unique: true, uppercase: true, trim: true },
    direction: { type: String, enum: TRANSACTION_DIRECTIONS, required: true, index: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true, index: true },
    captainId: { type: Schema.Types.ObjectId, ref: 'Captain', default: null, index: true },

    partyReference: { type: String, required: true, trim: true, maxlength: 120 },

    amountPaise: {
      type: Number,
      required: true,
      min: [1, 'Amount must be greater than zero'],
      validate: { validator: Number.isInteger, message: 'amountPaise must be an integer (paise)' },
    },

    partyCommissionPaise: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'partyCommissionPaise must be an integer (paise)' },
    },
    commissionPaise: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'commissionPaise must be an integer (paise)' },
    },
    partyCommissionRate: { type: Number, required: true, default: 0, min: 0 },
    commissionRate: { type: Number, required: true, default: 0, min: 0 },
    commissionRateAgreed: { type: Number, required: true, default: 0, min: 0 },
    commissionConfigVersion: { type: Number, required: true, default: 0 },
    commissionPaid: { type: Boolean, required: true, default: false },

    status: { type: String, enum: TRANSACTION_STATES, required: true, default: 'CREATED', index: true },
    stateHistory: { type: [stateChangeSchema], default: [] },

    beneficiaryName: { type: String, default: null, trim: true, maxlength: 120 },
    beneficiaryUpiId: { type: String, default: null, trim: true, maxlength: 120 },
    beneficiaryAccountNumber: { type: String, default: null, trim: true, maxlength: 40 },
    beneficiaryIfsc: { type: String, default: null, trim: true, uppercase: true, maxlength: 20 },

    gatewayOrderId: { type: String, default: null, trim: true, maxlength: 120, index: true },
    gatewayQrPayload: { type: String, default: null, maxlength: 2000 },

    settlementReference: { type: String, default: null, trim: true, maxlength: 120 },
    confirmedAt: { type: Date, default: null },
    settledAt: { type: Date, default: null },

    disputeReason: { type: String, default: null, maxlength: 500 },
    failureReason: { type: String, default: null, maxlength: 500 },

    previousCaptainIds: { type: [Schema.Types.ObjectId], ref: 'Captain', default: [] },

    expiresAt: { type: Date, required: true, index: true },

    createdByKeyId: { type: String, default: null, index: true },
    callbackUrl: { type: String, default: null, maxlength: 500 },
    callbackDeliveredAt: { type: Date, default: null },
    callbackAttempts: { type: Number, required: true, default: 0, min: 0 },
    callbackLastError: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true },
);

/**
 * One row per party reference. This index is the idempotency guarantee: a
 * party that sends the same order twice gets the same transaction back rather
 * than a second payment, and no application check can be forgotten around it.
 */
transactionSchema.index({ partyId: 1, partyReference: 1 }, { unique: true });
transactionSchema.index({ status: 1, createdAt: 1 });
transactionSchema.index({ captainId: 1, status: 1 });
transactionSchema.index({ direction: 1, status: 1, expiresAt: 1 });

export const Transaction = model<ITransaction>('Transaction', transactionSchema);
