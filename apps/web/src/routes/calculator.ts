/**
 * Calculator (Tools): an expression calculator with money functions, plus four guided money tools —
 * loan instalments, savings goal, VAT / withholding tax and splitting a bill.
 * Everything works as plain GET forms without JavaScript; calc.js adds live results, keypad and history.
 */
import { get, htmlRes, type Ctx } from '../http/app.ts';
import { html, raw, type SafeHtml } from '../views/html.ts';
import { page, icon } from '../views/layout.ts';
import { field, input, moneyInput, rateInput, select, card, tabs, disclaimer, checkbox } from '../views/ui.ts';
import { makeFmt, inputRate } from '../views/format.ts';
import { lineChart } from '../views/charts.ts';
import { parseMoney, parseRateE4, divRound, annuityPayment, flatRate, projectValue, toMajorNumber } from '@hearth/engine';
import { evaluate, CalcError, FUNCTION_GROUPS, formatNumber } from '../../public/calc.js';

const ERR_CODES = ['empty', 'syntax', 'unknown', 'args', 'div0', 'domain', 'never', 'reserved', 'too_long', 'too_complex', 'invalid'] as const;

function nav(ctx: Ctx): SafeHtml {
  const t = ctx.t;
  return tabs(ctx, [
    { href: '/calculator', label: t('calc.tab.calc') },
    { href: '/calculator/loan', label: t('calc.tab.loan') },
    { href: '/calculator/savings', label: t('calc.tab.savings') },
    { href: '/calculator/tax', label: t('calc.tab.tax') },
    { href: '/calculator/split', label: t('calc.tab.split') },
  ]);
}

const q = (ctx: Ctx, k: string) => (ctx.query.get(k) ?? '').trim();
const months = (ctx: Ctx, k: string, max = 600) => { const n = Number(q(ctx, k)); return Number.isInteger(n) && n >= 1 && n <= max ? n : null; };
/** Rate as percent ×10⁴ (6.5% → 65000), like the rest of Hearth; empty → fallback. */
const rateOf = (ctx: Ctx, k: string, fallback: number | null = null) => { const v = q(ctx, k); if (!v) return fallback; const r = parseRateE4(v); return r != null && r >= 0 && r <= 9_999_999 ? r : null; };
const moneyOf = (ctx: Ctx, k: string) => { const m = parseMoney(q(ctx, k)); return m != null && m >= 0n && m <= 100_000_000_000_000n ? m : null; };

function kv(rows: [string, SafeHtml | string, string?][]): SafeHtml {
  return html`<div class="kv calc-kv">${rows.map(([k, v, cls]) => html`<div class="${cls ?? ''}"><span>${k}</span><strong>${v}</strong></div>`)}</div>`;
}

// ───────────── Expression calculator ─────────────
get('/calculator', { access: 'auth' }, async (ctx) => {
  const t = ctx.t;
  const expr = (ctx.query.get('q') ?? '').slice(0, 500);
  let value: number | null = null;
  let error = '';
  if (expr.trim()) {
    try { value = evaluate(expr).value; } catch (e) { error = t(`calc.err.${e instanceof CalcError && (ERR_CODES as readonly string[]).includes(e.code) ? e.code : 'syntax'}`); }
  }
  const errAttrs = raw(ERR_CODES.map((c) => ` data-err-${c.replace(/_/g, '-')}="${t(`calc.err.${c}`).replace(/"/g, '&quot;')}"`).join(''));
  const keys = ['7', '8', '9', '/', '(', ')', '4', '5', '6', '*', '^', '%', '1', '2', '3', '-', '⌫', 'C', '0', '.', ';', '+', 'ans', '='];
  const label = (k: string) => ({ '/': '÷', '*': '×', '-': '−', '⌫': '⌫', C: 'C' } as Record<string, string>)[k] ?? k;
  const useHref = value != null && value !== 0 ? `/transactions/new?amount=${(Math.round(Math.abs(value) * 100) / 100).toFixed(2)}` : '';
  return htmlRes(page(ctx, {
    title: t('nav.calculator'),
    body: html`${nav(ctx)}
      <div class="calc-layout">
        <form method="get" action="/calculator" class="card calc" data-calc-page${errAttrs}>
          <label for="f-calc" class="sr-only">${t('calc.expr')}</label>
          <input id="f-calc" name="q" type="text" value="${expr}" class="calc-input" data-calc-input autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="500" placeholder="2,500 × 12 + 7%" autofocus aria-describedby="f-calc-hint">
          <div class="calc-result" aria-live="polite"><span class="calc-eq" aria-hidden="true">=</span><output for="f-calc" data-calc-out>${value != null ? formatNumber(value) : ''}</output></div>
          <p class="calc-err" role="alert" data-calc-err>${error}</p>
          <small id="f-calc-hint" class="hint">${t('calc.expr_hint')}</small>
          <div class="calc-keys" data-calc-keys hidden>${keys.map((k) => k === '='
            ? html`<button type="submit" class="btn primary">=</button>`
            : html`<button type="button" class="btn${/[0-9.]/.test(k) ? ' num' : ''}" data-key="${k}"${k === '⌫' ? raw(` aria-label="${t('calc.backspace')}"`) : k === 'C' ? raw(` aria-label="${t('calc.clear')}"`) : ''}>${label(k)}</button>`)}</div>
          <div class="actions"><a class="btn" href="${useHref || '/transactions/new'}" data-calc-use ${useHref ? '' : raw('hidden')}>${icon('plus')} ${t('calc.use_as_txn')}</a></div>
        </form>
        <section class="card calc-side" aria-labelledby="calc-hist-h" data-calc-side hidden>
          <div class="card-head"><h2 id="calc-hist-h">${t('calc.history')}</h2><button type="button" class="btn sm" data-calc-clear>${t('calc.clear_history')}</button></div>
          <ol class="calc-history" data-calc-history></ol>
          <p class="note">${t('calc.history_hint')}</p>
        </section>
      </div>
      ${card(t('calc.functions'), html`<p class="note">${t('calc.functions_hint')}</p>
        <div class="fn-groups">${FUNCTION_GROUPS.map(([group, fns]) => html`<section><h3>${t(`calc.group.${group}`)}</h3><dl class="fn-list">${fns.map(([name, args, example]) => html`
          <div><dt><code>${name}(${args})</code></dt><dd>${t(`calc.fn.${name}`)} <a href="/calculator?q=${encodeURIComponent(example)}" data-calc-example="${example}"><code>${example}</code></a></dd></div>`)}</dl></section>`)}</div>`)}`,
  }));
});

