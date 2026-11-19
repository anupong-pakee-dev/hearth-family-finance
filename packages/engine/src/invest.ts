/**
 * Investment tracking maths (FR-INV-09, 13, 14, 16, 17, 20, 21; formulas §8.6).
 *
 * Units and prices are fixed-point integers scaled by 1e8 (DB decimal(20,8)).
 * Price is in MAJOR currency units × 1e8 (e.g. 12.3456 THB/unit = 1_234_560_000n).
 * Value in satang = unitsE8 × priceE8 / 1e14.
 *
 * This is a record-keeping tool — never investment advice (FR-INV-26).
 */
import { type Satang, divRound, bmin, toMajorNumber, fromMajorNumber } from './money.ts';
import { type IsoDate, daysBetween } from './dates.ts';

export const E8 = 100_000_000n;

export type InvTxnType = 'buy' | 'sell' | 'dividend' | 'interest' | 'fee' | 'switch_in' | 'switch_out' | 'split' | 'transfer_in' | 'transfer_out';

export interface InvTxn {
  date: IsoDate;
  type: InvTxnType;
  assetId: string;
  /** Units × 1e8. For `split` this is the ratio × 1e8 (2-for-1 = 2e8). */
  unitsE8: bigint;
  /** Gross cash amount in satang (buy cost before fee, sell proceeds before fee, dividend gross). */
  amount: Satang;
  fee?: Satang;
  tax?: Satang;
}

export interface Holding {
  assetId: string;
  unitsE8: bigint;
  /** Cost basis of units still held (incl. buy fees). */
  costBasis: Satang;
  realizedPL: Satang;
  income: Satang;
  fees: Satang;
  /** Total cash put in (buys + switch-ins + transfer-ins cost). */
  invested: Satang;
  /** Total cash received back (sell proceeds net + income). */
  returned: Satang;
}

export type CostMethod = 'average' | 'fifo';

export function valueOf(unitsE8: bigint, priceE8: bigint): Satang {
  return divRound(unitsE8 * priceE8, 100_000_000_000_000n);
}

/** Average cost per unit as priceE8. */
export function averageCostE8(h: Holding): bigint {
  if (h.unitsE8 <= 0n) return 0n;
  return divRound(h.costBasis * 100_000_000_000_000n, h.unitsE8);
}

