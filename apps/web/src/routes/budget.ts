/**
 * Budget (§4.10) and recurring items (§4.11).
 */
import { get, post, htmlRes, redirect, withFlash, HttpError, type Ctx } from '../http/app.ts';
import { html } from '../views/html.ts';
import { page, icon } from '../views/layout.ts';
import { field, input, moneyInput, dateInput, select, form, postButton, empty, card, stat, meter, checkbox } from '../views/ui.ts';
import { makeFmt, inputMoney } from '../views/format.ts';
import { lineChart } from '../views/charts.ts';
import { money, date, optDate, text, oneOf, requireUuid, uuidOrNull, scope, intIn, today } from '../services/common.ts';
import { createTransaction } from '../services/finance.ts';
import { detectSubscriptions } from '../services/subscriptions.ts';
import { currentCycle, cycles } from '../services/summary.ts';
import { addMonths, addDays, nextOccurrence, toMajorNumber, divRound, type Frequency } from '@hearth/engine';

const PERIOD_MONTHS: Record<string, bigint> = { monthly: 1n, quarterly: 3n, yearly: 12n };

get('/budget', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const p = ctx.prefs!;
  const cur = currentCycle(p);
  const month = /^\d{4}-\d{2}$/.test(ctx.query.get('month') ?? '') ? ctx.query.get('month')! : cur.start.slice(0, 7);
  const start = `${month}-${String(p.month_start_day).padStart(2, '0')}`;
  const end = addDays(addMonths(start, 1), -1);
  const { lines, cats, spent } = await ctx.as(async (q) => ({
    lines: await q.query<any>(`select l.*, c.name, c.parent_id from budget_lines l join categories c on c.id = l.category_id where l.owner_id = hearth_uid() and l.month = $1 order by c.sort`, [month]),
    cats: await q.query<any>(`select c.id, c.name, p.name parent from categories c left join categories p on p.id = c.parent_id where c.owner_id = hearth_uid() and c.kind = 'expense' and not c.archived order by coalesce(p.sort, c.sort), c.parent_id nulls first, c.sort`),
    spent: await q.query<any>(`select coalesce(c.parent_id, c.id) top, t.category_id, sum(t.amount)::bigint s from transaction_lines t join categories c on c.id = t.category_id
        where t.kind = 'expense' and t.date between $1 and $2 and ${scope(ctx.view, 't')} group by 1, 2`, [start, end]),
  }));
  const spentFor = (catId: string): bigint => spent.filter((s) => s.category_id === catId || s.top === catId).reduce<bigint>((a, s) => a + (s.s as bigint), 0n);
  const warn = p.budget_warn_e4 / 1_000_000;
  const totalBudget = lines.reduce<bigint>((s, l) => s + divRound(l.amount, PERIOD_MONTHS[l.period]), 0n);
  const totalSpent = lines.reduce<bigint>((s, l) => s + spentFor(l.category_id), 0n);
  const prev = addMonths(`${month}-01`, -1).slice(0, 7);
  const next = addMonths(`${month}-01`, 1).slice(0, 7);
  return htmlRes(page(ctx, {
    title: ctx.t('nav.budget'),
    actions: html`<nav class="month-nav"><a class="btn sm" href="/budget?month=${prev}" aria-label="${ctx.t('common.prev')}">‹</a><strong>${f.month(month)}</strong><a class="btn sm" href="/budget?month=${next}" aria-label="${ctx.t('common.next')}">›</a></nav>`,
    body: html`
      <section class="stats">${stat(ctx.t('budget.total'), f.moneyHtml(totalBudget))}${stat(ctx.t('budget.spent'), f.moneyHtml(totalSpent), totalBudget > 0n ? f.pct(toMajorNumber(totalSpent) / toMajorNumber(totalBudget)) : '', totalSpent > totalBudget && totalBudget > 0n ? 'bad' : undefined)}${stat(ctx.t('budget.left'), f.moneyHtml(totalBudget - totalSpent))}</section>
      ${card(ctx.t('budget.vs_actual'), lines.length ? html`<ul class="budget-list">${lines.map((l) => {
        const monthly = divRound(l.amount, PERIOD_MONTHS[l.period]);
        const s = spentFor(l.category_id);
        const ratio = monthly > 0n ? toMajorNumber(s) / toMajorNumber(monthly) : 0;
        const tone = ratio >= 1 ? 'bad' : ratio >= warn ? 'warn' : 'ok';
        return html`<li class="${tone}"><div class="row"><strong>${l.name}</strong>${l.period !== 'monthly' ? html`<span class="tag">${ctx.t(`budget.period.${l.period}`)} · ${ctx.t('budget.sinking', { amount: f.money(monthly) })}</span>` : ''}<span>${f.money(s)} / ${f.money(monthly)}</span>${postButton(ctx, `/budget/${l.id}/delete`, '×', { cls: 'sm link', fields: { month } })}</div>
          ${meter(ratio * 100, 100, l.name, { low: warn * 100, high: 99.9, optimum: 50 })}
          <small>${ratio >= 1 ? ctx.t('budget.over', { amount: f.money(s - monthly) }) : ratio >= warn ? ctx.t('budget.near', { pct: f.pct(ratio, 0) }) : ctx.t('budget.remaining', { amount: f.money(monthly - s) })}</small></li>`;
      })}</ul>` : empty(ctx.t('budget.none')))}
      <div class="grid2">
        ${card(ctx.t('budget.add_line'), form(ctx, '/budget', html`<input type="hidden" name="month" value="${month}">
          ${field(ctx.t('txn.category'), select('category_id', cats.map((c) => ({ value: c.id, label: c.parent ? `${c.parent} › ${c.name}` : c.name })), '', { required: true }))}
          ${field(ctx.t('txn.amount'), moneyInput('amount', '', { required: true }), { id: 'f-amount' })}
          ${field(ctx.t('budget.period_label'), select('period', ['monthly', 'quarterly', 'yearly'].map((v) => ({ value: v, label: ctx.t(`budget.period.${v}`) })), 'monthly'), { hint: ctx.t('budget.period_hint') })}`, { submit: ctx.t('common.save') }))}
        ${card(ctx.t('budget.quick'), html`${postButton(ctx, '/budget/copy', ctx.t('budget.copy_prev'), { cls: '', fields: { month } })}
          ${postButton(ctx, '/budget/average', ctx.t('budget.use_average'), { cls: '', fields: { month } })}
          <p class="note">${ctx.t('budget.alert_note', { pct: f.pct(warn, 0) })}</p>`)}
      </div>`,
  }));
});