// ───────────── Loan / instalments ─────────────
get('/calculator/loan', { access: 'auth' }, async (ctx) => {
  const t = ctx.t;
  const f = makeFmt(ctx.prefs!, ctx.lang);
  const method = q(ctx, 'method') === 'flat' ? 'flat' : 'reducing';
  const p = moneyOf(ctx, 'principal'), r = rateOf(ctx, 'rate'), n = months(ctx, 'months');
  let result: SafeHtml = html``;
  if (ctx.query.has('principal')) {
    if (p == null || p === 0n || r == null || n == null) result = html`<p class="flash err" role="alert">${t('calc.invalid_input')}</p>`;
    else {
      const pay = method === 'flat' ? flatRate(p, r, n).installment : annuityPayment(p, r, n);
      const totalInterest = method === 'flat' ? flatRate(p, r, n).totalInterest : pay * BigInt(n) - p;
      const eff = method === 'flat' ? flatRate(p, r, n).effectiveAnnualPercent : r / 10_000;
      // remaining balance after each payment (flat rate: what is still owed on the contract)
      const balance: number[] = [];
      let b = toMajorNumber(p), owed = toMajorNumber(p + totalInterest);
      const m = r / 1_000_000 / 12, pm = toMajorNumber(pay);
      for (let i = 0; i <= n; i++) {
        balance.push(Math.max(0, Math.round((method === 'flat' ? owed : b) * 100) / 100));
        b = b * (1 + m) - pm; owed -= pm;
      }
      result = html`${kv([
        [t('calc.loan.payment'), f.moneyHtml(pay), 'big'],
        [t('calc.loan.total_interest'), f.moneyHtml(totalInterest)],
        [t('calc.loan.total_paid'), f.moneyHtml(p + totalInterest)],
        [t('calc.loan.effective'), f.privacy ? '•••' : `${eff.toFixed(2)}%`],
      ])}
      ${method === 'flat' ? html`<p class="note">${t('calc.loan.flat_note', { flat: inputRate(r), eff: eff.toFixed(2) })}</p>` : ''}
      ${lineChart({ title: t('calc.loan.balance_chart'), summary: t('calc.loan.balance_sum', { n }), labels: balance.map((_, i) => String(i)), series: [{ name: t('calc.loan.balance_chart'), cls: 'c-exp', values: balance, area: true }], fmt: (v) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v)) })}`;
    }
  }
  return htmlRes(page(ctx, {
    title: t('nav.calculator'),
    body: html`${nav(ctx)}<div class="grid2">
      ${card(t('calc.tab.loan'), html`<form method="get" action="/calculator/loan" class="stack"><div class="grid2">
        ${field(t('calc.loan.principal'), moneyInput('principal', q(ctx, 'principal') ? q(ctx, 'principal') : '', { required: true }), { id: 'f-principal' })}
        ${field(t('calc.loan.rate'), rateInput('rate', q(ctx, 'rate'), true), { hint: t('calc.rate_hint') })}
        ${field(t('calc.loan.months'), input({ name: 'months', type: 'number', min: 1, max: 600, value: q(ctx, 'months'), required: true, inputmode: 'numeric' }), { id: 'f-months' })}
        ${field(t('calc.loan.method'), select('method', [{ value: 'reducing', label: t('calc.loan.reducing') }, { value: 'flat', label: t('calc.loan.flat') }], method))}
        </div><div class="actions"><button class="btn primary">${t('common.calculate')}</button></div></form>`)}
      ${card(t('calc.result'), html`${result}${disclaimer(ctx)}`)}
    </div>`,
  }));
});

