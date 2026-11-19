/**
 * Debts (§4.4) and family debts (§4.8).
 */
import { get, post, htmlRes, redirect, withFlash, HttpError, type Ctx } from '../http/app.ts';
import { html, raw, type SafeHtml } from '../views/html.ts';
import { page, icon } from '../views/layout.ts';
import { field, input, moneyInput, rateInput, dateInput, select, form, postButton, empty, card, checkbox, stat, disclaimer, meter } from '../views/ui.ts';
import { makeFmt, inputMoney, inputRate, type Fmt } from '../views/format.ts';
import { lineChart, stackedBars } from '../views/charts.ts';
import { money, rate, date, optDate, text, oneOf, requireUuid, uuidOrNull, scope, cipher, cipherFor, shareTarget, activity, intIn, today, notify } from '../services/common.ts';
import { createDebt, createTransaction, bucketMove, DEBT_TYPES, INTEREST_METHODS } from '../services/finance.ts';
import { loadDebts, debtTerms, nextDue, debtOverview, emergencyStatus } from '../services/summary.ts';
import { simulate, whatIf, refinance, splitPayment, compareStrategies, minimumBudget, flatRate, debtServiceRatio, monthsBetween, toMajorNumber, addMonths, type PlanDebt, type Strategy } from '@hearth/engine';

function canSeeDetail(ctx: Ctx, d: any) {
  return d.owner_id === ctx.user!.id || d.visibility === 'full';
}

function debtFields(ctx: Ctx, d: any = {}, lookups: { members: any[]; buckets: any[] } = { members: [], buckets: [] }, creditor = '') {
  const shareOpts = ctx.households.filter((h) => h.role !== 'viewer').map((h) => ({ value: h.id, label: h.name }));
  return html`<div class="grid3">
    ${field(ctx.t('debt.name'), input({ name: 'name', value: d.name, required: true, maxlength: 80 }), { id: 'f-name' })}
    ${field(ctx.t('debt.type'), select('type', DEBT_TYPES.map((v) => ({ value: v, label: ctx.t(`debt.type.${v}`) })), d.type ?? 'personal_loan'))}
    ${field(ctx.t('debt.creditor'), input({ name: 'creditor', value: creditor, maxlength: 80 }), { id: 'f-creditor', hint: ctx.t('common.encrypted_hint') })}
    ${field(ctx.t('debt.principal'), moneyInput('principal', inputMoney(d.principal_original)), { id: 'f-principal', hint: ctx.t('debt.principal_hint') })}
    ${field(ctx.t('debt.balance'), moneyInput('balance', inputMoney(d.balance_current), { required: true }), { id: 'f-balance' })}
    ${field(ctx.t('debt.method'), select('method', INTEREST_METHODS.map((v) => ({ value: v, label: ctx.t(`debt.method.${v}`) })), d.interest_method ?? 'reducing'))}
    ${field(ctx.t('debt.rate'), rateInput('rate', inputRate(d.annual_rate_e4)), { id: 'f-rate', hint: ctx.t('debt.rate_hint') })}
    ${field(ctx.t('debt.payment'), moneyInput('payment', inputMoney(d.payment_amount)), { id: 'f-payment', hint: ctx.t('debt.payment_hint') })}
    ${field(ctx.t('debt.due_day'), input({ name: 'due_day', type: 'number', min: 1, max: 31, value: d.due_day }), { id: 'f-due_day' })}
    ${field(ctx.t('debt.start_date'), dateInput('start_date', d.start_date))}
    ${field(ctx.t('debt.term_months'), input({ name: 'term_months', type: 'number', min: 1, max: 600, value: d.term_months }), { id: 'f-term_months', hint: ctx.t('debt.term_hint') })}
    ${field(ctx.t('debt.plan_payoff'), dateInput('plan_payoff_date', d.plan_payoff_date), { hint: ctx.t('debt.plan_payoff_hint') })}
  </div>
  <details><summary>${ctx.t('debt.card_options')}</summary><div class="grid3">
    ${field(ctx.t('debt.min_percent'), rateInput('min_percent', d.min_payment_type === 'percent_of_balance' ? inputRate(Number(d.min_payment_value)) : ''), { hint: ctx.t('debt.min_percent_hint') })}
    ${field(ctx.t('debt.min_floor'), moneyInput('min_floor', inputMoney(d.min_payment_floor)), { id: 'f-min_floor' })}
    ${checkbox('daily_accrual', ctx.t('debt.daily_accrual'), !!d.daily_accrual)}
  </div></details>
  <details ${d.household_id || d.owner_member_id ? raw('open') : ''}><summary>${ctx.t('debt.family_options')}</summary><div class="grid3">
    ${shareOpts.length ? field(ctx.t('common.share_with'), select('household_id', shareOpts, d.household_id ?? '', { empty: ctx.t('common.private') })) : ''}
    ${field(ctx.t('debt.visibility'), select('visibility', ['private', 'summary', 'full'].map((v) => ({ value: v, label: ctx.t(`debt.visibility.${v}`) })), d.visibility ?? 'full'))}
    ${lookups.members.length ? field(ctx.t('debt.owner_member'), select('owner_member_id', lookups.members.map((m) => ({ value: m.id, label: `${m.display_name} (${m.hh})` })), d.owner_member_id ?? '', { empty: ctx.t('debt.owner_me') }), { hint: ctx.t('debt.owner_member_hint') }) : ''}
    ${lookups.members.length ? field(ctx.t('debt.lender_member'), select('lender_member_id', lookups.members.map((m) => ({ value: m.id, label: `${m.display_name} (${m.hh})` })), d.lender_member_id ?? '', { empty: '—' }), { hint: ctx.t('debt.lender_member_hint') }) : ''}
    ${lookups.buckets.length ? field(ctx.t('debt.bucket'), select('bucket_id', lookups.buckets.map((b) => ({ value: b.id, label: b.name })), d.bucket_id ?? '', { empty: '—' }), { hint: ctx.t('debt.bucket_hint') }) : ''}
    ${field(ctx.t('debt.guarantor'), input({ name: 'guarantor', value: d.guarantor, maxlength: 80 }), { id: 'f-guarantor', hint: ctx.t('common.optional') })}
    ${checkbox('receivable', ctx.t('debt.is_receivable'), !!d.is_receivable)}
  </div></details>`;
}

