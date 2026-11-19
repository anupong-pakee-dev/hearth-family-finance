/**
 * Savings goals (§4.5) and emergency fund (§4.6). Neither requires buckets (FR-SAVE-10, FR-EMG-08).
 */
import { get, post, htmlRes, redirect, withFlash, HttpError, type Ctx } from '../http/app.ts';
import { html, raw } from '../views/html.ts';
import { page, icon } from '../views/layout.ts';
import { field, input, moneyInput, rateInput, dateInput, select, form, postButton, empty, card, stat, disclaimer, checkbox } from '../views/ui.ts';
import { makeFmt, inputMoney, inputRate } from '../views/format.ts';
import { lineChart, ring, thresholdBar } from '../views/charts.ts';
import { money, rate, date, optDate, text, oneOf, requireUuid, uuidOrNull, scope, shareTarget, activity, intIn, today, notify } from '../services/common.ts';
import { bucketMove } from '../services/finance.ts';
import { emergencyStatus, cycles } from '../services/summary.ts';
import { goalProgress, growthSeries, distributeByPriority, refillPlan, tierFor, addMonths, toMajorNumber, monthsBetween, TIER_MONTHS, challengeAmount, daysBetween } from '@hearth/engine';

async function goalRows(ctx: Ctx, id?: string) {
  return ctx.as((q) => q.query<any>(`select g.*, g.created_at::date::text started, g.target_date::text target_date,
      coalesce((select sum(amount) from goal_contributions c where c.goal_id = g.id),0)::bigint contributed,
      coalesce((select sum(amount) from goal_contributions c where c.goal_id = g.id and c.date >= $1),0)::bigint recent,
      b.balance bucket_balance, a.balance account_balance
     from goals g left join buckets b on b.id = g.bucket_id left join accounts a on a.id = g.account_id
     where not g.archived and ${id ? 'g.id = $2' : scope(ctx.view, 'g')} order by g.priority, g.created_at`, id ? [addMonths(today(), -3), id] : [addMonths(today(), -3)]));
}

/** Current amount: linked bucket balance, else linked account balance, else manual contributions (FR-SAVE-10). */
function savedOf(g: any): bigint {
  if (g.bucket_id && g.bucket_balance != null) return g.bucket_balance;
  if (g.account_id && g.account_balance != null) return g.account_balance;
  return g.contributed;
}

function progressOf(g: any) {
  return goalProgress({ target: g.target_amount, current: savedOf(g), targetDate: g.target_date, today: today(), startedOn: g.started, recentMonthlyAvg: g.recent / 3n, annualReturnE4: g.expected_return_e4 });
}

function goalFields(ctx: Ctx, g: any = {}, lk: { buckets: any[]; accounts: any[] }) {
  const shareOpts = ctx.households.filter((h) => h.role !== 'viewer').map((h) => ({ value: h.id, label: h.name }));
  return html`<div class="grid3">
    ${field(ctx.t('goal.name'), input({ name: 'name', value: g.name, required: true, maxlength: 80 }), { id: 'f-name' })}
    ${field(ctx.t('goal.target'), moneyInput('target', inputMoney(g.target_amount)), { id: 'f-target', hint: ctx.t('goal.target_hint') })}
    ${field(ctx.t('goal.date'), dateInput('target_date', g.target_date), { hint: ctx.t('common.optional') })}
    ${field(ctx.t('goal.return'), rateInput('return', g.expected_return_e4 ? inputRate(g.expected_return_e4) : ''), { hint: ctx.t('goal.return_hint') })}
    ${field(ctx.t('goal.priority'), input({ name: 'priority', type: 'number', min: 1, max: 999, value: g.priority ?? 100 }), { id: 'f-priority' })}
    ${lk.buckets.length ? field(ctx.t('goal.bucket'), select('bucket_id', lk.buckets.map((b) => ({ value: b.id, label: b.name })), g.bucket_id ?? '', { empty: '—' }), { hint: ctx.t('common.optional') }) : ''}
    ${field(ctx.t('goal.account'), select('account_id', lk.accounts.map((a) => ({ value: a.id, label: a.name })), g.account_id ?? '', { empty: ctx.t('goal.manual') }), { hint: ctx.t('goal.account_hint') })}
    ${shareOpts.length ? field(ctx.t('common.share_with'), select('household_id', shareOpts, g.household_id ?? '', { empty: ctx.t('common.private') })) : ''}
    ${field(ctx.t('goal.challenge'), select('challenge', [{ value: '52_week', label: ctx.t('goal.challenge.52_week') }, { value: 'daily_increment', label: ctx.t('goal.challenge.daily_increment') }], g.challenge ?? '', { empty: ctx.t('goal.challenge.none') }), { hint: ctx.t('goal.challenge_hint') })}
    ${field(ctx.t('goal.challenge_step'), moneyInput('challenge_step', inputMoney(g.challenge_step)), { hint: ctx.t('goal.challenge_step_hint') })}
  </div>`;
}

