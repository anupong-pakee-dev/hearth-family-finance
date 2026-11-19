/**
 * Investments (§4.7). Whole module is optional (module: 'invest'). Record-keeping only — not advice.
 */
import { get, post, htmlRes, redirect, withFlash, HttpError, type Ctx } from '../http/app.ts';
import { html } from '../views/html.ts';
import { page, icon } from '../views/layout.ts';
import { field, input, moneyInput, rateInput, dateInput, select, form, postButton, empty, card, stat, tabs } from '../views/ui.ts';
import { makeFmt, inputMoney, inputRate } from '../views/format.ts';
import { lineChart, donut, hBars, barChart } from '../views/charts.ts';
import { money, rate, date, text, oneOf, requireUuid, uuidOrNull, scope, shareTarget, intIn, today } from '../services/common.ts';
import { bucketMove, ASSET_CLASSES, INV_TYPES } from '../services/finance.ts';
import { portfolioValues, invTxnFromRow, emergencyStatus, loadDebts, convert } from '../services/summary.ts';
import { registry } from '../services/plugins.ts';
import { csrfField } from '../views/layout.ts';
import { computeHoldings, valuation, xirr, cashFlowsFor, rebalance, scenarios, retirementPlan, parseScaled, toMajorNumber, addMonths, valueOf, E8, divRound } from '@hearth/engine';

const disclaimer = (ctx: Ctx) => html`<p class="note disclaimer">${icon('info')} ${ctx.t('invest.disclaimer')}</p>`;
const nav = (ctx: Ctx) => tabs(ctx, [{ href: '/invest', label: ctx.t('invest.overview') }, { href: '/invest/allocation', label: ctx.t('invest.allocation') }, { href: '/invest/plan', label: ctx.t('invest.plan') }]);

function units(v: string | undefined, required = true): bigint {
  const s = (v ?? '').replace(/[,\s]/g, '');
  if (!s) { if (required) throw new HttpError(422, 'units'); return 0n; }
  const u = parseScaled(s, 8);
  if (u == null || u < 0n) throw new HttpError(422, 'units');
  return u;
}

async function priorityWarnings(ctx: Ctx) {
  return ctx.as(async (q) => {
    const emg = await emergencyStatus(q, 'mine', ctx.prefs!);
    const debts = await loadDebts(q, 'mine');
    const high = debts.filter((d) => d.annual_rate_e4 > ctx.prefs!.invest_warn_rate_e4);
    return { lowEmergency: emg.runway < 1, high };
  });
}

/** FR-INV-18: value per currency, converted at today's rate, and the gain/loss caused by exchange-rate moves. */
function fxCard(ctx: Ctx, f: ReturnType<typeof makeFmt>, pv: Awaited<ReturnType<typeof portfolioValues>>) {
  const main = ctx.prefs!.currency;
  const groups = new Map<string, { value: bigint; cost: bigint; rate: number; boughtAt: number }>();
  for (const r of pv.rows) {
    if (r.currency === main) continue;
    const buys = pv.txRows.filter((t: any) => t.asset_id === r.holding.assetId && ['buy', 'switch_in', 'transfer_in'].includes(t.type));
    const w = buys.reduce((s: number, t: any) => s + Number(t.amount), 0);
    const boughtAt = w > 0 ? buys.reduce((s: number, t: any) => s + Number(t.amount) * (t.fx_rate ? Number(t.fx_rate) : r.fxRate), 0) / w : r.fxRate;
    const g = groups.get(r.currency) ?? { value: 0n, cost: 0n, rate: r.fxRate, boughtAt: 0 };
    g.value += r.valuation.marketValue; g.cost += r.holding.costBasis; g.boughtAt = boughtAt;
    groups.set(r.currency, g);
  }
  if (!groups.size) return '';
  return card(ctx.t('invest.by_currency'), html`<div class="table-wrap"><table class="tbl"><thead><tr><th>${ctx.t('common.currency')}</th><th class="num">${ctx.t('invest.value')}</th><th class="num">${ctx.t('invest.rate_now')}</th><th class="num">${ctx.t('invest.value')} (${main})</th><th class="num">${ctx.t('invest.fx_effect')}</th></tr></thead>
    <tbody>${[...groups.entries()].map(([cur, g]) => html`<tr><td>${cur}</td><td class="num">${f.money(g.value, { currency: cur })}</td><td class="num">${g.rate.toFixed(4)}</td><td class="num">${f.money(convert(g.value, g.rate))}</td><td class="num">${f.moneyHtml(convert(g.cost, g.rate) - convert(g.cost, g.boughtAt), { sign: true })}</td></tr>`)}</tbody></table></div>
    <p class="note">${ctx.t('invest.fx_note')}</p>`);
}

