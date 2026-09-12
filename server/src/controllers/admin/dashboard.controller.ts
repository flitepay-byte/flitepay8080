/**
 * ADMIN — DASHBOARD, TASKS AND DISPUTES
 *
 * The landing figures, the task list and detail, and the two disputes that
 * reach admin as a last resort: a contested cancellation and a rejected proof.
 * The Review queue lives here too, because it is the one screen that must show
 * everything still waiting on an admin decision.
 */
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, paginate } from '../../utils/http';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import {
  Task,
  Captain,
  Party,
  findLiveProof,
  Commission,
  AdminWithdrawalPortion,
  PartyTopUpRequest,
  DmcPurchase,
  DmcRedemption,
  Transaction,
  CaptainLimitPurchase,
  CaptainRegistration,
} from '../../models';
import * as collateral from '../../services/collateral.service';
import { getPlatformAccount } from '../../services/platformAccount.service';
import { notifyLimitUpdated, notifyCancelDisputeResolved, notifyRejectionResolved } from '../../services/notification.service';
import { resolveCancelDispute, resolveTaskRejection } from '../../services/workflow.service';
import { toTaskDto, toCaptainDto, toProofDto } from '../../utils/serializers';
import { paiseToRupees } from '../../utils/money';
import { istDayBounds } from '../../utils/dates';
import { taskSearchClause } from '../../utils/taskSearch';
import { resolveCounterparties } from '../../utils/counterpartySearch';
import { sumMovedValuePaise } from '../../utils/taskValue';
import { adminActor } from './actor';
/** Dashboard cards: system-wide counts and today's throughput. */
export const dashboard = asyncHandler(async (_req: Request, res: Response) => {
  const day = istDayBounds();

  const [statusCounts, todayAgg, captains, pendingAudits, commissionAgg, platformAccount] = await Promise.all([
    Task.aggregate<{ _id: string; count: number; totalPaise: number }>([
      { $group: { _id: '$status', count: { $sum: 1 }, totalPaise: { $sum: '$amountPaise' } } },
    ]),
    Task.aggregate<{ _id: null; count: number; totalPaise: number }>([
      { $match: { createdAt: { $gte: day.start, $lt: day.end } } },
      // Counts every task raised today, but values only the ones not refunded.
      { $group: { _id: null, count: { $sum: 1 }, totalPaise: sumMovedValuePaise } },
    ]),
    Captain.aggregate<{ _id: null; total: number; online: number; collateralPaise: number; lockedPaise: number }>([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          online: { $sum: { $cond: ['$isOnline', 1, 0] } },
          collateralPaise: { $sum: '$collateralBalancePaise' },
          lockedPaise: { $sum: '$lockedAmountPaise' },
        },
      },
    ]),
    Task.countDocuments({ status: 'AUDIT_PENDING' }),
    Commission.aggregate<{ _id: null; totalPaise: number }>([
      { $group: { _id: null, totalPaise: { $sum: '$commissionPaise' } } },
    ]),
    getPlatformAccount(),
  ]);

  const byStatus: Record<string, { count: number; value: number }> = {};
  for (const row of statusCounts) {
    byStatus[row._id] = { count: row.count, value: paiseToRupees(row.totalPaise) };
  }

  const today = todayAgg[0];
  const captainStats = captains[0];

  return ok(res, {
    byStatus,
    pendingAudits,
    today: { taskCount: today?.count ?? 0, taskValue: paiseToRupees(today?.totalPaise ?? 0) },
    captains: {
      total: captainStats?.total ?? 0,
      online: captainStats?.online ?? 0,
      totalCollateral: paiseToRupees(captainStats?.collateralPaise ?? 0),
      totalLocked: paiseToRupees(captainStats?.lockedPaise ?? 0),
    },
    totalCommissionPaid: paiseToRupees(commissionAgg[0]?.totalPaise ?? 0),
    platformCommissionBalance: paiseToRupees(platformAccount.poolBalancePaise),
  });
});