// ───────────── Savings goal ─────────────
get('/calculator/savings', { access: 'auth' }, async (ctx) => {
  const t = ctx.t;
  const f = makeFmt(ctx.prefs!, ctx.lang);
  const target = moneyOf(ctx, 'target'), start = moneyOf(ctx, 'start') ?? 0n, n = months(ctx, 'months'), r = rateOf(ctx, 'rate', 0);
  let result: SafeHtml = html``;
  if (ctx.query.has('target')) {
    if (target == null || target === 0n || n == null || r == null) result = html`<p class="flash err" role="alert">${t('calc.invalid_input')}</p>`;
    else if (start >= target) result = html`<p class="flash ok">${t('calc.sav.reached')}</p>`;
    else {
      const pct = r / 10_000, mr = pct / 100 / 12;
      const T = toMajorNumber(target), S = toMajorNumber(start);
      const grown = S * (1 + mr) ** n;
      const monthly = Math.max(0, mr === 0 ? (T - S) / n : ((T - grown) * mr) / ((1 + mr) ** n - 1));
      const monthlySat = BigInt(Math.ceil(monthly * 100)); // round up so the goal is reached
      const values = projectValue(start, monthlySat, pct, n).map(toMajorNumber);
      const deposited = values.map((_, i) => S + toMajorNumber(monthlySat) * (i + 1));
      const final = values[values.length - 1] ?? S;
      const fmt = (v: number) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v));
      result = html`${kv([
        [t('calc.sav.monthly'), f.moneyHtml(monthlySat), 'big'],
        [t('calc.sav.deposited'), f.moneyHtml(BigInt(Math.round((S + toMajorNumber(monthlySat) * n) * 100)))],
        [t('calc.sav.growth'), f.moneyHtml(BigInt(Math.round((final - S - toMajorNumber(monthlySat) * n) * 100)))],
        [t('calc.sav.final'), f.moneyHtml(BigInt(Math.round(final * 100)))],
      ])}
      ${lineChart({ title: t('calc.sav.chart'), summary: t('calc.sav.chart_sum', { n }), labels: values.map((_, i) => String(i + 1)), series: [
        { name: t('calc.sav.value'), cls: 'c-inc', values, area: true },
        { name: t('calc.sav.deposited'), cls: 'c-net', values: deposited, dashed: true },
      ], fmt })}`;
    }
  }
  return htmlRes(page(ctx, {
    title: t('nav.calculator'),
    body: html`${nav(ctx)}<div class="grid2">
      ${card(t('calc.tab.savings'), html`<form method="get" action="/calculator/savings" class="stack"><div class="grid2">
        ${field(t('calc.sav.target'), moneyInput('target', q(ctx, 'target'), { required: true }), { id: 'f-target' })}
        ${field(t('calc.sav.start'), moneyInput('start', q(ctx, 'start')), { id: 'f-start' })}
        ${field(t('calc.sav.months'), input({ name: 'months', type: 'number', min: 1, max: 600, value: q(ctx, 'months'), required: true, inputmode: 'numeric' }), { id: 'f-months' })}
        ${field(t('calc.sav.rate'), rateInput('rate', q(ctx, 'rate')), { hint: t('calc.sav.rate_hint') })}
        </div><div class="actions"><button class="btn primary">${t('common.calculate')}</button></div></form>`)}
      ${card(t('calc.result'), html`${result}${disclaimer(ctx)}`)}
    </div>`,
  }));
});

