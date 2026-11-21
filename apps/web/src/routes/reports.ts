/**
 * Reports (§4.14), financial health (§8.7), notifications (§4.12) and the JSON API (§3.1 "API สำหรับต่อยอด").
 */
import { get, post, htmlRes, redirect, jsonRes, withFlash, HttpError } from '../http/app.ts';
import { html } from '../views/html.ts';
import { page, icon } from '../views/layout.ts';
import { card, stat, empty, postButton, tabs, disclaimer, form, field, moneyInput } from '../views/ui.ts';
import { inputMoney } from '../views/format.ts';
import { makeFmt } from '../views/format.ts';
import { stackedBars, lineChart } from '../views/charts.ts';
import { scope, requireUuid, money, date, oneOf, uuidOrNull, text, today, cipher } from '../services/common.ts';
import { totals, expenseByCategory, netWorth, emergencyStatus, debtOverview, monthlySeries, currentCycle } from '../services/summary.ts';
import { createTransaction } from '../services/finance.ts';
import { healthScore, savingsRate, addMonths, addDays, toMajorNumber, liquidityRatio } from '@hearth/engine';

get('/reports', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const p = ctx.prefs!;
  const cur = currentCycle(p);
  const month = /^\d{4}-\d{2}$/.test(ctx.query.get('month') ?? '') ? ctx.query.get('month')! : cur.start.slice(0, 7);
  const start = `${month}-${String(p.month_start_day).padStart(2, '0')}`;
  const end = addDays(addMonths(start, 1), -1);
  const data = await ctx.as(async (q) => ({
    tot: await totals(q, ctx.view, start, end),
    cats: await expenseByCategory(q, ctx.view, start, end),
    debt: await q.one<any>(`select coalesce(sum(principal),0)::bigint principal, coalesce(sum(interest),0)::bigint interest, coalesce(sum(fee),0)::bigint fee from debt_payments where date between $1 and $2 and ${scope(ctx.view)}`, [start, end]),
    saved: await q.one<any>(`select coalesce(sum(amount),0)::bigint s from goal_contributions where date between $1 and $2 and ${scope(ctx.view)}`, [start, end]),
  }));
  const prev = addMonths(`${month}-01`, -1).slice(0, 7);
  const next = addMonths(`${month}-01`, 1).slice(0, 7);
  return htmlRes(page(ctx, {
    title: ctx.t('nav.reports'),
    actions: html`<span class="head-actions"><nav class="month-nav"><a class="btn sm" href="/reports?month=${prev}" aria-label="${ctx.t('common.prev')}">‹</a><strong>${f.month(month)}</strong><a class="btn sm" href="/reports?month=${next}" aria-label="${ctx.t('common.next')}">›</a></nav><button class="btn" data-print>${icon('download')} PDF</button></span>`,
    body: html`${tabs(ctx, [{ href: '/reports', label: ctx.t('rpt.monthly') }, { href: '/reports/year', label: ctx.t('rpt.year') }, { href: '/reports/debt', label: ctx.t('rpt.debt') }, { href: '/reports/health', label: ctx.t('dash.health') }, { href: '/reports/tax', label: ctx.t('rpt.tax') }])}
      <section class="stats">
        ${stat(ctx.t('txn.kind.income'), f.moneyHtml(data.tot.income))}
        ${stat(ctx.t('txn.kind.expense'), f.moneyHtml(data.tot.expense))}
        ${stat(ctx.t('dash.left'), f.moneyHtml(data.tot.income - data.tot.expense), f.pct(savingsRate(data.tot.income, data.tot.expense)))}
        ${stat(ctx.t('rpt.saved_goals'), f.moneyHtml(data.saved.s))}
        ${stat(ctx.t('rpt.debt_reduced'), f.moneyHtml(data.debt.principal), ctx.t('rpt.interest_paid', { amount: f.money(data.debt.interest) }))}
      </section>
      ${card(ctx.t('dash.chart.by_category'), data.cats.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>${ctx.t('txn.category')}</th><th class="num">${ctx.t('txn.amount')}</th><th class="num">%</th></tr></thead><tbody>
        ${data.cats.map((c) => html`<tr><td><a href="/transactions?category=${c.id ?? ''}&from=${start}&to=${end}">${c.name ?? ctx.t('txn.uncategorized')}</a></td><td class="num">${f.money(c.total)}</td><td class="num">${data.tot.expense > 0n ? f.pct(toMajorNumber(c.total) / toMajorNumber(data.tot.expense)) : ''}</td></tr>`)}</tbody></table></div>` : empty(ctx.t('common.no_data')))}`,
  }));
});

get('/reports/year', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const year = Number.parseInt(ctx.query.get('year') ?? today().slice(0, 4), 10) || Number(today().slice(0, 4));
  const { rows, debt, top } = await ctx.as(async (q) => ({
    rows: await q.query<any>(`select to_char(date, 'YYYY-MM') m, coalesce(sum(amount) filter (where kind='income'),0)::bigint inc, coalesce(sum(amount) filter (where kind='expense'),0)::bigint exp
        from transaction_lines where ${scope(ctx.view)} and date between $1 and $2 group by 1 order by 1`, [`${year}-01-01`, `${year}-12-31`]),
    debt: await q.one<any>(`select coalesce(sum(principal),0)::bigint p, coalesce(sum(interest),0)::bigint i from debt_payments where date between $1 and $2 and ${scope(ctx.view)}`, [`${year}-01-01`, `${year}-12-31`]),
    top: await expenseByCategory(q, ctx.view, `${year}-01-01`, `${year}-12-31`),
  }));
  const inc = rows.reduce((s, r) => s + r.inc, 0n), exp = rows.reduce((s, r) => s + r.exp, 0n);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const fm = (n: number) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact' }).format(n));
  return htmlRes(page(ctx, {
    title: ctx.t('rpt.year_title', { year: ctx.prefs!.date_era === 'be' ? year + 543 : year }),
    actions: html`<nav class="month-nav"><a class="btn sm" href="/reports/year?year=${year - 1}">‹</a><a class="btn sm" href="/reports/year?year=${year + 1}">›</a></nav>`,
    body: html`<section class="stats">${stat(ctx.t('txn.kind.income'), f.moneyHtml(inc))}${stat(ctx.t('txn.kind.expense'), f.moneyHtml(exp))}${stat(ctx.t('dash.savings_rate'), f.pct(savingsRate(inc, exp)))}${stat(ctx.t('rpt.debt_reduced'), f.moneyHtml(debt.p), ctx.t('rpt.interest_paid', { amount: f.money(debt.i) }))}</section>
      ${card(ctx.t('dash.chart.income_expense'), stackedBars({ title: ctx.t('dash.chart.income_expense'), summary: '', labels: months.map((m) => f.monthShort(m)), stacks: [{ name: ctx.t('txn.kind.expense'), cls: 'c-exp', values: months.map((m) => toMajorNumber(rows.find((r) => r.m === m)?.exp ?? 0n)) }], fmt: fm }), { cls: 'span2' })}
      ${card(ctx.t('rpt.top_categories'), html`<ol class="rows">${top.slice(0, 5).map((c) => html`<li><span>${c.name ?? ctx.t('txn.uncategorized')}</span>${f.moneyHtml(c.total)}</li>`)}</ol>`)}`,
  }));
});

get('/reports/debt', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const rows = await ctx.as((q) => q.query<any>(`select d.id, d.name, d.principal_original, d.balance_current, coalesce(sum(p.interest),0)::bigint interest, coalesce(sum(p.principal),0)::bigint principal, coalesce(sum(p.fee),0)::bigint fee
     from debts d left join debt_payments p on p.debt_id = d.id where ${scope(ctx.view, 'd')} and not d.is_receivable group by d.id order by d.created_at`));
  const ti = rows.reduce((s, r) => s + r.interest, 0n), tp = rows.reduce((s, r) => s + r.principal, 0n);
  const fm = (n: number) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact' }).format(n));
  return htmlRes(page(ctx, {
    title: ctx.t('rpt.debt'),
    body: html`<section class="stats">${stat(ctx.t('rpt.interest_total'), f.moneyHtml(ti))}${stat(ctx.t('rpt.principal_total'), f.moneyHtml(tp))}</section>
      ${rows.length ? card(ctx.t('rpt.principal_vs_interest'), stackedBars({ title: ctx.t('rpt.principal_vs_interest'), summary: '', labels: rows.map((r) => r.name), stacks: [{ name: ctx.t('debt.principal_part'), cls: 'c-inc', values: rows.map((r) => toMajorNumber(r.principal)) }, { name: ctx.t('debt.interest'), cls: 'c-exp', values: rows.map((r) => toMajorNumber(r.interest)) }], fmt: fm })) : ''}
      ${card(ctx.t('debt.list'), html`<div class="table-wrap"><table class="tbl"><thead><tr><th>${ctx.t('debt.name')}</th><th class="num">${ctx.t('debt.principal')}</th><th class="num">${ctx.t('debt.balance')}</th><th class="num">${ctx.t('rpt.principal_total')}</th><th class="num">${ctx.t('rpt.interest_total')}</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr><td><a href="/debts/${r.id}">${r.name}</a></td><td class="num">${f.money(r.principal_original)}</td><td class="num">${f.money(r.balance_current)}</td><td class="num">${f.money(r.principal)}</td><td class="num">${f.money(r.interest)}</td></tr>`)}</tbody></table></div>`)}`,
  }));
});