function parseDebt(ctx: Ctx) {
  const method = oneOf(ctx.body.method, INTEREST_METHODS);
  const balance = money(ctx.body.balance, { required: true, allowZero: true })!;
  const principal = money(ctx.body.principal) ?? balance;
  const rateE4 = method === 'none' ? 0 : rate(ctx.body.rate);
  const term = ctx.body.term_months ? intIn(ctx.body.term_months, 1, 600, 12) : null;
  let payment = money(ctx.body.payment) ?? 0n;
  if (!payment && method === 'flat' && term) payment = flatRate(principal, rateE4, term).installment;
  const minPct = ctx.body.min_percent ? rate(ctx.body.min_percent) : 0;
  let householdId = shareTarget(ctx, ctx.body.household_id);
  const visibility = oneOf(ctx.body.visibility, ['private', 'summary', 'full'] as const, 'full');
  if (visibility === 'private') householdId = null; // FR-FDEBT-07
  return {
    name: text(ctx.body.name, 80, true), type: oneOf(ctx.body.type, DEBT_TYPES), creditor: text(ctx.body.creditor, 80),
    principal, balance, method, rateE4, payment, dailyAccrual: ctx.body.daily_accrual === '1',
    minType: method === 'credit_card' && minPct ? 'percent_of_balance' : 'fixed', minValue: method === 'credit_card' && minPct ? BigInt(minPct) : 0n,
    minFloor: money(ctx.body.min_floor) ?? 0n, dueDay: ctx.body.due_day ? intIn(ctx.body.due_day, 1, 31, 1) : null,
    startDate: optDate(ctx.body.start_date), termMonths: term, visibility, householdId,
    ownerMemberId: uuidOrNull(ctx.body.owner_member_id), lenderMemberId: uuidOrNull(ctx.body.lender_member_id), bucketId: uuidOrNull(ctx.body.bucket_id), receivable: ctx.body.receivable === '1',
    guarantor: text(ctx.body.guarantor, 80) || null, planPayoffDate: optDate(ctx.body.plan_payoff_date),
  };
}

async function debtLookups(ctx: Ctx) {
  return ctx.as(async (q) => ({
    members: await q.query<any>(`select m.id, m.display_name, h.name hh from members m join households h on h.id = m.household_id where hearth_member_role(m.household_id) in ('owner','manager','member') order by h.name, m.display_name`),
    buckets: ctx.prefs!.bucket_mode !== 'off' ? await q.query<any>(`select id, name from buckets where not archived and type = 'debt' and owner_id = hearth_uid()`) : [],
  }));
}

function debtRow(ctx: Ctx, f: Fmt, d: any, s: ReturnType<typeof simulate> | undefined): SafeHtml {
  const detail = canSeeDetail(ctx, d);
  const paidPct = d.principal_original > 0n ? Math.max(0, Math.min(100, 100 - (toMajorNumber(d.balance_current) / toMajorNumber(d.principal_original)) * 100)) : 0;
  return html`<li class="debt-row">
    <a href="/debts/${d.id}"><strong>${d.name}</strong><small>${ctx.t(`debt.type.${d.type}`)}${detail ? html` · ${inputRate(d.annual_rate_e4)}% · ${ctx.t(`debt.method.${d.interest_method}`)}` : ''}${d.owner_member_name ? html` · ${icon('user')} ${d.owner_member_name}` : ''}${d.household_id ? html` · ${icon('users')}` : ''}</small></a>
    <span class="amt">${f.money(d.balance_current)}</span>
    ${meter(paidPct, 100, ctx.t('debt.paid_off_pct'), { optimum: 100 })}
    ${detail && s ? html`<small>${s.neverPaysOff ? html`<span class="neg">${ctx.t('debt.never')}</span>` : ctx.t('debt.payoff_on', { date: f.date(s.payoffDate), months: s.months })} · ${ctx.t('debt.payment_short', { amount: f.money(d.payment_amount) })}</small>` : ''}
  </li>`;
}

