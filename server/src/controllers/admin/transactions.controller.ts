/**
 * ADMIN — TRANSACTIONS
 *
 * The pay-in rail: listing transactions and settling a disputed one. Pay-outs
 * are Tasks and are handled under the dashboard module, not here.
 */
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, paginate } from '../../utils/http';
import { Captain, Party, Transaction } from '../../models';
import { recordAudit } from '../../services/audit.service';
import { toAdminTransactionDto } from '../../utils/serializers';
import { literalRegex, normaliseSearch } from '../../utils/searchPattern';
import { resolveCounterparties } from '../../utils/counterpartySearch';
import { resolveDispute } from '../../services/transaction.service';
import { adminActor } from './actor';
/**
 * Every transaction in the system, with both counterparties named.
 *
 * Admin is the only role that sees both sides — a party never learns the
 * captain and a captain never learns the party — because admin is the one who
 * has to settle an argument between them, and that is impossible while only
 * seeing half of it.
 */
export const transactionList = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as {
    page: number; limit: number; direction?: string; status?: string; search?: string;
    captainId?: string; partyId?: string;
  };

  const filter: Record<string, unknown> = {};
  if (query.direction) filter['direction'] = query.direction;
  if (query.status) filter['status'] = query.status;
  // Scoped to one person, for their profile page. Admin is the only role that
  // may look across the party/captain boundary like this.
  if (query.captainId) filter['captainId'] = new Types.ObjectId(query.captainId);
  if (query.partyId) filter['partyId'] = new Types.ObjectId(query.partyId);
  const term = normaliseSearch(query.search);
  if (term) {
    // The three references anybody would actually paste in: ours, the party's
    // own, and the one the bank or gateway gave. Escaped through the shared
    // helper, so a term with regex characters in it matches literally.
    const pattern = literalRegex(term);
    const clauses: Array<Record<string, unknown>> = [
      { transactionCode: pattern },
      { partyReference: pattern },
      { settlementReference: pattern },
    ];
    // And by who it is between, because admin looks these up the way a person
    // thinks about them — "what has Acme paid in", "what did Sharma take".
    const matched = await resolveCounterparties(query.search);
    if (matched) {
      clauses.push({ captainId: { $in: matched.captainIds } }, { partyId: { $in: matched.partyIds } });
    }
    filter['$or'] = clauses;
  }

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    Transaction.countDocuments(filter),
  ]);

  const [parties, captains] = await Promise.all([
    Party.find({ _id: { $in: items.map((t) => t.partyId) } }).select('partyCode companyName').lean(),
    Captain.find({ _id: { $in: items.map((t) => t.captainId).filter(Boolean) } })
      .select('captainCode displayName')
      .lean(),
  ]);
  const partyById = new Map(parties.map((p) => [String(p._id), p]));
  const captainById = new Map(captains.map((c) => [String(c._id), c]));

  return ok(
    res,
    paginate(
      items.map((t) => toAdminTransactionDto(t, partyById.get(String(t.partyId)), captainById.get(String(t.captainId)))),
      query.page,
      query.limit,
      total,
    ),
  );
});

/**
 * Admin's decision on a disputed transaction.
 *
 * Two answers, because only two things can be true: the money moved, or it did
 * not. Settling pays the receiving side and the captain's commission; releasing
 * returns the hold to whoever put it up. There is no third option that leaves
 * the DMC held, because that is what the dispute already is.
 */
export const resolveTransactionDispute = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const transactionId = req.params['transactionId'] as string;
  const { decision, reason } = req.body as { decision: 'SETTLE' | 'RELEASE'; reason: string };

  const resolved = await resolveDispute(transactionId, decision, reason, actor);

  await recordAudit({
    action: 'TRANSACTION_DISPUTE_RESOLVED',
    targetCollection: 'Transaction',
    targetId: resolved._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    newState: { status: resolved.status, decision, reason },
    metadata: { transactionCode: resolved.transactionCode },
  });

  return ok(
    res,
    toAdminTransactionDto(resolved),
    decision === 'SETTLE' ? 'Settled — the money has been moved' : 'Released — the hold went back',
  );
});