function parseGoal(ctx: Ctx) {
  const challenge = ctx.body.challenge === '52_week' || ctx.body.challenge === 'daily_increment' ? ctx.body.challenge : null;
  return {
    name: text(ctx.body.name, 80, true), target: money(ctx.body.target), targetDate: optDate(ctx.body.target_date), ret: rate(ctx.body.return),
    priority: intIn(ctx.body.priority, 1, 999, 100), bucketId: ctx.prefs!.bucket_mode === 'off' ? null : uuidOrNull(ctx.body.bucket_id),
    accountId: uuidOrNull(ctx.body.account_id), householdId: shareTarget(ctx, ctx.body.household_id),
    challenge, challengeStep: challenge ? money(ctx.body.challenge_step) ?? (challenge === '52_week' ? 1000n : 100n) : null,
  };
}

/** FR-SAVE-09: 52-week challenge (week n → n × step) or daily increment (day n → n × step). */
function challengeStatus(g: any, today: string) {
  if (!g.challenge) return null;
  const start: string = g.challenge_start ?? g.started;
  const days = Math.max(0, daysBetween(start, today));
  const index = g.challenge === '52_week' ? Math.min(52, Math.floor(days / 7) + 1) : Math.min(365, days + 1);
  const periods = g.challenge === '52_week' ? 52 : 365;
  const step = g.challenge_step ?? 0n;
  const dueSoFar = step * BigInt((index * (index + 1)) / 2);
  const total = step * BigInt((periods * (periods + 1)) / 2);
  return { index, periods, today: challengeAmount(g.challenge, index, step), dueSoFar, total };
}

async function goalLookups(ctx: Ctx) {
  return ctx.as(async (q) => ({
    buckets: ctx.prefs!.bucket_mode !== 'off' ? await q.query<any>(`select id, name from buckets where not archived and owner_id = hearth_uid() and type in ('savings','investing','emergency')`) : [],
    accounts: await q.query<any>('select id, name from accounts where not archived and owner_id = hearth_uid()'),
  }));
}

