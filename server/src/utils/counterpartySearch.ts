import { Captain, Party } from '../models';
import { literalRegex, normaliseSearch } from './searchPattern';

/**
 * Finding money movements by who they involve, rather than by their own ids.
 *
 * Admin looks these up the way a person thinks about them — "what did Sharma
 * withdraw", "what has Acme paid in" — but the withdrawal and top-up records
 * hold only ids. Names live on Captain and Party, so the name is resolved to
 * ids first and the ids are what filter the ledger. Two small queries beat an
 * aggregation pipeline here: these collections are the small ones, and the
 * result stays an ordinary filter that callers can combine with their own.
 *
 * Codes are matched alongside names, because admin is as likely to paste
 * CAP-002 out of a task page as to type someone's name.
 */

export interface CounterpartyIds {
  captainIds: unknown[];
  partyIds: unknown[];
}

/** Ids of every captain and party whose name or code matches. Null when there is no term. */
export async function resolveCounterparties(search: string | undefined): Promise<CounterpartyIds | null> {
  const term = normaliseSearch(search);
  if (!term) return null;

  const pattern = literalRegex(term);
  const [captains, parties] = await Promise.all([
    Captain.find({ $or: [{ displayName: pattern }, { captainCode: pattern }] })
      .select('_id')
      .lean(),
    Party.find({ $or: [{ companyName: pattern }, { partyCode: pattern }] })
      .select('_id')
      .lean(),
  ]);

  return { captainIds: captains.map((c) => c._id), partyIds: parties.map((p) => p._id) };
}

/**
 * Narrows a filter to records involving a matched captain or party.
 *
 * When the term matches nobody the filter is still narrowed — to an empty set.
 * Leaving it untouched would answer "who is Sharma?" with every record in the
 * ledger, which is both wrong and alarming to read.
 */
export async function applyCounterpartySearch(
  filter: Record<string, unknown>,
  search: string | undefined,
  fields: { captain?: boolean; party?: boolean } = { captain: true, party: true },
): Promise<void> {
  const matched = await resolveCounterparties(search);
  if (!matched) return;

  const clauses: Array<Record<string, unknown>> = [];
  if (fields.captain) clauses.push({ captainId: { $in: matched.captainIds } });
  if (fields.party) clauses.push({ partyId: { $in: matched.partyIds } });
  filter['$or'] = clauses;
}
