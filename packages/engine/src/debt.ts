/**
 * Debt maths (FR-DEBT-03..07, 12, 13; formulas §8.1–8.3).
 *
 * Every simulation works month by month in integer satang with banker's rounding so that
 * schedules add up exactly. Results are estimates — real lender figures may differ (NFR-ACC-04).
 */
import { type Satang, divRound, bmax, bmin, applyRate } from './money.ts';
import { type IsoDate, addMonths, daysInMonth, parseIso, daysBetween } from './dates.ts';

export type InterestMethod = 'reducing' | 'flat' | 'credit_card' | 'none';

export interface RateStep {
  /** 0-based month index (relative to the first simulated payment) from which this rate applies. */
  fromMonth: number;
  rateE4: number;
}

export interface DebtTerms {
  id?: string;
  name?: string;
  /** Current outstanding principal. */
  balance: Satang;
  method: InterestMethod;
  /** Annual rate, percent × 10 000. */
  rateE4: number;
  /** Planned monthly payment. For credit cards 0 = pay the minimum. */
  payment: Satang;
  /** Original principal — used by the flat-rate method. Defaults to `balance`. */
  principalOriginal?: Satang;
  /** Reducing balance: accrue interest daily (balance × rate × days / 365) like many Thai mortgages. */
  dailyAccrual?: boolean;
  /** Credit card minimum, percent of balance × 10 000 (e.g. 8% = 80 000). */
  minPercentE4?: number;
  /** Credit card fixed minimum floor. */
  minFloor?: Satang;
  /** Rate changes over time (FR-DEBT-13). */
  rateSchedule?: RateStep[];
  /** Date of the first simulated payment. */
  startDate?: IsoDate;
}

export interface ScheduleRow {
  month: number;
  date: IsoDate;
  payment: Satang;
  interest: Satang;
  principal: Satang;
  balance: Satang;
}

export interface PayoffSummary {
  months: number;
  totalInterest: Satang;
  totalPaid: Satang;
  payoffDate: IsoDate | null;
  /** True when payments never cover interest (§8.1: P ≤ B × r) or the horizon is exceeded. */
  neverPaysOff: boolean;
  schedule: ScheduleRow[];
}

export const MAX_MONTHS = 600; // 50 years

export function rateAt(terms: DebtTerms, month: number): number {
  let rate = terms.rateE4;
  if (terms.rateSchedule?.length) {
    const steps = [...terms.rateSchedule].sort((a, b) => a.fromMonth - b.fromMonth);
    for (const s of steps) if (s.fromMonth <= month) rate = s.rateE4;
  }
  return rate;
}

/** Days in the accrual period that ends on `date` (the previous calendar month length). */
function periodDays(date: IsoDate): number {
  const { y, m } = parseIso(date);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return daysInMonth(py, pm);
}

/** Interest accrued for one monthly period. */
export function periodInterest(terms: DebtTerms, balance: Satang, month: number, date: IsoDate, days?: number): Satang {
  if (balance <= 0n) return 0n;
  const rate = BigInt(rateAt(terms, month));
  switch (terms.method) {
    case 'none':
      return 0n;
    case 'flat': {
      const p0 = terms.principalOriginal ?? balance;
      return divRound(p0 * rate, 12n * 1_000_000n);
    }
    case 'credit_card': {
      const d = BigInt(days ?? periodDays(date));
      return divRound(balance * rate * d, 365n * 1_000_000n);
    }
    case 'reducing': {
      if (terms.dailyAccrual) {
        const d = BigInt(days ?? periodDays(date));
        return divRound(balance * rate * d, 365n * 1_000_000n);
      }
      return divRound(balance * rate, 12n * 1_000_000n);
    }
  }
}

/** Credit card minimum (§8.3): max(balance × min%, floor), never more than what is owed. */
export function creditCardMinimum(terms: DebtTerms, owed: Satang): Satang {
  const pct = terms.minPercentE4 ?? 50_000; // default 5%
  const floor = terms.minFloor ?? 0n;
  return bmin(owed, bmax(applyRate(owed, pct), floor));
}