get('/invest', { access: 'auth', module: 'invest' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const p = ctx.prefs!;
  const [pv, portfolios, warn, buckets, goals] = await Promise.all([
    ctx.as((q) => portfolioValues(q, ctx.view, p)),
    ctx.as((q) => q.query<any>(`select p.*, g.name goal_name, m.display_name member_name from portfolios p left join goals g on g.id = p.goal_id left join members m on m.id = p.member_id where not p.archived and ${scope(ctx.view, 'p')} order by p.created_at`)),
    priorityWarnings(ctx),
    p.bucket_mode !== 'off' ? ctx.as((q) => q.query<any>(`select balance from buckets where type = 'investing' and not archived and owner_id = hearth_uid()`)) : Promise.resolve([]),
    ctx.as((q) => q.query<any>('select id, name from goals where not archived and owner_id = hearth_uid()')),
  ]);
  const members = ctx.households.length ? await ctx.as((q) => q.query<any>(`select m.id, m.display_name, m.role from members m where hearth_member_role(m.household_id) in ('owner','manager','member') order by m.role = 'dependent' desc, m.display_name`)) : [];
  const flows = cashFlowsFor(pv.txRows.map(invTxnFromRow), pv.value, today());
  const irr = xirr(flows);
  const totalReturn = pv.invested > 0n ? toMajorNumber(pv.value + pv.returned - pv.invested) / toMajorNumber(pv.invested) : 0;
  // per-portfolio values (visibility: others' portfolios with 'total' show only the total) FR-INV-23
  const perPortfolio = new Map<string, bigint>();
  for (const r of pv.txRows) perPortfolio.set(r.portfolio_id, 0n);
  const byPortfolio = await ctx.as(async (q) => {
    const out: Record<string, bigint> = {};
    for (const pf of portfolios) {
      const v = await portfolioValues(q, ctx.view, p, pf.id);
      out[pf.id] = v.value;
    }
    return out;
  });
  // DASH-16 value vs invested over time (12 months)
  const months = Array.from({ length: 12 }, (_, i) => addMonths(today(), i - 11));
  const prices = await ctx.as((q) => q.query<any>(`select asset_id, date::text date, price_e8 from price_history where owner_id = hearth_uid() order by date`));
  const valueSeries: number[] = [], costSeries: number[] = [];
  for (const m of months) {
    const end = `${m.slice(0, 7)}-31`;
    const hs = computeHoldings(pv.txRows.filter((t: any) => t.date <= end).map(invTxnFromRow), p.cost_method);
    let v = 0n, c = 0n;
    for (const h of hs.values()) {
      const pr = [...prices].reverse().find((x) => x.asset_id === h.assetId && x.date <= end);
      v += pr ? valueOf(h.unitsE8, pr.price_e8) : h.costBasis;
      c += h.costBasis;
    }
    valueSeries.push(toMajorNumber(v)); costSeries.push(toMajorNumber(c));
  }
  // DASH-19 dividends per month, DASH-21 planned vs actual buys
  const divs = months.map((m) => toMajorNumber(pv.txRows.filter((t: any) => (t.type === 'dividend' || t.type === 'interest') && t.date.slice(0, 7) === m.slice(0, 7)).reduce((s: bigint, t: any) => s + t.amount - t.tax, 0n)));
  const buys = months.map((m) => toMajorNumber(pv.txRows.filter((t: any) => t.type === 'buy' && t.date.slice(0, 7) === m.slice(0, 7)).reduce((s: bigint, t: any) => s + t.amount + t.fee, 0n)));
  const fm = (n: number) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact' }).format(n));
  const labels = months.map((m) => f.monthShort(m.slice(0, 7)));
  const investBucket = buckets.reduce((s: bigint, b: any) => s + b.balance, 0n);
  return htmlRes(page(ctx, {
    title: ctx.t('nav.invest'),
    body: html`${nav(ctx)}
      ${warn.lowEmergency && p.emergency_first ? html`<p class="flash warn">${ctx.t('invest.warn_emergency')}</p>` : ''}
      ${warn.high.length ? html`<p class="flash warn">${ctx.t('invest.warn_debt', { names: warn.high.map((d: any) => d.name).join(', '), rate: inputRate(p.invest_warn_rate_e4) })}</p>` : ''}
      <section class="stats">
        ${stat(ctx.t('invest.value'), f.moneyHtml(pv.value))}
        ${stat(ctx.t('invest.cost'), f.moneyHtml(pv.cost))}
        ${stat(ctx.t('invest.unrealized'), f.moneyHtml(pv.unrealized, { sign: true }), undefined, pv.unrealized < 0n ? 'bad' : 'ok')}
        ${stat(ctx.t('invest.realized_income'), f.moneyHtml(pv.realized + pv.income, { sign: true }))}
        ${stat(ctx.t('invest.return_simple'), f.privacy ? '•••' : f.pct(totalReturn, 2), irr != null ? `XIRR ${f.privacy ? '•••' : f.pct(irr, 2)}` : '')}
        ${p.bucket_mode !== 'off' && buckets.length ? stat(ctx.t('invest.bucket_cash'), f.moneyHtml(investBucket), ctx.t('invest.bucket_cash_hint')) : stat(ctx.t('invest.monthly_budget'), f.moneyHtml(p.invest_monthly_budget), ctx.t('invest.this_month_bought', { amount: f.money(BigInt(Math.round(buys[11] * 100))) }))}
      </section>
      ${card(ctx.t('invest.value_vs_cost'), lineChart({ title: ctx.t('invest.value_vs_cost'), summary: ctx.t('invest.value_vs_cost'), labels, series: [{ name: ctx.t('invest.value'), cls: 'c-inc', area: true, values: valueSeries }, { name: ctx.t('invest.cost'), cls: 'c-net', dashed: true, values: costSeries }], fmt: fm }), { cls: 'span2' })}
      ${card(ctx.t('invest.portfolios'), portfolios.length ? html`<ul class="rows">${portfolios.map((pf) => html`<li><a href="/invest/portfolios/${pf.id}">${icon('chart')} <span><strong>${pf.name}</strong><small>${ctx.t(`invest.kind.${pf.kind}`)}${pf.member_name ? html` · ${icon('child')} ${pf.member_name}` : ''}${pf.goal_name ? html` · ${icon('target')} ${pf.goal_name}` : ''}${pf.household_id ? html` · ${icon('users')}` : ''}</small></span></a>${f.moneyHtml(byPortfolio[pf.id])}</li>`)}</ul>` : empty(ctx.t('invest.no_portfolio')))}
      ${fxCard(ctx, f, pv)}
      ${pv.rows.length ? card(ctx.t('invest.returns_by_asset'), hBars({ title: ctx.t('invest.returns_by_asset'), summary: '', rows: pv.rows.filter((r) => r.holding.invested > 0n).map((r) => ({ label: r.asset?.symbol ?? '?', value: r.valuation.simpleReturn * 100, display: f.privacy ? '•••' : f.pct(r.valuation.simpleReturn, 1) })) })) : ''}
      ${card(ctx.t('invest.dividends'), barChart({ title: ctx.t('invest.dividends'), summary: ctx.t('invest.dividends'), labels, bars: [{ name: ctx.t('invest.dividends'), cls: 'c-inc', values: divs }], fmt: fm }))}
      ${card(ctx.t('invest.plan_vs_actual'), barChart({ title: ctx.t('invest.plan_vs_actual'), summary: '', labels, bars: [{ name: ctx.t('invest.bought'), cls: 'c-inc', values: buys }], line: { name: ctx.t('invest.monthly_budget'), cls: 'c-net', values: months.map(() => toMajorNumber(p.invest_monthly_budget)) }, fmt: fm }))}
      ${card(ctx.t('invest.add_portfolio'), form(ctx, '/invest/portfolios', html`<div class="grid3">
        ${field(ctx.t('invest.portfolio_name'), input({ name: 'name', required: true, maxlength: 80 }), { id: 'f-name' })}
        ${field(ctx.t('invest.portfolio_kind'), select('kind', ['brokerage', 'fund', 'crypto', 'retirement', 'other'].map((k) => ({ value: k, label: ctx.t(`invest.kind.${k}`) })), 'brokerage'))}
        ${field(ctx.t('invest.visibility'), select('visibility', ['private', 'total', 'full'].map((v) => ({ value: v, label: ctx.t(`invest.visibility.${v}`) })), 'private'))}
        ${goals.length ? field(ctx.t('invest.goal'), select('goal_id', goals.map((g: any) => ({ value: g.id, label: g.name })), '', { empty: '—' })) : ''}
        ${members.length ? field(ctx.t('invest.for_member'), select('member_id', members.map((m: any) => ({ value: m.id, label: `${m.display_name} (${ctx.t(`hh.role.${m.role}`)})` })), '', { empty: ctx.t('debt.owner_me') }), { hint: ctx.t('invest.for_member_hint') }) : ''}
        ${ctx.households.length ? field(ctx.t('common.share_with'), select('household_id', ctx.households.filter((h) => h.role !== 'viewer').map((h) => ({ value: h.id, label: h.name })), '', { empty: ctx.t('common.private') })) : ''}
      </div>`, { submit: ctx.t('common.add') }))}
      ${card(ctx.t('invest.monthly_budget'), form(ctx, '/invest/budget', html`${field(ctx.t('invest.monthly_budget'), moneyInput('budget', inputMoney(p.invest_monthly_budget)), { id: 'f-budget', hint: ctx.t('invest.monthly_budget_hint') })}`, { submit: ctx.t('common.save') }))}
      ${disclaimer(ctx)}`,
    wide: true,
  }));
});