get('/reports/health', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const p = ctx.prefs!;
  const cur = currentCycle(p);
  const prevStart = addMonths(cur.start, -1);
  const d = await ctx.as(async (q) => ({
    tot: await totals(q, ctx.view, prevStart, addDays(cur.start, -1)),
    nw: await netWorth(q, ctx.view, p),
    emg: await emergencyStatus(q, ctx.view, p),
    debt: await debtOverview(q, ctx.view),
    prevNw: await q.one<any>(`select assets - liabilities nw from net_worth_snapshots where owner_id = hearth_uid() and date <= $1 order by date desc limit 1`, [addMonths(today(), -1)]),
  }));
  const income = d.tot.income > 0n ? d.tot.income : p.monthly_income;
  const h = healthScore({ monthlyIncome: income, monthlyExpense: d.tot.expense, monthlyDebtPayments: d.debt.monthlyPayments, emergencyRunwayMonths: d.emg.runway, liquidAssets: d.nw.liquid, netWorth: d.nw.netWorth, netWorthPrev: d.prevNw?.nw ?? null });
  const lr = liquidityRatio(d.nw.liquid, d.tot.expense);
  return htmlRes(page(ctx, {
    title: ctx.t('dash.health'),
    body: html`<section class="stats">${stat(ctx.t('dash.health'), `${h.score}/100`, ctx.t('health.based_on_last'), h.score >= 70 ? 'ok' : h.score >= 40 ? 'warn' : 'bad')}${stat(ctx.t('health.liquidity'), f.num(lr), ctx.t('health.liquidity_hint'))}</section>
      ${card(ctx.t('health.breakdown'), html`<ul class="health-list">${h.parts.map((part) => html`<li><div class="row"><strong>${ctx.t(`health.${part.key}`)}</strong><span>${part.score}/${part.max}</span></div>
        <meter min="0" max="${part.max}" value="${part.score}" low="${part.max * 0.4}" high="${part.max * 0.8}" optimum="${part.max}" aria-label="${ctx.t(`health.${part.key}`)}"></meter>
        <small>${part.value != null && Number.isFinite(part.value) ? (part.key === 'runway' || part.key === 'liquidity' ? f.num(part.value) : f.pct(part.value)) + ' · ' : ''}${ctx.t(`health.reason.${part.key}.${part.reason}`)}</small></li>`)}</ul>`)}
      ${disclaimer(ctx)}`,
  }));
});

