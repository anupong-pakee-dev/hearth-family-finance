/**
 * Money buckets (FR-BKT-03, 05, 06, 08).
 * Buckets are OPTIONAL — nothing else in the engine depends on them.
 */
import { type Satang, divRound, bmax, bmin } from './money.ts';

export type BucketMode = 'off' | 'partial' | 'full';
export type BucketType = 'bills' | 'spending' | 'savings' | 'emergency' | 'debt' | 'investing';

export type AllocationRule =
  | { kind: 'percent'; bucketId: string; percentE4: number }
  | { kind: 'fixed'; bucketId: string; amount: Satang }
  | { kind: 'fill'; bucketId: string; upTo: Satang }; // priority fill up to target (uses current balance)

/**
 * Apply allocation rules to an income amount (FR-BKT-05).
 * Order matters: fixed amounts and fills are applied in the given order; percent rules are computed
 * on the ORIGINAL income. Never allocates more than the income. Returns per-bucket amounts + leftover.
 */
export function allocateIncome(income: Satang, rules: AllocationRule[], balances: Record<string, Satang> = {}): { allocations: Record<string, Satang>; unallocated: Satang } {
  const allocations: Record<string, Satang> = {};
  let left = income;
  for (const r of rules) {
    if (left <= 0n) break;
    let amt = 0n;
    if (r.kind === 'percent') amt = divRound(income * BigInt(r.percentE4), 1_000_000n);
    else if (r.kind === 'fixed') amt = r.amount;
    else {
      const current = (balances[r.bucketId] ?? 0n) + (allocations[r.bucketId] ?? 0n);
      amt = bmax(0n, r.upTo - current);
    }
    amt = bmin(amt, left);
    if (amt <= 0n) continue;
    allocations[r.bucketId] = (allocations[r.bucketId] ?? 0n) + amt;
    left -= amt;
  }
  return { allocations, unallocated: left };
}

/** "To be allocated" = money in accounts − money in buckets (FR-BKT-03). */
export function toBeAllocated(accountsTotal: Satang, bucketsTotal: Satang): Satang {
  return accountsTotal - bucketsTotal;
}

export type RolloverPolicy = 'carry' | 'return' | 'to_bucket';

/** End-of-month rollover (FR-BKT-08): returns the amount leaving the bucket (≥ 0) and where it goes. */
export function rollover(balance: Satang, policy: RolloverPolicy): { keep: Satang; release: Satang } {
  if (balance <= 0n || policy === 'carry') return { keep: balance, release: 0n };
  return { keep: 0n, release: balance };
}

export interface TemplateBucket { key: string; type: BucketType; percentE4: number; icon: string; color: string }

/** Ready-made templates (FR-BKT-06). Names are i18n keys. */
export const BUCKET_TEMPLATES: Record<string, TemplateBucket[]> = {
  '50_30_20': [
    { key: 'needs', type: 'bills', percentE4: 500_000, icon: 'home', color: '#2f6f5e' },
    { key: 'wants', type: 'spending', percentE4: 300_000, icon: 'bag', color: '#c27c2c' },
    { key: 'savings', type: 'savings', percentE4: 200_000, icon: 'piggy', color: '#3a5ea8' },
  ],
  six_jars: [
    { key: 'necessities', type: 'bills', percentE4: 550_000, icon: 'home', color: '#2f6f5e' },
    { key: 'financial_freedom', type: 'investing', percentE4: 100_000, icon: 'chart', color: '#6b4fa3' },
    { key: 'long_term_savings', type: 'savings', percentE4: 100_000, icon: 'piggy', color: '#3a5ea8' },
    { key: 'education', type: 'spending', percentE4: 100_000, icon: 'book', color: '#8a6d1f' },
    { key: 'play', type: 'spending', percentE4: 100_000, icon: 'star', color: '#c27c2c' },
    { key: 'give', type: 'spending', percentE4: 50_000, icon: 'heart', color: '#b2456e' },
  ],
  pay_yourself_first: [
    { key: 'savings', type: 'savings', percentE4: 200_000, icon: 'piggy', color: '#3a5ea8' },
    { key: 'spending', type: 'spending', percentE4: 800_000, icon: 'bag', color: '#c27c2c' },
  ],
  save_emergency_invest: [
    { key: 'savings', type: 'savings', percentE4: 100_000, icon: 'piggy', color: '#3a5ea8' },
    { key: 'emergency', type: 'emergency', percentE4: 100_000, icon: 'shield', color: '#b5483b' },
    { key: 'investing', type: 'investing', percentE4: 100_000, icon: 'chart', color: '#6b4fa3' },
  ],
};

/** Distribute an existing balance across buckets by weight (wizard when turning buckets on, FR-BKT-00b). */
export function distribute(total: Satang, weightsE4: number[]): Satang[] {
  const sum = weightsE4.reduce((a, b) => a + b, 0);
  if (sum <= 0 || weightsE4.length === 0) return weightsE4.map(() => 0n);
  const out = weightsE4.map((w) => (total * BigInt(w)) / BigInt(sum));
  const rest = total - out.reduce((a, b) => a + b, 0n);
  out[0] += rest;
  return out;
}
