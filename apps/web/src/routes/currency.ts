/**
 * Exchange rates (Tools › Exchange rates): convert between currencies, see the latest rates for the currencies a
 * person uses or follows, update them from the FX plugin, and record one's own rate (bank / exchange booth).
 */
import { get, post, htmlRes, redirect, withFlash, HttpError, type Ctx } from '../http/app.ts';
import { html, raw, type SafeHtml } from '../views/html.ts';
import { page, icon, csrfField } from '../views/layout.ts';
import { field, input, moneyInput, select, card, postButton, form, dateInput } from '../views/ui.ts';
import { makeFmt } from '../views/format.ts';
import { lineChart } from '../views/charts.ts';
import { parseMoney, toMajorNumber, todayIso } from '@hearth/engine';
import { registry } from '../services/plugins.ts';
import { COMMON_CURRENCIES, isCurrency, fxProvider, latestRates, rateHistory, myCurrencies, refreshRates, mayRefresh } from '../services/fx.ts';

const num = (n: number, locale: string, max = 4) => n.toLocaleString(locale, { maximumFractionDigits: max, minimumFractionDigits: Math.min(2, max) });
const RATE_RE = /^\d{1,10}(\.\d{1,10})?$/;

get('/currency', { access: 'auth' }, async (ctx) => {
  const t = ctx.t;
  const p = ctx.prefs!;
  const f = makeFmt(p, ctx.lang);
  const main = p.currency;
  const qv = (k: string) => (ctx.query.get(k) ?? '').trim().toUpperCase();
  const mine = await ctx.as((q) => myCurrencies(q, main, p.fx_watch ?? []));
  const from = isCurrency(qv('from')) ? qv('from') : (mine[0] ?? (main === 'USD' ? 'EUR' : 'USD'));
  const to = isCurrency(qv('to')) ? qv('to') : main;
  const chartCur = isCurrency(qv('c')) && qv('c') !== main ? qv('c') : (mine[0] ?? from);
  const { rates, history } = await ctx.as(async (q) => ({
    rates: await latestRates(q, [...mine, from, to, chartCur], main),
    history: chartCur !== main ? await rateHistory(q, chartCur, main, 90) : [],
  }));
  const rateOf = (c: string) => (c === main ? 1 : rates.get(c)?.rate ?? null);
  const provider = fxProvider();
  const srcLabel = (s: string) => (s === 'personal' ? t('fx.src.personal') : s === 'manual' ? t('fx.src.admin') : registry.fx.get(s)?.name ?? s);
  const pickList = [...new Set([main, ...mine, ...COMMON_CURRENCIES])];
  const opts = pickList.map((c) => ({ value: c, label: c }));

  // ── converter ──
  const amountText = ctx.query.get('amount') ?? '';
  const amount = parseMoney(amountText);
  let converted: SafeHtml = html``;
  if (amountText.trim()) {
    const rf = rateOf(from), rt = rateOf(to);
    if (amount == null) converted = html`<p class="flash err" role="alert">${t('calc.invalid_input')}</p>`;
    else if (rf == null || rt == null) converted = html`<p class="flash warn" role="alert">${t('fx.no_rate', { cur: rf == null ? from : to })}</p>`;
    else {
      const value = (toMajorNumber(amount) * rf) / rt;
      const cross = rf / rt;
      const newest = [from, to].filter((c) => c !== main).map((c) => rates.get(c)!).sort((a, b) => a.date.localeCompare(b.date))[0];
      converted = html`<div class="fx-result" aria-live="polite">
        <span class="fx-from">${num(toMajorNumber(amount), f.locale, 2)} ${from} =</span>
        <strong class="fx-to">${f.privacy ? '•••' : num(value, f.locale, 2)} ${to}</strong>
        <span class="note">1 ${from} = ${num(cross, f.locale, 6)} ${to}${newest ? html` · ${t('fx.as_of', { date: f.date(newest.date), source: srcLabel(newest.source) })}` : ''}</span>
        ${to === main && value > 0 ? html`<a class="btn sm" href="/transactions/new?amount=${(Math.round(value * 100) / 100).toFixed(2)}">${icon('plus')} ${t('calc.use_as_txn')}</a>` : ''}
      </div>`;
    }
  }

  // ── rates table ──
  const rows = mine.map((c) => {
    const r = rates.get(c);
    const change = r?.prev ? (r.rate - r.prev) / r.prev : null;
    return html`<tr>
      <th scope="row"><a href="/currency?c=${c}#fx-chart">${c}</a>${(p.fx_watch ?? []).includes(c) ? html` <span class="tag">${t('fx.watching')}</span>` : ''}</th>
      <td class="num">${r ? html`<strong>${num(r.rate, f.locale)}</strong> ${main}` : html`<span class="neg">${t('fx.missing')}</span>`}</td>
      <td class="num">${change == null ? '–' : html`<span class="${change > 0 ? 'pos' : change < 0 ? 'neg' : ''}">${change > 0 ? '▲' : change < 0 ? '▼' : ''} ${(Math.abs(change) * 100).toFixed(2)}%</span>`}</td>
      <td>${r ? html`${f.date(r.date)}<small class="note"> · ${srcLabel(r.source)}</small>` : ''}</td>
      <td class="row-actions">${r?.personal ? postButton(ctx, '/currency/rate/delete', t('fx.remove_mine'), { cls: 'sm link', fields: { cur: c, date: r.date } }) : ''}
        ${(p.fx_watch ?? []).includes(c) ? postButton(ctx, '/currency/watch', t('fx.unwatch'), { cls: 'sm link', fields: { cur: c, op: 'remove' } }) : ''}</td>
    </tr>`;
  });

  const chart = history.length > 1 ? lineChart({
    title: t('fx.chart', { cur: chartCur, main }), summary: t('fx.chart_sum', { cur: chartCur, main, n: history.length }),
    labels: history.map((h) => f.date(h.date)), series: [{ name: `1 ${chartCur} → ${main}`, cls: 'c-net', values: history.map((h) => h.rate), area: true }],
    fmt: (v) => num(v, f.locale, v < 1 ? 4 : 2),
  }) : html`<p class="empty">${t('fx.chart_empty')}</p>`;

  return htmlRes(page(ctx, {
    title: t('nav.currency'),
    actions: provider ? html`<form method="post" action="/currency/refresh" class="inline">${csrfField(ctx)}<button class="btn primary">${icon('repeat')} ${t('fx.refresh')}</button></form>` : undefined,
    body: html`
      ${!provider ? html`<p class="flash warn">${ctx.user!.is_admin ? raw(t('fx.no_provider_admin')) : t('fx.no_provider')}</p>` : ''}
      <div class="fx-grid">
        ${card(t('fx.convert'), html`<form method="get" action="/currency" class="stack">
          ${field(t('fx.amount'), moneyInput('amount', amountText || '100', { required: true, id: 'f-fx-amount' }), { id: 'f-fx-amount' })}
          <div class="fx-pair">
            ${field(t('fx.from'), select('from', opts, from, { id: 'f-fx-from' }))}
            <a class="btn fx-swap" href="/currency?amount=${encodeURIComponent(amountText || '100')}&from=${to}&to=${from}" aria-label="${t('fx.swap')}" title="${t('fx.swap')}">⇄</a>
            ${field(t('fx.to'), select('to', opts, to, { id: 'f-fx-to' }))}
          </div>
          <div class="actions"><button class="btn primary">${t('fx.convert_btn')}</button></div>
        </form>${converted}`)}
        ${card(t('fx.rates', { main }), html`${mine.length ? html`<div class="table-wrap"><table class="tbl fx-table">
            <thead><tr><th scope="col">${t('common.currency')}</th><th scope="col" class="num">${t('fx.one_unit', { main })}</th><th scope="col" class="num">${t('fx.change')}</th><th scope="col">${t('fx.updated')}</th><th scope="col"><span class="sr-only">${t('fx.actions')}</span></th></tr></thead>
            <tbody>${rows}</tbody></table></div>` : html`<p class="empty">${t('fx.none_yet')}</p>`}
          <form method="post" action="/currency/watch" class="inline-form fx-add">${csrfField(ctx)}<input type="hidden" name="op" value="add">
            <label for="f-fx-watch" class="sr-only">${t('fx.add')}</label>
            ${select('cur', COMMON_CURRENCIES.filter((c) => c !== main && !mine.includes(c)).map((c) => ({ value: c, label: c })), null, { id: 'f-fx-watch' })}
            <button class="btn sm">${t('fx.add')}</button></form>`)}
      </div>
      <section class="card" id="fx-chart"><div class="card-head"><h2>${t('fx.chart', { cur: chartCur, main })}</h2></div>${chart}</section>
      ${card(t('fx.my_rate'), html`<p class="note">${t('fx.my_rate_intro')}</p>${form(ctx, '/currency/rate', html`<div class="grid3">
          ${field(t('common.currency'), select('cur', pickList.filter((c) => c !== main).map((c) => ({ value: c, label: c })), chartCur, { id: 'f-fx-mycur' }))}
          ${field(t('fx.my_rate_value', { main }), input({ name: 'rate', inputmode: 'decimal', pattern: '[0-9]*[.]?[0-9]{0,10}', required: true, placeholder: rateOf(chartCur)?.toFixed(4) ?? '', id: 'f-fx-rate' }), { id: 'f-fx-rate', hint: t('fx.my_rate_hint', { main }) })}
          ${field(t('txn.date'), dateInput('date', todayIso()))}
        </div>`, { submit: t('common.save') })}`)}`,
  }));
});