// ───────────── VAT and withholding tax ─────────────
get('/calculator/tax', { access: 'auth' }, async (ctx) => {
  const t = ctx.t;
  const f = makeFmt(ctx.prefs!, ctx.lang);
  const mode = q(ctx, 'mode') === 'inclusive' ? 'inclusive' : 'exclusive';
  const amount = moneyOf(ctx, 'amount'), vatE4 = rateOf(ctx, 'vat', 70_000), whtE4 = rateOf(ctx, 'wht', 0);
  const M = 1_000_000n;
  let result: SafeHtml = html``;
  if (ctx.query.has('amount')) {
    if (amount == null || vatE4 == null || whtE4 == null || vatE4 > 1_000_000 || whtE4 > 1_000_000) result = html`<p class="flash err" role="alert">${t('calc.invalid_input')}</p>`;
    else {
      const base = mode === 'inclusive' ? divRound(amount * M, M + BigInt(vatE4)) : amount;
      const vat = mode === 'inclusive' ? amount - base : divRound(base * BigInt(vatE4), M);
      const total = base + vat;
      const wht = divRound(base * BigInt(whtE4), M); // withholding tax is on the amount before VAT
      result = kv([
        [t('calc.tax.base'), f.moneyHtml(base)],
        [t('calc.tax.vat', { rate: inputRate(vatE4) }), f.moneyHtml(vat)],
        [t('calc.tax.total'), f.moneyHtml(total)],
        [t('calc.tax.wht', { rate: inputRate(whtE4) }), f.moneyHtml(wht)],
        [t('calc.tax.net'), f.moneyHtml(total - wht), 'big'],
      ]);
    }
  }
  return htmlRes(page(ctx, {
    title: t('nav.calculator'),
    body: html`${nav(ctx)}<div class="grid2">
      ${card(t('calc.tab.tax'), html`<form method="get" action="/calculator/tax" class="stack">
        ${field(t('calc.tax.amount'), moneyInput('amount', q(ctx, 'amount'), { required: true }), { id: 'f-amount' })}
        <fieldset class="seg" role="radiogroup" aria-label="${t('calc.tax.mode')}">
          ${(['exclusive', 'inclusive'] as const).map((m) => html`<label><input type="radio" name="mode" value="${m}" ${raw(mode === m ? 'checked' : '')}><span>${t(`calc.tax.${m}`)}</span></label>`)}
        </fieldset>
        <div class="grid2">
          ${field(t('calc.tax.vat_rate'), rateInput('vat', q(ctx, 'vat') || '7'))}
          ${field(t('calc.tax.wht_rate'), select('wht', ['0', '1', '2', '3', '5', '10', '15'].map((v) => ({ value: v, label: v === '0' ? t('calc.tax.no_wht') : `${v}%` })), q(ctx, 'wht') || '0'), { hint: t('calc.tax.wht_hint') })}
        </div>
        <div class="actions"><button class="btn primary">${t('common.calculate')}</button></div></form>`)}
      ${card(t('calc.result'), result)}
    </div>`,
  }));
});

// ───────────── Split a bill ─────────────
get('/calculator/split', { access: 'auth' }, async (ctx) => {
  const t = ctx.t;
  const f = makeFmt(ctx.prefs!, ctx.lang);
  const total = moneyOf(ctx, 'total'), people = months(ctx, 'people', 100), service = rateOf(ctx, 'service', 0), addVat = q(ctx, 'vat') === '1';
  const M = 1_000_000n;
  let result: SafeHtml = html``;
  if (ctx.query.has('total')) {
    if (total == null || total === 0n || people == null || service == null || service > 1_000_000) result = html`<p class="flash err" role="alert">${t('calc.invalid_input')}</p>`;
    else {
      const svc = divRound(total * BigInt(service), M);
      const vat = addVat ? divRound((total + svc) * 70_000n, M) : 0n; // Thai restaurants: VAT 7% on food + service
      const grand = total + svc + vat;
      const each = (grand + BigInt(people) - 1n) / BigInt(people); // round up to the satang so nobody is short
      result = html`${kv([
        [t('calc.split.service_amt'), f.moneyHtml(svc)],
        [t('calc.split.vat_amt'), f.moneyHtml(vat)],
        [t('calc.split.grand'), f.moneyHtml(grand)],
        [t('calc.split.each', { n: people }), f.moneyHtml(each), 'big'],
      ])}${each * BigInt(people) > grand ? html`<p class="note">${t('calc.split.rounding', { amount: f.money(each * BigInt(people) - grand) })}</p>` : ''}`;
    }
  }
  return htmlRes(page(ctx, {
    title: t('nav.calculator'),
    body: html`${nav(ctx)}<div class="grid2">
      ${card(t('calc.tab.split'), html`<form method="get" action="/calculator/split" class="stack"><div class="grid2">
        ${field(t('calc.split.total'), moneyInput('total', q(ctx, 'total'), { required: true }), { id: 'f-total' })}
        ${field(t('calc.split.people'), input({ name: 'people', type: 'number', min: 1, max: 100, value: q(ctx, 'people') || '2', required: true, inputmode: 'numeric' }), { id: 'f-people' })}
        ${field(t('calc.split.service'), rateInput('service', q(ctx, 'service')), { hint: t('calc.split.service_hint') })}
        </div>${checkbox('vat', t('calc.split.vat'), addVat)}
        <div class="actions"><button class="btn primary">${t('common.calculate')}</button></div></form>`)}
      ${card(t('calc.result'), result)}
    </div>`,
  }));
});
