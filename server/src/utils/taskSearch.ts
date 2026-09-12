import { literalRegex, normaliseSearch } from './searchPattern';

/**
 * The task search shared by all three roles, so "search" means the same thing
 * on every screen and only one place has to get the escaping right.
 *
 * Two things are searched everywhere: the task code and the customer's name —
 * what a person actually has in front of them when they go looking for a task.
 *
 * "The task code" is not the same string for everyone. A captain is shown an
 * opaque code (JOB-XXXXXXXX) precisely because the party-facing one spells out
 * the owner, so their search has to match that instead; searching a code they
 * are never shown would find nothing. Party and admin get both, since admin
 * has to be able to look up whatever code a captain reads out to them.
 *
 * `externalRef` is the exception. The party's own tracking reference is
 * searchable by the party and by admin, who own it, and never by a captain.
 * Withholding the field from a captain's responses while letting them search
 * it would be pointless: a captain could confirm any reference by seeing
 * whether a task came back. So the caller states which side is asking.
 */
export interface TaskSearchOptions {
  /** True for party and admin, false for captains. See above. */
  includeExternalRef: boolean;
  /**
   * The captain's UTR for the transfer they made. Admin searches by it because
   * it is the number a bank or a customer quotes back when a payment is
   * queried, and admin is who gets asked.
   */
  includeProviderReference?: boolean;
}

/**
 * The `$or` clause for a search term, or null when there is nothing to search
 * — callers should leave their filter untouched in that case rather than
 * adding an empty `$or`, which matches nothing.
 */
export function taskSearchClause(
  search: string | undefined,
  { includeExternalRef, includeProviderReference }: TaskSearchOptions,
): Array<Record<string, unknown>> | null {
  const term = normaliseSearch(search);
  if (!term) return null;

  const pattern = literalRegex(term);
  return [
    // A captain only ever sees the opaque code, so that is the one they search.
    ...(includeExternalRef ? [{ taskCode: pattern }] : []),
    { captainTaskCode: pattern },
    { customerName: pattern },
    ...(includeExternalRef ? [{ externalRef: pattern }] : []),
    ...(includeProviderReference ? [{ providerReference: pattern }] : []),
  ];
}

/** Applies the clause to a filter in place, when there is one. */
export function applyTaskSearch(
  filter: Record<string, unknown>,
  search: string | undefined,
  options: TaskSearchOptions,
): void {
  const clause = taskSearchClause(search, options);
  if (clause) filter['$or'] = clause;
}