post('/budget', { access: 'auth' }, async (ctx) => {
  const month = /^\d{4}-\d{2}$/.test(ctx.body.month ?? '') ? ctx.body.month : today().slice(0, 7);
  await ctx.as((q) => q.query(`insert into budget_lines(owner_id, month, category_id, amount, period) select hearth_uid(), $1, id, $3, $4 from categories where id = $2 and owner_id = hearth_uid()
    on conflict (owner_id, month, category_id) do update set amount = excluded.amount, period = excluded.period`, [month, requireUuid(ctx.body.category_id), money(ctx.body.amount, { required: true }), oneOf(ctx.body.period, ['monthly', 'quarterly', 'yearly'] as const, 'monthly')]));
  return redirect(withFlash(`/budget?month=${month}`, 'ok', 'saved'));
});

post('/budget/:id/delete', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query('delete from budget_lines where id = $1 and owner_id = hearth_uid()', [requireUuid(ctx.params.id)]));
  return redirect(`/budget?month=${/^\d{4}-\d{2}$/.test(ctx.body.month ?? '') ? ctx.body.month : ''}`);
});

/** FR-BUD-03: copy previous month. */
post('/budget/copy', { access: 'auth' }, async (ctx) => {
  const month = /^\d{4}-\d{2}$/.test(ctx.body.month ?? '') ? ctx.body.month : today().slice(0, 7);
  const prev = addMonths(`${month}-01`, -1).slice(0, 7);
  await ctx.as((q) => q.query(`insert into budget_lines(owner_id, month, category_id, amount, period) select owner_id, $1, category_id, amount, period from budget_lines where owner_id = hearth_uid() and month = $2 on conflict do nothing`, [month, prev]));
  return redirect(withFlash(`/budget?month=${month}`, 'ok', 'saved'));
});