const TAX_TYPES = ['ssf', 'rmf', 'thaiesg'] as const;

get('/reports/tax', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const year = today().slice(0, 4);
  const d = await ctx.as(async (q) => ({
    mortgage: await q.one<any>(`select coalesce(sum(p.interest),0)::bigint s from debt_payments p join debts d on d.id = p.debt_id where d.type = 'mortgage' and p.date between $1 and $2 and p.owner_id = hearth_uid()`, [`${year}-01-01`, `${year}-12-31`]),
    funds: ctx.prefs!.investment_enabled ? await q.query<any>(`select a.symbol, coalesce(a.tax_type, 'other') tax_type, sum(t.amount + t.fee)::bigint s from investment_transactions t join assets a on a.id = t.asset_id
        where (a.asset_class = 'tax_fund' or a.tax_type is not null) and t.type in ('buy','switch_in') and not t.pending and t.date between $1 and $2 and t.owner_id = hearth_uid() group by 1, 2`, [`${year}-01-01`, `${year}-12-31`]) : [],
    insurance: await q.one<any>(`select coalesce(sum(t.amount),0)::bigint s from transaction_lines t join categories c on c.id = t.category_id where t.kind = 'expense' and (c.name ilike '%ประกัน%' or c.name ilike '%insurance%') and t.date between $1 and $2 and t.owner_id = hearth_uid()`, [`${year}-01-01`, `${year}-12-31`]),
  }));
  // FR-INV-22: caps are user-configurable because the law changes often — nothing is hard-coded
  const limits = (ctx.prefs!.tax_limits ?? {}) as Record<string, string>;
  const byType = (t: string) => d.funds.filter((r: any) => r.tax_type === t).reduce((s: bigint, r: any) => s + (r.s as bigint), 0n) as bigint;
  return htmlRes(page(ctx, {
    title: ctx.t('rpt.tax'),
    body: html`<p class="flash warn">${ctx.t('rpt.tax_disclaimer')}</p>
      <section class="stats">${stat(ctx.t('rpt.mortgage_interest'), f.moneyHtml(d.mortgage.s))}${stat(ctx.t('rpt.insurance'), f.moneyHtml(d.insurance.s))}${stat(ctx.t('rpt.tax_funds'), f.moneyHtml(d.funds.reduce((s: bigint, r: any) => s + (r.s as bigint), 0n) as bigint))}</section>
      ${ctx.prefs!.investment_enabled ? card(ctx.t('rpt.tax_limits'), html`<ul class="budget-list">${TAX_TYPES.map((t) => {
        const used = byType(t);
        const cap = limits[t] ? BigInt(limits[t]) : null;
        return html`<li class="${cap && used > cap ? 'bad' : ''}"><div class="row"><strong>${ctx.t(`invest.tax_type.${t}`)}</strong><span>${f.money(used)}${cap ? html` / ${f.money(cap)}` : ''}</span></div>
          ${cap ? html`<meter min="0" max="${Number(cap)}" value="${Math.min(Number(used), Number(cap))}" high="${Number(cap) * 0.999}" optimum="0" aria-label="${ctx.t(`invest.tax_type.${t}`)}"></meter><small>${used > cap ? ctx.t('rpt.over_limit', { amount: f.money(used - cap) }) : ctx.t('rpt.room_left', { amount: f.money(cap - used) })}</small>` : html`<small>${ctx.t('rpt.no_limit')}</small>`}</li>`;
      })}</ul>
      ${form(ctx, '/reports/tax/limits', html`<div class="grid3">${TAX_TYPES.map((t) => field(ctx.t('rpt.limit_for', { type: ctx.t(`invest.tax_type.${t}`) }), moneyInput(`limit_${t}`, limits[t] ? inputMoney(BigInt(limits[t])) : '')))}</div><p class="note">${ctx.t('rpt.limit_hint')}</p>`, { submit: ctx.t('common.save') })}`) : ''}
      ${d.funds.length ? card(ctx.t('rpt.tax_funds'), html`<ul class="rows">${d.funds.map((r: any) => html`<li><span>${r.symbol} · ${ctx.t(`invest.tax_type.${r.tax_type}`)}</span>${f.moneyHtml(r.s)}</li>`)}</ul>`) : ''}`,
  }));
});

