/**
 * Data portability (FR-IO-04, PDPA): everything the user OWNS, decrypted, as JSON or CSV.
 */
import type { Ctx } from '../http/app.ts';
import { cipher } from './common.ts';
import { toDecimalString } from '@hearth/engine';

const TABLES = ['accounts', 'categories', 'buckets', 'bucket_movements', 'transactions', 'transaction_splits', 'debts', 'debt_payments', 'debt_rate_schedule',
  'debt_plans', 'goals', 'goal_contributions', 'emergency_events', 'portfolios', 'assets', 'investment_transactions', 'price_history', 'allocation_targets',
  'dca_plans', 'budget_lines', 'recurring_rules', 'net_worth_snapshots'] as const;

export async function exportUserData(ctx: Ctx): Promise<Record<string, unknown>> {
  const c = cipher(ctx);
  const out: Record<string, unknown> = {
    format: 'hearth-export/1',
    exported_at: new Date().toISOString(),
    user: { id: ctx.user!.id, email: ctx.user!.email, display_name: ctx.user!.display_name },
    note: 'Money amounts are integers in minor units (satang). Rates are percent × 10000.',
  };
  await ctx.as(async (q) => {
    out.preferences = await q.one('select * from user_preferences where user_id = hearth_uid()');
    for (const t of TABLES) {
      const rows = await q.query<any>(`select * from ${t} where owner_id = hearth_uid()`);
      for (const r of rows) {
        for (const k of Object.keys(r)) {
          if (k.endsWith('_enc')) { r[k.slice(0, -4)] = c.dec(r[k]); delete r[k]; }
        }
      }
      out[t] = rows;
    }
  });
  return out;
}

function cell(v: unknown): string {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join('|') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  const cols = ['date', 'kind', 'amount', 'payee', 'note', 'tags', 'category_id', 'account_id', 'to_account_id', 'bucket_id', 'id'];
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => cell(c === 'amount' ? toDecimalString(r.amount as bigint) : r[c])).join(','));
  return lines.join('\r\n');
}