get('/goals', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const [rows, lk] = await Promise.all([goalRows(ctx), goalLookups(ctx)]);
  const amt = money(ctx.query.get('distribute') ?? undefined);
  let dist = '' as any;
  if (amt) {
    const plan = distributeByPriority(amt, rows.filter((g) => g.target_amount).map((g) => { const p = progressOf(g); return { id: g.id, need: p.requiredMonthly ?? p.remaining, remaining: p.remaining }; }));
    dist = card(ctx.t('goal.distribution'), html`<ul class="rows">${rows.filter((g) => plan[g.id]).map((g) => html`<li><span>${g.name}</span>${f.moneyHtml(plan[g.id])}</li>`)}</ul>`);
  }
  return htmlRes(page(ctx, {
    title: ctx.t('nav.goals'),
    body: html`
      ${card(ctx.t('nav.goals'), rows.length ? html`<ul class="goal-cards">${rows.map((g) => {
        const p = progressOf(g);
        return html`<li><a href="/goals/${g.id}">${g.target_amount ? ring(p.percent, g.name) : icon('target')}
          <span><strong>${g.name}</strong><small>${f.money(savedOf(g))}${g.target_amount ? html` / ${f.money(g.target_amount)}` : html` · ${ctx.t('goal.open_ended')}`}</small>
          ${p.requiredMonthly != null && p.status !== 'done' ? html`<small>${ctx.t('goal.need_monthly', { amount: f.money(p.requiredMonthly) })}</small>` : ''}
          <small class="status s-${p.status}">${ctx.t(`goal.status.${p.status}`)}${p.forecastDate && p.status !== 'done' ? html` · ${ctx.t('goal.forecast', { date: f.date(p.forecastDate) })}` : ''}</small></span></a></li>`;
      })}</ul>` : empty(ctx.t('goal.none')))}
      ${rows.length > 1 ? card(ctx.t('goal.distribute'), html`<form method="get" action="/goals" class="stack">${field(ctx.t('goal.distribute_amount'), moneyInput('distribute', amt ? inputMoney(amt) : ''), { id: 'f-distribute', hint: ctx.t('goal.distribute_hint') })}<div class="actions"><button class="btn">${ctx.t('common.calculate')}</button></div></form>${dist}`) : ''}
      ${card(ctx.t('goal.create'), form(ctx, '/goals', goalFields(ctx, {}, lk), { submit: ctx.t('common.add') }))}
      ${disclaimer(ctx)}`,
  }));
});

post('/goals', { access: 'auth' }, async (ctx) => {
  const g = parseGoal(ctx);
  await ctx.as(async (q) => {
    const r = await q.one<any>(`insert into goals(owner_id, household_id, name, target_amount, target_date, expected_return_e4, priority, bucket_id, account_id, challenge, challenge_step, challenge_start)
      values (hearth_uid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $9::text is null then null else current_date end) returning id`,
      [g.householdId, g.name, g.target, g.targetDate, g.ret, g.priority, g.bucketId, g.accountId, g.challenge, g.challengeStep]);
    await activity(q, ctx, g.householdId, 'create', 'goal', r.id, g.name);
  });
  return redirect(withFlash('/goals', 'ok', 'saved'));
});

