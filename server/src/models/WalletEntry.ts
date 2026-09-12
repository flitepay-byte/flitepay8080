import { Schema, model, type Document, type Types } from 'mongoose';

export const WALLET_ENTRY_KINDS = ['COMMISSION_EARNED', 'CONVERTED_TO_CAPITAL'] as const;
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];

/**
 * Every movement in and out of a captain's commission wallet.
 *
 * The wallet is a running balance, and a running balance with no history
 * behind it cannot be checked or argued with: "you earned ₹4,000 this week" is
 * not a claim anybody can verify, and an audit cannot tell a wallet that is
 * merely surprising from one that is wrong. So each movement is written down
 * as it happens, and the balance is derivable from the entries rather than
 * only from itself.
 *
 * There are exactly two kinds. Commission comes in from the platform's funded
 * pool; conversion takes it out into working capital. Nothing else touches the
 * wallet — in particular a security deposit never does, because a deposit is
 * money the captain put in rather than profit they made.
 *
 * Rows are immutable: a wallet movement is an event, not a request, so it has
 * no state to move through and nothing to correct after the fact. A mistake is
 * fixed by a compensating entry, never by editing history.
 */
export interface IWalletEntry extends Document {
  _id: Types.ObjectId;
  captainId: Types.ObjectId;
  kind: WalletEntryKind;
  /** Always positive. `kind` says which way it moved. */
  amountPaise: number;
  /** The wallet immediately after, so a row reads without replaying the rest. */
  walletBalanceAfterPaise: number;
  /**
   * Working capital immediately after — only meaningful for a conversion,
   * which is the one kind that touches both balances at once.
   */
  dmcBalanceAfterPaise?: number | null;
  /** What earned it: the pay-in or pay-out this commission came from. */
  sourceReference?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const walletEntrySchema = new Schema<IWalletEntry>(
  {
    captainId: { type: Schema.Types.ObjectId, ref: 'Captain', required: true, index: true },
    kind: { type: String, enum: WALLET_ENTRY_KINDS, required: true },
    amountPaise: {
      type: Number,
      required: true,
      min: [1, 'A wallet movement must be greater than zero'],
      validate: { validator: Number.isInteger, message: 'amountPaise must be an integer (paise)' },
    },
    walletBalanceAfterPaise: { type: Number, required: true, min: 0 },
    dmcBalanceAfterPaise: { type: Number, default: null, min: 0 },
    sourceReference: { type: String, default: null, trim: true, maxlength: 64 },
  },
  { timestamps: true },
);

walletEntrySchema.index({ captainId: 1, createdAt: -1 });

const IMMUTABLE = 'Wallet entries are a ledger and cannot be modified or removed.';
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany'] as const) {
  walletEntrySchema.pre(op, function reject() {
    throw new Error(IMMUTABLE);
  });
}

export const WalletEntry = model<IWalletEntry>('WalletEntry', walletEntrySchema);
