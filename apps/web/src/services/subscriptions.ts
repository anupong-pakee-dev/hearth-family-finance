import type { Q } from '../db/index.ts';
import { addMonths } from '@hearth/engine';

/**
 * Recurring payees that look like subscriptions (≥ 3 of the last 4 months, similar amount) and price increases
 * (latest charge more than 5 % above the earlier average). FR-REC-06.
 */
export async function detectSubscriptions(q: Q, today: string) {
  const rows = await q.query<any>(`select payee, to_char(date, 'YYYY-MM') m, max(amount)::bigint amount from transactions
      where owner_id = hearth_uid() and kind = 'expense' and payee is not null and date >= $1 group by 1, 2 order by 1, 2`, [addMonths(today, -4)]);
  const rules = new Set((await q.query<any>('select lower(name) n from recurring_rules where owner_id = hearth_uid()')).map((r) => r.n));
  const byPayee = new Map<string, { m: string; amount: bigint }[]>();
  for (const r of rows) byPayee.set(r.payee, [...(byPayee.get(r.payee) ?? []), { m: r.m, amount: r.amount }]);
  const out: { payee: string; months: number; latest: bigint; average: bigint; increased: boolean; tracked: boolean }[] = [];
  for (const [payee, list] of byPayee) {
    if (list.length < 3) continue;
    const amounts = list.map((x) => x.amount);
    const prev = amounts.slice(0, -1);
    const avg = prev.reduce((a, b) => a + b, 0n) / BigInt(prev.length);
    const min = prev.reduce((a, b) => (b < a ? b : a)), max = prev.reduce((a, b) => (b > a ? b : a));
    if (avg === 0n || (max - min) * 100n > avg * 20n) continue; // amounts vary too much: not a subscription
    const latest = amounts[amounts.length - 1];
    out.push({ payee, months: list.length, latest, average: avg, increased: latest * 100n > avg * 105n, tracked: rules.has(payee.toLowerCase()) });
  }
  return out;
}

