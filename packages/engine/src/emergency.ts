/**
 * Emergency fund (FR-EMG-01..06).
 */
import { type Satang, bmax, divRound } from './money.ts';

export type EmergencyTier = 'none' | 'starter' | 'basic' | 'secure';

export const TIER_MONTHS: Record<Exclude<EmergencyTier, 'none'>, number> = { starter: 1, basic: 3, secure: 6 };

/** Runway in months = fund / essential monthly expenses (FR-EMG-03). One decimal, Infinity when no expenses. */
export function runwayMonths(fund: Satang, essentialMonthly: Satang): number {
  if (essentialMonthly <= 0n) return fund > 0n ? Infinity : 0;
  return Number((bmax(0n, fund) * 10n) / essentialMonthly) / 10;
}

export function tierFor(runway: number): EmergencyTier {
  if (runway >= TIER_MONTHS.secure) return 'secure';
  if (runway >= TIER_MONTHS.basic) return 'basic';
  if (runway >= TIER_MONTHS.starter) return 'starter';
  return 'none';
}

/** Target amount: months × essential expenses, or a fixed amount (FR-EMG-01). */
export function targetAmount(opts: { mode: 'months' | 'fixed'; months?: number; fixed?: Satang; essentialMonthly: Satang }): Satang {
  if (opts.mode === 'fixed') return opts.fixed ?? 0n;
  const m = opts.months ?? 6;
  return divRound(opts.essentialMonthly * BigInt(Math.round(m * 100)), 100n);
}

/** Average of monthly essential spending (FR-EMG-02) — pass the last 3–6 complete months. */
export function averageMonthly(monthTotals: Satang[]): Satang {
  const used = monthTotals.filter((v) => v > 0n);
  if (used.length === 0) return 0n;
  return divRound(used.reduce((a, b) => a + b, 0n), BigInt(used.length));
}

/** Refill plan after a withdrawal (FR-EMG-05): equal monthly amounts, last one absorbs rounding. */
export function refillPlan(amount: Satang, months: number): Satang[] {
  const n = Math.max(1, Math.trunc(months));
  const each = amount / BigInt(n);
  const plan = Array.from({ length: n }, () => each);
  plan[n - 1] += amount - each * BigInt(n);
  return plan;
}

/** FR-EMG-06 / FR-INV-05: should extra money go to the emergency fund before extra debt payments / investing? */
export function shouldPrioritiseEmergency(runway: number, minimumMonths = 1): boolean {
  return runway < minimumMonths;
}