export const tasks = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as {
    page: number;
    limit: number;
    status?: string;
    search?: string;
    partyId?: string;
    captainId?: string;
  };

  const filter: Record<string, unknown> = {};
  if (query.status) filter['status'] = query.status;
  if (query.partyId) filter['partyId'] = new Types.ObjectId(query.partyId);
  if (query.captainId) filter['captainId'] = new Types.ObjectId(query.captainId);

  /**
   * Admin sees every field, so every field is searchable — including who the
   * task is between, which nobody else may search by.
   *
   * The two clauses are merged into one `$or` rather than applied one after
   * the other: both helpers write `filter.$or`, so calling them in sequence
   * would silently discard the first and answer a name search with only the
   * code matches.
   */
  const clauses = taskSearchClause(query.search, {
    includeExternalRef: true,
    includeProviderReference: true,
  }) ?? [];
  const matched = await resolveCounterparties(query.search);
  if (matched) {
    clauses.push({ captainId: { $in: matched.captainIds } }, { partyId: { $in: matched.partyIds } });
  }
  if (clauses.length > 0) filter['$or'] = clauses;

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    Task.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    Task.countDocuments(filter),
  ]);

  // Both counterparties, named. Resolved here in two queries rather than per
  // row, and only on admin's list — a party's task never names the captain and
  // a captain's never names the party.
  const [parties, captains] = await Promise.all([
    Party.find({ _id: { $in: items.map((t) => t.partyId) } }).select('companyName partyCode').lean(),
    Captain.find({ _id: { $in: items.map((t) => t.captainId).filter(Boolean) } })
      .select('displayName captainCode')
      .lean(),
  ]);
  const partyById = new Map(parties.map((p) => [String(p._id), p]));
  const captainById = new Map(captains.map((c) => [String(c._id), c]));

  return ok(
    res,
    paginate(
      items.map((task) => {
        const party = partyById.get(String(task.partyId));
        const captain = task.captainId ? captainById.get(String(task.captainId)) : undefined;
        return {
          ...toTaskDto(task),
          partyName: party?.companyName ?? null,
          partyCode: party?.partyCode ?? null,
          captainName: captain?.displayName ?? null,
          captainCode: captain?.captainCode ?? null,
        };
      }),
      query.page,
      query.limit,
      total,
    ),
  );
});

/**
 * Everything waiting on an admin decision, in one place.
 *
 * The rule this enforces is simple: if the app is holding money or a task
 * still because admin has not decided something, it appears here. Nothing that
 * needs admin may live only on a profile page — a captain disputing a payment
 * used to surface only under Captains -> that captain -> withdrawals, which
 * meant the one screen admin actually watches showed nothing while a captain
 * waited to be paid.
 *
 * The sources are deliberately heterogeneous, because "needs a decision" is
 * not a status on any one collection: a rejected proof, a disputed
 * cancellation, a task nobody can take, a payment a party disputes,
 * and real money sitting unconfirmed are all the same thing from admin's
 * side. They are normalised into one shape and merged.
 *
 * Merging in memory is safe here precisely because this list is the work that
 * is *outstanding* — a healthy system has tens of these, not thousands. Each
 * source is capped so a pathological backlog degrades rather than exhausts.
 */
export const SOURCE_CAP = 200;

type DecisionKind =
  | 'TASK_REJECTED'
  | 'CANCEL_DISPUTED'
  | 'NO_ELIGIBLE_CAPTAIN'
  | 'PLATFORM_PAYMENT_DISPUTED'
  | 'PARTY_TOPUP_PENDING'
  | 'CAPTAIN_DEPOSIT_PENDING'
  | 'CAPTAIN_LIMIT_PURCHASE_PENDING'
  | 'CAPTAIN_REGISTRATION_PENDING'
  | 'CAPTAIN_REDEMPTION_PENDING'
  | 'TRANSACTION_DISPUTED';

interface DecisionItem {
  id: string;
  kind: DecisionKind;
  /** DISPUTE and STALLED mean somebody is blocked; CONFIRM means money is waiting to be acknowledged. */
  severity: 'DISPUTE' | 'STALLED' | 'CONFIRM';
  reference: string;
  headline: string;
  detail: string | null;
  amount: number;
  waitingSince: string;
  /** Where admin actually makes this decision. */
  href: string;
}