/** FR-BUD-03: average of the last 3 cycles per top-level category. */
post('/budget/average', { access: 'auth' }, async (ctx) => {
  const month = /^\d{4}-\d{2}$/.test(ctx.body.month ?? '') ? ctx.body.month : today().slice(0, 7);
  const cs = cycles(ctx.prefs!, 4).slice(0, 3);
  await ctx.as((q) => q.query(`insert into budget_lines(owner_id, month, category_id, amount, period)
     select hearth_uid(), $1, coalesce(c.parent_id, c.id), (sum(t.amount) / 3)::bigint, 'monthly' from transaction_lines t join categories c on c.id = t.category_id
      where t.owner_id = hearth_uid() and t.kind = 'expense' and t.date between $2 and $3 group by coalesce(c.parent_id, c.id) having sum(t.amount) > 0
     on conflict (owner_id, month, category_id) do nothing`, [month, cs[0].start, cs[2].end]));
  return redirect(withFlash(`/budget?month=${month}`, 'ok', 'saved'));
});

// ───────────── Recurring ─────────────
const FREQS = ['daily', 'weekly', 'monthly', 'yearly', 'last_business_day'] as const;

get('/recurring', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const subs = await ctx.as((q) => detectSubscriptions(q, today()));
  const { rules, accounts, cats, debts, balance } = await ctx.as(async (q) => ({
    rules: await q.query<any>(`select r.*, r.next_date::text next_date, a.name acc, c.name cat from recurring_rules r join accounts a on a.id = r.account_id left join categories c on c.id = r.category_id where ${scope(ctx.view, 'r')} order by r.active desc, r.next_date`),
    accounts: await q.query<any>('select id, name from accounts where not archived and owner_id = hearth_uid()'),
    cats: await q.query<any>(`select c.id, c.name, c.kind, p.name parent from categories c left join categories p on p.id = c.parent_id where c.owner_id = hearth_uid() and not c.archived order by c.kind, c.sort`),
    debts: await q.query<any>('select id, name from debts where closed_at is null and owner_id = hearth_uid()'),
    balance: (await q.one<{ s: bigint }>(`select coalesce(sum(balance),0)::bigint s from accounts where not archived and owner_id = hearth_uid() and type in ('cash','savings','ewallet')`))!.s,
  }));
  // FR-REC-04 upcoming 30 days, FR-REC-05 forecast 90 days
  const horizon = addDays(today(), 90);
  const events: { date: string; name: string; delta: bigint }[] = [];
  for (const r of rules.filter((r) => r.active)) {
    let d = r.next_date;
    let n = 0;
    while (d <= horizon && n++ < 400 && (!r.end_date || d <= r.end_date)) {
      events.push({ date: d, name: r.name, delta: r.kind === 'income' ? r.amount : r.kind === 'expense' ? -r.amount : 0n });
      d = nextOccurrence(d, r.frequency as Frequency, r.interval_count);
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : 1));
  const upcoming = events.filter((e) => e.date <= addDays(today(), 30));
  const days = Array.from({ length: 13 }, (_, i) => addDays(today(), i * 7));
  let run = balance;
  const series = days.map((d) => { for (const e of events) if (e.date <= d && e.date > addDays(d, -7)) run += e.delta; return toMajorNumber(run); });
  // subscription price increase detection (FR-REC-06): same payee, latest amount > rule amount
  const fm = (n: number) => (f.privacy ? '•' : new Intl.NumberFormat(f.locale, { notation: 'compact' }).format(n));
  const catOpts = cats.map((c) => ({ value: c.id, label: c.parent ? `${c.parent} › ${c.name}` : c.name, group: ctx.t(`txn.kind.${c.kind}`) }));
  return htmlRes(page(ctx, {
    title: ctx.t('nav.recurring'),
    body: html`
      ${card(ctx.t('rec.upcoming'), upcoming.length ? html`<ul class="rows">${upcoming.map((e) => html`<li><span>${f.date(e.date)} · ${e.name}</span>${f.moneyHtml(e.delta, { sign: true })}</li>`)}</ul>` : empty(ctx.t('rec.none_upcoming')))}
      ${card(ctx.t('rec.forecast'), lineChart({ title: ctx.t('rec.forecast'), summary: ctx.t('rec.forecast_sum'), labels: days.map((d) => f.date(d).split(' ').slice(0, 2).join(' ')), series: [{ name: ctx.t('rec.liquid_balance'), cls: 'c-inc', area: true, values: series }], fmt: fm }), { cls: 'span2' })}
      ${subs.filter((x) => !x.tracked || x.increased).length ? card(ctx.t('rec.detected'), html`<p class="note">${ctx.t('rec.detected_hint')}</p><ul class="rows">${subs.filter((x) => !x.tracked || x.increased).map((x) => html`<li>
        <span><strong>${x.payee}</strong><small>${ctx.t('rec.seen_months', { n: x.months })} · ${ctx.t('rec.avg', { amount: f.money(x.average) })}${x.increased ? html` · <span class="neg">${ctx.t('rec.price_up', { amount: f.money(x.latest) })}</span>` : ''}${x.tracked ? html` · ${ctx.t('rec.tracked')}` : ''}</small></span></li>`)}</ul>`) : ''}
      ${card(ctx.t('rec.rules'), rules.length ? html`<ul class="rows">${rules.map((r) => html`<li class="${r.active ? '' : 'muted'}"><span><strong>${r.name}</strong><small>${ctx.t(`rec.freq.${r.frequency}`)} · ${ctx.t('rec.next', { date: f.date(r.next_date) })} · ${r.acc}${r.auto_create ? html` · ${ctx.t('rec.auto')}` : html` · ${ctx.t('rec.confirm')}`}</small></span>
        ${f.moneyHtml(r.kind === 'expense' ? -r.amount : r.amount, { sign: r.kind === 'income' })}
        ${r.active ? postButton(ctx, `/recurring/${r.id}/post`, ctx.t('rec.post_now'), { cls: 'sm' }) : ''}
        ${postButton(ctx, `/recurring/${r.id}/toggle`, r.active ? ctx.t('rec.pause') : ctx.t('rec.resume'), { cls: 'sm link' })}
        ${postButton(ctx, `/recurring/${r.id}/delete`, '×', { cls: 'sm link', confirm: ctx.t('common.confirm_delete') })}</li>`)}</ul>` : empty(ctx.t('rec.none')))}
      ${accounts.length ? card(ctx.t('rec.add'), form(ctx, '/recurring', html`<div class="grid3">
        ${field(ctx.t('rec.name'), input({ name: 'name', required: true, maxlength: 80, placeholder: ctx.t('rec.name_ph') }), { id: 'f-name' })}
        ${field(ctx.t('txn.kind'), select('kind', ['expense', 'income', 'transfer'].map((k) => ({ value: k, label: ctx.t(`txn.kind.${k}`) })), 'expense'))}
        ${field(ctx.t('txn.amount'), moneyInput('amount', '', { required: true }), { id: 'f-amount' })}
        ${field(ctx.t('txn.account'), select('account_id', accounts.map((a: any) => ({ value: a.id, label: a.name })), accounts[0].id))}
        ${field(ctx.t('txn.to_account'), select('to_account_id', accounts.map((a: any) => ({ value: a.id, label: a.name })), '', { empty: '—' }))}
        ${field(ctx.t('txn.category'), select('category_id', catOpts, '', { empty: '—' }))}
        ${field(ctx.t('rec.frequency'), select('frequency', FREQS.map((v) => ({ value: v, label: ctx.t(`rec.freq.${v}`) })), 'monthly'))}
        ${field(ctx.t('rec.every'), input({ name: 'interval', type: 'number', min: 1, max: 52, value: 1 }), { id: 'f-interval' })}
        ${field(ctx.t('rec.next_date'), dateInput('next_date', today(), true))}
        ${field(ctx.t('rec.end_date'), dateInput('end_date', ''), { hint: ctx.t('common.optional') })}
        ${debts.length ? field(ctx.t('rec.debt'), select('debt_id', debts.map((d: any) => ({ value: d.id, label: d.name })), '', { empty: '—' })) : ''}
        ${checkbox('auto', ctx.t('rec.auto_label'), false)}</div>`, { submit: ctx.t('common.add') })) : ''}`,
  }));
});

