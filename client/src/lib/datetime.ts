/**
 * One way of writing a timestamp, so no two screens can disagree.
 *
 * Every list in this application shows the same kind of moment — when a task
 * moved, when a payment landed, when a key was last used — and each screen
 * used to carry its own copy of the same options object. Copies drift: one
 * list gains a year while the one beside it does not, and the two stop being
 * comparable at a glance even though they are showing the same kind of thing.
 *
 * Times are rendered in the reader's own locale settings for `en-IN`, which is
 * the working day of everybody using this.
 */

const SHORT: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
};

const WITH_YEAR: Intl.DateTimeFormatOptions = { ...SHORT, year: 'numeric' };

/** Day, month, hour and minute — the default for anything recent. */
export function when(value: string | number | Date): string {
  return new Date(value).toLocaleString('en-IN', SHORT);
}

/**
 * The same, plus the year.
 *
 * For lists that reach back far enough that "12 Mar" is ambiguous — settings
 * history, and a delivery estimate that may fall outside the current year.
 */
export function whenWithYear(value: string | number | Date): string {
  return new Date(value).toLocaleString('en-IN', WITH_YEAR);
}
