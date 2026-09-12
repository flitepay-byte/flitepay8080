import { Schema, model, type Document, type Types } from 'mongoose';

export interface ICaptain extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  captainCode: string;
  displayName: string;
  /** Total simulated collateral posted, in paise. */
  collateralBalancePaise: number;
  /** Sum of amounts locked against in-flight tasks, in paise. */
  lockedAmountPaise: number;
  /**
   * The captain's money, and the thing that decides how much they can do.
   *
   * There used to be three numbers here: capital, a separate wallet that
   * commission landed in, and a third holding what had been earned and not
   * yet cashed out. Nobody could say what distinguished them, because nothing
   * did — every one of them was DMC the captain owned. So there is one.
   *
   * A pay-in *spends* it: the captain receives the customer's real money and
   * gives up the matching DMC, so a captain with 10,000 DMC can receive at
   * most ₹10,000 before they are out. A pay-out *earns* it back: they hand
   * over real cash and take the DMC in exchange. Commission earned on either
   * lands here too, which is why the captain's percentage is worth having:
   * it is capacity to do more work, not a number in a second pocket.
   *
   * That symmetry is the point. A captain who only ever takes pay-ins runs
   * dry and stops; one who only takes pay-outs accumulates DMC they must
   * redeem. Keeping both flowing is what keeps a captain in business, and the
   * balance here is the number that says so.
   *
   * Collateral stays separate, and stays out of this: it is security the
   * captain posted, not money they may spend.
   */
  dmcBalancePaise: number;
  /**
   * Everything this captain has ever earned in commission.
   *
   * Kept so capacity can be told apart from wealth. A captain's DMC rises with
   * every fee they earn, but earning a fee does not let them take on more work
   * than their security backs — capacity is capital, and commission is profit.
   * Subtracting this from the balance is what makes "how much more can I take"
   * a different number from "how much do I have".
   */
  /**
   * Earned fee still sitting in this captain's DMC balance.
   *
   * Not a lifetime total. A withdrawal spends it before it spends working
   * capital, and a refused withdrawal puts it back. Current Limit subtracts it
   * because profit held in the balance is not capacity — but profit already
   * taken home must not be subtracted a second time, which is exactly what a
   * lifetime figure did. The permanent record of everything ever earned is the
   * WalletEntry ledger, not this counter.
   */
  commissionEarnedTotalPaise: number;
  /**
   * An admin-set ceiling on what this captain may hold in live work, in place
   * of their posted collateral.
   *
   * Null — the normal case — means the collateral itself is the limit, which
   * is where every captain starts. Setting it lets admin extend trust to a
   * proven captain beyond the security they posted, or pull a shaky one back
   * without touching their money. Either way the collateral is untouched: it
   * is the captain's, and a limit decision is not a reason to move it.
   */
  creditLimitPaise?: number | null;
  /**
   * WHERE THIS CAPTAIN IS PAID
   *
   * A list, because a captain may hold several merchant accounts and move
   * between them. Exactly one is active at a time, and the active one is where
   * every new withdrawal goes.
   *
   * The single-active rule is enforced by the write in captainUpi.service.ts —
   * activating one deactivates the rest in the same operation — rather than by
   * asking callers to remember. A rule that depends on being remembered is a
   * rule that eventually is not.
   *
   * Only merchant UPI IDs belong here. That is a business requirement rather
   * than something a format can check, so the screens say it plainly and an
   * administrator verifies it when they pay.
   */
  merchantUpiIds: { upiId: string; label?: string | null; active: boolean; addedAt: Date }[];
  isOnline: boolean;
  status: 'ACTIVE' | 'SUSPENDED';
  /** Per-captain overrides; null means "inherit from SystemConfig". */
  dailyLimitPaise?: number | null;
  monthlyLimitPaise?: number | null;
  /**
   * What this captain is paid, per direction, as a percentage of the amount.
   * Null means the SystemConfig default. Zero is a real setting, distinct
   * from null: it means this captain works this direction for nothing.
   *
   * A captain's share is still capped by what their party was charged, so a
   * generous rate here cannot promise money the pool never received — the cap
   * lives in commission.service.ts, where both halves meet.
   */
  payInCaptainCommissionPercentage?: number | null;
  payOutCaptainCommissionPercentage?: number | null;
  lastSeenAt?: Date | null;
  /**
   * When this captain was last offered a task. Used to break scoring ties in
   * taskRouting.service.ts: among equally-rated captains the one who has gone
   * longest without an offer wins, so identical captains rotate instead of the
   * oldest account taking every task.
   */
  lastOfferedAt?: Date | null;

  /**
   * PERFORMANCE COUNTERS — the raw inputs to the rating (see
   * captainRating.service.ts, which owns the formula). Stored as running
   * totals rather than recomputed from the task history on every read, since
   * routing scores every eligible captain on every offer.
   */
  totalTasksCompleted: number;
  /** Finished inside the allowed completion window — the basis of the "On time" badge. */
  totalTasksOnTime: number;
  /** Claimed but never finished before the deadline. */
  totalTasksExpired: number;
  /** Proof the party rejected, whatever admin later decided. */
  totalProofsRejected: number;
  /** Party rejected the proof AND admin upheld it — the heaviest signal there is. */
  totalRejectionsUpheldByAdmin: number;
  /** Offers that lapsed unanswered, so the task had to be routed elsewhere. */
  totalOffersMissed: number;
  /** Offers accepted, and the total seconds taken to accept them — together these give mean response time. */
  totalOffersAccepted: number;
  totalAcceptSeconds: number;

  /** Denormalised 0–5 rating, recomputed whenever a counter above moves. */
  rating: number;

  createdAt: Date;
  updatedAt: Date;
  readonly availableLimitPaise: number;
}