/** Contractual payment for this period (before extras), capped at what is owed. */
export function scheduledPayment(terms: DebtTerms, balance: Satang, interest: Satang): Satang {
  const owed = balance + interest;
  if (terms.method === 'credit_card') {
    return bmin(owed, bmax(terms.payment, creditCardMinimum(terms, owed)));
  }
  return bmin(owed, terms.payment);
}

export interface SimulateOptions {
  extraMonthly?: Satang;
  lumpSum?: Satang;
  /** 0-based month in which the lump sum is paid. */
  lumpSumMonth?: number;
  maxMonths?: number;
  startDate?: IsoDate;
}

/** Month-by-month amortization (FR-DEBT-05/06/07). */
export function simulate(terms: DebtTerms, opts: SimulateOptions = {}): PayoffSummary {
  const start = opts.startDate ?? terms.startDate ?? '2026-01-01';
  const extra = opts.extraMonthly ?? 0n;
  const lump = opts.lumpSum ?? 0n;
  const lumpMonth = opts.lumpSumMonth ?? 0;
  const maxMonths = opts.maxMonths ?? MAX_MONTHS;
  const schedule: ScheduleRow[] = [];
  let balance = terms.balance;
  let totalInterest = 0n;
  let totalPaid = 0n;
  let stagnant = 0;

  if (balance <= 0n) return { months: 0, totalInterest: 0n, totalPaid: 0n, payoffDate: null, neverPaysOff: false, schedule };

  for (let i = 0; i < maxMonths; i++) {
    const date = addMonths(start, i);
    const interest = periodInterest(terms, balance, i, date);
    const owed = balance + interest;
    let pay = scheduledPayment(terms, balance, interest) + extra + (i === lumpMonth ? lump : 0n);
    pay = bmin(pay, owed);
    const interestPaid = bmin(pay, interest);
    const principal = pay - interestPaid;
    const newBalance = owed - pay;
    schedule.push({ month: i, date, payment: pay, interest, principal, balance: newBalance });
    totalInterest += interest;
    totalPaid += pay;
    if (newBalance <= 0n) {
      return { months: i + 1, totalInterest, totalPaid, payoffDate: date, neverPaysOff: false, schedule };
    }
    stagnant = newBalance >= balance ? stagnant + 1 : 0;
    balance = newBalance;
    if (stagnant >= 12) break; // payment does not cover interest
  }
  return { months: schedule.length, totalInterest, totalPaid, payoffDate: null, neverPaysOff: true, schedule };
}

/**
 * Closed-form remaining periods for a reducing-balance loan (§8.1):
 *   n = −ln(1 − B·r / P) / ln(1 + r)
 * Returns Infinity when P ≤ B·r (never pays off). Uses floats — estimate only.
 */
export function remainingPeriods(balance: Satang, rateE4: number, payment: Satang): number {
  const B = Number(balance);
  const P = Number(payment);
  const r = rateE4 / 1_000_000 / 12;
  if (P <= 0) return Infinity;
  if (r === 0) return Math.ceil(B / P);
  if (P <= B * r) return Infinity;
  return -Math.log(1 - (B * r) / P) / Math.log(1 + r);
}

/** Standard annuity payment for a reducing-balance loan over n months. */
export function annuityPayment(principal: Satang, rateE4: number, months: number): Satang {
  if (months <= 0) return principal;
  const r = rateE4 / 1_000_000 / 12;
  if (r === 0) return divRound(principal, BigInt(months));
  const p = Number(principal) * r / (1 - Math.pow(1 + r, -months));
  return BigInt(Math.ceil(p)); // round up so the loan actually closes
}

