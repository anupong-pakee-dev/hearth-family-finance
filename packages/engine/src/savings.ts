/**
 * Savings goals (FR-SAVE-02..05, 07; formula §8.5).
 */
import { type Satang, divRound, bmax, bmin, toMajorNumber, fromMajorNumber } from './money.ts';
import { type IsoDate, monthsBetween, addMonths } from './dates.ts';

/**
 * Required monthly saving to reach `target` from `current` in `months`.
 *   no return : (target − current) / months
 *   return r  : PMT = (FV − PV(1+r)^n) × r / ((1+r)^n − 1)   (r monthly)
 */
export function requiredMonthly(target: Satang, current: Satang, months: number, annualReturnE4 = 0): Satang {
  const gap = target - current;
  if (gap <= 0n) return 0n;
  if (months <= 0) return gap;
  if (annualReturnE4 <= 0) {
    const q = divRound(gap, BigInt(months));
    return q * BigInt(months) < gap ? q + 1n : q; // round up: must reach the goal
  }
  const r = annualReturnE4 / 1_000_000 / 12;
  const growth = Math.pow(1 + r, months);
  const fv = toMajorNumber(target);
  const pv = toMajorNumber(current);
  const pmt = ((fv - pv * growth) * r) / (growth - 1);
  return bmax(0n, fromMajorNumber(Math.ceil(pmt * 100) / 100));
}

/** Months needed to reach target saving `monthly` with optional return. Infinity if never. */
export function monthsToTarget(target: Satang, current: Satang, monthly: Satang, annualReturnE4 = 0): number {
  if (current >= target) return 0;
  const r = annualReturnE4 / 1_000_000 / 12;
  if (monthly <= 0n && r <= 0) return Infinity;
  if (r <= 0) {
    const gap = target - current;
    return Number((gap + monthly - 1n) / monthly);
  }
  const fv = toMajorNumber(target), pv = toMajorNumber(current), pmt = toMajorNumber(monthly);
  // FV = PV(1+r)^n + PMT((1+r)^n − 1)/r  →  (1+r)^n = (FV·r + PMT) / (PV·r + PMT)
  const num = fv * r + pmt;
  const den = pv * r + pmt;
  if (den <= 0) return Infinity;
  const n = Math.log(num / den) / Math.log(1 + r);
  return Number.isFinite(n) ? Math.max(0, Math.ceil(n)) : Infinity;
}

export type GoalStatus = 'done' | 'ahead' | 'on_track' | 'behind' | 'no_deadline';

export interface GoalProgress {
  percent: number;
  remaining: Satang;
  monthsLeft: number | null;
  requiredMonthly: Satang | null;
  /** Forecast based on the recent average saving rate (FR-SAVE-03). */
  forecastDate: IsoDate | null;
  status: GoalStatus;
}

/**
 * @param recentMonthlyAvg average monthly contribution over the last 3 months.
 * @param startedOn goal creation date (used for the linear "expected by now" check).
 */
export function goalProgress(args: {
  target: Satang | null;
  current: Satang;
  targetDate: IsoDate | null;
  today: IsoDate;
  startedOn: IsoDate;
  recentMonthlyAvg: Satang;
  annualReturnE4?: number;
}): GoalProgress {
  const { target, current, targetDate, today, startedOn, recentMonthlyAvg } = args;
  const ret = args.annualReturnE4 ?? 0;
  if (target == null || target <= 0n) {
    return { percent: 0, remaining: 0n, monthsLeft: null, requiredMonthly: null, forecastDate: null, status: 'no_deadline' };
  }
  const remaining = bmax(0n, target - current);
  const percent = Math.min(100, Number((bmin(current, target) * 10_000n) / target) / 100);
  if (remaining === 0n) {
    return { percent: 100, remaining, monthsLeft: 0, requiredMonthly: 0n, forecastDate: today, status: 'done' };
  }
  const n = monthsToTarget(target, current, recentMonthlyAvg, ret);
  const forecastDate = Number.isFinite(n) ? addMonths(today, n) : null;
  if (!targetDate) {
    return { percent, remaining, monthsLeft: null, requiredMonthly: null, forecastDate, status: 'no_deadline' };
  }
  const monthsLeft = Math.max(0, monthsBetween(today, targetDate));
  const req = requiredMonthly(target, current, Math.max(1, monthsLeft), ret);
  // Linear expectation: share of time elapsed should match share of target saved.
  const totalSpan = Math.max(1, monthsBetween(startedOn, targetDate));
  const elapsed = Math.min(totalSpan, Math.max(0, monthsBetween(startedOn, today)));
  const expected = (elapsed / totalSpan) * 100;
  let status: GoalStatus = 'on_track';
  if (forecastDate && forecastDate < targetDate && percent >= expected + 5) status = 'ahead';
  else if ((forecastDate === null || forecastDate > targetDate) && percent < expected - 5) status = 'behind';
  else if (forecastDate === null && percent < expected) status = 'behind';
  return { percent, remaining, monthsLeft, requiredMonthly: req, forecastDate, status };
}

/**
 * FR-SAVE-07: distribute an amount across goals in priority order, filling each goal's
 * required monthly amount first and putting any remainder into the top-priority open goal.
 */
export function distributeByPriority(amount: Satang, goals: { id: string; need: Satang; remaining: Satang }[]): Record<string, Satang> {
  const out: Record<string, Satang> = {};
  let left = amount;
  for (const g of goals) {
    const give = bmin(left, bmin(g.need, g.remaining));
    out[g.id] = give;
    left -= give;
  }
  for (const g of goals) {
    if (left <= 0n) break;
    const room = g.remaining - (out[g.id] ?? 0n);
    const give = bmin(left, bmax(0n, room));
    out[g.id] = (out[g.id] ?? 0n) + give;
    left -= give;
  }
  return out;
}

/** Projected balance month by month (DASH-10), estimate. */
export function growthSeries(current: Satang, monthly: Satang, months: number, annualReturnE4 = 0): Satang[] {
  const r = annualReturnE4 / 1_000_000 / 12;
  const out: Satang[] = [];
  let v = toMajorNumber(current);
  const p = toMajorNumber(monthly);
  for (let i = 0; i < months; i++) {
    v = v * (1 + r) + p;
    out.push(fromMajorNumber(v));
  }
  return out;
}

/** 52-week challenge amount for week w (1-based) with base step (FR-SAVE-09). */
export function challengeAmount(kind: '52_week' | 'daily_increment', index: number, step: Satang): Satang {
  return step * BigInt(Math.max(1, index));
}