export const reviewQueue = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as { page: number; limit: number };

  // One filter per source, named once and used by both the fetch and the
  // count below. Two copies of the same question are how a queue starts
  // reporting a total that does not match the rows under it.
  const taskFilter = {
    $or: [
      { status: { $in: ['REJECTED', 'CANCEL_DISPUTED'] } },
      { routingStalledAt: { $ne: null } },
    ],
  };
  const disputed = { status: 'DISPUTED' } as const;
  const pending = { status: 'PENDING' } as const;
  const awaitingApproval = { status: 'PENDING_APPROVAL' } as const;

  const [
    tasks,
    activeCaptains,
    platformDisputes,
    topUps,
    deposits,
    limitPurchases,
    redemptions,
    disputedTransactions,
    registrations,
    outstanding,
  ] = await Promise.all([
    /**
     * Newest first, matching the order the page renders in. Fetching oldest
     * first and then displaying newest first would mean that a source big enough
     * to hit the cap showed the newest of the *oldest* two hundred — so the rows
     * an administrator opened this screen to see would be the ones missing.
     *
     * The cost is that truncation now drops the oldest rather than the newest.
     * `outstanding` and `truncated` below say so plainly, and the cap is far
     * above what a queue that is being worked ever reaches.
     */
    Task.find(taskFilter).sort({ updatedAt: -1 }).limit(SOURCE_CAP),
    Captain.countDocuments({ status: 'ACTIVE' }),
    AdminWithdrawalPortion.find(disputed).sort({ createdAt: -1 }).limit(SOURCE_CAP).lean(),
    PartyTopUpRequest.find(pending).sort({ createdAt: -1 }).limit(SOURCE_CAP).lean(),
    DmcPurchase.find(pending).sort({ createdAt: -1 }).limit(SOURCE_CAP).lean(),
    CaptainLimitPurchase.find(pending).sort({ createdAt: -1 }).limit(SOURCE_CAP).lean(),
    DmcRedemption.find(pending).sort({ createdAt: -1 }).limit(SOURCE_CAP).lean(),
    Transaction.find(disputed).sort({ updatedAt: -1 }).limit(SOURCE_CAP).lean(),
    // A captain who has confirmed their email and is waiting to be let in.
    // PENDING_EMAIL is deliberately not here: until they prove the address,
    // there is nothing for an administrator to decide.
    CaptainRegistration.find(awaitingApproval).sort({ createdAt: -1 }).limit(SOURCE_CAP).lean(),
    /**
     * How much is really waiting, counted rather than inferred from the rows
     * above — those are capped, so their number is how much fitted, not how
     * much there is. Every source row becomes exactly one item, so these
     * counts sum to the true size of the queue.
     */
    Promise.all([
      Task.countDocuments(taskFilter),
      AdminWithdrawalPortion.countDocuments(disputed),
      PartyTopUpRequest.countDocuments(pending),
      DmcPurchase.countDocuments(pending),
      CaptainLimitPurchase.countDocuments(pending),
      DmcRedemption.countDocuments(pending),
      Transaction.countDocuments(disputed),
      CaptainRegistration.countDocuments(awaitingApproval),
    ]).then((counts) => counts.reduce((sum, n) => sum + n, 0)),
  ]);

  // One round trip for every name the rows need, rather than one per row.
  const partyIds = [
    ...platformDisputes.map((p) => p.partyId),
    ...topUps.map((t) => t.partyId),
    ...disputedTransactions.map((t) => t.partyId),
  ];
  const captainIds = [
    ...deposits.map((d) => d.captainId),
    ...limitPurchases.map((p) => p.captainId),
    ...redemptions.map((r) => r.captainId),
    ...disputedTransactions.map((t) => t.captainId).filter((id): id is NonNullable<typeof id> => id != null),
  ];
  const [parties, captains] = await Promise.all([
    partyIds.length > 0
      ? Party.find({ _id: { $in: partyIds } }).select('partyCode companyName').lean()
      : [],
    captainIds.length > 0
      ? Captain.find({ _id: { $in: captainIds } }).select('captainCode displayName').lean()
      : [],
  ]);
  const partyById = new Map(parties.map((p) => [String(p._id), p]));
  const captainById = new Map(captains.map((c) => [String(c._id), c]));
  const partyName = (id: unknown): string => partyById.get(String(id))?.companyName ?? 'Unknown party';
  const captainName = (id: unknown): string => {
    const c = captainById.get(String(id));
    return c ? `${c.displayName} (${c.captainCode})` : 'Unknown captain';
  };

  const items: DecisionItem[] = [];

  for (const task of tasks) {
    const committed = task.amountPaise + (task.commissionPaise ?? 0) + (task.adminCommissionPaise ?? 0);
    if (task.routingStalledAt) {
      items.push({
        id: `task-stalled-${String(task._id)}`,
        kind: 'NO_ELIGIBLE_CAPTAIN',
        severity: 'STALLED',
        reference: task.taskCode,
        headline: 'No captain left who can take this task',
        detail:
          `${(task.previousCaptainIds ?? []).length} of ${activeCaptains} captain` +
          `${activeCaptains === 1 ? '' : 's'} rejected off · DMC ${paiseToRupees(committed).toLocaleString('en-IN')} committed`,
        amount: paiseToRupees(task.amountPaise),
        waitingSince: task.routingStalledAt.toISOString(),
        href: `/admin/tasks/${String(task._id)}`,
      });
      continue;
    }
    const cancelDispute = task.status === 'CANCEL_DISPUTED';
    items.push({
      id: `task-${String(task._id)}`,
      kind: cancelDispute ? 'CANCEL_DISPUTED' : 'TASK_REJECTED',
      severity: 'DISPUTE',
      reference: task.taskCode,
      headline: cancelDispute
        ? 'A cancellation was disputed'
        : 'A party rejected the captain’s proof',
      detail: cancelDispute
        ? task.cancelReviewDecisionReason ?? task.cancelReason ?? null
        : task.rejectionReason ?? null,
      amount: paiseToRupees(task.amountPaise),
      waitingSince: task.updatedAt.toISOString(),
      href: `/admin/tasks/${String(task._id)}`,
    });
  }

  for (const portion of platformDisputes) {
    items.push({
      id: `platform-portion-${String(portion._id)}`,
      kind: 'PLATFORM_PAYMENT_DISPUTED',
      severity: 'DISPUTE',
      reference: partyName(portion.partyId),
      headline: 'A commission payment from a party is disputed',
      detail: portion.disputeReason ?? 'no reason given',
      amount: paiseToRupees(portion.amountPaise),
      waitingSince: portion.createdAt.toISOString(),
      href: '/admin/wallet',
    });
  }

  for (const topUp of topUps) {
    items.push({
      id: `topup-${String(topUp._id)}`,
      kind: 'PARTY_TOPUP_PENDING',
      severity: 'CONFIRM',
      reference: partyName(topUp.partyId),
      headline: 'A party is waiting for its top-up to be confirmed',
      detail: 'Nothing is credited until you confirm the money arrived',
      amount: paiseToRupees(topUp.amountPaise),
      waitingSince: topUp.createdAt.toISOString(),
      href: `/admin/parties/${String(topUp.partyId)}`,
    });
  }

  for (const deposit of deposits) {
    items.push({
      id: `deposit-${String(deposit._id)}`,
      kind: 'CAPTAIN_DEPOSIT_PENDING',
      severity: 'CONFIRM',
      reference: captainName(deposit.captainId),
      headline: 'A captain is waiting for security money to be confirmed',
      detail: 'Their collateral does not move until you confirm it arrived',
      amount: paiseToRupees(deposit.amountPaise),
      waitingSince: deposit.createdAt.toISOString(),
      href: `/admin/captains/${String(deposit.captainId)}`,
    });
  }

  for (const registration of registrations) {
    items.push({
      id: `captain-registration-${String(registration._id)}`,
      kind: 'CAPTAIN_REGISTRATION_PENDING',
      severity: 'CONFIRM',
      reference: registration.name,
      headline: 'A captain has registered and is waiting to be approved',
      detail: `${registration.fullName} · ${registration.email} · ${registration.mobile}`,
      // Registration involves no money at all: an approved captain starts at
      // zero and funds themselves through a security deposit afterwards.
      amount: 0,
      waitingSince: registration.createdAt.toISOString(),
      href: '/admin/captain-registrations',
    });
  }

  for (const purchase of limitPurchases) {
    items.push({
      id: `limit-purchase-${String(purchase._id)}`,
      kind: 'CAPTAIN_LIMIT_PURCHASE_PENDING',
      severity: 'CONFIRM',
      reference: captainName(purchase.captainId),
      headline: 'A captain paid to raise their limit and is waiting on you',
      detail: 'Their capacity does not move until you confirm the money arrived',
      amount: paiseToRupees(purchase.amountPaise),
      waitingSince: purchase.createdAt.toISOString(),
      href: `/admin/captains/${String(purchase.captainId)}`,
    });
  }

  for (const redemption of redemptions) {
    // The captain's DMC is already held against this, so they are not merely
    // waiting to be paid — they cannot spend it either. That is why a cash-out
    // belongs here and not only on the captain's profile page.
    const destination =
      redemption.payoutMethod === 'UPI'
        ? redemption.payoutUpiId ?? 'no UPI ID given'
        : `${redemption.payoutAccountName ?? 'unnamed'} · ${redemption.payoutIfsc ?? 'no IFSC'}`;
    items.push({
      id: `redemption-${String(redemption._id)}`,
      kind: 'CAPTAIN_REDEMPTION_PENDING',
      severity: 'CONFIRM',
      reference: captainName(redemption.captainId),
      headline: 'A captain is waiting to be paid out in rupees',
      detail: `Send by ${redemption.payoutMethod} to ${destination}, then confirm here`,
      amount: paiseToRupees(redemption.amountPaise),
      waitingSince: redemption.createdAt.toISOString(),
      // The wallet screen, not the captain's profile — that is where the pool
      // and the pay/reject controls actually are.
      href: '/admin/wallet',
    });
  }

  for (const transaction of disputedTransactions) {
    // Both sides are stuck: the DMC is held and neither the party nor the
    // captain can touch it until admin says whether the money really moved.
    // That is the definition of a decision that belongs here.
    const isPayIn = transaction.direction === 'PAY_IN';
    items.push({
      id: `transaction-${String(transaction._id)}`,
      kind: 'TRANSACTION_DISPUTED',
      severity: 'DISPUTE',
      reference: transaction.transactionCode,
      headline: isPayIn
        ? 'A captain says a customer’s payment never arrived'
        : 'A payout transfer is disputed',
      detail:
        `${isPayIn ? 'Pay-in' : 'Pay-out'} for ${partyName(transaction.partyId)}` +
        `${transaction.captainId ? ` · ${captainName(transaction.captainId)}` : ''}` +
        ` · ${transaction.disputeReason ?? 'no reason given'}`,
      amount: paiseToRupees(transaction.amountPaise),
      waitingSince: transaction.updatedAt.toISOString(),
      href: '/admin/transactions',
    });
  }

  /**
   * Somebody blocked still outranks somebody merely waiting — a dispute holds a
   * task and somebody's money, and burying it under routine confirmations is how
   * this queue stops being worth watching.
   *
   * Within a severity the newest goes first. This reads as a feed: an
   * administrator watching the screen sees what has just arrived at the top,
   * rather than having to scroll past everything they have already looked at to
   * find it.
   */
  const rank: Record<DecisionItem['severity'], number> = { DISPUTE: 0, STALLED: 1, CONFIRM: 2 };
  items.sort((a, b) =>
    rank[a.severity] !== rank[b.severity]
      ? rank[a.severity] - rank[b.severity]
      : Date.parse(b.waitingSince) - Date.parse(a.waitingSince),
  );

  const start = (query.page - 1) * query.limit;
  return ok(res, {
    // Paging runs over the rows actually loaded, so every page holds real
    // rows rather than promising ones that were never fetched.
    ...paginate(items.slice(start, start + query.limit), query.page, query.limit, items.length),
    /**
     * Everything waiting on an admin decision, including whatever the cap
     * left out. When `truncated` is true this queue is not the whole story
     * and admin needs to clear some of it before the rest becomes visible —
     * which is worth saying out loud, because a queue that looks complete
     * while hiding work is worse than one that admits it is behind.
     */
    outstanding,
    truncated: outstanding > items.length,
  });
});

