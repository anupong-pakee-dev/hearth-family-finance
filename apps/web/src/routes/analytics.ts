/**
 * Analytics (§4.9): time-range picker, drill-down, DASH-03 Sankey, DASH-04 category trends,
 * DASH-13 net worth over time, DASH-15 calendar heatmap.
 */
import { get, htmlRes, type Ctx } from '../http/app.ts';
import { html } from '../views/html.ts';
import { page } from '../views/layout.ts';
import { card, empty, field, dateInput } from '../views/ui.ts';
import { makeFmt } from '../views/format.ts';
import { barChart, donut, lineChart, sankey, calendarHeatmap, type SankeyNode, type SankeyLink } from '../views/charts.ts';
import { scope } from '../services/common.ts';
import { cycles, invTxnFromRow } from '../services/summary.ts';
import { addDays, addMonths, isIsoDate, todayIso, toMajorNumber, computeHoldings, valueOf } from '@hearth/engine';

export const RANGES = ['1m', '3m', '6m', '12m', 'ytd', 'custom'] as const;
export type Range = (typeof RANGES)[number];

/** Resolve the range picker into month buckets [{key,start,end}] (FR shared chart rule "เลือกช่วงเวลา"). */
export function resolveRange(ctx: Ctx, today = todayIso()) {
  const p = ctx.prefs!;
  const r = (RANGES as readonly string[]).includes(ctx.query.get('range') ?? '') ? (ctx.query.get('range') as Range) : '6m';
  if (r === 'ytd' || r === 'custom') {
    let from = r === 'ytd' ? `${today.slice(0, 4)}-01-01` : ctx.query.get('from') ?? '';
    let to = r === 'ytd' ? today : ctx.query.get('to') ?? '';
    if (!isIsoDate(from)) from = addMonths(today, -5).slice(0, 8) + '01';
    if (!isIsoDate(to) || to < from) to = today;
    if (addMonths(from, 36) < to) from = addMonths(to, -36); // bound the work
    const months: { key: string; start: string; end: string }[] = [];
    for (let m = `${from.slice(0, 7)}-01`; m <= to; m = addMonths(m, 1)) {
      const end = addDays(addMonths(m, 1), -1);
      months.push({ key: m.slice(0, 7), start: m < from ? from : m, end: end > to ? to : end });
    }
    return { range: r, from, to, months };
  }
  const n = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 }[r];
  const months = cycles(p, n, today);
  return { range: r, from: months[0].start, to: months[months.length - 1].end, months };
}

