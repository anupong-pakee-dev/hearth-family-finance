/**
 * Aggregations shared by the dashboard, reports and module pages.
 * Balances come from snapshot columns maintained by triggers (NFR-PERF-19); month totals use the
 * (owner_id, date) index and never scan the whole table.
 */
import type { Q } from '../db/index.ts';
import type { Prefs, View } from '../http/app.ts';
import { scope } from './common.ts';
import {
  type DebtTerms, type PlanDebt, type InvTxn, simulate, simulatePlan, minimumBudget, runwayMonths, averageMonthly,
  computeHoldings, valuation, cycleFor, addMonths, todayIso, addDays, divRound,
} from '@hearth/engine';

export function currentCycle(prefs: Prefs, today = todayIso()) {
  return cycleFor(today, prefs.month_start_day);
}

/** The last n cycles ending with the current one: [{key:'YYYY-MM', start, end}] oldest first. */
export function cycles(prefs: Prefs, n: number, today = todayIso()) {
  const cur = currentCycle(prefs, today);
  const out: { key: string; start: string; end: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = addMonths(cur.start, -i);
    out.push({ key: start.slice(0, 7), start, end: addDays(addMonths(start, 1), -1) });
  }
  return out;
}

export async function totals(q: Q, view: View, start: string, end: string) {
  const r = await q.one<{ income: bigint; expense: bigint }>(
    `select coalesce(sum(amount) filter (where kind='income'),0)::bigint income,
            coalesce(sum(amount) filter (where kind='expense'),0)::bigint expense
       from transaction_lines where ${scope(view)} and date between $1 and $2`, [start, end]);
  return { income: r?.income ?? 0n, expense: r?.expense ?? 0n };
}

export async function monthlySeries(q: Q, view: View, prefs: Prefs, n = 12) {
  const cs = cycles(prefs, n);
  // One query: bucket each transaction into its cycle by start date.
  const rows = await q.query<{ start: string; income: bigint; expense: bigint }>(
    `with c(start, finish) as (select * from unnest($1::date[], $2::date[]))
     select c.start::text as start,
            coalesce(sum(t.amount) filter (where t.kind='income'),0)::bigint income,
            coalesce(sum(t.amount) filter (where t.kind='expense'),0)::bigint expense
       from c left join transaction_lines t on t.date between c.start and c.finish and ${scope(view, 't')}
      group by c.start order by c.start`,
    [cs.map((c) => c.start), cs.map((c) => c.end)]);
  const map = new Map(rows.map((r) => [r.start, r]));
  return cs.map((c) => ({ ...c, income: map.get(c.start)?.income ?? 0n, expense: map.get(c.start)?.expense ?? 0n }));
}

export async function expenseByCategory(q: Q, view: View, start: string, end: string) {
  return q.query<{ id: string | null; name: string | null; total: bigint }>(
    `select coalesce(p.id, c.id) id, coalesce(p.name, c.name) name, sum(t.amount)::bigint total
       from transaction_lines t left join categories c on c.id = t.category_id left join categories p on p.id = c.parent_id
      where ${scope(view, 't')} and t.kind = 'expense' and t.date between $1 and $2
      group by 1, 2 order by total desc`, [start, end]);
}

/** Average monthly spending in categories flagged essential (FR-EMG-02), last 3 complete cycles. */
export async function essentialMonthly(q: Q, view: View, prefs: Prefs): Promise<bigint> {
  if (prefs.essential_override != null && prefs.essential_override > 0n) return prefs.essential_override;
  const cs = cycles(prefs, 4).slice(0, 3);
  const rows = await q.query<{ start: string; total: bigint }>(
    `with c(start, finish) as (select * from unnest($1::date[], $2::date[]))
     select c.start::text start, coalesce(sum(t.amount),0)::bigint total
       from c left join transaction_lines t on t.date between c.start and c.finish and t.kind = 'expense' and ${scope(view, 't')}
              and exists (select 1 from categories cat left join categories par on par.id = cat.parent_id
                           where cat.id = t.category_id and (cat.essential or coalesce(par.essential,false)))
      group by c.start order by c.start`,
    [cs.map((c) => c.start), cs.map((c) => c.end)]);
  return averageMonthly(rows.map((r) => r.total));
}

export async function emergencyFund(q: Q, view: View, prefs: Prefs): Promise<bigint> {
  if (prefs.emergency_source === 'bucket') {
    const r = await q.one<{ s: bigint }>(`select coalesce(sum(balance),0)::bigint s from buckets where type='emergency' and not archived and ${scope(view)}`);
    return r?.s ?? 0n;
  }
  if (prefs.emergency_source === 'account' && prefs.emergency_account_id) {
    const r = await q.one<{ balance: bigint }>('select balance from accounts where id = $1', [prefs.emergency_account_id]);
    return r?.balance ?? 0n;
  }
  const ev = await q.one<{ s: bigint }>('select coalesce(sum(amount),0)::bigint s from emergency_events where owner_id = hearth_uid()');
  return prefs.emergency_manual + (ev?.s ?? 0n);
}

