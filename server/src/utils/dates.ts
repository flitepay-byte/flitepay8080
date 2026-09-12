/**
 * Limit windows are evaluated in IST, since the simulated operating entity
 * is Indian. Using UTC day boundaries would roll daily limits at 05:30 local.
 */
const IST_OFFSET_MINUTES = 330;

export function istDayBounds(reference: Date = new Date()): { start: Date; end: Date } {
  const istMillis = reference.getTime() + IST_OFFSET_MINUTES * 60_000;
  const istDate = new Date(istMillis);
  const startIst = Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate(), 0, 0, 0, 0);
  const start = new Date(startIst - IST_OFFSET_MINUTES * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

export function istMonthBounds(reference: Date = new Date()): { start: Date; end: Date } {
  const istMillis = reference.getTime() + IST_OFFSET_MINUTES * 60_000;
  const istDate = new Date(istMillis);
  const startIst = Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), 1, 0, 0, 0, 0);
  const start = new Date(startIst - IST_OFFSET_MINUTES * 60_000);
  const nextMonthIst = Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  const end = new Date(nextMonthIst - IST_OFFSET_MINUTES * 60_000);
  return { start, end };
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
