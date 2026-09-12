/**
 * ADMIN — PLATFORM WALLET AND WITHDRAWALS
 *
 * The platform's own balance and the flows through the commission pool, plus
 * the full withdrawal lifecycle: request, portions, confirmation, dispute and
 * cancellation.
 */
import type { Request, Response } from 'express';
import { asyncHandler, ok, created, paginate } from '../../utils/http';
import { Task, AdminWithdrawalRequest, AdminWithdrawalPortion, Transaction, WalletEntry } from '../../models';
import { getPlatformAccount } from '../../services/platformAccount.service';
import {
  requestPlatformWithdrawal,
  cancelPlatformWithdrawal,
  confirmPlatformPortionReceipt,
  disputePlatformPortionReceipt,
  resolvePlatformPortionDispute,
} from '../../services/adminWithdrawal.service';
import { notifyPlatformWithdrawalRequested, notifyPlatformWithdrawalFulfilled, notifyPlatformWithdrawalDisputed } from '../../services/notification.service';
import { toAdminWithdrawalDto, toAdminWithdrawalPortionDto, toPlatformAccountDto } from '../../utils/serializers';
import { fundCommissionPool } from '../../services/platformAccount.service';
import { adminActor } from './actor';
/**
 * Admin cashing out its earned platform commission (see PlatformAccount) —
 * the same two-sided handshake as a captain's Pay In. See adminWithdrawal.service.ts.
 */
export const platformWallet = asyncHandler(async (_req: Request, res: Response) => {
  const account = await getPlatformAccount();
  return ok(res, toPlatformAccountDto(account, await poolFlows()));
});

/**
 * What the pool has taken in from parties and paid out to captains.
 *
 * Counted from the records that moved the money — completed tasks and settled
 * pay-ins on one side, the captain's own commission entries on the other —
 * rather than inferred from the balance, which cannot separate the two now
 * that both pass through the same pot.
 */
async function poolFlows(): Promise<{ collectedPaise: number; paidOutPaise: number }> {
  const [fromTasks, fromPayIns, toCaptains] = await Promise.all([
    Task.aggregate<{ total: number }>([
      { $match: { status: 'COMPLETED' } },
      {
        $group: {
          _id: null,
          total: {
            $sum: { $add: [{ $ifNull: ['$commissionPaise', 0] }, { $ifNull: ['$adminCommissionPaise', 0] }] },
          },
        },
      },
    ]),
    Transaction.aggregate<{ total: number }>([
      { $match: { status: 'SETTLED' } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$partyCommissionPaise', 0] } } } },
    ]),
    WalletEntry.aggregate<{ total: number }>([
      { $match: { kind: 'COMMISSION_EARNED' } },
      { $group: { _id: null, total: { $sum: '$amountPaise' } } },
    ]),
  ]);
  return {
    collectedPaise: (fromTasks[0]?.total ?? 0) + (fromPayIns[0]?.total ?? 0),
    paidOutPaise: toCaptains[0]?.total ?? 0,
  };
}

export const requestWithdrawal = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const body = req.body as { amount: number };

  const { request, portions } = await requestPlatformWithdrawal(body.amount, actor);
  notifyPlatformWithdrawalRequested(portions);

  return created(res, toAdminWithdrawalDto(request), 'Withdrawal request submitted');
});

export const listWithdrawals = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as { page: number; limit: number; status?: string };
  const filter: Record<string, unknown> = {};
  if (query.status) filter['status'] = query.status;

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    AdminWithdrawalRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    AdminWithdrawalRequest.countDocuments(filter),
  ]);

  return ok(res, paginate(items.map(toAdminWithdrawalDto), query.page, query.limit, total));
});

/** Admin's own withdrawal portions — full source detail, since it's admin's own withdrawal. */
export const listWithdrawalPortions = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as { page: number; limit: number; status?: string };
  const filter: Record<string, unknown> = {};
  if (query.status) filter['status'] = query.status;

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    AdminWithdrawalPortion.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    AdminWithdrawalPortion.countDocuments(filter),
  ]);

  return ok(res, paginate(items.map(toAdminWithdrawalPortionDto), query.page, query.limit, total));
});

/** The same ruling, on admin's own commission withdrawal. */
export const resolveOwnPortionDispute = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { decision } = req.body as { decision: 'SETTLE' | 'RETRY' };
  const portion = await resolvePlatformPortionDispute(req.params['portionId'] as string, decision, actor);
  return ok(
    res,
    toAdminWithdrawalPortionDto(portion),
    decision === 'SETTLE' ? 'Settled in the party’s favour' : 'Sent back to the party to pay again',
  );
});

export const cancelWithdrawal = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const request = await cancelPlatformWithdrawal(req.params['withdrawalId'] as string, actor);
  return ok(res, toAdminWithdrawalDto(request), 'Withdrawal request cancelled');
});

/** Admin's own verification step for one portion — confirming is what actually moves that slice of the balance. */
export const confirmWithdrawal = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const portion = await confirmPlatformPortionReceipt(req.params['portionId'] as string, actor);
  notifyPlatformWithdrawalFulfilled(portion);
  return ok(res, toAdminWithdrawalPortionDto(portion), 'Payment confirmed');
});

/** Admin says the party's claimed payment for this portion never arrived. */
export const disputeWithdrawal = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { reason } = req.body as { reason: string };
  const portion = await disputePlatformPortionReceipt(req.params['portionId'] as string, reason, actor);
  notifyPlatformWithdrawalDisputed(portion);
  return ok(res, toAdminWithdrawalPortionDto(portion), 'Payment disputed');
});

/**
 * Parties topping up their DMC balance beyond the registration grant — real
 * security money sent directly to admin, so admin (not a self-service click)
 * confirms it actually arrived before any balance moves.
 */

/**
 * Admin putting real money behind the commission captains earn.
 *
 * Commission is paid out of this pool rather than created when it is earned,
 * so the pool running dry is a funding problem admin can see coming rather
 * than DMC quietly appearing from nowhere.
 */
export const fundCommissionPoolEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { amount, reference } = req.body as { amount: number; reference?: string };
  const account = await fundCommissionPool(amount, actor, reference);
  return ok(res, toPlatformAccountDto(account, await poolFlows()), 'Commission pool funded');
});