/** Full detail for one task: which party sent it, which captain holds it, and its history. */
export const taskDetail = asyncHandler(async (req: Request, res: Response) => {
  const taskId = req.params['taskId'] as string;
  const task = await Task.findById(taskId);
  if (!task) throw AppError.notFound('Task not found', ErrorCodes.TASK_NOT_FOUND);

  // Everyone who has ever held this task, not just whoever holds it now —
  // a reassigned task has passed through several, and the history below is
  // only readable if each entry can name the captain it belonged to.
  const captainIds = [
    ...(task.previousCaptainIds ?? []),
    ...(task.captainId ? [task.captainId] : []),
  ];

  const [party, captains, proof] = await Promise.all([
    Party.findById(task.partyId),
    captainIds.length > 0
      ? Captain.find({ _id: { $in: captainIds } }).select('captainCode displayName').lean()
      : [],
    findLiveProof(task._id),
  ]);

  const captainById = new Map(captains.map((c) => [String(c._id), c]));
  const currentCaptain = task.captainId ? await Captain.findById(task.captainId) : null;

  return ok(res, {
    task: toTaskDto(task),
    party: party
      ? {
          id: String(party._id),
          partyCode: party.partyCode,
          companyName: party.companyName,
          contactEmail: party.contactEmail,
        }
      : null,
    captain: currentCaptain ? toCaptainDto(currentCaptain) : null,
    /** Every captain this task has been through, oldest first — admin only. */
    captainHistory: captainIds.map((id, index) => {
      const c = captainById.get(String(id));
      return {
        captainId: String(id),
        captainCode: c?.captainCode ?? null,
        displayName: c?.displayName ?? null,
        current: index === captainIds.length - 1 && String(task.captainId ?? '') === String(id),
      };
    }),
    proof: proof ? toProofDto(proof) : null,
    stateHistory: task.stateHistory.map((e) => {
      const c = e.captainId ? captainById.get(String(e.captainId)) : null;
      return {
        from: e.from,
        to: e.to,
        role: e.actorRole,
        reason: e.reason ?? null,
        at: e.at.toISOString(),
        // Who held the task at this point. Admin-only: the party's own view of
        // its task history never names a captain, and never should.
        captainId: e.captainId ? String(e.captainId) : null,
        captainCode: c?.captainCode ?? null,
        captainName: c?.displayName ?? null,
      };
    }),
  });
});

