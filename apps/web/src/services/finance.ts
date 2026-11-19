/**
 * Write paths shared by several pages (onboarding, forms, import, recurring jobs).
 */
import type { Q } from '../db/index.ts';
import { HttpError } from '../http/app.ts';
import { BUCKET_TEMPLATES, allocateIncome, type AllocationRule } from '@hearth/engine';

export async function createAccount(q: Q, ownerId: string, a: { name: string; type: string; opening: bigint; householdId?: string | null; accountNoEnc?: Buffer | null; currency?: string }) {
  const liquid = ['cash', 'savings', 'ewallet'].includes(a.type);
  const r = await q.one<{ id: string }>(
    `insert into accounts(owner_id, household_id, name, type, currency, opening_balance, balance, account_no_enc, is_liquid)
     values ($1,$2,$3,$4,$5,$6,$6,$7,$8) returning id`,
    [ownerId, a.householdId ?? null, a.name, a.type, a.currency ?? 'THB', a.opening, a.accountNoEnc ?? null, liquid]);
  return r!.id;
}

export interface TxnInput {
  kind: 'income' | 'expense' | 'transfer';
  date: string;
  amount: bigint;
  accountId: string;
  toAccountId?: string | null;
  categoryId?: string | null;
  bucketId?: string | null;
  payee?: string | null;
  noteEnc?: Buffer | null;
  tags?: string[];
  householdId?: string | null;
  importHash?: string | null;
  recurringId?: string | null;
  splits?: { categoryId: string | null; bucketId: string | null; amount: bigint }[];
  /** Foreign-currency account: rate to the main currency (FR-TXN-11). */
  currency?: string | null;
  fxRate?: string | null;
}

/** Insert splits (FR-TXN-04) and bucket movements for a transaction. Used by create and edit. */
export async function applyLines(q: Q, ownerId: string, id: string, t: Pick<TxnInput, 'kind' | 'amount' | 'bucketId' | 'splits' | 'householdId'>) {
  if (t.splits?.length) {
    const sum = t.splits.reduce((a, s) => a + s.amount, 0n);
    if (sum !== t.amount) throw new HttpError(422, 'split_sum');
    for (const s of t.splits) {
      await q.query('insert into transaction_splits(transaction_id, owner_id, household_id, category_id, bucket_id, amount) values ($1,$2,$3,$4,$5,$6)', [id, ownerId, t.householdId ?? null, s.categoryId, s.bucketId, s.amount]);
      if (s.bucketId && t.kind !== 'transfer') await bucketMove(q, ownerId, s.bucketId, t.kind === 'expense' ? -s.amount : s.amount, t.kind === 'expense' ? 'spend' : 'income', id);
    }
    return true;
  }
  if (t.bucketId && t.kind !== 'transfer') {
    await bucketMove(q, ownerId, t.bucketId, t.kind === 'expense' ? -t.amount : t.amount, t.kind === 'expense' ? 'spend' : 'income', id);
    return true;
  }
  return false;
}

/**
 * Insert a transaction. The account balance is maintained by a DB trigger; when a bucket is chosen,
 * a bucket movement is recorded (expense = out of bucket, income = into bucket). Buckets are optional.
 * Income without a bucket in a mode with auto-allocation rules is distributed automatically (FR-BKT-05).
 */
export async function createTransaction(q: Q, ownerId: string, t: TxnInput, opts: { autoAllocate?: boolean } = {}) {
  if (t.kind === 'transfer' && (!t.toAccountId || t.toAccountId === t.accountId)) throw new HttpError(422, 'transfer_accounts');
  // categorisation rules (FR-TXN-09)
  let categoryId = t.categoryId ?? null;
  if (!categoryId && t.payee && t.kind !== 'transfer') {
    const rule = await q.one<{ category_id: string }>(`select category_id from categorize_rules where owner_id = $1 and position(lower(pattern) in lower($2)) > 0 limit 1`, [ownerId, t.payee]);
    categoryId = rule?.category_id ?? null;
  }
  const r = await q.one<{ id: string }>(
    `insert into transactions(owner_id, household_id, kind, date, amount, account_id, to_account_id, category_id, bucket_id, payee, note_enc, tags, import_hash, recurring_id, currency, fx_rate, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             coalesce($15, (select currency from accounts where id = $6)),
             coalesce($16::numeric, (select case when a.currency = p.currency then null else hearth_fx(a.currency, p.currency) end
                                      from accounts a, user_preferences p where a.id = $6 and p.user_id = $1)),
             hearth_uid()) returning id`,
    [ownerId, t.householdId ?? null, t.kind, t.date, t.amount, t.accountId, t.kind === 'transfer' ? t.toAccountId : null, t.kind === 'transfer' ? null : categoryId,
      t.splits?.length ? null : t.bucketId ?? null, t.payee ?? null, t.noteEnc ?? null, t.tags ?? [], t.importHash ?? null, t.recurringId ?? null, t.currency ?? null, t.fxRate ?? null]);
  const id = r!.id;
  const applied = await applyLines(q, ownerId, id, t);
  if (!applied && t.kind === 'income' && opts.autoAllocate) await autoAllocate(q, ownerId, t.amount, id);
  return id;
}

