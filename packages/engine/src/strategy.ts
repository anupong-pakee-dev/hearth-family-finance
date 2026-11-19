/**
 * Multi-debt payoff planning (FR-DEBT-08/09, FR-FDEBT-06; algorithm §8.4).
 *
 * Every month: pay every minimum, sort the open debts by strategy, pour the remainder into the
 * first open debt. A closed debt's old minimum automatically rolls into the remainder (snowball roll-over).
 */
import { type Satang, bmin, bsum } from './money.ts';
import { type IsoDate, addMonths } from './dates.ts';
import { type DebtTerms, periodInterest, scheduledPayment, rateAt, MAX_MONTHS } from './debt.ts';

export type Strategy = 'snowball' | 'avalanche' | 'custom';

export interface PlanDebt extends DebtTerms { id: string; name: string }

export interface DebtOutcome {
  id: string;
  name: string;
  payoffMonth: number | null;
  payoffDate: IsoDate | null;
  totalInterest: Satang;
  totalPaid: Satang;
}

export interface PlanResult {
  strategy: Strategy;
  months: number;
  payoffDate: IsoDate | null;
  totalInterest: Satang;
  totalPaid: Satang;
  /** Budget lower than the sum of minimums in the first month. */
  shortfall: Satang;
  neverPaysOff: boolean;
  debts: DebtOutcome[];
  /** Total balance at the end of each month. */
  balanceSeries: Satang[];
  /** Per-debt balance at the end of each month (same index as balanceSeries). */
  debtSeries: Record<string, Satang[]>;
  /** Suggested payment per debt for the first month (FR-DEBT-09). */
  firstMonth: Record<string, Satang>;
}

/**
 * Cost of carrying one more baht of this debt, as an annual rate (× 10 000). For flat-rate loans the
 * monthly interest is fixed on the ORIGINAL principal, so the true rate on the remaining balance is
 * rate × P0 / balance — much higher than the nominal flat rate. Avalanche must rank by this.
 */
export function effectiveRateE4(d: DebtTerms, balance: Satang, month = 0): number {
  const r = rateAt(d, month);
  if (d.method === 'flat' && balance > 0n) {
    const p0 = d.principalOriginal ?? balance;
    return Number((BigInt(r) * p0) / balance);
  }
  return r;
}

function order(open: { d: PlanDebt; bal: Satang }[], strategy: Strategy, custom: string[], month: number): { d: PlanDebt; bal: Satang }[] {
  const arr = [...open];
  if (strategy === 'snowball') arr.sort((a, b) => (a.bal < b.bal ? -1 : a.bal > b.bal ? 1 : b.d.rateE4 - a.d.rateE4));
  else if (strategy === 'avalanche') arr.sort((a, b) => effectiveRateE4(b.d, b.bal, month) - effectiveRateE4(a.d, a.bal, month) || (a.bal < b.bal ? -1 : a.bal > b.bal ? 1 : 0));
  else {
    const idx = (id: string) => { const i = custom.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    arr.sort((a, b) => idx(a.d.id) - idx(b.d.id));
  }
  return arr;
}

export function simulatePlan(debts: PlanDebt[], monthlyBudget: Satang, strategy: Strategy, opts: { customOrder?: string[]; startDate?: IsoDate; maxMonths?: number } = {}): PlanResult {
  const start = opts.startDate ?? '2026-01-01';
  const maxMonths = opts.maxMonths ?? MAX_MONTHS;
  const custom = opts.customOrder ?? debts.map((d) => d.id);
  const state = debts.map((d) => ({ d, bal: d.balance }));
  const outcome = new Map<string, DebtOutcome>(debts.map((d) => [d.id, { id: d.id, name: d.name, payoffMonth: d.balance <= 0n ? 0 : null, payoffDate: null, totalInterest: 0n, totalPaid: 0n }]));
  const balanceSeries: Satang[] = [];
  const debtSeries: Record<string, Satang[]> = Object.fromEntries(debts.map((d) => [d.id, [] as Satang[]]));
  const firstMonth: Record<string, Satang> = {};
  let shortfall = 0n;
  let totalInterest = 0n;
  let totalPaid = 0n;
  let month = 0;
  let stagnant = 0;
  let prevTotal = bsum(state.map((s) => s.bal));

  for (; month < maxMonths; month++) {
    const open = state.filter((s) => s.bal > 0n);
    if (open.length === 0) break;
    const date = addMonths(start, month);
    const owed = new Map<string, Satang>();
    const paid = new Map<string, Satang>();
    let mins = 0n;
    for (const s of open) {
      const interest = periodInterest(s.d, s.bal, month, date);
      const o = outcome.get(s.d.id)!;
      o.totalInterest += interest;
      totalInterest += interest;
      s.bal += interest;
      owed.set(s.d.id, s.bal);
      const min = scheduledPayment({ ...s.d, payment: s.d.method === 'credit_card' ? 0n : s.d.payment }, s.bal - interest, interest);
      paid.set(s.d.id, min);
      mins += min;
    }
    let leftover = monthlyBudget - mins;
    if (leftover < 0n) {
      if (month === 0) shortfall = -leftover;
      leftover = 0n;
    }
    for (const s of order(open, strategy, custom, month)) {
      if (leftover <= 0n) break;
      const room = owed.get(s.d.id)! - paid.get(s.d.id)!;
      const add = bmin(room, leftover);
      paid.set(s.d.id, paid.get(s.d.id)! + add);
      leftover -= add;
    }
    for (const s of open) {
      const p = paid.get(s.d.id)!;
      s.bal -= p;
      const o = outcome.get(s.d.id)!;
      o.totalPaid += p;
      totalPaid += p;
      if (month === 0) firstMonth[s.d.id] = p;
      if (s.bal <= 0n && o.payoffMonth === null) { o.payoffMonth = month + 1; o.payoffDate = date; s.bal = 0n; }
    }
    const total = bsum(state.map((s) => s.bal));
    balanceSeries.push(total);
    for (const s of state) debtSeries[s.d.id].push(s.bal);
    stagnant = total >= prevTotal ? stagnant + 1 : 0;
    prevTotal = total;
    if (stagnant >= 12) break;
  }

  const done = state.every((s) => s.bal <= 0n);
  return {
    strategy,
    months: done ? month : balanceSeries.length,
    payoffDate: done && month > 0 ? addMonths(start, month - 1) : null,
    totalInterest,
    totalPaid,
    shortfall,
    neverPaysOff: !done,
    debts: [...outcome.values()],
    balanceSeries,
    debtSeries,
    firstMonth,
  };
}

/** Compare snowball / avalanche / custom with the same budget (FR-DEBT-08, DASH-07). */
export function compareStrategies(debts: PlanDebt[], monthlyBudget: Satang, opts: { customOrder?: string[]; startDate?: IsoDate } = {}) {
  return {
    snowball: simulatePlan(debts, monthlyBudget, 'snowball', opts),
    avalanche: simulatePlan(debts, monthlyBudget, 'avalanche', opts),
    custom: simulatePlan(debts, monthlyBudget, 'custom', opts),
  };
}

/** Sum of contractual minimums in the first month — the smallest workable plan budget. */
export function minimumBudget(debts: PlanDebt[], startDate: IsoDate = '2026-01-01'): Satang {
  let sum = 0n;
  for (const d of debts) {
    if (d.balance <= 0n) continue;
    const interest = periodInterest(d, d.balance, 0, startDate);
    sum += scheduledPayment({ ...d, payment: d.method === 'credit_card' ? 0n : d.payment }, d.balance, interest);
  }
  return sum;
}