get('/goals/:id', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const f = makeFmt(ctx.prefs, ctx.lang);
  const [rows, lk] = await Promise.all([goalRows(ctx, id), goalLookups(ctx)]);
  const g = rows[0];
  if (!g) throw new HttpError(404);
  const { contrib, byMember, members, monthly } = await ctx.as(async (q) => ({
    contrib: await q.query<any>('select c.*, c.date::text date, m.display_name who from goal_contributions c left join members m on m.id = c.member_id where c.goal_id = $1 order by c.date desc limit 50', [id]),
    byMember: g.household_id ? await q.query<any>(`select coalesce(m.display_name,'—') who, sum(c.amount)::bigint total from goal_contributions c left join members m on m.id = c.member_id where c.goal_id = $1 group by 1 order by 2 desc`, [id]) : [],
    members: g.household_id ? await q.query<any>('select id, display_name from members where household_id = $1', [g.household_id]) : [],
    monthly: await q.query<any>(`select to_char(date, 'YYYY-MM') m, sum(amount)::bigint s from goal_contributions where goal_id = $1 group by 1 order by 1`, [id]),
  }));
  const p = progressOf(g);
  const saved = savedOf(g);
  // DASH-10: actual cumulative + projection to target
  const hist: number[] = [];
  let acc = 0n;
  for (const m of monthly) { acc += m.s; hist.push(toMajorNumber(acc)); }
  const pace = p.requiredMonthly ?? g.recent / 3n;
  const horizon = Math.min(240, p.monthsLeft ?? 24) || 12;
  const proj = growthSeries(saved, pace, horizon, g.expected_return_e4).map(toMajorNumber);
  const labels = [...monthly.map((m: any) => f.monthShort(m.m)), ...proj.map((_, i) => f.month(addMonths(today(), i + 1).slice(0, 7)))];
  const fm = (n: number) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact' }).format(n));
  const chart = labels.length > 1 ? lineChart({
    title: ctx.t('goal.growth'), summary: ctx.t('goal.growth'), labels,
    series: [
      { name: ctx.t('common.actual'), cls: 'c-inc', area: true, values: [...hist, ...proj.map(() => null)] },
      { name: ctx.t('common.projected'), cls: 'c-inc', dashed: true, values: [...hist.map((v, i) => (i === hist.length - 1 ? v : null)), ...proj] },
      ...(g.target_amount ? [{ name: ctx.t('goal.target'), cls: 'c-net', dotted: true, values: labels.map(() => toMajorNumber(g.target_amount)) }] : []),
    ],
    fmt: fm,
  }) : '';
  const mine = g.owner_id === ctx.user!.id;
  return htmlRes(page(ctx, {
    title: g.name,
    body: html`
      <section class="stats">
        ${stat(ctx.t('goal.saved'), f.moneyHtml(saved), g.target_amount ? `${p.percent.toFixed(1)}%` : ctx.t('goal.open_ended'))}
        ${g.target_amount ? stat(ctx.t('goal.remaining'), f.moneyHtml(p.remaining)) : ''}
        ${p.requiredMonthly != null ? stat(ctx.t('goal.need_per_month'), f.moneyHtml(p.requiredMonthly), g.target_date ? ctx.t('goal.by_date', { date: f.date(g.target_date) }) : '') : ''}
        ${stat(ctx.t('goal.status_label'), ctx.t(`goal.status.${p.status}`), p.forecastDate ? ctx.t('goal.forecast', { date: f.date(p.forecastDate) }) : ctx.t('goal.no_pace'), p.status === 'behind' ? 'warn' : p.status === 'done' || p.status === 'ahead' ? 'ok' : undefined)}
      </section>
      ${(() => { const ch = challengeStatus(g, today()); return ch ? card(ctx.t(`goal.challenge.${g.challenge}`), html`
        <section class="stats">${stat(ctx.t('goal.challenge_today', { n: ch.index, of: ch.periods }), f.moneyHtml(ch.today))}${stat(ctx.t('goal.challenge_due'), f.moneyHtml(ch.dueSoFar), `${ctx.t('goal.saved')} ${f.money(saved)}`, saved >= ch.dueSoFar ? 'ok' : 'warn')}${stat(ctx.t('goal.challenge_total'), f.moneyHtml(ch.total))}</section>
        ${postButton(ctx, `/goals/${id}/contribute`, ctx.t('goal.challenge_deposit', { amount: f.money(ch.today) }), { cls: 'primary', fields: { amount: inputMoney(ch.today), date: today(), to_bucket: '1' } })}`) : ''; })()}
      ${chart ? card(ctx.t('goal.growth'), chart, { cls: 'span2' }) : ''}
      ${card(ctx.t('goal.contribute'), form(ctx, `/goals/${id}/contribute`, html`<div class="grid3">
        ${field(ctx.t('txn.amount'), moneyInput('amount', '', { required: true }), { id: 'f-amount', hint: ctx.t('goal.withdraw_hint') })}
        ${field(ctx.t('txn.date'), dateInput('date', today(), true))}
        ${members.length ? field(ctx.t('goal.by_member'), select('member_id', members.map((m: any) => ({ value: m.id, label: m.display_name })), ctx.households.find((h) => h.id === g.household_id)?.member_id ?? '')) : ''}
        ${g.bucket_id ? checkbox('to_bucket', ctx.t('goal.also_bucket'), true) : ''}</div>`, { submit: ctx.t('common.save') }))}
      ${byMember.length ? card(ctx.t('goal.member_share'), html`<ul class="rows">${byMember.map((r: any) => html`<li><span>${r.who}</span>${f.moneyHtml(r.total)}<small>${saved > 0n ? `${(toMajorNumber(r.total) / toMajorNumber(saved) * 100).toFixed(0)}%` : ''}</small></li>`)}</ul>`) : ''}
      ${card(ctx.t('goal.history'), contrib.length ? html`<ul class="rows">${contrib.map((c: any) => html`<li><span>${f.date(c.date)}${c.who ? html` · ${c.who}` : ''}</span>${f.moneyHtml(c.amount, { sign: true })}${postButton(ctx, `/goals/${id}/contributions/${c.id}/delete`, '×', { cls: 'sm link' })}</li>`)}</ul>` : empty(ctx.t('common.no_data')))}
      ${mine ? card(ctx.t('common.edit'), form(ctx, `/goals/${id}/edit`, goalFields(ctx, g, lk), { submit: ctx.t('common.save') })) : ''}
      ${mine ? html`<p class="row-actions">${postButton(ctx, `/goals/${id}/archive`, ctx.t('common.archive'))} ${postButton(ctx, `/goals/${id}/delete`, ctx.t('common.delete'), { cls: 'danger sm', confirm: ctx.t('common.confirm_delete') })}</p>` : ''}
      ${disclaimer(ctx)}`,
  }));
});