/** Replay transactions into holdings (FR-INV-09, 13). Transactions are processed in date order. */
export function computeHoldings(txns: InvTxn[], method: CostMethod = 'average'): Map<string, Holding> {
  const sorted = [...txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out = new Map<string, Holding>();
  const lots = new Map<string, { units: bigint; cost: Satang }[]>();
  const get = (id: string) => {
    let h = out.get(id);
    if (!h) { h = { assetId: id, unitsE8: 0n, costBasis: 0n, realizedPL: 0n, income: 0n, fees: 0n, invested: 0n, returned: 0n }; out.set(id, h); lots.set(id, []); }
    return h;
  };
  for (const t of sorted) {
    const h = get(t.assetId);
    const fee = t.fee ?? 0n;
    const tax = t.tax ?? 0n;
    const L = lots.get(t.assetId)!;
    switch (t.type) {
      case 'buy':
      case 'switch_in':
      case 'transfer_in': {
        const cost = t.amount + fee;
        h.unitsE8 += t.unitsE8;
        h.costBasis += cost;
        h.fees += fee;
        h.invested += cost;
        L.push({ units: t.unitsE8, cost });
        break;
      }
      case 'sell':
      case 'switch_out':
      case 'transfer_out': {
        const units = bmin(t.unitsE8, h.unitsE8);
        if (units <= 0n) break;
        let costOut = 0n;
        if (method === 'average') {
          costOut = divRound(h.costBasis * units, h.unitsE8);
          // keep lots roughly in sync for a later method switch
          let left = units;
          while (left > 0n && L.length) {
            const lot = L[0];
            if (lot.units <= left) { left -= lot.units; L.shift(); }
            else { const c = divRound(lot.cost * left, lot.units); lot.units -= left; lot.cost -= c; left = 0n; }
          }
        } else {
          let left = units;
          while (left > 0n && L.length) {
            const lot = L[0];
            if (lot.units <= left) { costOut += lot.cost; left -= lot.units; L.shift(); }
            else { const c = divRound(lot.cost * left, lot.units); costOut += c; lot.units -= left; lot.cost -= c; left = 0n; }
          }
        }
        h.unitsE8 -= units;
        h.costBasis -= costOut;
        h.fees += fee;
        if (t.type === 'transfer_out') {
          h.invested -= costOut; // moved out at cost, no P/L
        } else {
          const net = t.amount - fee - tax;
          h.realizedPL += net - costOut;
          h.returned += net;
        }
        if (h.unitsE8 === 0n) h.costBasis = 0n;
        break;
      }
      case 'dividend':
      case 'interest': {
        const net = t.amount - tax - fee;
        h.income += net;
        h.returned += net;
        break;
      }
      case 'fee': {
        const f = t.amount + fee;
        h.fees += f;
        h.realizedPL -= f;
        break;
      }
      case 'split': {
        if (t.unitsE8 > 0n) {
          h.unitsE8 = divRound(h.unitsE8 * t.unitsE8, E8);
          for (const lot of L) lot.units = divRound(lot.units * t.unitsE8, E8);
        }
        break;
      }
    }
  }
  return out;
}

export interface Valuation {
  marketValue: Satang;
  unrealizedPL: Satang;
  totalPL: Satang;
  /** (value + returned − invested) / invested */
  simpleReturn: number;
}

export function valuation(h: Holding, priceE8: bigint | null): Valuation {
  const marketValue = priceE8 == null ? h.costBasis : valueOf(h.unitsE8, priceE8);
  const unrealizedPL = marketValue - h.costBasis;
  const totalPL = unrealizedPL + h.realizedPL + h.income;
  const simpleReturn = h.invested > 0n ? Number(((marketValue + h.returned - h.invested) * 1_000_000n) / h.invested) / 1_000_000 : 0;
  return { marketValue, unrealizedPL, totalPL, simpleReturn };
}

export interface CashFlow { date: IsoDate; amount: number }

/**
 * XIRR (FR-INV-14): r such that Σ CFᵢ / (1+r)^((tᵢ − t₀)/365) = 0.
 * Investor perspective: money in is negative, money out (and current value) positive.
 * Newton–Raphson with a bisection fallback. Returns null if it cannot converge.
 */
export function xirr(flows: CashFlow[]): number | null {
  if (flows.length < 2) return null;
  const f = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!f.some((c) => c.amount > 0) || !f.some((c) => c.amount < 0)) return null;
  const t0 = f[0].date;
  const years = f.map((c) => daysBetween(t0, c.date) / 365);
  const npv = (r: number) => f.reduce((s, c, i) => s + c.amount / Math.pow(1 + r, years[i]), 0);
  const dnpv = (r: number) => f.reduce((s, c, i) => s - (years[i] * c.amount) / Math.pow(1 + r, years[i] + 1), 0);
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const v = npv(r);
    const d = dnpv(r);
    if (!Number.isFinite(v) || !Number.isFinite(d) || d === 0) break;
    const next = r - v / d;
    if (next <= -0.9999) break;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }
  let lo = -0.9999, hi = 10;
  let flo = npv(lo), fhi = npv(hi);
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/** Build XIRR cash flows from transactions + current value. */
export function cashFlowsFor(txns: InvTxn[], currentValue: Satang, today: IsoDate): CashFlow[] {
  const flows: CashFlow[] = [];
  for (const t of txns) {
    const fee = toMajorNumber(t.fee ?? 0n), tax = toMajorNumber(t.tax ?? 0n), amt = toMajorNumber(t.amount);
    if (t.type === 'buy' || t.type === 'switch_in' || t.type === 'transfer_in') flows.push({ date: t.date, amount: -(amt + fee) });
    else if (t.type === 'sell' || t.type === 'switch_out' || t.type === 'transfer_out') flows.push({ date: t.date, amount: amt - fee - tax });
    else if (t.type === 'dividend' || t.type === 'interest') flows.push({ date: t.date, amount: amt - fee - tax });
    else if (t.type === 'fee') flows.push({ date: t.date, amount: -(amt + fee) });
  }
  if (currentValue > 0n) flows.push({ date: today, amount: toMajorNumber(currentValue) });
  return flows;
}