get('/analytics', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const p = ctx.prefs!;
  const t = ctx.t;
  const { range, from, to, months } = resolveRange(ctx);
  const sc = scope(ctx.view, 't');
  const fm = (n: number) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n));
  const bounds = [months.map((m) => m.start), months.map((m) => m.end)];

  const d = await ctx.as(async (q) => ({
    monthly: await q.query<any>(`with c(start, finish) as (select * from unnest($1::date[], $2::date[]))
      select c.start::text start, coalesce(sum(t.amount) filter (where t.kind='income'),0)::bigint inc, coalesce(sum(t.amount) filter (where t.kind='expense'),0)::bigint exp
        from c left join transaction_lines t on t.date between c.start and c.finish and ${sc} group by c.start order by c.start`, bounds),
    byCat: await q.query<any>(`select coalesce(p.id, c.id) id, coalesce(p.name, c.name) name, t.kind, sum(t.amount)::bigint total
        from transaction_lines t left join categories c on c.id = t.category_id left join categories p on p.id = c.parent_id
       where ${sc} and t.kind <> 'transfer' and t.date between $1 and $2 group by 1, 2, 3 order by total desc`, [from, to]),
    trend: await q.query<any>(`with c(start, finish) as (select * from unnest($1::date[], $2::date[]))
      select c.start::text start, coalesce(p.id, cat.id) id, sum(t.amount)::bigint total
        from c join transaction_lines t on t.date between c.start and c.finish and t.kind = 'expense' and ${sc}
        left join categories cat on cat.id = t.category_id left join categories p on p.id = cat.parent_id group by 1, 2`, bounds),
    daily: await q.query<any>(`select t.date::text date, sum(t.amount)::bigint total from transaction_lines t where ${sc} and t.kind = 'expense' and t.date between $1 and $2 group by 1`, [addMonths(to, -12) > from ? addMonths(to, -12) : from, to]),
    // DASH-13 inputs: current balances + flows after each month end
    accNow: (await q.one<any>(`select coalesce(sum(balance),0)::bigint s from accounts where not archived and type <> 'investment' and ${scope(ctx.view)}`))!.s as bigint,
    debtNow: (await q.one<any>(`select coalesce(sum(balance_current),0)::bigint s from debts where not is_receivable and ${scope(ctx.view)}`))!.s as bigint,
    flowsAfter: await q.query<any>(`select c.finish::text finish,
        coalesce((select sum(case when t.kind='income' then t.amount when t.kind='expense' then -t.amount else 0 end) from transactions t where t.date > c.finish and ${sc}),0)::bigint net,
        coalesce((select sum(dp.principal - dp.balance_adjustment) from debt_payments dp where dp.date > c.finish and ${scope(ctx.view, 'dp')}),0)::bigint principal
        from unnest($1::date[]) c(finish)`, [months.map((m) => m.end)]),
    snaps: await q.query<any>(`select date::text date, assets - liabilities nw from net_worth_snapshots where owner_id = hearth_uid() and date between $1 and $2 order by date`, [from, to]),
    inv: p.investment_enabled ? await q.query<any>(`select it.*, it.date::text date from investment_transactions it join portfolios pf on pf.id = it.portfolio_id where ${scope(ctx.view, 'pf')} order by it.date`) : [],
    prices: p.investment_enabled ? await q.query<any>(`select asset_id, date::text date, price_e8 from price_history where owner_id = hearth_uid() order by date desc`) : [],
  }));

  const link = (a: string, b: string, extra = '') => `/transactions?from=${a}&to=${b}${extra}`;
  const labels = months.map((m) => (months.length > 12 ? f.month(m.key) : f.monthShort(m.key)));
  const totalInc = d.monthly.reduce((s: bigint, m: any) => s + (m.inc as bigint), 0n) as bigint;
  const totalExp = d.monthly.reduce((s: bigint, m: any) => s + (m.exp as bigint), 0n) as bigint;

  // DASH-01 with drill-down
  const incomeExpense = barChart({
    title: t('an.income_expense'), summary: t('dash.chart.income_expense_sum'), labels,
    bars: [{ name: t('txn.kind.income'), cls: 'c-inc', values: d.monthly.map((m: any) => toMajorNumber(m.inc)) }, { name: t('txn.kind.expense'), cls: 'c-exp', values: d.monthly.map((m: any) => toMajorNumber(m.exp)) }],
    line: { name: t('dash.left'), cls: 'c-net', values: d.monthly.map((m: any) => toMajorNumber((m.inc as bigint) - (m.exp as bigint))) },
    fmt: fm, links: months.map((m) => link(m.start, m.end)),
  });

  // DASH-02 + drill-down list
  const expCats = d.byCat.filter((c: any) => c.kind === 'expense');
  const incCats = d.byCat.filter((c: any) => c.kind === 'income');
  const catList = html`<ul class="rows">${expCats.map((c: any) => html`<li><a href="${link(from, to, c.id ? `&category=${c.id}` : '&kind=expense')}">${c.name ?? t('txn.uncategorized')}</a>${f.moneyHtml(c.total)}</li>`)}</ul>`;

  // DASH-04 trend of the top 5 categories
  const top = expCats.slice(0, 5);
  const trend = top.length ? lineChart({
    title: t('an.trend'), summary: t('an.trend_sum'), labels,
    series: top.map((c: any, i: number) => ({ name: c.name ?? t('txn.uncategorized'), cls: `s${i}`, dashed: i % 3 === 1, dotted: i % 3 === 2, values: months.map((m) => toMajorNumber(d.trend.find((r: any) => r.start === m.start && r.id === c.id)?.total ?? 0n)) })),
    fmt: fm,
  }) : empty(t('common.no_data'));

  // DASH-03 Sankey: income sources → spent/saved → spending categories
  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];
  const topInc = incCats.slice(0, 5);
  const otherInc = incCats.slice(5).reduce((s: bigint, c: any) => s + (c.total as bigint), 0n) as bigint;
  for (const c of topInc) nodes.push({ id: `i:${c.id}`, label: c.name ?? t('txn.uncategorized'), col: 0, href: link(from, to, c.id ? `&category=${c.id}` : '&kind=income') });
  if (otherInc > 0n) nodes.push({ id: 'i:other', label: t('common.other'), col: 0 });
  const saved = totalInc - totalExp;
  const fromSavings = saved < 0n ? -saved : 0n;
  if (fromSavings > 0n) nodes.push({ id: 'i:savings', label: t('an.from_savings'), col: 0 });
  nodes.push({ id: 'm:spent', label: t('an.spent'), col: 1, href: link(from, to, '&kind=expense') });
  if (saved > 0n) nodes.push({ id: 'm:saved', label: t('an.saved'), col: 1 });
  const spentShare = totalInc > 0n ? toMajorNumber(totalExp - fromSavings) / toMajorNumber(totalInc) : 0;
  for (const c of topInc) {
    links.push({ from: `i:${c.id}`, to: 'm:spent', value: toMajorNumber(c.total) * spentShare });
    if (saved > 0n) links.push({ from: `i:${c.id}`, to: 'm:saved', value: toMajorNumber(c.total) * (1 - spentShare) });
  }
  if (otherInc > 0n) {
    links.push({ from: 'i:other', to: 'm:spent', value: toMajorNumber(otherInc) * spentShare });
    if (saved > 0n) links.push({ from: 'i:other', to: 'm:saved', value: toMajorNumber(otherInc) * (1 - spentShare) });
  }
  if (fromSavings > 0n) links.push({ from: 'i:savings', to: 'm:spent', value: toMajorNumber(fromSavings) });
  const topExp = expCats.slice(0, 7);
  const otherExp = expCats.slice(7).reduce((s: bigint, c: any) => s + (c.total as bigint), 0n) as bigint;
  for (const c of topExp) { nodes.push({ id: `e:${c.id}`, label: c.name ?? t('txn.uncategorized'), col: 2, href: link(from, to, c.id ? `&category=${c.id}` : '&kind=expense') }); links.push({ from: 'm:spent', to: `e:${c.id}`, value: toMajorNumber(c.total) }); }
  if (otherExp > 0n) { nodes.push({ id: 'e:other', label: t('common.other'), col: 2 }); links.push({ from: 'm:spent', to: 'e:other', value: toMajorNumber(otherExp) }); }
  const flow = totalInc > 0n || totalExp > 0n ? sankey({ title: t('an.sankey'), summary: t('an.sankey_sum'), nodes, links, fmt: (n) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n)) }) : empty(t('common.no_data'));

  // DASH-13 net worth over time (snapshots when available, otherwise reconstructed from history)
  const investAt = (end: string): bigint => {
    if (!d.inv.length) return 0n;
    const hs = computeHoldings(d.inv.filter((x: any) => x.date <= end).map(invTxnFromRow), p.cost_method);
    let v = 0n;
    for (const h of hs.values()) { const pr = d.prices.find((x: any) => x.asset_id === h.assetId && x.date <= end); v += pr ? valueOf(h.unitsE8, pr.price_e8) : h.costBasis; }
    return v;
  };
  const nwSeries = months.map((m) => {
    const snap = [...d.snaps].reverse().find((s: any) => s.date <= m.end && s.date >= m.start);
    if (snap) return toMajorNumber(snap.nw);
    const fa = d.flowsAfter.find((x: any) => x.finish === m.end);
    const assets = d.accNow - (fa?.net ?? 0n);
    const liabilities = d.debtNow + (fa?.principal ?? 0n);
    return toMajorNumber(assets + investAt(m.end) - liabilities);
  });
  const netWorthChart = lineChart({ title: t('an.net_worth'), summary: t('an.net_worth_sum'), labels, series: [{ name: t('dash.net_worth'), cls: 'c-net', area: true, values: nwSeries }], fmt: fm });

  // DASH-15 calendar heatmap
  const hFrom = addMonths(to, -12) > from ? addMonths(to, -12) : from;
  const weekday = ctx.lang === 'th' ? ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const heat = calendarHeatmap({ title: t('an.heatmap'), start: hFrom, end: to, weekdayLabels: weekday, monthLabel: (k) => f.monthShort(k), days: d.daily.map((x: any) => ({ date: x.date, value: toMajorNumber(x.total), display: f.money(x.total) })) });

  const opt = (r: string) => html`<a class="btn sm" href="/analytics?range=${r}" ${range === r ? html`aria-current="page"` : ''}>${t(`an.range.${r}`)}</a>`;
  return htmlRes(page(ctx, {
    title: t('nav.analytics'),
    wide: true,
    body: html`
      <form method="get" action="/analytics" class="range-bar" aria-label="${t('an.range_label')}">
        <nav class="row-actions" aria-label="${t('an.range_label')}">${['1m', '3m', '6m', '12m', 'ytd'].map(opt)}</nav>
        <input type="hidden" name="range" value="custom">
        ${field(t('common.from'), dateInput('from', range === 'custom' ? from : ''))}${field(t('common.to'), dateInput('to', range === 'custom' ? to : ''))}
        <button class="btn sm">${t('common.apply')}</button>
      </form>
      <p class="note">${f.date(from)} – ${f.date(to)} · ${t('an.drill_hint')}</p>
      <div class="dash">
        ${card(t('an.income_expense'), incomeExpense, { cls: 'span2' })}
        ${card(t('an.sankey'), flow, { cls: 'span2' })}
        ${card(t('dash.chart.by_category'), expCats.length ? html`${donut({ title: t('dash.chart.by_category'), summary: t('dash.chart.by_category_sum'), items: expCats.slice(0, 8).map((c: any) => ({ label: c.name ?? t('txn.uncategorized'), value: toMajorNumber(c.total), display: f.money(c.total) })), center: f.money(totalExp, { compact: true }) })}${catList}` : empty(t('common.no_data')))}
        ${card(t('an.trend'), trend)}
        ${card(t('an.net_worth'), html`${netWorthChart}<p class="note">${t('an.net_worth_note')}</p>`, { cls: 'span2' })}
        ${card(t('an.heatmap'), heat, { cls: 'span2' })}
      </div>`,
  }));
});