export interface FlatRateSummary {
  totalInterest: Satang;
  installment: Satang;
  /** Effective annual interest rate (reducing-balance equivalent), percent as a float. */
  effectiveAnnualPercent: number;
}

/** Hire-purchase flat rate (§8.2). */
export function flatRate(principal: Satang, rateE4: number, months: number): FlatRateSummary {
  const totalInterest = divRound(principal * BigInt(rateE4) * BigInt(months), 12n * 1_000_000n);
  const installment = divRound(principal + totalInterest, BigInt(Math.max(1, months)));
  return { totalInterest, installment, effectiveAnnualPercent: effectiveRate(principal, installment, months) };
}

/** Solve the monthly IRR of an annuity by bisection and annualise it (×12, nominal). */
export function effectiveRate(principal: Satang, installment: Satang, months: number): number {
  const P = Number(principal);
  const A = Number(installment);
  if (A * months <= P) return 0;
  let lo = 0, hi = 1;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    const pv = A * (1 - Math.pow(1 + mid, -months)) / mid;
    if (pv > P) lo = mid; else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 12 * 100 * 10_000) / 10_000;
}

export interface WhatIfResult {
  base: PayoffSummary;
  scenario: PayoffSummary;
  monthsSaved: number;
  interestSaved: Satang;
}

/** FR-DEBT-07: pay X more per month and/or a one-off lump sum. */
export function whatIf(terms: DebtTerms, opts: SimulateOptions): WhatIfResult {
  const base = simulate(terms, { startDate: opts.startDate, maxMonths: opts.maxMonths });
  const scenario = simulate(terms, opts);
  return {
    base,
    scenario,
    monthsSaved: base.neverPaysOff && !scenario.neverPaysOff ? Infinity : base.months - scenario.months,
    interestSaved: base.totalInterest - scenario.totalInterest,
  };
}

/** FR-DEBT-12: compare current terms with a refinance offer (new rate / payment / fees). */
export function refinance(terms: DebtTerms, offer: { rateE4: number; payment: Satang; fees: Satang; method?: InterestMethod }, startDate?: IsoDate) {
  const current = simulate(terms, { startDate });
  const next = simulate({ ...terms, rateE4: offer.rateE4, payment: offer.payment, method: offer.method ?? terms.method, rateSchedule: undefined, principalOriginal: terms.balance }, { startDate });
  return {
    current,
    refinanced: next,
    interestSaved: current.totalInterest - next.totalInterest - offer.fees,
    monthsSaved: current.months - next.months,
  };
}

/**
 * FR-DEBT-04: split a real payment into interest / principal for the period since the last payment.
 * Fees are taken first, then interest, then principal.
 */
export function splitPayment(terms: DebtTerms, balance: Satang, amount: Satang, paidOn: IsoDate, lastPaidOn?: IsoDate | null, fee: Satang = 0n) {
  const days = lastPaidOn ? Math.max(0, daysBetween(lastPaidOn, paidOn)) : undefined;
  let interest = periodInterest(terms, balance, 0, paidOn, days);
  if (days !== undefined && (terms.method === 'flat' || (terms.method === 'reducing' && !terms.dailyAccrual))) {
    // monthly method: pro-rate by months elapsed (at least one period)
    const months = Math.max(1, Math.round(days / 30.4375));
    interest = interest * BigInt(months);
  }
  const afterFee = bmax(0n, amount - fee);
  const interestPaid = bmin(afterFee, interest);
  const principal = bmin(balance, afterFee - interestPaid);
  return { fee: bmin(fee, amount), interest: interestPaid, principal, newBalance: balance - principal };
}

/** DSR (FR-DEBT-14): monthly debt payments / monthly income, as a fraction. */
export function debtServiceRatio(monthlyPayments: Satang, monthlyIncome: Satang): number {
  if (monthlyIncome <= 0n) return monthlyPayments > 0n ? Infinity : 0;
  return Number(monthlyPayments * 10_000n / monthlyIncome) / 10_000;
}
