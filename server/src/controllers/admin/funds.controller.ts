/**
 * ADMIN — REAL MONEY IN AND OUT
 *
 * The queues where real money crosses the boundary and admin must confirm both
 * sides by hand: party top-ups, captain collateral deposits, and redemptions
 * back out. Nothing here credits itself.
 */
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, paginate } from '../../utils/http';
import { Captain, Party, PartyTopUpRequest, DmcPurchase, DmcRedemption, CaptainLimitPurchase } from '../../models';
import * as collateral from '../../services/collateral.service';
import { approveTopUp, rejectTopUp } from '../../services/partyTopUp.service';
import {
  notifyLimitUpdated,
  notifyPartyTopUpDecided,
  notifyCollateralDepositDecided,
  notifyRedemptionDecided,
  notifyLimitPurchaseDecided,
} from '../../services/notification.service';
import {
  toPartyTopUpDto,
  toDmcPurchaseDto,
  toRedemptionDto,
  toAdminRedemptionDto,
  toLimitPurchaseDto,
} from '../../utils/serializers';
import { paiseToRupees } from '../../utils/money';
import { applyCounterpartySearch } from '../../utils/counterpartySearch';
import { approveDeposit, rejectDeposit } from '../../services/dmcPurchase.service';
import { approveLimitPurchase, rejectLimitPurchase } from '../../services/captainLimitPurchase.service';
import { currentLimitPaise } from '../../services/captainCapacity.service';
import { markRedemptionPaid, rejectRedemption } from '../../services/captainBalance.service';
import { adminActor } from './actor';
/**
 * Party top-ups — both the queue of ones awaiting review and, with `status:
 * 'ALL'`, the full history shown on a party's profile and the transactions
 * page. Defaults to PENDING so the review queue keeps its old behaviour.
 */
export const topUpQueue = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as {
    page: number; limit: number; status?: string; partyId?: string; search?: string;
  };
  const filter: Record<string, unknown> = {};
  // 'ALL' is the explicit opt-out; anything else, including nothing, means the
  // pending queue, because that is what the reviewing screen has always shown.
  if (query.status !== 'ALL') filter['status'] = query.status ?? 'PENDING';
  if (query.partyId) filter['partyId'] = new Types.ObjectId(query.partyId);
  // A top-up has no captain — only the paying party can be searched for.
  await applyCounterpartySearch(filter, query.search, { party: true });

  // Pending is a worklist, so oldest first; history reads newest first.
  const newestFirst = query.status === 'ALL';
  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    PartyTopUpRequest.find(filter)
      .sort({ createdAt: newestFirst ? -1 : 1 })
      .skip(skip)
      .limit(query.limit),
    PartyTopUpRequest.countDocuments(filter),
  ]);

  const parties = await Party.find({ _id: { $in: items.map((t) => t.partyId) } })
    .select('companyName partyCode')
    .lean();
  const partyById = new Map(parties.map((p) => [String(p._id), p]));

  return ok(
    res,
    paginate(
      items.map((request) => ({
        ...toPartyTopUpDto(request),
        // Named here so the transactions view can show who paid without a
        // second round trip per row.
        partyCompanyName: partyById.get(String(request.partyId))?.companyName ?? null,
        partyCode: partyById.get(String(request.partyId))?.partyCode ?? null,
      })),
      query.page,
      query.limit,
      total,
    ),
  );
});

/**
 * Captains' security-money deposits, awaiting admin's confirmation that the
 * money actually arrived. Mirrors the party top-up queue above: `status: 'ALL'`
 * switches from the pending worklist to full history.
 */