post('/invest/budget', { access: 'auth', module: 'invest' }, async (ctx) => {
  await ctx.as((q) => q.query('update user_preferences set invest_monthly_budget = $1 where user_id = hearth_uid()', [money(ctx.body.budget) ?? 0n]));
  return redirect(withFlash('/invest', 'ok', 'saved'));
});

post('/invest/portfolios', { access: 'auth', module: 'invest' }, async (ctx) => {
  const visibility = oneOf(ctx.body.visibility, ['private', 'total', 'full'] as const, 'private');
  const memberId = uuidOrNull(ctx.body.member_id);
  await ctx.as(async (q) => {
    if (memberId && !(await q.one(`select 1 from members where id = $1 and hearth_member_role(household_id) in ('owner','manager','member')`, [memberId]))) throw new HttpError(404);
    await q.query('insert into portfolios(owner_id, household_id, name, kind, visibility, goal_id, member_id) values (hearth_uid(),$1,$2,$3,$4,$5,$6)',
      [visibility === 'private' ? null : shareTarget(ctx, ctx.body.household_id), text(ctx.body.name, 80, true), oneOf(ctx.body.kind, ['brokerage', 'fund', 'crypto', 'retirement', 'other'] as const, 'other'), visibility, uuidOrNull(ctx.body.goal_id), memberId]);
  });
  return redirect(withFlash('/invest', 'ok', 'saved'));
});