post('/recurring', { access: 'auth' }, async (ctx) => {
  const kind = oneOf(ctx.body.kind, ['income', 'expense', 'transfer'] as const);
  await ctx.as((q) => q.query(`insert into recurring_rules(owner_id, name, kind, amount, account_id, to_account_id, category_id, debt_id, frequency, interval_count, next_date, end_date, auto_create)
     values (hearth_uid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [text(ctx.body.name, 80, true), kind, money(ctx.body.amount, { required: true }), requireUuid(ctx.body.account_id),
    kind === 'transfer' ? uuidOrNull(ctx.body.to_account_id) : null, kind === 'transfer' ? null : uuidOrNull(ctx.body.category_id), uuidOrNull(ctx.body.debt_id),
    oneOf(ctx.body.frequency, FREQS), intIn(ctx.body.interval, 1, 52, 1), date(ctx.body.next_date), optDate(ctx.body.end_date), ctx.body.auto === '1']));
  return redirect(withFlash('/recurring', 'ok', 'saved'));
});

/** Post the next occurrence now (confirm mode, FR-REC-03). */
export async function postOccurrence(q: import('../db/index.ts').Q, r: any) {
  const id = await createTransaction(q, r.owner_id, { kind: r.kind, amount: r.amount, date: r.next_date, accountId: r.account_id, toAccountId: r.to_account_id, categoryId: r.category_id, bucketId: r.bucket_id, payee: r.name, recurringId: r.id, householdId: r.household_id });
  const next = nextOccurrence(r.next_date, r.frequency, r.interval_count);
  await q.query('update recurring_rules set next_date = $2, active = case when end_date is not null and $2::date > end_date then false else active end where id = $1', [r.id, next]);
  return id;
}

post('/recurring/:id/post', { access: 'auth' }, async (ctx) => {
  await ctx.as(async (q) => {
    const r = await q.one<any>('select *, next_date::text next_date from recurring_rules where id = $1 and active', [requireUuid(ctx.params.id)]);
    if (!r) throw new HttpError(404);
    await postOccurrence(q, r);
  });
  return redirect(withFlash('/recurring', 'ok', 'saved'));
});

post('/recurring/:id/toggle', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query('update recurring_rules set active = not active where id = $1 and owner_id = hearth_uid()', [requireUuid(ctx.params.id)]));
  return redirect('/recurring');
});

post('/recurring/:id/delete', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query('delete from recurring_rules where id = $1 and owner_id = hearth_uid()', [requireUuid(ctx.params.id)]));
  return redirect(withFlash('/recurring', 'ok', 'deleted'));
});

export const _u = { icon };