export const collateralDepositQueue = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as {
    page: number; limit: number; status?: string; captainId?: string; search?: string;
  };
  const filter: Record<string, unknown> = {};
  if (query.status !== 'ALL') filter['status'] = query.status ?? 'PENDING';
  if (query.captainId) filter['captainId'] = new Types.ObjectId(query.captainId);
  // A deposit has no party — only the depositing captain can be searched for.
  await applyCounterpartySearch(filter, query.search, { captain: true });

  const newestFirst = query.status === 'ALL';
  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    DmcPurchase.find(filter).sort({ createdAt: newestFirst ? -1 : 1 }).skip(skip).limit(query.limit),
    DmcPurchase.countDocuments(filter),
  ]);

  const captains = await Captain.find({ _id: { $in: items.map((d) => d.captainId) } })
    .select('displayName captainCode collateralBalancePaise')
    .lean();
  const byId = new Map(captains.map((c) => [String(c._id), c]));

  return ok(
    res,
    paginate(
      items.map((request) => ({
        ...toDmcPurchaseDto(request),
        captainDisplayName: byId.get(String(request.captainId))?.displayName ?? null,
        captainCode: byId.get(String(request.captainId))?.captainCode ?? null,
        captainCollateral: paiseToRupees(byId.get(String(request.captainId))?.collateralBalancePaise ?? 0),
      })),
      query.page,
      query.limit,
      total,
    ),
  );
});

export const approveCollateralDeposit = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const request = await approveDeposit(req.params['depositId'] as string, actor);
  notifyCollateralDepositDecided(request, 'APPROVED');

  // Their claim ceiling moves with the collateral unless admin has set one.
  const view = await collateral.getCollateral(request.captainId);
  notifyLimitUpdated(String(request.captainId), view.availableLimitPaise);

  return ok(res, toDmcPurchaseDto(request), 'Deposit confirmed — split into security and working capital');
});

export const rejectCollateralDeposit = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { reason } = req.body as { reason: string };
  const request = await rejectDeposit(req.params['depositId'] as string, reason, actor);
  notifyCollateralDepositDecided(request, 'REJECTED');
  return ok(res, toDmcPurchaseDto(request), 'Deposit rejected');
});

// ---------------------------------------------------------------------------
// Captains buying more room to work with
// ---------------------------------------------------------------------------

/**
 * Capacity purchases waiting on admin, or a captain's whole history.
 *
 * Carries the figures admin needs to decide with: what the captain is buying,
 * what they can work with today, and what that becomes if this is approved.
 * Computed here rather than on the screen so the number admin approves against
 * is the number the server will actually apply.
 */
export const limitPurchaseQueue = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as {
    page: number; limit: number; status?: string; captainId?: string;
  };
  const filter: Record<string, unknown> = {};
  if (query.status !== 'ALL') filter['status'] = query.status ?? 'PENDING';
  if (query.captainId) filter['captainId'] = new Types.ObjectId(query.captainId);

  const newestFirst = query.status === 'ALL';
  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    CaptainLimitPurchase.find(filter).sort({ createdAt: newestFirst ? -1 : 1 }).skip(skip).limit(query.limit),
    CaptainLimitPurchase.countDocuments(filter),
  ]);

  const captains = await Captain.find({ _id: { $in: items.map((d) => d.captainId) } })
    .select('displayName captainCode collateralBalancePaise dmcBalancePaise creditLimitPaise commissionEarnedTotalPaise')
    .lean();
  const byId = new Map(captains.map((c) => [String(c._id), c]));

  return ok(
    res,
    paginate(
      items.map((request) => {
        const captain = byId.get(String(request.captainId));
        const before = captain ? currentLimitPaise(captain) : 0;
        /**
         * What this captain's Current Limit becomes if admin approves.
         *
         * Modelled the same way the approval writes it — the amount lands on
         * both the balance and the ceiling — and then run through the real
         * Current Limit rule, so the preview cannot disagree with the result.
         */
        const after = captain
          ? currentLimitPaise({
              ...captain,
              dmcBalancePaise: captain.dmcBalancePaise + request.amountPaise,
              creditLimitPaise:
                (captain.creditLimitPaise ?? captain.collateralBalancePaise) + request.amountPaise,
            })
          : 0;
        return {
          ...toLimitPurchaseDto(request),
          captainDisplayName: captain?.displayName ?? null,
          captainCode: captain?.captainCode ?? null,
          captainCollateral: paiseToRupees(captain?.collateralBalancePaise ?? 0),
          currentLimitBefore: paiseToRupees(before),
          currentLimitAfter: paiseToRupees(request.status === 'APPROVED' ? before : after),
        };
      }),
      query.page,
      query.limit,
      total,
    ),
  );
});