/**
 * Admin is the final word only when the captain and whoever requested the
 * cancellation could not agree (CANCEL_DISPUTED) — admin never initiates a
 * cancellation itself, only party and captain do. APPROVE leaves the task
 * exactly as it was; REASSIGN releases the current captain and returns the
 * task to the open pool.
 */
export const resolveCancellationDispute = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const taskId = req.params['taskId'] as string;
  const { decision } = req.body as { decision: 'APPROVE' | 'REASSIGN' };

  const task = await resolveCancelDispute(taskId, decision, actor);
  notifyCancelDisputeResolved(task, decision);
  return ok(res, toTaskDto(task), decision === 'APPROVE' ? 'Dispute resolved — task resumes' : 'Dispute resolved — task returned to the pool');
});

/**
 * Admin is the final word only when party rejected a captain's proof
 * (REJECTED) — never a first-line reviewer. APPROVE overrules the rejection
 * and completes the task normally; REASSIGN releases the captain and returns
 * the task to the open pool.
 */
export const resolveRejection = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const taskId = req.params['taskId'] as string;
  const { decision } = req.body as { decision: 'APPROVE' | 'REASSIGN' };

  const beforeCaptainId = (await Task.findById(taskId).select('captainId').lean())?.captainId;
  const { task, commissionPaise } = await resolveTaskRejection(taskId, decision, actor);

  if (beforeCaptainId) {
    notifyRejectionResolved(task, String(beforeCaptainId), decision);
    if (commissionPaise != null) {
      const view = await collateral.getCollateral(beforeCaptainId);
      notifyLimitUpdated(String(beforeCaptainId), view.availableLimitPaise);
    }
  }

  return ok(res, toTaskDto(task), decision === 'APPROVE' ? 'Rejection overruled — task complete' : 'Task returned to the pool');
});