get('/debts', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const p = ctx.prefs!;
  const [ov, debts, receivables, lk, byMember] = await Promise.all([
    ctx.as((q) => debtOverview(q, ctx.view)),
    ctx.as((q) => loadDebts(q, ctx.view)),
    ctx.as((q) => loadDebts(q, ctx.view, { receivable: true })),
    debtLookups(ctx),
    ctx.households.length ? ctx.as((q) => q.query<any>(`select coalesce(m.display_name, $1) who, d.type, sum(d.balance_current)::bigint total from debts d left join members m on m.id = d.owner_member_id
       where d.closed_at is null and not d.is_receivable and ${scope(ctx.view, 'd')} group by 1, 2`, [ctx.user!.display_name || ctx.t('common.me')])) : Promise.resolve([]),
  ]);
  const dsr = debtServiceRatio(ov.monthlyPayments, p.monthly_income);
  const over = dsr > p.dsr_threshold_e4 / 1_000_000;
  let familyChart: SafeHtml | string = '';
  if (byMember.length) {
    const people = [...new Set(byMember.map((r) => r.who))];
    const types = [...new Set(byMember.map((r) => r.type))];
    familyChart = card(ctx.t('debt.by_member'), stackedBars({
      title: ctx.t('debt.by_member'), summary: ctx.t('debt.by_member'), labels: people,
      stacks: types.map((ty, i) => ({ name: ctx.t(`debt.type.${ty}`), cls: `s${i % 8}`, values: people.map((who) => toMajorNumber(byMember.find((r) => r.who === who && r.type === ty)?.total ?? 0n)) })),
      fmt: (n) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact' }).format(n)),
    }));
  }
  return htmlRes(page(ctx, {
    title: ctx.t('nav.debts'),
    actions: html`<a class="btn primary" href="/debts/plan">${icon('route')} ${ctx.t('debt.plan')}</a>`,
    body: html`
      <section class="stats">
        ${stat(ctx.t('debt.total'), f.moneyHtml(ov.total))}
        ${stat(ctx.t('debt.monthly_payments'), f.moneyHtml(ov.monthlyPayments), ctx.t('debt.interest_month', { amount: f.money(ov.monthlyInterest) }))}
        ${stat(ctx.t('dash.debt_free'), ov.total === 0n ? ctx.t('debt.none') : ov.neverPaysOff ? ctx.t('debt.never') : f.date(ov.debtFreeDate), undefined, ov.neverPaysOff ? 'bad' : undefined)}
        ${stat('DSR', p.monthly_income > 0n ? f.pct(dsr) : '—', p.monthly_income > 0n ? (over ? ctx.t('debt.dsr_over', { limit: f.pct(p.dsr_threshold_e4 / 1_000_000, 0) }) : ctx.t('debt.dsr_ok')) : html`<a href="/settings">${ctx.t('debt.dsr_need_income')}</a>`, over ? 'warn' : undefined)}
      </section>
      ${ov.neverPaysOff ? html`<p class="flash err" role="alert">${ctx.t('debt.never_alert')}</p>` : ''}
      ${card(ctx.t('debt.list'), debts.length ? html`<ul class="debt-list">${debts.map((d) => debtRow(ctx, f, d, ov.perDebt.get(d.id)))}</ul>` : empty(ctx.t('debt.none_yet')))}
      ${familyChart}
      ${receivables.length ? card(ctx.t('debt.receivables'), html`<ul class="rows">${receivables.map((d) => html`<li><a href="/debts/${d.id}">${d.name}</a>${f.moneyHtml(d.balance_current)}</li>`)}</ul>`) : ''}
      ${card(ctx.t('debt.add'), form(ctx, '/debts', debtFields(ctx, {}, lk), { submit: ctx.t('common.add') }))}
      ${disclaimer(ctx)}`,
  }));
});

post('/debts', { access: 'auth' }, async (ctx) => {
  const d = parseDebt(ctx);
  const c = cipher(ctx);
  await ctx.as(async (q) => {
    const id = await createDebt(q, ctx.user!.id, { ...d, creditorEnc: c.enc(d.creditor) });
    await activity(q, ctx, d.householdId, 'create', 'debt', id, d.name);
  });
  return redirect(withFlash('/debts', 'ok', 'saved'));
});