/**
 * FV = PV(1+r)^n + PMT × ((1+r)^n − 1) / r, monthly compounding (FR-INV-20).
 * Returns end-of-month values for `months` months. Estimate only.
 */
export function projectValue(pv: Satang, monthly: Satang, annualReturnPercent: number, months: number): Satang[] {
  const r = annualReturnPercent / 100 / 12;
  const out: Satang[] = [];
  let v = toMajorNumber(pv);
  const p = toMajorNumber(monthly);
  for (let i = 0; i < months; i++) { v = v * (1 + r) + p; out.push(fromMajorNumber(v)); }
  return out;
}

export function scenarios(pv: Satang, monthly: Satang, months: number, rates: { conservative: number; moderate: number; optimistic: number }) {
  return {
    conservative: projectValue(pv, monthly, rates.conservative, months),
    moderate: projectValue(pv, monthly, rates.moderate, months),
    optimistic: projectValue(pv, monthly, rates.optimistic, months),
    contributed: Array.from({ length: months }, (_, i) => pv + monthly * BigInt(i + 1)),
  };
}

/**
 * Retirement calculator (FR-INV-21). Returns the nest egg needed at retirement (in future money)
 * and the monthly investment required to get there. Estimate only.
 */
export function retirementPlan(a: {
  currentAge: number; retireAge: number; lifeExpectancy: number;
  monthlyExpenseToday: Satang; inflationPercent: number;
  returnBeforePercent: number; returnAfterPercent: number; currentSavings: Satang;
}) {
  const yearsToRetire = Math.max(0, a.retireAge - a.currentAge);
  const yearsInRetirement = Math.max(1, a.lifeExpectancy - a.retireAge);
  const expenseAtRetire = toMajorNumber(a.monthlyExpenseToday) * Math.pow(1 + a.inflationPercent / 100, yearsToRetire);
  // Present value at retirement of an inflation-growing monthly annuity
  const rr = (1 + a.returnAfterPercent / 100) / (1 + a.inflationPercent / 100) - 1; // real annual
  const rm = Math.pow(1 + rr, 1 / 12) - 1;
  const n = yearsInRetirement * 12;
  const needed = rm === 0 ? expenseAtRetire * n : expenseAtRetire * (1 - Math.pow(1 + rm, -n)) / rm;
  const r = a.returnBeforePercent / 100 / 12;
  const m = yearsToRetire * 12;
  const fvCurrent = toMajorNumber(a.currentSavings) * Math.pow(1 + r, m);
  const gap = Math.max(0, needed - fvCurrent);
  const monthly = m === 0 ? gap : r === 0 ? gap / m : (gap * r) / (Math.pow(1 + r, m) - 1);
  return {
    expenseAtRetirement: fromMajorNumber(expenseAtRetire),
    nestEgg: fromMajorNumber(needed),
    projectedFromCurrent: fromMajorNumber(fvCurrent),
    monthlyRequired: fromMajorNumber(Math.ceil(monthly * 100) / 100),
    yearsToRetire,
  };
}

/** FR-INV-16/17: allocation vs target and the amount to add (+) / reduce (−) per class. */
export function rebalance(values: Record<string, Satang>, targetsE4: Record<string, number>) {
  const total = Object.values(values).reduce((a, b) => a + b, 0n);
  const classes = new Set([...Object.keys(values), ...Object.keys(targetsE4)]);
  const rows = [...classes].map((cls) => {
    const value = values[cls] ?? 0n;
    const targetE4 = targetsE4[cls] ?? 0;
    const targetValue = divRound(total * BigInt(targetE4), 1_000_000n);
    return {
      assetClass: cls,
      value,
      actualPercent: total > 0n ? Number((value * 1_000_000n) / total) / 10_000 : 0,
      targetPercent: targetE4 / 10_000,
      difference: targetValue - value,
    };
  });
  return { total, rows };
}
