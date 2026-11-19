/**
 * Calendar helpers. Dates are ISO-8601 strings "YYYY-MM-DD" in the Gregorian calendar
 * (decision #7: always store CE, convert to Buddhist Era only for display).
 */

export type IsoDate = string;

export function parseIso(d: IsoDate): { y: number; m: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new RangeError(`invalid ISO date: ${d}`);
  return { y: Number(m[1]), m: Number(m[2]), day: Number(m[3]) };
}

export function isIsoDate(d: unknown): d is IsoDate {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const { y, m, day } = parseIso(d);
  return m >= 1 && m <= 12 && day >= 1 && day <= daysInMonth(y, m);
}

export function fmtIso(y: number, m: number, day: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Add months, clamping the day to the end of the target month (Jan 31 + 1m = Feb 28/29). */
export function addMonths(d: IsoDate, n: number): IsoDate {
  const { y, m, day } = parseIso(d);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmtIso(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

export function addDays(d: IsoDate, n: number): IsoDate {
  const { y, m, day } = parseIso(d);
  const t = new Date(Date.UTC(y, m - 1, day + n));
  return fmtIso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  const pa = parseIso(a); const pb = parseIso(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.day) - Date.UTC(pa.y, pa.m - 1, pa.day)) / 86_400_000);
}

/** Whole months from a to b (floor), e.g. 2026-01-15 -> 2026-03-14 = 1. */
export function monthsBetween(a: IsoDate, b: IsoDate): number {
  const pa = parseIso(a); const pb = parseIso(b);
  let months = (pb.y - pa.y) * 12 + (pb.m - pa.m);
  if (pb.day < pa.day) months -= 1;
  return months;
}

export function monthKey(d: IsoDate): string { return d.slice(0, 7); }

export function todayIso(now = new Date()): IsoDate {
  return fmtIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/**
 * Budget cycle containing `d` when the cycle starts on `startDay` (FR-SET-03).
 * startDay = 25 -> cycle 25th .. 24th of next month.
 */
export function cycleFor(d: IsoDate, startDay: number): { start: IsoDate; end: IsoDate } {
  const sd = Math.min(Math.max(1, Math.trunc(startDay) || 1), 28);
  const { y, m, day } = parseIso(d);
  let start = fmtIso(y, m, sd);
  if (day < sd) start = addMonths(start, -1);
  const end = addDays(addMonths(start, 1), -1);
  return { start, end };
}

/** Last business day (Mon–Fri) of the month containing d (FR-REC-02). */
export function lastBusinessDay(d: IsoDate): IsoDate {
  const { y, m } = parseIso(d);
  let day = daysInMonth(y, m);
  for (;;) {
    const wd = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    if (wd !== 0 && wd !== 6) return fmtIso(y, m, day);
    day -= 1;
  }
}

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'last_business_day';

export function nextOccurrence(d: IsoDate, freq: Frequency, interval = 1): IsoDate {
  switch (freq) {
    case 'daily': return addDays(d, interval);
    case 'weekly': return addDays(d, 7 * interval);
    case 'monthly': return addMonths(d, interval);
    case 'yearly': return addMonths(d, 12 * interval);
    case 'last_business_day': return lastBusinessDay(addMonths(fmtIso(parseIso(d).y, parseIso(d).m, 1), interval));
  }
}