get('/debts/plan', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const { debts, plan, emg } = await ctx.as(async (q) => ({
    debts: await loadDebts(q, ctx.view),
    plan: await q.one<any>('select * from debt_plans where owner_id = hearth_uid()'),
    emg: await emergencyStatus(q, ctx.view, ctx.prefs!),
  }));
  const start = nextDue(1);
  const pd: PlanDebt[] = debts.map((d) => ({ ...debtTerms(d, d.rates, start), id: d.id, name: d.name }));
  const min = minimumBudget(pd, start);
  const budget = money(ctx.query.get('budget') ?? undefined) ?? (plan?.monthly_budget && plan.monthly_budget >= min ? plan.monthly_budget : min);
  const strategy: Strategy = (['snowball', 'avalanche', 'custom'] as const).includes(ctx.query.get('strategy') as any) ? (ctx.query.get('strategy') as Strategy) : plan?.strategy ?? 'avalanche';
  const order: string[] = plan?.custom_order?.length ? plan.custom_order : debts.map((d) => d.id);
  if (!pd.length) return htmlRes(page(ctx, { title: ctx.t('debt.plan'), body: empty(ctx.t('debt.none_yet'), html`<a class="btn" href="/debts">${ctx.t('debt.add')}</a>`) }));
  const t0 = performance.now();
  const cmp = compareStrategies(pd, budget, { customOrder: order, startDate: start });
  const ms = performance.now() - t0;
  const chosen = cmp[strategy];
  const horizon = Math.max(cmp.snowball.balanceSeries.length, cmp.avalanche.balanceSeries.length, cmp.custom.balanceSeries.length);
  const pick = Math.min(horizon, 360);
  const labels = Array.from({ length: pick }, (_, i) => f.month(addMonths(start, i).slice(0, 7)));
  const series = (['snowball', 'avalanche', 'custom'] as const).map((k, i) => ({ name: ctx.t(`debt.strategy.${k}`), cls: `s${i}`, dashed: i === 1, dotted: i === 2, values: Array.from({ length: pick }, (_, m) => (cmp[k].balanceSeries[m] != null ? toMajorNumber(cmp[k].balanceSeries[m]) : 0)) }));
  const fm = (n: number) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact' }).format(n));
  const lowEmergency = ctx.prefs!.emergency_first && emg.runway < 1 && budget > min;
  return htmlRes(page(ctx, {
    title: ctx.t('debt.plan'),
    body: html`
      ${card(ctx.t('debt.plan_settings'), html`<form method="get" action="/debts/plan" class="stack"><div class="grid3">
        ${field(ctx.t('debt.monthly_budget'), moneyInput('budget', inputMoney(budget), { required: true }), { id: 'f-budget', hint: ctx.t('debt.min_budget', { amount: f.money(min) }) })}
        ${field(ctx.t('debt.strategy'), select('strategy', ['avalanche', 'snowball', 'custom'].map((v) => ({ value: v, label: ctx.t(`debt.strategy.${v}`) })), strategy))}
        </div><div class="actions"><button class="btn">${ctx.t('debt.simulate')}</button></div></form>
        ${form(ctx, '/debts/plan', html`<input type="hidden" name="budget" value="${inputMoney(budget)}"><input type="hidden" name="strategy" value="${strategy}">`, { submit: ctx.t('debt.save_plan') })}`)}
      ${budget < min ? html`<p class="flash err" role="alert">${ctx.t('debt.budget_short', { amount: f.money(min - budget) })}</p>` : ''}
      ${lowEmergency ? html`<p class="flash warn">${ctx.t('emg.first_hint')}</p>` : ''}
      <section class="stats">
        ${(['avalanche', 'snowball', 'custom'] as const).map((k) => stat(ctx.t(`debt.strategy.${k}`), cmp[k].neverPaysOff ? ctx.t('debt.never') : f.date(cmp[k].payoffDate), html`${ctx.t('debt.months_n', { n: cmp[k].months })} · ${ctx.t('debt.interest_total', { amount: f.money(cmp[k].totalInterest) })}`, k === strategy ? 'ok' : undefined))}
      </section>
      ${card(ctx.t('debt.compare_chart'), lineChart({ title: ctx.t('debt.compare_chart'), summary: ctx.t('debt.compare_chart_sum'), labels, series, fmt: fm }), { cls: 'span2' })}
      ${card(ctx.t('debt.suggested_payments'), html`<div class="table-wrap"><table class="tbl"><thead><tr><th>${ctx.t('debt.name')}</th><th class="num">${ctx.t('debt.balance')}</th><th class="num">${ctx.t('debt.rate')}</th><th class="num">${ctx.t('debt.pay_this_month')}</th><th>${ctx.t('debt.payoff')}</th></tr></thead>
        <tbody>${chosen.debts.map((o) => { const d = debts.find((x) => x.id === o.id); return html`<tr><td>${o.name}</td><td class="num">${f.money(d.balance_current)}</td><td class="num">${inputRate(d.annual_rate_e4)}%</td><td class="num"><strong>${f.money(chosen.firstMonth[o.id] ?? 0n)}</strong></td><td>${o.payoffDate ? f.date(o.payoffDate) : '—'}</td></tr>`; })}</tbody></table></div>
        <p class="note">${ctx.t('debt.calc_time', { ms: ms.toFixed(1) })}</p>`)}
      ${strategy === 'custom' ? card(ctx.t('debt.custom_order'), form(ctx, '/debts/plan/order', html`<ol class="order-list">${order.map((id, i) => { const d = debts.find((x) => x.id === id); return d ? html`<li>${field(d.name, input({ name: `pos_${id}`, type: 'number', min: 1, max: 99, value: i + 1, id: `f-pos-${id}` }), { id: `f-pos-${id}` })}</li>` : ''; })}</ol>`, { submit: ctx.t('common.save') })) : ''}
      ${disclaimer(ctx)}`,
    wide: true,
  }));
});

post('/debts/plan', { access: 'auth' }, async (ctx) => {
  const budget = money(ctx.body.budget, { required: true })!;
  const strategy = oneOf(ctx.body.strategy, ['snowball', 'avalanche', 'custom'] as const);
  await ctx.as((q) => q.query(`insert into debt_plans(owner_id, strategy, monthly_budget) values (hearth_uid(), $1, $2)
    on conflict (owner_id) do update set strategy = excluded.strategy, monthly_budget = excluded.monthly_budget, updated_at = now()`, [strategy, budget]));
  return redirect(withFlash(`/debts/plan?strategy=${strategy}`, 'ok', 'saved'));
});

post('/debts/plan/order', { access: 'auth' }, async (ctx) => {
  const entries = Object.entries(ctx.body).filter(([k]) => k.startsWith('pos_')).map(([k, v]) => ({ id: requireUuid(k.slice(4)), pos: intIn(v, 1, 999, 999) })).sort((a, b) => a.pos - b.pos);
  await ctx.as((q) => q.query(`insert into debt_plans(owner_id, strategy, custom_order) values (hearth_uid(), 'custom', $1::uuid[])
    on conflict (owner_id) do update set custom_order = excluded.custom_order, strategy = 'custom', updated_at = now()`, [entries.map((e) => e.id)]));
  return redirect(withFlash('/debts/plan?strategy=custom', 'ok', 'saved'));
});

