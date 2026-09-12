/**
 * Recognising the errors MongoDB reports by number rather than by type.
 */

/**
 * Did this write lose a race against an identical one?
 *
 * Code 11000 is a unique-index violation. Several places here deliberately
 * write first and ask afterwards — inserting a commission row, claiming a
 * transaction code — because a unique index is the only check that cannot be
 * raced. Catching this is how those writes tell "somebody else got there
 * first" apart from a real failure, so the two callers must agree on what the
 * signal looks like rather than each carrying its own copy.
 */
export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
