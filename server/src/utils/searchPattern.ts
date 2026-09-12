/**
 * Turning what someone typed into a pattern that matches it literally.
 *
 * Every search box in the app funnels through here. A term is user input: it
 * arrives with dots, brackets and plus signs in it, and none of those may be
 * allowed to act as regex syntax — both because `.*` would silently match
 * everything, and because a crafted term could otherwise cost the database far
 * more than the search is worth.
 */

/** Matches the term as text, anywhere in the field, ignoring case. */
export function literalRegex(term: string): RegExp {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/** The trimmed term, or null when there is nothing to search for. */
export function normaliseSearch(search: string | undefined | null): string | null {
  const term = search?.trim();
  return term ? term : null;
}