/** Update reference rates now for this person's currencies (shared table; cooled down per main currency). */
post('/currency/refresh', { access: 'auth' }, async (ctx) => {
  const p = ctx.prefs!;
  if (!fxProvider()) return redirect(withFlash('/currency', 'err', 'fx_no_provider'));
  if (!mayRefresh(p.currency)) return redirect(withFlash('/currency', 'err', 'fx_recent'));
  const mine = await ctx.as((q) => myCurrencies(q, p.currency, p.fx_watch ?? []));
  if (!mine.length) return redirect(withFlash('/currency', 'err', 'fx_nothing'));
  const r = await refreshRates(ctx.db, todayIso(), new Map([[p.currency, mine]]));
  return redirect(withFlash('/currency', r.failed && !r.updated ? 'err' : 'ok', r.failed && !r.updated ? 'fx_failed' : 'fx_updated'));
});

post('/currency/watch', { access: 'auth' }, async (ctx) => {
  const cur = (ctx.body.cur ?? '').toUpperCase();
  if (!isCurrency(cur) || cur === ctx.prefs!.currency) throw new HttpError(422, 'invalid');
  if (ctx.body.op === 'remove') await ctx.as((q) => q.query('update user_preferences set fx_watch = array_remove(fx_watch, $1) where user_id = hearth_uid()', [cur]));
  else await ctx.as((q) => q.query(`update user_preferences set fx_watch = case when $1 = any(fx_watch) or cardinality(fx_watch) >= 20 then fx_watch else fx_watch || $1::text end where user_id = hearth_uid()`, [cur]));
  return redirect(withFlash('/currency', 'ok', 'saved'));
});