get('/debts/:id', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const f = makeFmt(ctx.prefs, ctx.lang);
  const data = await ctx.as(async (q) => {
    const d = await q.one<any>('select d.*, d.start_date::text start_date, d.plan_payoff_date::text plan_payoff_date, m.display_name owner_member_name from debts d left join members m on m.id = d.owner_member_id where d.id = $1', [id]);
    if (!d) throw new HttpError(404);
    return {
      d,
      rates: await q.query<any>('select id, from_date::text from_date, annual_rate_e4 from debt_rate_schedule where debt_id = $1 order by from_date', [id]),
      payments: await q.query<any>('select p.*, p.date::text date, m.display_name who from debt_payments p left join members m on m.id = p.paid_by_member_id where p.debt_id = $1 order by p.date desc, p.created_at desc limit 60', [id]),
      resp: await q.query<any>('select r.*, m.display_name from debt_responsibilities r join members m on m.id = r.member_id where r.debt_id = $1', [id]),
      byPayer: await q.query<any>(`select coalesce(m.display_name, '—') who, sum(p.amount)::bigint total from debt_payments p left join members m on m.id = p.paid_by_member_id where p.debt_id = $1 and p.balance_adjustment = 0 group by 1 order by 2 desc`, [id]),
      accounts: await q.query<any>('select id, name from accounts where not archived and owner_id = hearth_uid()'),
      members: d.household_id ? await q.query<any>('select id, display_name from members where household_id = $1 order by display_name', [d.household_id]) : [],
    };
  });
  const { d } = data;
  const lk = await debtLookups(ctx);
  if (!canSeeDetail(ctx, d)) {
    return htmlRes(page(ctx, { title: d.name, body: html`<section class="stats">${stat(ctx.t('debt.balance'), f.moneyHtml(d.balance_current))}${stat(ctx.t('debt.type'), ctx.t(`debt.type.${d.type}`))}</section><p class="note">${ctx.t('debt.summary_only')}</p>` }));
  }
  const c = await cipherFor(ctx, d.owner_id);
  const start = nextDue(d.due_day);
  const terms = debtTerms(d, data.rates, start);
  const extra = money(ctx.query.get('extra') ?? undefined) ?? 0n;
  const lump = money(ctx.query.get('lump') ?? undefined) ?? 0n;
  const lumpMonth = intIn(ctx.query.get('lump_month') ?? '0', 0, 600, 0);
  const wi = whatIf(terms, { extraMonthly: extra, lumpSum: lump, lumpSumMonth: lumpMonth, startDate: start });
  const base = wi.base;
  const showAll = ctx.query.get('all') === '1';
  const sched = showAll ? base.schedule : base.schedule.slice(0, 24);
  const fm = (n: number) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact' }).format(n));
  const n = Math.min(Math.max(base.schedule.length, wi.scenario.schedule.length), 360);
  const chart = lineChart({
    title: ctx.t('debt.balance_chart'), summary: ctx.t('debt.balance_chart'),
    labels: Array.from({ length: n }, (_, i) => f.month(addMonths(start, i).slice(0, 7))),
    series: [
      { name: ctx.t('debt.current_plan'), cls: 'c-exp', dashed: true, values: Array.from({ length: n }, (_, i) => (base.schedule[i] ? toMajorNumber(base.schedule[i].balance) : 0)) },
      ...(extra || lump ? [{ name: ctx.t('debt.with_extra'), cls: 'c-inc', values: Array.from({ length: n }, (_, i) => (wi.scenario.schedule[i] ? toMajorNumber(wi.scenario.schedule[i].balance) : 0)) }] : []),
    ],
    fmt: fm,
  });
  const refiRate = ctx.query.get('refi_rate');
  let refi: SafeHtml | string = '';
  if (refiRate) {
    const r = refinance(terms, { rateE4: rate(refiRate), payment: money(ctx.query.get('refi_payment') ?? undefined) ?? d.payment_amount, fees: money(ctx.query.get('refi_fees') ?? undefined) ?? 0n }, start);
    refi = html`<div class="result ${r.interestSaved > 0n ? 'ok' : 'bad'}"><p>${r.interestSaved > 0n ? ctx.t('debt.refi_saves', { amount: f.money(r.interestSaved), months: r.monthsSaved }) : ctx.t('debt.refi_costs', { amount: f.money(-r.interestSaved) })}</p></div>`;
  }
  let vsPlan: SafeHtml | string = '';
  if (d.plan_payoff_date && base.payoffDate) {
    const diff = monthsBetween(d.plan_payoff_date, base.payoffDate);
    vsPlan = html`<p class="flash ${diff > 0 ? 'warn' : 'ok'}">${diff > 0 ? ctx.t('debt.behind_plan', { n: diff }) : diff < 0 ? ctx.t('debt.ahead_plan', { n: -diff }) : ctx.t('debt.on_plan')}</p>`;
  }
  const flat = d.interest_method === 'flat' && d.term_months ? flatRate(d.principal_original, d.annual_rate_e4, d.term_months) : null;
  const canWrite = d.owner_id === ctx.user!.id || ctx.households.some((h) => h.id === d.household_id && h.role !== 'viewer');
  return htmlRes(page(ctx, {
    title: d.name,
    body: html`
      <section class="stats">
        ${stat(ctx.t('debt.balance'), f.moneyHtml(d.balance_current), html`${ctx.t('debt.of_principal', { amount: f.money(d.principal_original) })}`)}
        ${stat(ctx.t('debt.payoff'), base.neverPaysOff ? ctx.t('debt.never') : f.date(base.payoffDate), base.neverPaysOff ? ctx.t('debt.never_hint') : ctx.t('debt.months_n', { n: base.months }), base.neverPaysOff ? 'bad' : undefined)}
        ${stat(ctx.t('debt.interest_remaining'), f.moneyHtml(base.totalInterest))}
        ${stat(ctx.t('debt.rate'), `${inputRate(d.annual_rate_e4)}%`, flat ? ctx.t('debt.eir', { rate: flat.effectiveAnnualPercent.toFixed(2) }) : ctx.t(`debt.method.${d.interest_method}`))}
      </section>
      ${vsPlan}
      ${card(ctx.t('debt.whatif'), html`<form method="get" action="/debts/${id}" class="stack"><div class="grid3">
          ${field(ctx.t('debt.extra_monthly'), moneyInput('extra', extra ? inputMoney(extra) : ''), { id: 'f-extra' })}
          ${field(ctx.t('debt.lump_sum'), moneyInput('lump', lump ? inputMoney(lump) : ''), { id: 'f-lump' })}
          ${field(ctx.t('debt.lump_month'), input({ name: 'lump_month', type: 'number', min: 0, max: 600, value: lumpMonth }), { id: 'f-lump_month', hint: ctx.t('debt.lump_month_hint') })}
        </div><div class="actions"><button class="btn">${ctx.t('debt.simulate')}</button></div></form>
        ${extra || lump ? html`<div class="result ok"><p>${ctx.t('debt.whatif_result', { months: Number.isFinite(wi.monthsSaved) ? wi.monthsSaved : '∞', amount: f.money(wi.interestSaved), date: f.date(wi.scenario.payoffDate) })}</p></div>` : ''}
        ${chart}`, { cls: 'span2' })}
      ${card(ctx.t('debt.schedule'), html`<div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th>${ctx.t('txn.date')}</th><th class="num">${ctx.t('debt.payment')}</th><th class="num">${ctx.t('debt.interest')}</th><th class="num">${ctx.t('debt.principal_part')}</th><th class="num">${ctx.t('debt.balance')}</th></tr></thead>
        <tbody>${sched.map((r) => html`<tr><td>${r.month + 1}</td><td>${f.date(r.date)}</td><td class="num">${f.money(r.payment)}</td><td class="num">${f.money(r.interest)}</td><td class="num">${f.money(r.principal)}</td><td class="num">${f.money(r.balance)}</td></tr>`)}</tbody></table></div>
        ${!showAll && base.schedule.length > 24 ? html`<p><a href="/debts/${id}?all=1">${ctx.t('debt.show_all', { n: base.schedule.length })}</a></p>` : ''}`)}
      ${canWrite ? card(ctx.t('debt.record_payment'), form(ctx, `/debts/${id}/payments`, html`<div class="grid3">
        ${field(ctx.t('txn.amount'), moneyInput('amount', inputMoney(d.payment_amount), { required: true }), { id: 'f-amount' })}
        ${field(ctx.t('txn.date'), dateInput('date', today(), true))}
        ${field(ctx.t('debt.fee'), moneyInput('fee', ''), { id: 'f-fee' })}
        ${data.members.length ? field(ctx.t('debt.paid_by'), select('paid_by', data.members.map((m: any) => ({ value: m.id, label: m.display_name })), ctx.households.find((h) => h.id === d.household_id)?.member_id ?? '', { empty: '—' })) : ''}
        ${data.accounts.length ? field(ctx.t('debt.from_account'), select('account_id', data.accounts.map((a: any) => ({ value: a.id, label: a.name })), '', { empty: ctx.t('debt.no_txn') }), { hint: ctx.t('debt.from_account_hint') }) : ''}
        </div><p class="note">${ctx.t('debt.split_auto')}</p>`, { submit: ctx.t('debt.record_payment') })) : ''}
      ${card(ctx.t('debt.payments'), data.payments.length ? html`<ul class="rows">${data.payments.map((p: any) => html`<li><span>${f.date(p.date)}${p.who ? html` · ${p.who}` : ''}${p.balance_adjustment !== 0n ? html` · ${ctx.t('debt.adjustment')}` : html` · ${ctx.t('debt.split_line', { p: f.money(p.principal), i: f.money(p.interest) })}`}</span>
        ${f.moneyHtml(p.balance_adjustment !== 0n ? p.balance_adjustment : p.amount)}${canWrite ? postButton(ctx, `/debts/${id}/payments/${p.id}/delete`, '×', { cls: 'sm link', confirm: ctx.t('common.confirm_delete') }) : ''}</li>`)}</ul>` : empty(ctx.t('debt.no_payments')))}
      ${data.byPayer.length > 1 || data.resp.length ? card(ctx.t('debt.co_payers'), html`
        ${data.resp.length ? html`<ul class="rows">${data.resp.map((r: any) => html`<li><span>${r.display_name}</span><span>${r.share_percent_e4 != null ? `${inputRate(r.share_percent_e4)}%` : f.money(r.share_amount)}</span></li>`)}</ul>` : ''}
        ${data.byPayer.length ? html`<h3>${ctx.t('debt.paid_so_far')}</h3><ul class="rows">${data.byPayer.map((r: any) => html`<li><span>${r.who}</span>${f.moneyHtml(r.total)}</li>`)}</ul>` : ''}`) : ''}
      ${canWrite && data.members.length ? card(ctx.t('debt.add_co_payer'), form(ctx, `/debts/${id}/responsibility`, html`<div class="grid3">
        ${field(ctx.t('debt.member'), select('member_id', data.members.map((m: any) => ({ value: m.id, label: m.display_name })), '', { required: true }))}
        ${field(ctx.t('debt.share_percent'), rateInput('share_percent'))}${field(ctx.t('debt.share_amount'), moneyInput('share_amount'), { id: 'f-share_amount' })}</div>`, { submit: ctx.t('common.add') })) : ''}
      ${card(ctx.t('debt.refinance'), html`<form method="get" action="/debts/${id}" class="stack"><div class="grid3">
        ${field(ctx.t('debt.new_rate'), rateInput('refi_rate', refiRate ?? ''))}${field(ctx.t('debt.new_payment'), moneyInput('refi_payment', ctx.query.get('refi_payment') ?? inputMoney(d.payment_amount)), { id: 'f-refi_payment' })}${field(ctx.t('debt.refi_fees'), moneyInput('refi_fees', ctx.query.get('refi_fees') ?? ''), { id: 'f-refi_fees' })}
        </div><div class="actions"><button class="btn">${ctx.t('debt.compare')}</button></div></form>${refi}`)}
      ${card(ctx.t('debt.rate_changes'), html`${data.rates.length ? html`<ul class="rows">${data.rates.map((r: any) => html`<li><span>${ctx.t('debt.from_date', { date: f.date(r.from_date) })}</span><span>${inputRate(r.annual_rate_e4)}%</span>${canWrite ? postButton(ctx, `/debts/${id}/rates/${r.id}/delete`, '×', { cls: 'sm link' }) : ''}</li>`)}</ul>` : html`<p class="note">${ctx.t('debt.rate_changes_hint')}</p>`}
        ${canWrite ? form(ctx, `/debts/${id}/rates`, html`<div class="grid2">${field(ctx.t('debt.start_date'), dateInput('from_date', '', true))}${field(ctx.t('debt.rate'), rateInput('rate', '', true))}</div>`, { submit: ctx.t('common.add') }) : ''}`)}
      ${canWrite ? card(ctx.t('debt.update_balance'), form(ctx, `/debts/${id}/adjust`, html`<p class="note">${ctx.t('debt.update_balance_hint')}</p>${field(ctx.t('debt.statement_balance'), moneyInput('balance', inputMoney(d.balance_current), { required: true }), { id: 'f-adj-balance' })}`, { submit: ctx.t('common.save') })) : ''}
      ${d.owner_id === ctx.user!.id ? card(ctx.t('common.edit'), form(ctx, `/debts/${id}/edit`, debtFields(ctx, d, lk, c.dec(d.creditor_enc)), { submit: ctx.t('common.save') })) : ''}
      ${d.owner_id === ctx.user!.id ? html`<p class="row-actions">${postButton(ctx, `/debts/${id}/delete`, ctx.t('common.delete'), { cls: 'danger sm', confirm: ctx.t('common.confirm_delete') })}</p>` : ''}
      ${disclaimer(ctx)}`,
    wide: true,
  }));
});