post('/goals/:id/edit', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const g = parseGoal(ctx);
  const r = await ctx.as((q) => q.query(`update goals set name=$2, target_amount=$3, target_date=$4, expected_return_e4=$5, priority=$6, bucket_id=$7, account_id=$8, household_id=$9,
      challenge=$10, challenge_step=$11, challenge_start = case when $10::text is null then null when challenge is distinct from $10 then current_date else coalesce(challenge_start, current_date) end
     where id=$1 and owner_id = hearth_uid() returning id`,
    [id, g.name, g.target, g.targetDate, g.ret, g.priority, g.bucketId, g.accountId, g.householdId, g.challenge, g.challengeStep]));
  if (!r.length) throw new HttpError(404);
  return redirect(withFlash(`/goals/${id}`, 'ok', 'saved'));
});

post('/goals/:id/contribute', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const amount = money(ctx.body.amount, { required: true, allowNegative: true })!;
  const d = date(ctx.body.date, today());
  let reached = false;
  await ctx.as(async (q) => {
    const g = await q.one<any>('select id, owner_id, household_id, bucket_id, target_amount, name from goals where id = $1', [id]);
    if (!g) throw new HttpError(404);
    await q.query('insert into goal_contributions(goal_id, owner_id, household_id, date, amount, member_id, created_by) values ($1,$2,$3,$4,$5,$6,hearth_uid())', [id, g.owner_id, g.household_id, d, amount, uuidOrNull(ctx.body.member_id)]);
    if (g.bucket_id && ctx.body.to_bucket === '1' && ctx.prefs!.bucket_mode !== 'off') await bucketMove(q, g.owner_id, g.bucket_id, amount, 'allocate', null, g.name);
    const s = await q.one<{ s: bigint }>('select coalesce(sum(amount),0)::bigint s from goal_contributions where goal_id = $1', [id]);
    if (g.target_amount && s!.s >= g.target_amount) {
      reached = true;
      await notify(q, ctx.user!.id, 'goal_reached', ctx.t('noti.goal_reached', { name: g.name }), '', `/goals/${id}`, `goal-reached-${id}`);
    }
    await activity(q, ctx, g.household_id, 'contribute', 'goal', id, g.name);
  });
  return redirect(withFlash(`/goals/${id}`, 'ok', reached ? 'goal_reached' : 'saved'));
});

post('/goals/:id/contributions/:cid/delete', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  await ctx.as((q) => q.query('delete from goal_contributions where id = $1 and goal_id = $2', [requireUuid(ctx.params.cid), id]));
  return redirect(`/goals/${id}`);
});

post('/goals/:id/archive', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query('update goals set archived = true where id = $1 and owner_id = hearth_uid()', [requireUuid(ctx.params.id)]));
  return redirect(withFlash('/goals', 'ok', 'saved'));
});

post('/goals/:id/delete', { access: 'auth' }, async (ctx) => {
  const r = await ctx.as((q) => q.query('delete from goals where id = $1 and owner_id = hearth_uid() returning id', [requireUuid(ctx.params.id)]));
  if (!r.length) throw new HttpError(404);
  return redirect(withFlash('/goals', 'ok', 'deleted'));
});

