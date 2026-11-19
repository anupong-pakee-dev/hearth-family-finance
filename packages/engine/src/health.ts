/**
 * Financial health indicators and score (§8.7).
 */
import { type Satang } from './money.ts';

export interface HealthInputs {
  monthlyIncome: Satang;
  monthlyExpense: Satang;
  monthlyDebtPayments: Satang;
  emergencyRunwayMonths: number;
  liquidAssets: Satang;
  netWorth: Satang;
  netWorthPrev?: Satang | null;
}

export interface HealthPart { key: string; score: number; max: number; value: number | null; reason: string }

export function savingsRate(income: Satang, expense: Satang): number {
  if (income <= 0n) return 0;
  return Number(((income - expense) * 10_000n) / income) / 10_000;
}

export function liquidityRatio(liquid: Satang, monthlyExpense: Satang): number {
  if (monthlyExpense <= 0n) return liquid > 0n ? Infinity : 0;
  return Number((liquid * 100n) / monthlyExpense) / 100;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Financial Health Score 0–100 with an explanation per component. */
export function healthScore(i: HealthInputs, thresholds = { savingsRate: 0.2, dsr: 0.4, runway: 6, liquidity: 6 }): { score: number; parts: HealthPart[] } {
  const parts: HealthPart[] = [];
  const sr = savingsRate(i.monthlyIncome, i.monthlyExpense);
  parts.push({ key: 'savings_rate', max: 25, value: sr, score: Math.round(clamp(sr / thresholds.savingsRate, 0, 1) * 25), reason: sr >= thresholds.savingsRate ? 'good' : sr > 0 ? 'low' : 'negative' });
  const dsr = i.monthlyIncome > 0n ? Number((i.monthlyDebtPayments * 10_000n) / i.monthlyIncome) / 10_000 : (i.monthlyDebtPayments > 0n ? 1 : 0);
  parts.push({ key: 'dsr', max: 25, value: dsr, score: Math.round(clamp(1 - Math.max(0, dsr - thresholds.dsr * 0.5) / (thresholds.dsr * 0.5 + 1e-9), 0, 1) * 25), reason: dsr <= thresholds.dsr ? 'good' : 'high' });
  const rw = Number.isFinite(i.emergencyRunwayMonths) ? i.emergencyRunwayMonths : thresholds.runway;
  parts.push({ key: 'runway', max: 25, value: i.emergencyRunwayMonths, score: Math.round(clamp(rw / thresholds.runway, 0, 1) * 25), reason: rw >= thresholds.runway ? 'good' : rw >= 1 ? 'building' : 'low' });
  const lq = liquidityRatio(i.liquidAssets, i.monthlyExpense);
  const lqv = Number.isFinite(lq) ? lq : thresholds.liquidity;
  parts.push({ key: 'liquidity', max: 15, value: lq, score: Math.round(clamp(lqv / thresholds.liquidity, 0, 1) * 15), reason: lqv >= 3 ? 'good' : 'low' });
  const growing = i.netWorthPrev == null ? i.netWorth > 0n : i.netWorth >= i.netWorthPrev;
  parts.push({ key: 'net_worth', max: 10, value: null, score: growing ? 10 : i.netWorth > 0n ? 5 : 0, reason: growing ? 'growing' : 'shrinking' });
  return { score: parts.reduce((s, p) => s + p.score, 0), parts };
}