const captainSchema = new Schema<ICaptain>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    captainCode: { type: String, required: true, unique: true, uppercase: true, trim: true },
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
    collateralBalancePaise: { type: Number, required: true, default: 0, min: 0 },
    lockedAmountPaise: { type: Number, required: true, default: 0, min: 0 },
    // Both guarded at zero. A captain cannot receive money they have no DMC to
    // back, and cannot spend commission they have not earned.
    dmcBalancePaise: { type: Number, required: true, default: 0, min: 0 },
    commissionEarnedTotalPaise: { type: Number, required: true, default: 0, min: 0 },
    creditLimitPaise: { type: Number, default: null, min: 0 },
    merchantUpiIds: {
      type: [
        new Schema(
          {
            upiId: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
            label: { type: String, default: null, trim: true, maxlength: 80 },
            active: { type: Boolean, default: false },
            addedAt: { type: Date, default: Date.now },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    isOnline: { type: Boolean, default: false, index: true },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE', index: true },
    dailyLimitPaise: { type: Number, default: null, min: 0 },
    monthlyLimitPaise: { type: Number, default: null, min: 0 },
    payInCaptainCommissionPercentage: { type: Number, default: null, min: 0, max: 100 },
    payOutCaptainCommissionPercentage: { type: Number, default: null, min: 0, max: 100 },
    lastSeenAt: { type: Date, default: null },
    lastOfferedAt: { type: Date, default: null },

    totalTasksCompleted: { type: Number, default: 0, min: 0 },
    totalTasksOnTime: { type: Number, default: 0, min: 0 },
    totalTasksExpired: { type: Number, default: 0, min: 0 },
    totalProofsRejected: { type: Number, default: 0, min: 0 },
    totalRejectionsUpheldByAdmin: { type: Number, default: 0, min: 0 },
    totalOffersMissed: { type: Number, default: 0, min: 0 },
    totalOffersAccepted: { type: Number, default: 0, min: 0 },
    totalAcceptSeconds: { type: Number, default: 0, min: 0 },

    // Seeded at the neutral prior in captainRating.service.ts, so a brand-new
    // captain is neither favoured nor buried before they have a record.
    rating: { type: Number, default: 3.5, min: 0, max: 5 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    // Guards against lost updates on collateral fields.
    optimisticConcurrency: true,
  },
);

/**
 * availableLimit = (creditLimit ?? collateralBalance) - lockedAmount
 *
 * Derived, never stored, so it cannot drift out of sync with its inputs. The
 * admin override stands in for the collateral in this sum and nowhere else —
 * the collateral balance is the captain's money and is never rewritten to
 * express a limit decision.
 */
captainSchema.virtual('availableLimitPaise').get(function (this: ICaptain): number {
  return (this.creditLimitPaise ?? this.collateralBalancePaise) - this.lockedAmountPaise;
});

// Query pattern: find online, active captains for task broadcast.
captainSchema.index({ isOnline: 1, status: 1 });
// Routing scans online+active captains best-rated first; see taskRouting.service.ts.
captainSchema.index({ isOnline: 1, status: 1, rating: -1 });

export const Captain = model<ICaptain>('Captain', captainSchema);