// ───────────── Emergency fund ─────────────
get('/emergency', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const p = ctx.prefs!;
  const { st, events, accounts, ess } = await ctx.as(async (q) => ({
    st: await emergencyStatus(q, ctx.view, p),
    events: await q.query<any>('select e.*, e.date::text date from emergency_events e where e.owner_id = hearth_uid() order by e.date desc, e.created_at desc limit 30', []),
    accounts: await q.query<any>('select id, name from accounts where not archived and owner_id = hearth_uid()'),
    ess: await q.query<any>(`select c.name from categories c left join categories p on p.id = c.parent_id where c.owner_id = hearth_uid() and not c.archived and c.kind = 'expense' and (c.essential or coalesce(p.essential,false)) order by c.sort`),
  }));
  const tier = tierFor(st.runway);
  const lastWithdrawal = events.find((e: any) => e.amount < 0n && e.refill_months);
  const refill = lastWithdrawal ? refillPlan(0n - (lastWithdrawal.amount as bigint), lastWithdrawal.refill_months) : null;
  const sources = [{ value: 'manual', label: ctx.t('emg.source.manual') }, { value: 'account', label: ctx.t('emg.source.account') }, ...(p.bucket_mode !== 'off' ? [{ value: 'bucket', label: ctx.t('emg.source.bucket') }] : [])];
  return htmlRes(page(ctx, {
    title: ctx.t('nav.emergency'),
    body: html`
      <section class="stats">
        ${stat(ctx.t('emg.fund'), f.moneyHtml(st.fund), ctx.t(`emg.source.${p.emergency_source}`))}
        ${stat(ctx.t('emg.essential'), f.moneyHtml(st.essential), p.essential_override ? ctx.t('emg.manual_value') : ctx.t('emg.avg_3m'))}
        ${stat(ctx.t('dash.runway'), Number.isFinite(st.runway) ? ctx.t('common.months', { n: f.num(st.runway) }) : '∞', ctx.t(`emg.tier.${tier}`), tier === 'secure' ? 'ok' : tier === 'none' ? 'bad' : 'warn')}
        ${stat(ctx.t('emg.target'), f.moneyHtml(st.target), p.emergency_mode === 'months' ? ctx.t('common.months', { n: p.emergency_months }) : ctx.t('emg.fixed'))}
      </section>
      ${card(ctx.t('emg.levels'), html`${thresholdBar({ title: ctx.t('dash.chart.emergency'), months: st.runway, marks: (Object.entries(TIER_MONTHS) as [string, number][]).map(([k, m]) => ({ at: m, label: ctx.t(`emg.tier.${k}`) })) })}
        <ol class="tiers">${(Object.entries(TIER_MONTHS) as [string, number][]).map(([k, m]) => html`<li class="${st.runway >= m ? 'done' : ''}">${st.runway >= m ? '✓ ' : ''}${ctx.t(`emg.tier.${k}`)} — ${ctx.t('common.months', { n: m })} (${f.money(st.essential * BigInt(m))})</li>`)}</ol>`)}
      ${refill ? card(ctx.t('emg.refill_plan'), html`<p>${ctx.t('emg.refill_intro', { amount: f.money(refill[0]), n: refill.length })}</p>`) : ''}
      ${p.emergency_source === 'manual' ? card(ctx.t('emg.record'), form(ctx, '/emergency/events', html`<div class="grid3">
        ${field(ctx.t('emg.direction'), select('direction', [{ value: 'deposit', label: ctx.t('emg.deposit') }, { value: 'withdraw', label: ctx.t('emg.withdraw') }], 'deposit'))}
        ${field(ctx.t('txn.amount'), moneyInput('amount', '', { required: true }), { id: 'f-amount' })}
        ${field(ctx.t('txn.date'), dateInput('date', today(), true))}
        ${field(ctx.t('emg.reason'), input({ name: 'reason', maxlength: 200 }), { id: 'f-reason', hint: ctx.t('emg.reason_hint') })}
        ${field(ctx.t('emg.refill_months'), input({ name: 'refill_months', type: 'number', min: 1, max: 60, value: 6 }), { id: 'f-refill_months' })}</div>`, { submit: ctx.t('common.save') })) : ''}
      ${events.length ? card(ctx.t('emg.history'), html`<ul class="rows">${events.map((e: any) => html`<li><span>${f.date(e.date)}${e.reason ? html` · ${e.reason}` : ''}</span>${f.moneyHtml(e.amount, { sign: true })}</li>`)}</ul>`) : ''}
      ${card(ctx.t('emg.settings'), form(ctx, '/emergency/settings', html`<div class="grid3">
        ${field(ctx.t('emg.source_label'), select('source', sources, p.emergency_source))}
        ${field(ctx.t('emg.account'), select('account_id', accounts.map((a: any) => ({ value: a.id, label: a.name })), p.emergency_account_id ?? '', { empty: '—' }))}
        ${field(ctx.t('emg.manual_amount'), moneyInput('manual', inputMoney(p.emergency_manual)), { id: 'f-manual', hint: ctx.t('emg.manual_hint') })}
        ${field(ctx.t('emg.mode'), select('mode', [{ value: 'months', label: ctx.t('emg.mode_months') }, { value: 'fixed', label: ctx.t('emg.fixed') }], p.emergency_mode))}
        ${field(ctx.t('emg.months'), input({ name: 'months', type: 'number', min: 1, max: 24, step: '0.5', value: p.emergency_months }), { id: 'f-months' })}
        ${field(ctx.t('emg.fixed_amount'), moneyInput('fixed', inputMoney(p.emergency_fixed)), { id: 'f-fixed' })}
        ${field(ctx.t('emg.essential_override'), moneyInput('override', inputMoney(p.essential_override)), { id: 'f-override', hint: ctx.t('emg.essential_override_hint') })}
        ${checkbox('first', ctx.t('emg.first_rule'), p.emergency_first)}</div>`, { submit: ctx.t('common.save') }))}
      ${card(ctx.t('emg.essential_cats'), html`<p class="note">${ctx.t('emg.essential_cats_hint')}</p><p>${ess.map((c: any) => c.name).join(', ') || '—'}</p><p><a href="/categories">${ctx.t('common.change')}</a></p>`)}`,
  }));
});