export async function bucketMove(q: Q, ownerId: string, bucketId: string, amount: bigint, kind: string, txnId: string | null = null, note: string | null = null) {
  const b = await q.one<{ household_id: string | null }>('select household_id from buckets where id = $1', [bucketId]);
  if (!b) throw new HttpError(404);
  await q.query('insert into bucket_movements(owner_id, household_id, bucket_id, amount, kind, transaction_id, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,hearth_uid())', [ownerId, b.household_id, bucketId, amount, kind, txnId, note]);
}

/** Apply the user's bucket allocation rules to an income (FR-BKT-05, FR-INV-03). */
export async function autoAllocate(q: Q, ownerId: string, income: bigint, txnId: string | null) {
  const buckets = await q.query<any>(`select id, balance, monthly_target, auto_percent_e4, auto_fixed, auto_priority from buckets
     where owner_id = $1 and not archived and (auto_percent_e4 is not null or auto_fixed is not null or auto_priority is not null)
     order by coalesce(auto_priority, 1000), sort`, [ownerId]);
  if (!buckets.length) return {};
  const rules: AllocationRule[] = [];
  for (const b of buckets) {
    if (b.auto_fixed != null) rules.push({ kind: 'fixed', bucketId: b.id, amount: b.auto_fixed });
    else if (b.auto_percent_e4 != null) rules.push({ kind: 'percent', bucketId: b.id, percentE4: b.auto_percent_e4 });
    else if (b.auto_priority != null && b.monthly_target != null) rules.push({ kind: 'fill', bucketId: b.id, upTo: b.monthly_target });
  }
  const res = allocateIncome(income, rules, Object.fromEntries(buckets.map((b) => [b.id, b.balance])));
  for (const [bid, amt] of Object.entries(res.allocations)) await bucketMove(q, ownerId, bid, amt, 'allocate', txnId);
  return res.allocations;
}

export async function applyBucketTemplate(q: Q, ownerId: string, key: string, t: (k: string) => string) {
  const tpl = BUCKET_TEMPLATES[key];
  if (!tpl) return;
  let sort = 0;
  for (const b of tpl) {
    const existing = await q.one<{ id: string }>('select id from buckets where owner_id = $1 and name = $2', [ownerId, t(`bucket.tpl.${b.key}`)]);
    if (existing) { await q.query('update buckets set archived = false, auto_percent_e4 = $2 where id = $1', [existing.id, b.percentE4]); continue; }
    await q.query('insert into buckets(owner_id, name, icon, color, type, auto_percent_e4, sort) values ($1,$2,$3,$4,$5,$6,$7)', [ownerId, t(`bucket.tpl.${b.key}`), b.icon, b.color, b.type, b.percentE4, sort++]);
  }
}

/** Switching bucket mode never loses data (FR-BKT-00b): off → archive; on → un-archive previously archived buckets. */
export async function setBucketMode(q: Q, mode: 'off' | 'partial' | 'full') {
  const prev = await q.one<{ bucket_mode: string }>('select bucket_mode from user_preferences where user_id = hearth_uid()');
  await q.query('update user_preferences set bucket_mode = $1, updated_at = now() where user_id = hearth_uid()', [mode]);
  if (mode === 'off') await q.query('update buckets set archived = true where owner_id = hearth_uid() and not archived');
  else if (prev?.bucket_mode === 'off') await q.query(`update buckets set archived = false where owner_id = hearth_uid() and archived`);
  return prev?.bucket_mode ?? 'off';
}

export async function createDebt(q: Q, ownerId: string, d: Record<string, unknown>) {
  const r = await q.one<{ id: string }>(
    `insert into debts(owner_id, household_id, owner_member_id, name, type, creditor_enc, principal_original, balance_current, interest_method,
       annual_rate_e4, daily_accrual, payment_amount, min_payment_type, min_payment_value, min_payment_floor, due_day, start_date, term_months,
       visibility, bucket_id, is_receivable, guarantor, plan_payoff_date, lender_member_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning id`,
    [ownerId, d.householdId ?? null, d.ownerMemberId ?? null, d.name, d.type, d.creditorEnc ?? null, d.principal, d.balance, d.method, d.rateE4, !!d.dailyAccrual,
      d.payment ?? 0n, d.minType ?? 'fixed', d.minValue ?? 0n, d.minFloor ?? 0n, d.dueDay ?? null, d.startDate ?? null, d.termMonths ?? null,
      d.visibility ?? 'full', d.bucketId ?? null, !!d.receivable, d.guarantor ?? null, d.planPayoffDate ?? null, d.lenderMemberId ?? null]);
  return r!.id;
}

export const ACCOUNT_TYPES = ['cash', 'savings', 'fixed_deposit', 'ewallet', 'credit_card', 'investment'] as const;
export const DEBT_TYPES = ['credit_card', 'personal_loan', 'mortgage', 'auto', 'student', 'informal', 'family', 'bnpl'] as const;
export const INTEREST_METHODS = ['reducing', 'flat', 'credit_card', 'none'] as const;
export const BUCKET_TYPES = ['bills', 'spending', 'savings', 'emergency', 'debt', 'investing'] as const;
export const ASSET_CLASSES = ['thai_stock', 'foreign_stock', 'etf', 'mutual_fund', 'tax_fund', 'pvd', 'sso', 'bond', 'fixed_deposit', 'gold', 'crypto', 'real_estate', 'other'] as const;
export const INV_TYPES = ['buy', 'sell', 'dividend', 'interest', 'fee', 'switch_in', 'switch_out', 'split', 'transfer_in', 'transfer_out'] as const;