/** Personal rate: 1 unit of `cur` = `rate` of the main currency, from `date`. */
post('/currency/rate', { access: 'auth' }, async (ctx) => {
  const main = ctx.prefs!.currency;
  const cur = (ctx.body.cur ?? '').toUpperCase();
  const rate = (ctx.body.rate ?? '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(ctx.body.date ?? '') && ctx.body.date <= todayIso() ? ctx.body.date : todayIso();
  if (!isCurrency(cur) || cur === main || !RATE_RE.test(rate) || !(Number(rate) > 0)) throw new HttpError(422, 'invalid');
  await ctx.as((q) => q.query(`insert into user_exchange_rates(owner_id, base, quote, date, rate) values (hearth_uid(), $1, $2, $3, $4)
    on conflict (owner_id, base, quote, date) do update set rate = excluded.rate`, [cur, main, date, rate]));
  return redirect(withFlash(`/currency?c=${cur}`, 'ok', 'saved'));
});

post('/currency/rate/delete', { access: 'auth' }, async (ctx) => {
  const cur = (ctx.body.cur ?? '').toUpperCase();
  if (!isCurrency(cur) || !/^\d{4}-\d{2}-\d{2}$/.test(ctx.body.date ?? '')) throw new HttpError(422, 'invalid');
  await ctx.as((q) => q.query('delete from user_exchange_rates where owner_id = hearth_uid() and base = $1 and quote = $2 and date = $3', [cur, ctx.prefs!.currency, ctx.body.date]));
  return redirect(withFlash('/currency', 'ok', 'saved'));
});