export function debtTerms(d: any, rates: { from_date: string; annual_rate_e4: number }[] = [], start = todayIso()): DebtTerms {
  const schedule = rates
    .map((r) => {
      const months = Math.max(0, (Number(r.from_date.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(r.from_date.slice(5, 7)) - Number(start.slice(5, 7)));
      return { fromMonth: months, rateE4: r.annual_rate_e4 };
    });
  return {
    id: d.id,
    name: d.name,
    balance: d.balance_current,
    method: d.interest_method,
    rateE4: d.annual_rate_e4,
    payment: d.payment_amount,
    principalOriginal: d.principal_original,
    dailyAccrual: d.daily_accrual,
    minPercentE4: d.min_payment_type === 'percent_of_balance' ? Number(d.min_payment_value) : undefined,
    minFloor: d.min_payment_floor ?? 0n,
    rateSchedule: schedule.length ? schedule : undefined,
  };
}

/** Next payment date for a debt given its due day. */
export function nextDue(dueDay: number | null, today = todayIso()): string {
  const d = Math.min(28, Math.max(1, dueDay ?? 1));
  const thisMonth = `${today.slice(0, 7)}-${String(d).padStart(2, '0')}`;
  return thisMonth >= today ? thisMonth : addMonths(thisMonth, 1);
}

export async function loadDebts(q: Q, view: View, opts: { includeClosed?: boolean; receivable?: boolean } = {}) {
  const debts = await q.query<any>(
    `select d.*, m.display_name as owner_member_name from debts d left join members m on m.id = d.owner_member_id
      where ${scope(view, 'd')} and d.is_receivable = $1 ${opts.includeClosed ? '' : 'and d.closed_at is null'}
      order by d.created_at`, [opts.receivable ?? false]);
  const rates = debts.length ? await q.query<any>('select debt_id, from_date::text, annual_rate_e4 from debt_rate_schedule where debt_id = any($1::uuid[]) order by from_date', [debts.map((d) => d.id)]) : [];
  for (const d of debts) d.rates = rates.filter((r) => r.debt_id === d.id);
  return debts;
}

export interface DebtOverview {
  total: bigint;
  monthlyPayments: bigint;
  monthlyInterest: bigint;
  debtFreeDate: string | null;
  neverPaysOff: boolean;
  plan: ReturnType<typeof simulatePlan> | null;
  perDebt: Map<string, ReturnType<typeof simulate>>;
}

export async function debtOverview(q: Q, view: View): Promise<DebtOverview> {
  const debts = await loadDebts(q, view);
  const plan = await q.one<any>('select * from debt_plans where owner_id = hearth_uid()');
  const start = nextDue(1);
  const planDebts: PlanDebt[] = debts.map((d) => ({ ...debtTerms(d, d.rates, start), id: d.id, name: d.name }));
  const perDebt = new Map<string, ReturnType<typeof simulate>>();
  let monthlyInterest = 0n;
  for (const d of planDebts) {
    const s = simulate(d, { startDate: nextDue(debts.find((x) => x.id === d.id)?.due_day) });
    perDebt.set(d.id, s);
    monthlyInterest += s.schedule[0]?.interest ?? 0n;
  }
  const minBudget = minimumBudget(planDebts, start);
  const budget = plan && plan.monthly_budget > minBudget ? plan.monthly_budget : minBudget;
  const sim = planDebts.length ? simulatePlan(planDebts, budget, plan?.strategy ?? 'avalanche', { customOrder: plan?.custom_order ?? [], startDate: start }) : null;
  return {
    total: debts.reduce((s, d) => s + d.balance_current, 0n),
    monthlyPayments: minBudget,
    monthlyInterest,
    debtFreeDate: sim?.payoffDate ?? null,
    neverPaysOff: sim?.neverPaysOff ?? false,
    plan: sim,
    perDebt,
  };
}

export function invTxnFromRow(r: any): InvTxn {
  return { date: r.date, type: r.type, assetId: r.asset_id, unitsE8: r.units_e8, amount: r.amount, fee: r.fee, tax: r.tax };
}

export async function latestPrices(q: Q, assetIds: string[]): Promise<Map<string, bigint>> {
  if (!assetIds.length) return new Map();
  const rows = await q.query<{ asset_id: string; price_e8: bigint }>(
    `select distinct on (asset_id) asset_id, price_e8 from price_history where asset_id = any($1::uuid[]) order by asset_id, date desc`, [assetIds]);
  return new Map(rows.map((r) => [r.asset_id, r.price_e8]));
}

/** Latest FX rate for each currency into the main currency (instance reference table, FR-TXN-11). */
export async function fxRates(q: Q, currencies: string[], main: string): Promise<Map<string, number>> {
  const uniq = [...new Set(currencies.filter((c) => c && c !== main))];
  const out = new Map<string, number>([[main, 1]]);
  if (!uniq.length) return out;
  const rows = await q.query<{ cur: string; rate: string }>('select c as cur, hearth_fx(c, $2)::text rate from unnest($1::text[]) c', [uniq, main]);
  for (const r of rows) out.set(r.cur, Number(r.rate));
  return out;
}

/** Convert minor units with a float FX rate (display/estimate only — stored money never uses floats). */
export function convert(v: bigint, rate: number): bigint {
  if (rate === 1) return v;
  return BigInt(Math.round(Number(v) * rate));
}

export async function portfolioValues(q: Q, view: View, prefs: Prefs, portfolioId?: string) {
  const txRows = await q.query<any>(
    `select it.*, it.date::text date from investment_transactions it join portfolios p on p.id = it.portfolio_id
      where ${scope(view, 'p')} and not p.archived and not it.pending ${portfolioId ? 'and p.id = $1' : ''} order by it.date, it.created_at`, portfolioId ? [portfolioId] : []);
  const assets = await q.query<any>(`select * from assets where ${scope(view)}`);
  const holdings = computeHoldings(txRows.map(invTxnFromRow), prefs.cost_method);
  const prices = await latestPrices(q, [...holdings.keys()]);
  const fx = await fxRates(q, assets.map((a) => a.currency), prefs.currency);
  // totals are in the user's main currency (FR-INV-18); per-row values stay in the asset's currency
  const conv = (v: bigint, cur: string) => convert(v, fx.get(cur) ?? 1);
  let value = 0n, cost = 0n, unrealized = 0n, realized = 0n, income = 0n, invested = 0n, returned = 0n;
  const rows = [...holdings.values()].map((h) => {
    const a = assets.find((x) => x.id === h.assetId);
    const cur = a?.currency ?? prefs.currency;
    const v = valuation(h, prices.get(h.assetId) ?? null);
    value += conv(v.marketValue, cur); cost += conv(h.costBasis, cur); unrealized += conv(v.unrealizedPL, cur); realized += conv(h.realizedPL, cur);
    income += conv(h.income, cur); invested += conv(h.invested, cur); returned += conv(h.returned, cur);
    return { asset: a, holding: h, valuation: v, price: prices.get(h.assetId) ?? null, currency: cur, fxRate: fx.get(cur) ?? 1 };
  });
  return { rows, txRows, value, cost, unrealized, realized, income, invested, returned };
}

export async function netWorth(q: Q, view: View, prefs: Prefs) {
  const acc = await q.one<{ assets: bigint; liabilities: bigint; liquid: bigint }>(
    `select coalesce(round(sum(balance * hearth_fx(currency, $1)) filter (where balance > 0 and type <> 'investment')),0)::bigint assets,
            coalesce(round(-sum(balance * hearth_fx(currency, $1)) filter (where balance < 0)),0)::bigint liabilities,
            coalesce(round(sum(balance * hearth_fx(currency, $1)) filter (where balance > 0 and is_liquid and type in ('cash','savings','ewallet'))),0)::bigint liquid
       from accounts where not archived and ${scope(view)}`, [prefs.currency]);
  const debts = await q.one<{ owed: bigint; receivable: bigint }>(
    `select coalesce(sum(balance_current) filter (where not is_receivable),0)::bigint owed,
            coalesce(sum(balance_current) filter (where is_receivable),0)::bigint receivable
       from debts where closed_at is null and ${scope(view)}`);
  let investments = 0n;
  if (prefs.investment_enabled) {
    const pv = await portfolioValues(q, view, prefs);
    for (const r of pv.rows) if (!prefs.networth_exclude.includes(r.asset?.asset_class)) investments += r.valuation.marketValue;
  }
  const assets = (acc?.assets ?? 0n) + (debts?.receivable ?? 0n) + investments;
  const liabilities = (acc?.liabilities ?? 0n) + (debts?.owed ?? 0n);
  return { assets, liabilities, netWorth: assets - liabilities, investments, liquid: acc?.liquid ?? 0n };
}

export async function emergencyStatus(q: Q, view: View, prefs: Prefs) {
  const fund = await emergencyFund(q, view, prefs);
  const essential = await essentialMonthly(q, view, prefs);
  const months = Number(prefs.emergency_months);
  const target = prefs.emergency_mode === 'fixed' ? prefs.emergency_fixed : divRound(essential * BigInt(Math.round(months * 10)), 10n);
  return { fund, essential, target, runway: runwayMonths(fund, essential) };
}