post('/reports/tax/limits', { access: 'auth' }, async (ctx) => {
  const limits: Record<string, string> = {};
  for (const t of TAX_TYPES) { const v = money(ctx.body[`limit_${t}`]); if (v) limits[t] = v.toString(); }
  await ctx.as((q) => q.query('update user_preferences set tax_limits = $1 where user_id = hearth_uid()', [JSON.stringify(limits)]));
  return redirect(withFlash('/reports/tax', 'ok', 'saved'));
});

// ───────────── Notifications (in-app) ─────────────
get('/notifications', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const rows = await ctx.as((q) => q.query<any>('select * from notifications where owner_id = hearth_uid() and dismissed_at is null order by created_at desc limit 100'));
  return htmlRes(page(ctx, {
    title: ctx.t('nav.notifications'),
    actions: rows.length ? html`${rows.some((r) => !r.read_at) ? postButton(ctx, '/notifications/read-all', ctx.t('noti.read_all')) : ''} ${postButton(ctx, '/notifications/delete-all', ctx.t('noti.delete_all'), { cls: 'danger sm', confirm: ctx.t('noti.confirm_delete_all') })}` : undefined,
    body: card(null, rows.length ? html`<ul class="noti-list">${rows.map((n) => html`<li class="${n.read_at ? '' : 'unread'}"><span class="noti-kind">${icon(n.kind === 'security' ? 'lock' : n.kind.startsWith('debt') ? 'debt' : n.kind.startsWith('goal') ? 'target' : 'bell')}</span>
      <span><strong>${n.link || !n.read_at ? html`<a href="/notifications/${n.id}/open">${n.title}</a>` : n.title}</strong>${n.body ? html`<small>${n.body}</small>` : ''}<small>${f.date(n.created_at)}</small></span>${postButton(ctx, `/notifications/${n.id}/delete`, ctx.t('common.delete'), { cls: 'sm link noti-del' })}</li>`)}</ul>` : empty(ctx.t('noti.none'))),
  }));
});