post('/emergency/events', { access: 'auth' }, async (ctx) => {
  const amount = money(ctx.body.amount, { required: true })!;
  const withdraw = ctx.body.direction === 'withdraw';
  const reason = text(ctx.body.reason, 200);
  if (withdraw && !reason) return redirect(withFlash('/emergency', 'err', 'reason_required')); // FR-EMG-05
  await ctx.as(async (q) => {
    await q.query('insert into emergency_events(owner_id, date, amount, reason, refill_months) values (hearth_uid(), $1, $2, $3, $4)', [date(ctx.body.date, today()), withdraw ? -amount : amount, reason || null, withdraw ? intIn(ctx.body.refill_months, 1, 60, 6) : null]);
  });
  return redirect(withFlash('/emergency', 'ok', 'saved'));
});

post('/emergency/settings', { access: 'auth' }, async (ctx) => {
  const source = oneOf(ctx.body.source, ['manual', 'account', 'bucket'] as const, 'manual');
  const months = Math.min(24, Math.max(1, Number.parseFloat(ctx.body.months ?? '6') || 6));
  await ctx.as((q) => q.query(`update user_preferences set emergency_source=$1, emergency_account_id=$2, emergency_manual=$3, emergency_mode=$4, emergency_months=$5, emergency_fixed=$6, essential_override=$7, emergency_first=$8 where user_id = hearth_uid()`,
    [source, uuidOrNull(ctx.body.account_id), money(ctx.body.manual) ?? 0n, oneOf(ctx.body.mode, ['months', 'fixed'] as const, 'months'), months, money(ctx.body.fixed) ?? 0n, money(ctx.body.override), ctx.body.first === '1']));
  return redirect(withFlash('/emergency', 'ok', 'saved'));
});

export const _x = { raw, cycles, monthsBetween };