post('/debts/:id/edit', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const d = parseDebt(ctx);
  const c = cipher(ctx);
  const r = await ctx.as((q) => q.query(`update debts set name=$2, type=$3, creditor_enc=$4, principal_original=$5, balance_current=$6, interest_method=$7, annual_rate_e4=$8, daily_accrual=$9, payment_amount=$10,
      min_payment_type=$11, min_payment_value=$12, min_payment_floor=$13, due_day=$14, start_date=$15, term_months=$16, visibility=$17, household_id=$18, owner_member_id=$19, bucket_id=$20, is_receivable=$21, guarantor=$22, plan_payoff_date=$23, lender_member_id=$24,
      closed_at = case when $6::bigint <= 0 then coalesce(closed_at, current_date) else null end
     where id = $1 and owner_id = hearth_uid() returning id`,
    [id, d.name, d.type, c.enc(d.creditor), d.principal, d.balance, d.method, d.rateE4, d.dailyAccrual, d.payment, d.minType, d.minValue, d.minFloor, d.dueDay, d.startDate, d.termMonths, d.visibility, d.householdId, d.ownerMemberId, d.bucketId, d.receivable, d.guarantor, d.planPayoffDate, d.lenderMemberId]));
  if (!r.length) throw new HttpError(404);
  return redirect(withFlash(`/debts/${id}`, 'ok', 'saved'));
});