get('/invest/portfolios/:id', { access: 'auth', module: 'invest' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const f = makeFmt(ctx.prefs, ctx.lang);
  const p = ctx.prefs!;
  const pf = await ctx.as((q) => q.one<any>('select * from portfolios where id = $1', [id]));
  if (!pf) throw new HttpError(404);
  const mine = pf.owner_id === ctx.user!.id;
  const pv = await ctx.as((q) => portfolioValues(q, ctx.view === 'mine' && !mine ? 'all' : ctx.view, p, id));
  if (!mine && pf.visibility !== 'full') {
    return htmlRes(page(ctx, { title: pf.name, body: html`<section class="stats">${stat(ctx.t('invest.value'), f.moneyHtml(pv.value))}</section><p class="note">${ctx.t('invest.total_only')}</p>` }));
  }
  const { assets, buckets, pending } = await ctx.as(async (q) => ({
    pending: await q.query<any>(`select it.id, it.date::text date, it.amount, a.symbol from investment_transactions it join assets a on a.id = it.asset_id where it.portfolio_id = $1 and it.pending order by it.date`, [id]),
    assets: await q.query<any>('select * from assets where owner_id = hearth_uid() order by symbol'),
    buckets: p.bucket_mode !== 'off' ? await q.query<any>(`select id, name, balance from buckets where type = 'investing' and not archived and owner_id = hearth_uid()`) : [],
  }));
  const irr = xirr(cashFlowsFor(pv.txRows.map(invTxnFromRow), pv.value, today()));
  return htmlRes(page(ctx, {
    title: pf.name,
    body: html`
      <section class="stats">
        ${stat(ctx.t('invest.value'), f.moneyHtml(pv.value))}
        ${stat(ctx.t('invest.unrealized'), f.moneyHtml(pv.unrealized, { sign: true }))}
        ${stat(ctx.t('invest.realized_income'), f.moneyHtml(pv.realized + pv.income, { sign: true }))}
        ${stat('XIRR', irr != null && !f.privacy ? f.pct(irr, 2) : '—')}
      </section>
      ${pending.length ? card(ctx.t('invest.pending'), html`<p class="note">${ctx.t('invest.pending_hint')}</p><ul class="rows">${pending.map((t: any) => html`<li>
        <span>${f.date(t.date)} · ${t.symbol} · ${f.money(t.amount)}</span>
        <form method="post" action="/invest/txns/${t.id}/confirm" class="inline-form">${csrfField(ctx)}<input type="hidden" name="back" value="/invest/portfolios/${id}">
          <label class="sr-only" for="u-${t.id}">${ctx.t('invest.units')}</label><input id="u-${t.id}" name="units" inputmode="decimal" required placeholder="${ctx.t('invest.units')}">
          <label class="sr-only" for="a-${t.id}">${ctx.t('invest.amount')}</label><input id="a-${t.id}" name="amount" inputmode="decimal" value="${inputMoney(t.amount)}">
          <button class="btn sm primary">${ctx.t('invest.confirm')}</button></form>
        ${postButton(ctx, `/invest/txns/${t.id}/delete`, ctx.t('invest.skip'), { cls: 'sm link', fields: { back: `/invest/portfolios/${id}` } })}</li>`)}</ul>`) : ''}
      ${card(ctx.t('invest.holdings'), pv.rows.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>${ctx.t('invest.asset')}</th><th class="num">${ctx.t('invest.units')}</th><th class="num">${ctx.t('invest.avg_cost')}</th><th class="num">${ctx.t('invest.price')}</th><th class="num">${ctx.t('invest.value')}</th><th class="num">${ctx.t('invest.unrealized')}</th></tr></thead>
        <tbody>${pv.rows.map((r) => html`<tr><td><strong>${r.asset?.symbol}</strong><br><small>${ctx.t(`invest.class.${r.asset?.asset_class}`)}</small></td><td class="num">${f.units(r.holding.unitsE8)}</td>
          <td class="num">${r.holding.unitsE8 > 0n ? f.money(divRound(r.holding.costBasis * E8, r.holding.unitsE8)) : '—'}</td><td class="num">${r.price != null ? f.money(divRound(r.price, 1_000_000n)) : html`<small>${ctx.t('invest.no_price')}</small>`}</td>
          <td class="num">${f.money(r.valuation.marketValue)}</td><td class="num">${f.moneyHtml(r.valuation.unrealizedPL, { sign: true })}</td></tr>`)}</tbody></table></div>` : empty(ctx.t('invest.no_holdings')))}
      ${card(ctx.t('invest.add_txn'), assets.length ? form(ctx, `/invest/portfolios/${id}/txns`, html`<div class="grid3">
        ${field(ctx.t('invest.txn_type'), select('type', INV_TYPES.map((v) => ({ value: v, label: ctx.t(`invest.type.${v}`) })), 'buy'))}
        ${field(ctx.t('invest.asset'), select('asset_id', assets.map((a: any) => ({ value: a.id, label: `${a.symbol} — ${a.name}` })), assets[0]?.id, { required: true }))}
        ${field(ctx.t('txn.date'), dateInput('date', today(), true))}
        ${field(ctx.t('invest.units'), input({ name: 'units', inputmode: 'decimal', placeholder: '0.00000000' }), { id: 'f-units', hint: ctx.t('invest.units_hint') })}
        ${field(ctx.t('invest.amount'), moneyInput('amount', ''), { id: 'f-amount', hint: ctx.t('invest.amount_hint') })}
        ${field(ctx.t('invest.fee'), moneyInput('fee', ''), { id: 'f-fee' })}
        ${field(ctx.t('invest.tax'), moneyInput('tax', ''), { id: 'f-tax' })}
        ${assets.some((a: any) => a.currency !== p.currency) ? field(ctx.t('txn.fx_rate'), input({ name: 'fx_rate', inputmode: 'decimal' }), { hint: ctx.t('txn.fx_rate_hint', { cur: p.currency }) }) : ''}
        ${buckets.length ? field(ctx.t('invest.from_bucket'), select('bucket_id', buckets.map((b: any) => ({ value: b.id, label: `${b.name} (${f.money(b.balance)})` })), buckets[0].id, { empty: '—' }), { hint: ctx.t('invest.from_bucket_hint') }) : ''}
        </div>`, { submit: ctx.t('common.save') }) : html`<p>${ctx.t('invest.add_asset_first')}</p>`)}
      ${card(ctx.t('invest.update_price'), assets.length ? form(ctx, '/invest/prices', html`<input type="hidden" name="back" value="/invest/portfolios/${id}"><div class="grid3">
        ${field(ctx.t('invest.asset'), select('asset_id', assets.map((a: any) => ({ value: a.id, label: a.symbol })), assets[0]?.id, { required: true }))}
        ${field(ctx.t('invest.price'), input({ name: 'price', inputmode: 'decimal', required: true }), { id: 'f-price', hint: ctx.t('invest.price_hint') })}
        ${field(ctx.t('txn.date'), dateInput('date', today(), true))}</div>`, { submit: ctx.t('common.save') }) : html`<p>${ctx.t('invest.add_asset_first')}</p>`)}
      ${card(ctx.t('invest.add_asset'), form(ctx, '/invest/assets', html`<input type="hidden" name="back" value="/invest/portfolios/${id}"><div class="grid3">
        ${field(ctx.t('invest.symbol'), input({ name: 'symbol', required: true, maxlength: 30 }), { id: 'f-symbol' })}
        ${field(ctx.t('invest.asset_name'), input({ name: 'name', maxlength: 80 }), { id: 'f-aname' })}
        ${field(ctx.t('invest.asset_class'), select('asset_class', ASSET_CLASSES.map((v) => ({ value: v, label: ctx.t(`invest.class.${v}`) })), 'mutual_fund'))}
        ${field(ctx.t('common.currency'), input({ name: 'currency', value: p.currency, maxlength: 3 }), { id: 'f-cur' })}
        ${field(ctx.t('invest.price_source'), select('price_source', [{ value: 'manual', label: ctx.t('invest.price_manual') }, ...[...registry.prices.values()].map((x) => ({ value: x.id, label: x.name }))], 'manual'), { hint: ctx.t('invest.price_source_hint') })}
        ${field(ctx.t('invest.tax_type'), select('tax_type', ['ssf', 'rmf', 'thaiesg', 'other'].map((v) => ({ value: v, label: ctx.t(`invest.tax_type.${v}`) })), '', { empty: '—' }), { hint: ctx.t('invest.tax_type_hint') })}</div>`, { submit: ctx.t('common.add') }))}
      ${card(ctx.t('invest.transactions'), pv.txRows.length ? html`<ul class="rows">${[...pv.txRows].reverse().slice(0, 100).map((t: any) => html`<li><span>${f.date(t.date)} · ${ctx.t(`invest.type.${t.type}`)} · ${assets.find((a: any) => a.id === t.asset_id)?.symbol ?? ''} ${t.units_e8 ? html`· ${f.units(t.units_e8)}` : ''}</span>${f.moneyHtml(t.amount)}${mine ? postButton(ctx, `/invest/txns/${t.id}/delete`, '×', { cls: 'sm link', fields: { back: `/invest/portfolios/${id}` } }) : ''}</li>`)}</ul>` : empty(ctx.t('common.no_data')))}
      ${mine ? html`<p class="row-actions">${postButton(ctx, `/invest/portfolios/${id}/archive`, ctx.t('common.archive'))}</p>` : ''}
      ${disclaimer(ctx)}`,
  }));
});

post('/invest/assets', { access: 'auth', module: 'invest' }, async (ctx) => {
  const source = ctx.body.price_source && registry.prices.has(ctx.body.price_source) ? ctx.body.price_source : 'manual';
  const taxType = ['ssf', 'rmf', 'thaiesg', 'other'].includes(ctx.body.tax_type ?? '') ? ctx.body.tax_type : null;
  await ctx.as((q) => q.query('insert into assets(owner_id, symbol, name, asset_class, currency, manual_valuation, price_source, tax_type) values (hearth_uid(),$1,$2,$3,$4,$5,$6,$7)', [
    text(ctx.body.symbol, 30, true).toUpperCase(), text(ctx.body.name, 80), oneOf(ctx.body.asset_class, ASSET_CLASSES),
    /^[A-Za-z]{3}$/.test(ctx.body.currency ?? '') ? ctx.body.currency.toUpperCase() : 'THB', ['real_estate', 'pvd', 'sso'].includes(ctx.body.asset_class), source, taxType]));
  return redirect(withFlash(ctx.body.back?.startsWith('/invest') ? ctx.body.back : '/invest', 'ok', 'saved'));
});

post('/invest/portfolios/:id/txns', { access: 'auth', module: 'invest' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const type = oneOf(ctx.body.type, INV_TYPES);
  const u = units(ctx.body.units, ['buy', 'sell', 'switch_in', 'switch_out', 'split', 'transfer_in', 'transfer_out'].includes(type));
  const amount = money(ctx.body.amount, { allowZero: true }) ?? 0n;
  const fee = money(ctx.body.fee) ?? 0n;
  const tax = money(ctx.body.tax) ?? 0n;
  const bucketId = uuidOrNull(ctx.body.bucket_id);
  await ctx.as(async (q) => {
    const pf = await q.one<any>('select owner_id, household_id from portfolios where id = $1 and owner_id = hearth_uid()', [id]);
    if (!pf) throw new HttpError(404);
    const asset = await q.one('select 1 from assets where id = $1 and owner_id = hearth_uid()', [requireUuid(ctx.body.asset_id)]);
    if (!asset) throw new HttpError(404);
    const price = u > 0n && amount > 0n ? divRound(amount * 1_000_000n * E8, u) : 0n; // price × 1e8 per unit (major units)
    const fxRate = /^\d{1,10}(\.\d{1,10})?$/.test((ctx.body.fx_rate ?? '').trim()) ? ctx.body.fx_rate.trim() : null;
    await q.query(`insert into investment_transactions(portfolio_id, asset_id, owner_id, household_id, type, date, units_e8, price_e8, amount, fee, tax, source_bucket_id, fx_rate, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,hearth_uid())`, [id, ctx.body.asset_id, pf.owner_id, pf.household_id, type, date(ctx.body.date, today()), u, price, amount, fee, tax, bucketId, fxRate]);
    if (price > 0n) await q.query(`insert into price_history(asset_id, owner_id, date, price_e8, source) values ($1, hearth_uid(), $2, $3, 'trade') on conflict (asset_id, date) do nothing`, [ctx.body.asset_id, date(ctx.body.date, today()), price]);
    // FR-BKT-02a: buying from the investing bucket reduces it automatically
    if (bucketId && type === 'buy' && ctx.prefs!.bucket_mode !== 'off') await bucketMove(q, ctx.user!.id, bucketId, -(amount + fee), 'invest');
  });
  return redirect(withFlash(`/invest/portfolios/${id}`, 'ok', 'saved'));
});

/** Confirm a pending DCA purchase with the units actually received (FR-INV-04). */
post('/invest/txns/:id/confirm', { access: 'auth', module: 'invest' }, async (ctx) => {
  const u = units(ctx.body.units);
  await ctx.as(async (q) => {
    const t = await q.one<any>('select it.*, it.date::text date, d.amount plan_amount from investment_transactions it left join dca_plans d on d.id = it.dca_plan_id where it.id = $1 and it.pending and it.owner_id = hearth_uid()', [requireUuid(ctx.params.id)]);
    if (!t) throw new HttpError(404);
    const amount = money(ctx.body.amount) ?? t.amount;
    const price = u > 0n ? divRound(amount * 1_000_000n * E8, u) : 0n;
    await q.query('update investment_transactions set pending = false, units_e8 = $2, amount = $3, price_e8 = $4 where id = $1', [t.id, u, amount, price]);
    if (price > 0n) await q.query(`insert into price_history(asset_id, owner_id, date, price_e8, source) values ($1, hearth_uid(), $2, $3, 'trade') on conflict (asset_id, date) do nothing`, [t.asset_id, t.date, price]);
  });
  return redirect(withFlash(ctx.body.back?.startsWith('/invest') ? ctx.body.back : '/invest', 'ok', 'saved'));
});

post('/invest/txns/:id/delete', { access: 'auth', module: 'invest' }, async (ctx) => {
  await ctx.as((q) => q.query('delete from investment_transactions where id = $1 and owner_id = hearth_uid()', [requireUuid(ctx.params.id)]));
  return redirect(ctx.body.back?.startsWith('/invest') ? ctx.body.back : '/invest');
});

post('/invest/prices', { access: 'auth', module: 'invest' }, async (ctx) => {
  const price = units(ctx.body.price);
  await ctx.as((q) => q.query(`insert into price_history(asset_id, owner_id, date, price_e8, source) select id, hearth_uid(), $2, $3, 'manual' from assets where id = $1 and owner_id = hearth_uid()
     on conflict (asset_id, date) do update set price_e8 = excluded.price_e8, source = 'manual'`, [requireUuid(ctx.body.asset_id), date(ctx.body.date, today()), price]));
  return redirect(withFlash(ctx.body.back?.startsWith('/invest') ? ctx.body.back : '/invest', 'ok', 'saved'));
});

post('/invest/portfolios/:id/archive', { access: 'auth', module: 'invest' }, async (ctx) => {
  await ctx.as((q) => q.query('update portfolios set archived = true where id = $1 and owner_id = hearth_uid()', [requireUuid(ctx.params.id)]));
  return redirect(withFlash('/invest', 'ok', 'saved'));
});

// ───────────── Allocation (FR-INV-16/17) ─────────────
get('/invest/allocation', { access: 'auth', module: 'invest' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const [pv, targets] = await Promise.all([ctx.as((q) => portfolioValues(q, 'mine', ctx.prefs!)), ctx.as((q) => q.query<any>('select asset_class, percent_e4 from allocation_targets where owner_id = hearth_uid()'))]);
  const values: Record<string, bigint> = {};
  for (const r of pv.rows) if (r.asset) values[r.asset.asset_class] = (values[r.asset.asset_class] ?? 0n) + r.valuation.marketValue;
  const tmap = Object.fromEntries(targets.map((t) => [t.asset_class, t.percent_e4]));
  const rb = rebalance(values, tmap);
  return htmlRes(page(ctx, {
    title: ctx.t('invest.allocation'),
    body: html`${nav(ctx)}
      <div class="grid2">
        ${card(ctx.t('invest.actual'), donut({ title: ctx.t('invest.actual'), summary: '', items: rb.rows.filter((r) => r.value > 0n).map((r) => ({ label: ctx.t(`invest.class.${r.assetClass}`), value: toMajorNumber(r.value), display: f.money(r.value) })) }))}
        ${card(ctx.t('invest.target'), targets.length ? donut({ title: ctx.t('invest.target'), summary: '', items: targets.map((t) => ({ label: ctx.t(`invest.class.${t.asset_class}`), value: t.percent_e4, display: `${inputRate(t.percent_e4)}%` })) }) : empty(ctx.t('invest.no_target')))}
      </div>
      ${card(ctx.t('invest.rebalance'), html`<div class="table-wrap"><table class="tbl"><thead><tr><th>${ctx.t('invest.asset_class')}</th><th class="num">${ctx.t('invest.actual')}</th><th class="num">${ctx.t('invest.target')}</th><th class="num">${ctx.t('invest.adjust')}</th></tr></thead>
        <tbody>${rb.rows.map((r) => html`<tr><td>${ctx.t(`invest.class.${r.assetClass}`)}</td><td class="num">${r.actualPercent.toFixed(1)}%</td><td class="num">${r.targetPercent.toFixed(1)}%</td><td class="num">${f.moneyHtml(r.difference, { sign: true })}</td></tr>`)}</tbody></table></div>
        <p class="note">${ctx.t('invest.rebalance_note')}</p>`)}
      ${card(ctx.t('invest.set_targets'), form(ctx, '/invest/allocation', html`<div class="grid4">${ASSET_CLASSES.map((c) => field(ctx.t(`invest.class.${c}`), rateInput(`t_${c}`, tmap[c] != null ? inputRate(tmap[c]) : '')))}</div><p class="note">${ctx.t('invest.targets_hint')}</p>`, { submit: ctx.t('common.save') }))}
      ${disclaimer(ctx)}`,
  }));
});

post('/invest/allocation', { access: 'auth', module: 'invest' }, async (ctx) => {
  const entries = ASSET_CLASSES.map((c) => [c, ctx.body[`t_${c}`] ? rate(ctx.body[`t_${c}`]) : 0] as const).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (entries.length && total !== 1_000_000) return redirect(withFlash('/invest/allocation', 'err', 'targets_sum'));
  await ctx.as(async (q) => {
    await q.query('delete from allocation_targets where owner_id = hearth_uid()');
    for (const [c, v] of entries) await q.query('insert into allocation_targets(owner_id, asset_class, percent_e4) values (hearth_uid(), $1, $2)', [c, v]);
  });
  return redirect(withFlash('/invest/allocation', 'ok', 'saved'));
});

// ───────────── Projection, retirement, DCA (FR-INV-04, 20, 21) ─────────────
get('/invest/plan', { access: 'auth', module: 'invest' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const p = ctx.prefs!;
  const qp = ctx.query;
  const [pv, dca, portfolios, assets] = await Promise.all([
    ctx.as((q) => portfolioValues(q, 'mine', p)),
    ctx.as((q) => q.query<any>('select d.*, d.next_date::text next_date, a.symbol, pf.name pname from dca_plans d join assets a on a.id = d.asset_id join portfolios pf on pf.id = d.portfolio_id where d.owner_id = hearth_uid() order by d.next_date')),
    ctx.as((q) => q.query<any>('select id, name from portfolios where not archived and owner_id = hearth_uid()')),
    ctx.as((q) => q.query<any>('select id, symbol from assets where owner_id = hearth_uid()')),
  ]);
  const years = intIn(qp.get('years') ?? '20', 1, 50, 20);
  const monthly = money(qp.get('monthly') ?? undefined) ?? p.invest_monthly_budget;
  const rates = { conservative: Number(qp.get('r1') ?? p.scenario_rates[0] ?? 3), moderate: Number(qp.get('r2') ?? p.scenario_rates[1] ?? 6), optimistic: Number(qp.get('r3') ?? p.scenario_rates[2] ?? 9) };
  for (const k of Object.keys(rates) as (keyof typeof rates)[]) if (!Number.isFinite(rates[k]) || rates[k] < -50 || rates[k] > 50) rates[k] = 0;
  const t0 = performance.now();
  const sc = scenarios(pv.value, monthly, years * 12, rates);
  const ms = performance.now() - t0;
  const step = 12;
  const idx = Array.from({ length: years }, (_, i) => (i + 1) * step - 1);
  const fm = (n: number) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact' }).format(n));
  const chart = lineChart({
    title: ctx.t('invest.projection'), summary: ctx.t('invest.projection'),
    labels: idx.map((i) => String(new Date().getFullYear() + Math.floor(i / 12) + 1 + (p.date_era === 'be' ? 543 : 0))),
    band: { lower: idx.map((i) => toMajorNumber(sc.conservative[i])), upper: idx.map((i) => toMajorNumber(sc.optimistic[i])), cls: 'c-inc' },
    series: [
      { name: ctx.t('invest.scenario.moderate'), cls: 'c-inc', values: idx.map((i) => toMajorNumber(sc.moderate[i])) },
      { name: ctx.t('invest.scenario.conservative'), cls: 'c-exp', dashed: true, values: idx.map((i) => toMajorNumber(sc.conservative[i])) },
      { name: ctx.t('invest.scenario.optimistic'), cls: 's2', dotted: true, values: idx.map((i) => toMajorNumber(sc.optimistic[i])) },
      { name: ctx.t('invest.contributed'), cls: 'c-net', values: idx.map((i) => toMajorNumber(sc.contributed[i])) },
    ],
    fmt: fm,
  });
  let retire: any = null;
  if (qp.get('age')) {
    retire = retirementPlan({
      currentAge: intIn(qp.get('age')!, 15, 90, 30), retireAge: intIn(qp.get('retire_age') ?? '60', 30, 100, 60), lifeExpectancy: intIn(qp.get('life') ?? '85', 50, 120, 85),
      monthlyExpenseToday: money(qp.get('expense') ?? undefined) ?? 3_000_000n, inflationPercent: Number(qp.get('inflation') ?? 3) || 0,
      returnBeforePercent: Number(qp.get('ret_before') ?? 6) || 0, returnAfterPercent: Number(qp.get('ret_after') ?? 4) || 0, currentSavings: pv.value,
    });
  }
  return htmlRes(page(ctx, {
    title: ctx.t('invest.plan'),
    body: html`${nav(ctx)}
      ${card(ctx.t('invest.projection'), html`<form method="get" action="/invest/plan" class="stack"><div class="grid4">
        ${field(ctx.t('invest.monthly_invest'), moneyInput('monthly', inputMoney(monthly)), { id: 'f-monthly' })}
        ${field(ctx.t('invest.years'), input({ name: 'years', type: 'number', min: 1, max: 50, value: years }), { id: 'f-years' })}
        ${field(ctx.t('invest.scenario.conservative') + ' %', input({ name: 'r1', inputmode: 'decimal', value: rates.conservative }), { id: 'f-r1' })}
        ${field(ctx.t('invest.scenario.moderate') + ' %', input({ name: 'r2', inputmode: 'decimal', value: rates.moderate }), { id: 'f-r2' })}
        ${field(ctx.t('invest.scenario.optimistic') + ' %', input({ name: 'r3', inputmode: 'decimal', value: rates.optimistic }), { id: 'f-r3' })}
        </div><div class="actions"><button class="btn">${ctx.t('common.calculate')}</button></div></form>
        ${chart}
        <section class="stats">${(['conservative', 'moderate', 'optimistic'] as const).map((k) => stat(ctx.t(`invest.scenario.${k}`), f.moneyHtml(sc[k][sc[k].length - 1]), `${rates[k]}%/${ctx.t('common.year')}`))}${stat(ctx.t('invest.contributed'), f.moneyHtml(sc.contributed[sc.contributed.length - 1]))}</section>
        <p class="note">${ctx.t('debt.calc_time', { ms: ms.toFixed(1) })}</p>`, { cls: 'span2' })}
      ${card(ctx.t('invest.retirement'), html`<form method="get" action="/invest/plan" class="stack"><div class="grid4">
        ${field(ctx.t('invest.age'), input({ name: 'age', type: 'number', min: 15, max: 90, value: qp.get('age') ?? 30, required: true }), { id: 'f-age' })}
        ${field(ctx.t('invest.retire_age'), input({ name: 'retire_age', type: 'number', min: 30, max: 100, value: qp.get('retire_age') ?? 60 }), { id: 'f-retire_age' })}
        ${field(ctx.t('invest.life'), input({ name: 'life', type: 'number', min: 50, max: 120, value: qp.get('life') ?? 85 }), { id: 'f-life' })}
        ${field(ctx.t('invest.expense_after'), moneyInput('expense', qp.get('expense') ?? '30000'), { id: 'f-expense', hint: ctx.t('invest.expense_after_hint') })}
        ${field(ctx.t('invest.inflation'), input({ name: 'inflation', inputmode: 'decimal', value: qp.get('inflation') ?? 3 }), { id: 'f-inflation' })}
        ${field(ctx.t('invest.ret_before'), input({ name: 'ret_before', inputmode: 'decimal', value: qp.get('ret_before') ?? 6 }), { id: 'f-ret_before' })}
        ${field(ctx.t('invest.ret_after'), input({ name: 'ret_after', inputmode: 'decimal', value: qp.get('ret_after') ?? 4 }), { id: 'f-ret_after' })}
        </div><div class="actions"><button class="btn">${ctx.t('common.calculate')}</button></div></form>
        ${retire ? html`<section class="stats">${stat(ctx.t('invest.nest_egg'), f.moneyHtml(retire.nestEgg), ctx.t('invest.in_years', { n: retire.yearsToRetire }))}${stat(ctx.t('invest.expense_then'), f.moneyHtml(retire.expenseAtRetirement))}${stat(ctx.t('invest.need_monthly'), f.moneyHtml(retire.monthlyRequired), undefined, 'warn')}${stat(ctx.t('invest.from_current'), f.moneyHtml(retire.projectedFromCurrent))}</section>` : ''}`)}
      ${card(ctx.t('invest.dca'), html`${dca.length ? html`<ul class="rows">${dca.map((d: any) => html`<li><span>${d.symbol} · ${d.pname} · ${ctx.t('invest.dca_day', { day: d.day_of_month })} · ${ctx.t('invest.next', { date: f.date(d.next_date) })}</span>${f.moneyHtml(d.amount)}${postButton(ctx, `/invest/dca/${d.id}/delete`, '×', { cls: 'sm link' })}</li>`)}</ul>` : html`<p class="note">${ctx.t('invest.dca_intro')}</p>`}
        ${portfolios.length && assets.length ? form(ctx, '/invest/dca', html`<div class="grid4">
          ${field(ctx.t('invest.portfolio_name'), select('portfolio_id', portfolios.map((x: any) => ({ value: x.id, label: x.name })), portfolios[0].id))}
          ${field(ctx.t('invest.asset'), select('asset_id', assets.map((x: any) => ({ value: x.id, label: x.symbol })), assets[0].id))}
          ${field(ctx.t('txn.amount'), moneyInput('amount', '', { required: true }), { id: 'f-dca-amount' })}
          ${field(ctx.t('invest.day_of_month'), input({ name: 'day', type: 'number', min: 1, max: 28, value: 1 }), { id: 'f-day' })}</div>`, { submit: ctx.t('common.add') }) : ''}`)}
      ${disclaimer(ctx)}`,
    wide: true,
  }));
});

post('/invest/dca', { access: 'auth', module: 'invest' }, async (ctx) => {
  const day = intIn(ctx.body.day, 1, 28, 1);
  const t = today();
  let next = `${t.slice(0, 7)}-${String(day).padStart(2, '0')}`;
  if (next < t) next = addMonths(next, 1);
  await ctx.as((q) => q.query(`insert into dca_plans(owner_id, portfolio_id, asset_id, amount, day_of_month, next_date)
     select hearth_uid(), p.id, a.id, $3, $4, $5 from portfolios p, assets a where p.id = $1 and a.id = $2 and p.owner_id = hearth_uid() and a.owner_id = hearth_uid()`,
    [requireUuid(ctx.body.portfolio_id), requireUuid(ctx.body.asset_id), money(ctx.body.amount, { required: true }), day, next]));
  return redirect(withFlash('/invest/plan', 'ok', 'saved'));
});

post('/invest/dca/:id/delete', { access: 'auth', module: 'invest' }, async (ctx) => {
  await ctx.as((q) => q.query('delete from dca_plans where id = $1 and owner_id = hearth_uid()', [requireUuid(ctx.params.id)]));
  return redirect('/invest/plan');
});

export const _v = valuation;