// Opening a notification marks it read, then follows its link (same-origin paths only).
get('/notifications/:id/open', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const row = await ctx.as((q) => q.one<{ link: string | null }>(
    'update notifications set read_at = coalesce(read_at, now()) where id = $1 and owner_id = hearth_uid() returning link', [id]));
  if (!row) throw new HttpError(404);
  const link = row.link ?? '';
  return redirect(link.startsWith('/') && !link.startsWith('//') && !link.startsWith('/\\') ? link : '/notifications');
});

/**
 * Delete one / all notifications. Rows with a dedupe_key are hidden instead of deleted: the scheduler checks that
 * key so the same alert (e.g. "debt due on …") is not created again on its next run.
 */
const DISMISS = `set dismissed_at = now(), read_at = coalesce(read_at, now())`;
post('/notifications/:id/delete', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  await ctx.as(async (q) => {
    await q.query(`delete from notifications where id = $1 and owner_id = hearth_uid() and dedupe_key is null`, [id]);
    await q.query(`update notifications ${DISMISS} where id = $1 and owner_id = hearth_uid() and dedupe_key is not null`, [id]);
  });
  return redirect('/notifications');
});

post('/notifications/delete-all', { access: 'auth' }, async (ctx) => {
  await ctx.as(async (q) => {
    await q.query(`delete from notifications where owner_id = hearth_uid() and dedupe_key is null`);
    await q.query(`update notifications ${DISMISS} where owner_id = hearth_uid() and dedupe_key is not null and dismissed_at is null`);
  });
  return redirect(withFlash('/notifications', 'ok', 'deleted'));
});

post('/notifications/read-all', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query('update notifications set read_at = now() where owner_id = hearth_uid() and read_at is null'));
  return redirect('/notifications');
});

// ───────────── JSON API v1 (session cookie + X-CSRF-Token for writes) ─────────────
get('/api/v1/summary', { access: 'auth', api: true }, async (ctx) => {
  const p = ctx.prefs!;
  const cyc = currentCycle(p);
  const out = await ctx.as(async (q) => ({
    period: cyc,
    totals: await totals(q, ctx.view, cyc.start, cyc.end),
    net_worth: await netWorth(q, ctx.view, p),
    emergency: await emergencyStatus(q, ctx.view, p),
    debt_free_date: (await debtOverview(q, ctx.view)).debtFreeDate,
    months: (await monthlySeries(q, ctx.view, p, 12)).map((m) => ({ month: m.key, income: m.income, expense: m.expense })),
  }));
  return jsonRes({ ...out, emergency: { ...out.emergency, runway: Number.isFinite(out.emergency.runway) ? out.emergency.runway : null }, note: 'amounts are minor units (satang)' });
});

get('/api/v1/transactions', { access: 'auth', api: true }, async (ctx) => {
  const limit = Math.min(500, Math.max(1, Number.parseInt(ctx.query.get('limit') ?? '100', 10) || 100));
  const before = ctx.query.get('before');
  const rows = await ctx.as((q) => q.query<any>(`select id, kind, date::text date, amount, account_id, to_account_id, category_id, bucket_id, payee, tags, household_id, created_at
     from transactions where ${scope(ctx.view)} ${before && /^\d{4}-\d{2}-\d{2}$/.test(before) ? 'and date < $2' : ''} order by date desc, created_at desc limit $1`, before && /^\d{4}-\d{2}-\d{2}$/.test(before) ? [limit, before] : [limit]));
  return jsonRes({ data: rows });
});

post('/api/v1/transactions', { access: 'auth', api: true }, async (ctx) => {
  const b = (ctx.json ?? {}) as Record<string, string>;
  if (typeof b !== 'object') throw new HttpError(400);
  const kind = oneOf(b.kind, ['income', 'expense', 'transfer'] as const);
  const c = cipher(ctx);
  const id = await ctx.as((q) => createTransaction(q, ctx.user!.id, {
    kind, amount: money(String(b.amount ?? ''), { required: true })!, date: date(b.date, today()), accountId: requireUuid(b.account_id),
    toAccountId: kind === 'transfer' ? uuidOrNull(b.to_account_id) : null, categoryId: uuidOrNull(b.category_id), bucketId: ctx.prefs!.bucket_mode === 'off' ? null : uuidOrNull(b.bucket_id),
    payee: text(b.payee, 120) || null, noteEnc: c.enc(text(b.note, 1000)),
  }));
  return jsonRes({ id }, 201);
});

export const _w = { withFlash, lineChart };