/** Record a payment with automatic fee/interest/principal split (FR-DEBT-04, FR-FDEBT-03). */
post('/debts/:id/payments', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const amount = money(ctx.body.amount, { required: true })!;
  const fee = money(ctx.body.fee) ?? 0n;
  const day = date(ctx.body.date, today());
  const paidBy = uuidOrNull(ctx.body.paid_by);
  const accountId = uuidOrNull(ctx.body.account_id);
  let closed = false;
  let name = '';
  await ctx.as(async (q) => {
    const d = await q.one<any>('select * from debts where id = $1 for update', [id]);
    if (!d) throw new HttpError(404);
    name = d.name;
    const last = await q.one<{ date: string }>('select date::text date from debt_payments where debt_id = $1 and balance_adjustment = 0 order by date desc limit 1', [id]);
    const rates = await q.query<any>('select from_date::text from_date, annual_rate_e4 from debt_rate_schedule where debt_id = $1', [id]);
    const s = splitPayment(debtTerms(d, rates, day), d.balance_current, amount, day, last?.date ?? (d.start_date ? String(d.start_date) : null), fee);
    let txnId: string | null = null;
    if (accountId) {
      txnId = await createTransaction(q, ctx.user!.id, { kind: d.is_receivable ? 'income' : 'expense', amount, date: day, accountId, payee: d.name, householdId: null });
      if (d.bucket_id) await bucketMove(q, d.owner_id, d.bucket_id, -amount, 'spend', txnId);
    }
    await q.query(`insert into debt_payments(debt_id, owner_id, household_id, date, amount, principal, interest, fee, paid_by_member_id, transaction_id, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,hearth_uid())`, [id, d.owner_id, d.household_id, day, amount, s.principal, s.interest, s.fee, paidBy, txnId]);
    closed = s.newBalance <= 0n;
    await q.query('update debts set balance_current = $2, closed_at = case when $2::bigint <= 0 then $3::date else null end where id = $1', [id, s.newBalance, day]);
    await activity(q, ctx, d.household_id, 'payment', 'debt', id, d.name);
    if (closed) {
      const moved = await rollOver(q, d);
      await notify(q, ctx.user!.id, 'debt_closed', ctx.t('noti.debt_closed', { name: d.name }), moved ? ctx.t('noti.debt_rolled', { name: moved }) : ctx.t('noti.debt_closed_body', { amount: '' }), '/debts/plan');
    }
  });
  return redirect(withFlash(closed ? '/debts' : `/debts/${id}`, 'ok', closed ? 'debt_closed' : 'payment_saved'));
});

