/**
 * Dashboard (§4.9). Summary numbers are in the first HTML response (NFR-PERF-06); charts are inline SVG.
 * Cards for modules the user turned off are not rendered at all.
 */
import { get, post, htmlRes, redirect, safeNext } from '../http/app.ts';
import { html, type SafeHtml } from '../views/html.ts';
import { page, icon } from '../views/layout.ts';
import { card, stat, empty, meter } from '../views/ui.ts';
import { makeFmt } from '../views/format.ts';
import { barChart, donut, lineChart, ring, thresholdBar } from '../views/charts.ts';
import { currentCycle, totals, monthlySeries, expenseByCategory, netWorth, emergencyStatus, debtOverview, portfolioValues } from '../services/summary.ts';
import { savingsRate, healthScore, tierFor, goalProgress, addMonths, todayIso, toMajorNumber, addDays, debtServiceRatio } from '@hearth/engine';
import { scope, BUCKETS_JOINED } from '../services/common.ts';
import { mailEnabled } from '../services/mail.ts';

export const DASH_CARDS = ['networth', 'month', 'emergency', 'debt', 'buckets', 'invest', 'goals', 'bills', 'health', 'charts'] as const;

get('/', { access: 'auth' }, async (ctx) => {
  const p = ctx.prefs!;
  const f = makeFmt(p, ctx.lang);
  const t = ctx.t;
  const view = ctx.view;
  const cyc = currentCycle(p);
  const today = todayIso();
  const hidden = new Set(p.dashboard_hidden);
  const fm = (n: number) => f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

  const data = await ctx.as(async (q) => {
    const [tot, series, cats, nw, emg, debts, buckets, goals, bills, snaps] = [
      await totals(q, view, cyc.start, cyc.end),
      await monthlySeries(q, view, p, 12),
      await expenseByCategory(q, view, cyc.start, cyc.end),
      await netWorth(q, view, p),
      await emergencyStatus(q, view, p),
      await debtOverview(q, view),
      p.bucket_mode !== 'off' ? await q.query<any>(`select id, name, type, balance, monthly_target, color from buckets where not archived and ${scope(view)} and ${BUCKETS_JOINED} order by sort, created_at`) : [],
      await q.query<any>(`select g.*, g.created_at::date::text started, coalesce((select sum(amount) from goal_contributions c where c.goal_id = g.id),0)::bigint saved,
          coalesce((select sum(amount) from goal_contributions c where c.goal_id = g.id and c.date >= $1),0)::bigint recent
          from goals g where not g.archived and ${scope(view, 'g')} order by g.priority, g.created_at limit 6`, [addMonths(today, -3)]),
      await q.query<any>(`select name, kind, amount, next_date::text next_date from recurring_rules where active and next_date <= $1 and ${scope(view)} order by next_date limit 6`, [addDays(today, 30)]),
      await q.query<any>(`select date::text date, liabilities from net_worth_snapshots where owner_id = hearth_uid() and date >= $1 order by date`, [addMonths(today, -12)]),
    ];
    const inv = p.investment_enabled ? await portfolioValues(q, view, p) : null;
    const accountsTotal = p.bucket_mode === 'full' ? (await q.one<{ s: bigint }>(`select coalesce(sum(balance),0)::bigint s from accounts where not archived and type <> 'credit_card' and type <> 'investment' and owner_id = hearth_uid()`))!.s : 0n;
    const bucketsTotal = (buckets as any[]).filter((b) => true).reduce((s, b) => s + b.balance, 0n);
    return { tot, series, cats, nw, emg, debts, buckets, goals, bills, snaps, inv, toAllocate: accountsTotal - bucketsTotal };
  });

  const { tot, nw, emg, debts } = data;
  const left = tot.income - tot.expense;
  const sr = savingsRate(tot.income, tot.expense);
  const tier = tierFor(emg.runway);
  const income = tot.income > 0n ? tot.income : p.monthly_income;
  // DSR uses the configured monthly income (same as /debts) so the two pages agree; fall back to this cycle's income.
  const dsr = debtServiceRatio(debts.monthlyPayments, p.monthly_income > 0n ? p.monthly_income : income);
  const health = healthScore({ monthlyIncome: income, monthlyExpense: tot.expense, monthlyDebtPayments: debts.monthlyPayments, emergencyRunwayMonths: emg.runway, liquidAssets: nw.liquid, netWorth: nw.netWorth });

  const cards: SafeHtml[] = [];
  // ── Summary stats ──
  const stats: SafeHtml[] = [];
  if (!hidden.has('networth')) stats.push(stat(t('dash.net_worth'), f.moneyHtml(nw.netWorth), html`${t('dash.assets')} ${f.money(nw.assets)} · ${t('dash.liabilities')} ${f.money(nw.liabilities)}`, nw.netWorth < 0n ? 'bad' : undefined));
  if (p.bucket_mode === 'full') stats.push(stat(t('bucket.to_allocate'), f.moneyHtml(data.toAllocate), data.toAllocate !== 0n ? html`<a href="/buckets">${t('bucket.allocate_now')}</a>` : t('bucket.all_allocated'), data.toAllocate !== 0n ? 'warn' : 'ok'));
  if (p.investment_enabled && data.inv && !hidden.has('invest')) stats.push(stat(t('dash.portfolio'), f.moneyHtml(data.inv.value), html`${t('invest.unrealized')} ${f.moneyHtml(data.inv.unrealized, { sign: true })}`));
  // Hero: the one number a family checks most — what is left to spend this cycle, and at what pace.
  if (!hidden.has('month')) {
    const daysLeft = Math.max(1, Math.round((Date.parse(cyc.end) - Date.parse(today)) / 86_400_000) + 1);
    const spent = tot.income > 0n ? Number((tot.expense * 1000n) / tot.income) / 1000 : 0;
    const spentPct = f.privacy ? '•••' : f.pct(spent);
    const perDay = left > 0n ? left / BigInt(daysLeft) : 0n;
    const inc = toMajorNumber(tot.income);
    cards.push(html`<section class="hero" aria-label="${t('dash.left_to_spend')}">
      <div class="hero-main">
        <span class="hero-label">${t('dash.left_to_spend')} · ${f.date(cyc.start)} – ${f.date(cyc.end)}</span>
        <strong class="hero-amount ${left < 0n ? 'neg' : ''}">${f.moneyHtml(left)}<small>${t('dash.of_income', { amount: f.money(tot.income) })}</small></strong>
        ${tot.income > 0n ? meter(toMajorNumber(tot.expense), inc, t('dash.spent_pct', { pct: spentPct }), { low: inc * 0.7, high: inc * 0.9, optimum: 0 }) : ''}
        <div class="hero-sub"><span>${left < 0n ? t('dash.overspent', { amount: f.money(-left) }) : t('dash.spent_pct', { pct: spentPct })}</span><span>${t('dash.days_left', { n: daysLeft, amount: f.money(perDay) })}</span></div>
      </div>
      <div class="tiles">
        <div class="tile inc"><span>${t('dash.income_month')}</span><strong>${f.moneyHtml(tot.income)}</strong></div>
        <div class="tile exp"><span>${t('dash.expense_month')}</span><strong>${f.moneyHtml(tot.expense)}</strong></div>
        <div class="tile" title="${t('dash.savings_rate_hint')}"><span>${t('dash.savings_rate')}</span><strong>${f.privacy ? '•••' : f.pct(sr)}</strong></div>
      </div>
    </section>`);
  }
  if (!hidden.has('emergency')) stats.push(stat(t('dash.runway'), Number.isFinite(emg.runway) ? t('common.months', { n: f.num(emg.runway) }) : '∞', t(`emg.tier.${tier}`), tier === 'secure' ? 'ok' : tier === 'none' ? 'bad' : 'warn'));
  if (!hidden.has('debt')) stats.push(stat(t('dash.debt_free'), debts.total === 0n ? t('debt.none') : debts.neverPaysOff ? t('debt.never') : f.date(debts.debtFreeDate), debts.total > 0n ? html`${t('debt.total')} ${f.money(debts.total)} · DSR ${f.pct(dsr)}` : '', debts.neverPaysOff ? 'bad' : dsr > p.dsr_threshold_e4 / 1_000_000 ? 'warn' : undefined));
  if (!hidden.has('health')) stats.push(stat(t('dash.health'), `${health.score}/100`, html`<a href="/reports/health">${t('common.details')}</a>`, health.score >= 70 ? 'ok' : health.score >= 40 ? 'warn' : 'bad'));
  cards.push(html`<section class="stats" aria-label="${t('dash.summary')}">${stats}</section>`);

  if (!hidden.has('charts')) {
    // DASH-01
    const s = data.series;
    cards.push(card(t('dash.chart.income_expense'), barChart({
      title: t('dash.chart.income_expense'), summary: t('dash.chart.income_expense_sum'),
      labels: s.map((m) => f.monthShort(m.key)),
      bars: [{ name: t('txn.kind.income'), cls: 'c-inc', values: s.map((m) => toMajorNumber(m.income)) }, { name: t('txn.kind.expense'), cls: 'c-exp', values: s.map((m) => toMajorNumber(m.expense)) }],
      line: { name: t('dash.left'), cls: 'c-net', values: s.map((m) => toMajorNumber(m.income - m.expense)) },
      fmt: fm, links: s.map((m) => `/transactions?from=${m.start}&to=${m.end}`),
    }), { cls: 'span2', action: html`<a href="/analytics">${t('nav.analytics')}</a>` }));
    // DASH-02
    cards.push(card(t('dash.chart.by_category'), data.cats.length ? donut({
      title: t('dash.chart.by_category'), summary: t('dash.chart.by_category_sum'),
      items: data.cats.slice(0, 7).map((c) => ({ label: c.name ?? t('txn.uncategorized'), value: toMajorNumber(c.total), display: f.money(c.total) }))
        .concat(data.cats.length > 7 ? [{ label: t('common.other'), value: toMajorNumber(data.cats.slice(7).reduce((a, c) => a + c.total, 0n)), display: f.money(data.cats.slice(7).reduce((a, c) => a + c.total, 0n)) }] : []),
      center: f.money(tot.expense, { compact: true }),
    }) : empty(t('dash.no_expense'), html`<a class="btn" href="/transactions/new">${t('txn.add')}</a>`)));
  }

  // DASH-05 buckets
  if (p.bucket_mode !== 'off' && !hidden.has('buckets')) {
    cards.push(card(t('nav.buckets'), data.buckets.length ? html`<ul class="bucket-list">${data.buckets.map((b: any) => html`<li>
      <a href="/buckets/${b.id}"><span class="dot" data-type="${b.type}"></span>${b.name}</a>
      <span class="amt ${b.balance < 0n ? 'neg' : ''}">${f.money(b.balance)}</span>
      ${b.monthly_target ? html`${meter(toMajorNumber(b.balance), toMajorNumber(b.monthly_target), b.name, { low: toMajorNumber(b.monthly_target) * 0.3, optimum: toMajorNumber(b.monthly_target) })}<small>${t('bucket.of_target', { target: f.money(b.monthly_target) })}</small>` : ''}
      ${b.balance < 0n ? html`<small class="neg">${t('bucket.negative')}</small>` : ''}</li>`)}</ul>` : empty(t('bucket.none'), html`<a class="btn" href="/buckets">${t('bucket.create')}</a>`), { action: html`<a href="/buckets">${t('common.all')}</a>` }));
  }

  // DASH-12 emergency
  if (!hidden.has('emergency')) {
    cards.push(card(t('nav.emergency'), html`${thresholdBar({ title: t('dash.chart.emergency'), months: emg.runway, marks: [{ at: 1, label: t('emg.tier.starter') }, { at: 3, label: t('emg.tier.basic') }, { at: 6, label: t('emg.tier.secure') }] })}
      <p>${t('emg.have_of', { have: f.money(emg.fund), target: f.money(emg.target) })}</p>`, { action: html`<a href="/emergency">${t('common.details')}</a>` }));
  }

  // DASH-06 debt
  if (!hidden.has('debt') && debts.plan && debts.total > 0n) {
    const proj = debts.plan.balanceSeries.slice(0, 120);
    const actual = data.snaps.map((r: any) => toMajorNumber(r.liabilities));
    const labels = [...data.snaps.map((r: any) => f.monthShort(r.date.slice(0, 7))), ...proj.map((_, i) => f.month(addMonths(today, i + 1).slice(0, 7)))];
    cards.push(card(t('dash.chart.debt'), lineChart({
      title: t('dash.chart.debt'), summary: t('dash.chart.debt_sum', { date: f.date(debts.debtFreeDate) }), labels: labels.length > 1 ? labels : [f.month(today.slice(0, 7)), ...labels],
      series: [
        { name: t('common.actual'), cls: 'c-exp', values: [...actual, ...proj.map(() => null)] },
        { name: t('common.projected'), cls: 'c-exp', dashed: true, values: [...actual.map((v: number, i: number) => (i === actual.length - 1 ? v : null)), ...proj.map((v) => toMajorNumber(v))] },
      ],
      fmt: fm,
    }), { action: html`<a href="/debts/plan">${t('debt.plan')}</a>`, cls: 'span2' }));
  }

  // DASH-11 goals
  if (!hidden.has('goals')) {
    cards.push(card(t('nav.goals'), data.goals.length ? html`<ul class="goal-rings">${data.goals.map((g: any) => {
      const gp = goalProgress({ target: g.target_amount, current: g.saved, targetDate: g.target_date, today, startedOn: g.started, recentMonthlyAvg: g.recent / 3n, annualReturnE4: g.expected_return_e4 });
      return html`<li><a href="/goals/${g.id}">${g.target_amount ? ring(gp.percent, g.name) : icon('target')}<span>${g.name}</span><small>${f.money(g.saved)}${g.target_amount ? html` / ${f.money(g.target_amount)}` : ''}</small><small class="status s-${gp.status}">${t(`goal.status.${gp.status}`)}</small></a></li>`;
    })}</ul>` : empty(t('goal.none'), html`<a class="btn" href="/goals">${t('goal.create')}</a>`), { action: html`<a href="/goals">${t('common.all')}</a>` }));
  }

  // DASH-16 investments
  if (p.investment_enabled && data.inv && !hidden.has('invest')) {
    cards.push(card(t('dash.portfolio'), html`<div class="kv"><div><span>${t('invest.value')}</span><strong>${f.moneyHtml(data.inv.value)}</strong></div>
      <div><span>${t('invest.invested')}</span><strong>${f.moneyHtml(data.inv.cost)}</strong></div>
      <div><span>${t('invest.unrealized')}</span><strong>${f.moneyHtml(data.inv.unrealized, { sign: true })}</strong></div>
      <div><span>${t('invest.realized')}</span><strong>${f.moneyHtml(data.inv.realized + data.inv.income, { sign: true })}</strong></div></div>
      <p class="note">${t('invest.disclaimer_short')}</p>`, { action: html`<a href="/invest">${t('common.details')}</a>` }));
  }

  // FR-REC-04 upcoming bills
  if (!hidden.has('bills')) {
    cards.push(card(t('rec.upcoming'), data.bills.length ? html`<ul class="rows">${data.bills.map((b: any) => html`<li><span>${f.date(b.next_date)}</span><span>${b.name}</span>${f.moneyHtml(b.kind === 'income' ? b.amount : -b.amount, { sign: true })}</li>`)}</ul>` : empty(t('rec.none_upcoming')), { action: html`<a href="/recurring">${t('common.all')}</a>` }));
  }

  return htmlRes(page(ctx, {
    title: t('nav.dashboard'),
    actions: html`<a class="btn primary" href="/transactions/new">${icon('plus')} ${t('txn.add')}</a>`,
    body: html`${!ctx.user!.email_verified_at && mailEnabled() ? html`<p class="flash warn">${t('auth.verify_pending')} <a href="/settings">${t('common.details')}</a></p>` : ''}<div class="dash">${cards}</div>`,
    wide: true,
  }));
});

post('/dashboard/hide', { access: 'auth' }, async (ctx) => {
  const key = ctx.body.card;
  if ((DASH_CARDS as readonly string[]).includes(key)) {
    await ctx.as((q) => q.query(`update user_preferences set dashboard_hidden = case when $1 = any(dashboard_hidden) then array_remove(dashboard_hidden, $1) else array_append(dashboard_hidden, $1) end where user_id = hearth_uid()`, [key]));
  }
  return redirect(safeNext(ctx.body.next, '/settings'));
});