export const approveLimitPurchaseRequest = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const request = await approveLimitPurchase(req.params['purchaseId'] as string, actor);
  notifyLimitPurchaseDecided(request, 'APPROVED');

  // Their claim ceiling has moved, so the figure on their screen must follow.
  const view = await collateral.getCollateral(request.captainId);
  notifyLimitUpdated(String(request.captainId), view.availableLimitPaise);

  return ok(res, toLimitPurchaseDto(request), 'Purchase confirmed — capacity raised');
});

export const rejectLimitPurchaseRequest = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { reason } = req.body as { reason: string };
  const request = await rejectLimitPurchase(req.params['purchaseId'] as string, reason, actor);
  notifyLimitPurchaseDecided(request, 'REJECTED');
  return ok(res, toLimitPurchaseDto(request), 'Purchase rejected');
});

// ---------------------------------------------------------------------------
// Captains cashing DMC back out into rupees
// ---------------------------------------------------------------------------

/**
 * The cash-out worklist. Pending by default because that is the only state
 * that needs admin; `status: 'ALL'` is the history a captain's profile shows.
 */
export const redemptionQueue = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as {
    page: number; limit: number; status?: string; captainId?: string;
  };
  const filter: Record<string, unknown> = {};
  if (query.status !== 'ALL') filter['status'] = query.status ?? 'PENDING';
  if (query.captainId) filter['captainId'] = new Types.ObjectId(query.captainId);

  // Pending is a queue, so oldest first; history reads newest first.
  const newestFirst = query.status === 'ALL' || (query.status != null && query.status !== 'PENDING');
  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    DmcRedemption.find(filter).sort({ createdAt: newestFirst ? -1 : 1 }).skip(skip).limit(query.limit),
    DmcRedemption.countDocuments(filter),
  ]);

  const captains = await Captain.find({ _id: { $in: items.map((r) => r.captainId) } })
    .select('displayName captainCode dmcBalancePaise')
    .lean();
  const byId = new Map(captains.map((c) => [String(c._id), c]));

  return ok(
    res,
    paginate(
      items.map((r) => toAdminRedemptionDto(r, byId.get(String(r.captainId)) ?? null)),
      query.page,
      query.limit,
      total,
    ),
  );
});

/** Admin has sent the rupees. The DMC held against the request is destroyed. */
export const payRedemption = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { reference, notes } = req.body as { reference: string; notes?: string };
  const request = await markRedemptionPaid(req.params['redemptionId'] as string, { reference, notes }, actor);
  notifyRedemptionDecided(request, 'PAID');
  return ok(res, toRedemptionDto(request), 'Cash-out marked as paid');
});

/** No money went out, so every paise held goes back to the captain. */
export const declineRedemption = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { reason } = req.body as { reason: string };
  const request = await rejectRedemption(req.params['redemptionId'] as string, reason, actor);
  notifyRedemptionDecided(request, 'REJECTED');
  return ok(res, toRedemptionDto(request), 'Cash-out rejected and the DMC returned');
});

export const approveTopUpRequest = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const request = await approveTopUp(req.params['topUpId'] as string, actor);
  notifyPartyTopUpDecided(request, 'APPROVED');
  return ok(res, toPartyTopUpDto(request), 'Top-up confirmed and credited');
});

export const rejectTopUpRequest = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const { reason } = req.body as { reason: string };
  const request = await rejectTopUp(req.params['topUpId'] as string, reason, actor);
  notifyPartyTopUpDecided(request, 'REJECTED');
  return ok(res, toPartyTopUpDto(request), 'Top-up rejected');
});