/**
 * FR-DEBT-17 snowball roll-over: when a debt is paid off, its debt-payment bucket's automatic allocation and any
 * money left in it move to the next open debt in the user's plan order (or to the first savings bucket).
 */
async function rollOver(q: import('../db/index.ts').Q, closed: any): Promise<string | null> {
  if (!closed.bucket_id) return null;
  const from = await q.one<any>('select id, balance, auto_fixed, auto_percent_e4 from buckets where id = $1', [closed.bucket_id]);
  if (!from) return null;
  const plan = await q.one<any>('select strategy, custom_order from debt_plans where owner_id = hearth_uid()');
  const open = await q.query<any>(`select id, name, bucket_id, annual_rate_e4, balance_current from debts where owner_id = hearth_uid() and closed_at is null and not is_receivable and id <> $1 and bucket_id is not null`, [closed.id]);
  const order = plan?.strategy === 'snowball' ? [...open].sort((a, b) => (a.balance_current < b.balance_current ? -1 : 1))
    : plan?.strategy === 'custom' ? [...open].sort((a, b) => (plan.custom_order.indexOf(a.id) + 1 || 999) - (plan.custom_order.indexOf(b.id) + 1 || 999))
    : [...open].sort((a, b) => b.annual_rate_e4 - a.annual_rate_e4);
  const next = order[0];
  const targetBucket = next?.bucket_id ?? (await q.one<any>(`select id from buckets where owner_id = hearth_uid() and type = 'savings' and not archived order by sort limit 1`))?.id;
  if (!targetBucket || targetBucket === from.id) return null;
  await q.query('update buckets set auto_fixed = coalesce(auto_fixed, 0) + coalesce($2::bigint, 0), auto_percent_e4 = coalesce(auto_percent_e4, $3) where id = $1', [targetBucket, from.auto_fixed, from.auto_percent_e4]);
  await q.query('update buckets set auto_fixed = null, auto_percent_e4 = null where id = $1', [from.id]);
  if (from.balance > 0n) {
    await bucketMove(q, closed.owner_id, from.id, 0n - (from.balance as bigint), 'rollover', null, closed.name);
    await bucketMove(q, closed.owner_id, targetBucket, from.balance, 'rollover', null, closed.name);
  }
  return next?.name ?? 'savings';
}

post('/debts/:id/payments/:pid/delete', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const pid = requireUuid(ctx.params.pid);
  await ctx.as(async (q) => {
    const p = await q.one<any>('delete from debt_payments where id = $1 and debt_id = $2 returning principal, balance_adjustment, transaction_id', [pid, id]);
    if (!p) throw new HttpError(404);
    await q.query('update debts set balance_current = balance_current + $2 - $3, closed_at = null where id = $1', [id, p.principal, p.balance_adjustment]);
    if (p.transaction_id) await q.query('delete from transactions where id = $1', [p.transaction_id]);
  });
  return redirect(withFlash(`/debts/${id}`, 'ok', 'deleted'));
});

/** Mixed balance mode (decision #4): user enters the real statement balance; the difference is stored. */
post('/debts/:id/adjust', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const bal = money(ctx.body.balance, { required: true, allowZero: true })!;
  await ctx.as(async (q) => {
    const d = await q.one<any>('select balance_current, owner_id, household_id from debts where id = $1', [id]);
    if (!d) throw new HttpError(404);
    const diff = bal - d.balance_current;
    if (diff === 0n) return;
    await q.query(`insert into debt_payments(debt_id, owner_id, household_id, date, amount, balance_adjustment, created_by) values ($1,$2,$3,current_date,$4,$5,hearth_uid())`, [id, d.owner_id, d.household_id, diff < 0n ? -diff : diff, diff]);
    await q.query('update debts set balance_current = $2, closed_at = case when $2::bigint <= 0 then current_date else null end where id = $1', [id, bal]);
  });
  return redirect(withFlash(`/debts/${id}`, 'ok', 'saved'));
});

post('/debts/:id/rates', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  await ctx.as((q) => q.query('insert into debt_rate_schedule(debt_id, owner_id, household_id, from_date, annual_rate_e4) select id, owner_id, household_id, $2, $3 from debts where id = $1', [id, date(ctx.body.from_date), rate(ctx.body.rate)]));
  return redirect(withFlash(`/debts/${id}`, 'ok', 'saved'));
});

post('/debts/:id/rates/:rid/delete', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  await ctx.as((q) => q.query('delete from debt_rate_schedule where id = $1 and debt_id = $2', [requireUuid(ctx.params.rid), id]));
  return redirect(`/debts/${id}`);
});

post('/debts/:id/responsibility', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const pct = ctx.body.share_percent ? rate(ctx.body.share_percent) : null;
  await ctx.as((q) => q.query(`insert into debt_responsibilities(debt_id, owner_id, household_id, member_id, share_percent_e4, share_amount)
     select d.id, d.owner_id, d.household_id, m.id, $3, $4 from debts d join members m on m.id = $2 and m.household_id = d.household_id where d.id = $1`, [id, requireUuid(ctx.body.member_id), pct, money(ctx.body.share_amount)]));
  return redirect(withFlash(`/debts/${id}`, 'ok', 'saved'));
});

post('/debts/:id/delete', { access: 'auth' }, async (ctx) => {
  const r = await ctx.as((q) => q.query('delete from debts where id = $1 and owner_id = hearth_uid() returning id', [requireUuid(ctx.params.id)]));
  if (!r.length) throw new HttpError(404);
  return redirect(withFlash('/debts', 'ok', 'deleted'));
});
