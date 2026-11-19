/**
 * Money buckets (§4.2). Only reachable when bucket mode ≠ off (module: 'buckets').
 */
import { get, post, htmlRes, redirect, withFlash, HttpError, type Ctx } from '../http/app.ts';
import { html, raw } from '../views/html.ts';
import { page, icon } from '../views/layout.ts';
import { field, input, moneyInput, rateInput, select, form, postButton, empty, card, meter } from '../views/ui.ts';
import { makeFmt, inputMoney, inputRate } from '../views/format.ts';
import { money, text, oneOf, requireUuid, uuidOrNull, scope, shareTarget, activity, intIn, BUCKETS_JOINED } from '../services/common.ts';
import { bucketMove, applyBucketTemplate, BUCKET_TYPES } from '../services/finance.ts';
import { BUCKET_TEMPLATES, distribute, toMajorNumber, parseRateE4 } from '@hearth/engine';

async function unallocated(ctx: Ctx) {
  return ctx.as(async (q) => {
    const a = await q.one<{ s: bigint }>(`select coalesce(sum(balance),0)::bigint s from accounts where owner_id = hearth_uid() and not archived and type not in ('credit_card','investment')`);
    const b = await q.one<{ s: bigint }>(`select coalesce(sum(balance),0)::bigint s from buckets where owner_id = hearth_uid() and not archived`);
    return a!.s - b!.s;
  });
}

function bucketFields(ctx: Ctx, b: any = {}, accounts: any[] = [], portfolios: any[] = []) {
  const shareOpts = ctx.households.filter((h) => h.role !== 'viewer').map((h) => ({ value: h.id, label: h.name }));
  return html`<div class="grid3">
    ${field(ctx.t('bucket.name'), input({ name: 'name', value: b.name, required: true, maxlength: 60 }), { id: 'f-name' })}
    ${field(ctx.t('bucket.type'), select('type', BUCKET_TYPES.map((v) => ({ value: v, label: ctx.t(`bucket.type.${v}`) })), b.type ?? 'spending'))}
    ${field(ctx.t('bucket.monthly_target'), moneyInput('monthly_target', inputMoney(b.monthly_target)), { id: 'f-monthly_target', hint: ctx.t('common.optional') })}
    ${field(ctx.t('bucket.rollover'), select('rollover_policy', ['carry', 'return', 'to_bucket'].map((v) => ({ value: v, label: ctx.t(`bucket.rollover.${v}`) })), b.rollover_policy ?? 'carry'))}
    ${field(ctx.t('bucket.color'), input({ name: 'color', type: 'color', value: b.color ?? '#2f6f5e' }), { id: 'f-color' })}
    ${accounts.length ? field(ctx.t('bucket.linked_account'), select('linked_account_id', accounts.map((a) => ({ value: a.id, label: a.name })), b.linked_account_id ?? '', { empty: '—' }), { hint: ctx.t('common.optional') }) : ''}
    ${portfolios.length ? field(ctx.t('bucket.linked_portfolio'), select('linked_portfolio_id', portfolios.map((a) => ({ value: a.id, label: a.name })), b.linked_portfolio_id ?? '', { empty: '—' }), { hint: ctx.t('bucket.linked_portfolio_hint') }) : ''}
    ${shareOpts.length ? field(ctx.t('common.share_with'), select('household_id', shareOpts, b.household_id ?? '', { empty: ctx.t('common.private') })) : ''}
  </div>
  <fieldset><legend>${ctx.t('bucket.auto_rule')}</legend><p class="note">${ctx.t('bucket.auto_rule_hint')}</p><div class="grid3">
    ${field(ctx.t('bucket.auto_percent'), rateInput('auto_percent', b.auto_percent_e4 != null ? inputRate(b.auto_percent_e4) : ''))}
    ${field(ctx.t('bucket.auto_fixed'), moneyInput('auto_fixed', inputMoney(b.auto_fixed)), { id: 'f-auto_fixed' })}
    ${field(ctx.t('bucket.auto_priority'), input({ name: 'auto_priority', type: 'number', min: 1, max: 99, value: b.auto_priority }), { id: 'f-auto_priority', hint: ctx.t('bucket.auto_priority_hint') })}
  </div></fieldset>`;
}

function parseBucket(ctx: Ctx) {
  const pct = ctx.body.auto_percent ? parseRateE4(ctx.body.auto_percent) : null;
  if (pct != null && (pct < 0 || pct > 1_000_000)) throw new HttpError(422, 'rate');
  return {
    name: text(ctx.body.name, 60, true),
    type: oneOf(ctx.body.type, BUCKET_TYPES),
    monthly_target: money(ctx.body.monthly_target),
    rollover_policy: oneOf(ctx.body.rollover_policy, ['carry', 'return', 'to_bucket'] as const, 'carry'),
    color: /^#[0-9a-fA-F]{6}$/.test(ctx.body.color ?? '') ? ctx.body.color : '#2f6f5e',
    linked_account_id: uuidOrNull(ctx.body.linked_account_id),
    linked_portfolio_id: uuidOrNull(ctx.body.linked_portfolio_id),
    household_id: shareTarget(ctx, ctx.body.household_id),
    auto_percent_e4: pct,
    auto_fixed: money(ctx.body.auto_fixed),
    auto_priority: ctx.body.auto_priority ? intIn(ctx.body.auto_priority, 1, 99, 1) : null,
  };
}

get('/buckets', { access: 'auth', module: 'buckets' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const mode = ctx.prefs!.bucket_mode;
  const [rows, accounts, portfolios, free] = await Promise.all([
    ctx.as((q) => q.query<any>(`select * from buckets where not archived and ${scope(ctx.view)} and ${BUCKETS_JOINED} order by sort, created_at`)),
    ctx.as((q) => q.query<any>('select id, name from accounts where not archived and owner_id = hearth_uid()')),
    ctx.prefs!.investment_enabled ? ctx.as((q) => q.query<any>('select id, name from portfolios where not archived and owner_id = hearth_uid()')) : Promise.resolve([]),
    unallocated(ctx),
  ]);
  const negatives = rows.filter((b) => b.balance < 0n);
  const donors = rows.filter((b) => b.balance > 0n).sort((a, b) => (a.balance > b.balance ? -1 : 1));
  const opts = [{ value: '', label: ctx.t('bucket.unallocated') }, ...rows.map((b) => ({ value: b.id, label: `${b.name} (${f.money(b.balance)})` }))];
  return htmlRes(page(ctx, {
    title: ctx.t('nav.buckets'),
    body: html`
      <section class="stats">
        <div class="stat ${mode === 'full' && free !== 0n ? 'warn' : ''}"><span class="stat-label">${ctx.t('bucket.to_allocate')}</span><strong class="stat-value">${f.moneyHtml(free)}</strong>
          <span class="stat-sub">${mode === 'full' ? (free !== 0n ? ctx.t('bucket.full_warn') : ctx.t('bucket.all_allocated')) : ctx.t('bucket.partial_info')}</span></div>
        <div class="stat"><span class="stat-label">${ctx.t('bucket.mode_label')}</span><strong class="stat-value">${ctx.t(`bucket.mode.${mode}`)}</strong><span class="stat-sub"><a href="/settings#buckets">${ctx.t('common.change')}</a></span></div>
      </section>
      ${negatives.map((b) => html`<p class="flash err" role="alert">${ctx.t('bucket.negative_alert', { name: b.name, amount: f.money(0n - (b.balance as bigint)) })}
        ${donors[0] ? postButton(ctx, '/buckets/move', ctx.t('bucket.pull_from', { name: donors[0].name }), { fields: { from: donors[0].id, to: b.id, amount: inputMoney(-b.balance < donors[0].balance ? -b.balance : donors[0].balance) } }) : ''}</p>`)}
      ${card(ctx.t('nav.buckets'), rows.length ? html`<ul class="bucket-list big">${rows.map((b) => html`<li>
        <a href="/buckets/${b.id}"><span class="dot" data-type="${b.type}"></span><strong>${b.name}</strong><small>${ctx.t(`bucket.type.${b.type}`)}${b.household_id ? html` · ${icon('users')}` : ''}${b.auto_percent_e4 != null ? html` · ${inputRate(b.auto_percent_e4)}%` : ''}</small></a>
        <span class="amt ${b.balance < 0n ? 'neg' : ''}">${f.money(b.balance)}</span>
        ${b.monthly_target ? html`${meter(toMajorNumber(b.balance), toMajorNumber(b.monthly_target), b.name, { low: toMajorNumber(b.monthly_target) * 0.3, optimum: toMajorNumber(b.monthly_target) })}<small>${ctx.t('bucket.of_target', { target: f.money(b.monthly_target) })}</small>` : ''}
      </li>`)}</ul>` : empty(ctx.t('bucket.none')))}
      ${rows.length ? card(ctx.t('bucket.move'), form(ctx, '/buckets/move', html`<div class="grid3">
        ${field(ctx.t('bucket.from'), select('from', opts, ''))}${field(ctx.t('bucket.to'), select('to', opts, rows[0]?.id))}${field(ctx.t('txn.amount'), moneyInput('amount', '', { required: true }), { id: 'f-amount' })}</div>`, { submit: ctx.t('bucket.move_btn') })) : ''}
      ${card(ctx.t('bucket.template'), form(ctx, '/buckets/template', html`<p class="note">${ctx.t('bucket.template_hint')}</p>
        ${field(ctx.t('bucket.template'), select('template', Object.keys(BUCKET_TEMPLATES).map((k) => ({ value: k, label: ctx.t(`bucket.tpl.${k}_name`) })), mode === 'partial' ? 'save_emergency_invest' : '50_30_20'))}`, { submit: ctx.t('bucket.apply_template') }))}
      ${card(ctx.t('bucket.create'), form(ctx, '/buckets', bucketFields(ctx, {}, accounts, portfolios), { submit: ctx.t('common.add') }))}`,
  }));
});

post('/buckets', { access: 'auth', module: 'buckets' }, async (ctx) => {
  const b = parseBucket(ctx);
  await ctx.as(async (q) => {
    const r = await q.one<any>(`insert into buckets(owner_id, household_id, name, type, monthly_target, rollover_policy, color, linked_account_id, linked_portfolio_id, auto_percent_e4, auto_fixed, auto_priority)
      values (hearth_uid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, [b.household_id, b.name, b.type, b.monthly_target, b.rollover_policy, b.color, b.linked_account_id, b.linked_portfolio_id, b.auto_percent_e4, b.auto_fixed, b.auto_priority]);
    await activity(q, ctx, b.household_id, 'create', 'bucket', r.id, b.name);
  });
  return redirect(withFlash('/buckets', 'ok', 'saved'));
});

/** Manual allocation / move between buckets (FR-BKT-04). Empty "from" = unallocated money. */
post('/buckets/move', { access: 'auth', module: 'buckets' }, async (ctx) => {
  const from = uuidOrNull(ctx.body.from);
  const to = uuidOrNull(ctx.body.to);
  const amount = money(ctx.body.amount, { required: true })!;
  if (from === to) throw new HttpError(422, 'invalid');
  await ctx.as(async (q) => {
    if (from) await bucketMove(q, ctx.user!.id, from, -amount, to ? 'move' : 'adjust');
    if (to) await bucketMove(q, ctx.user!.id, to, amount, from ? 'move' : 'allocate');
  });
  return redirect(withFlash('/buckets', 'ok', 'moved'));
});

post('/buckets/template', { access: 'auth', module: 'buckets' }, async (ctx) => {
  const key = oneOf(ctx.body.template, Object.keys(BUCKET_TEMPLATES));
  await ctx.as((q) => applyBucketTemplate(q, ctx.user!.id, key, ctx.t));
  return redirect(withFlash('/buckets', 'ok', 'saved'));
});

/** Wizard after turning buckets on: spread current unallocated money by auto % (FR-BKT-00b). */
get('/buckets/wizard', { access: 'auth', module: 'buckets' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const free = await unallocated(ctx);
  const rows = await ctx.as((q) => q.query<any>('select id, name, auto_percent_e4 from buckets where not archived and owner_id = hearth_uid() order by sort'));
  const weights = rows.map((r) => r.auto_percent_e4 ?? 0);
  const shares = free > 0n && weights.some((w) => w > 0) ? distribute(free, weights) : rows.map(() => 0n);
  return htmlRes(page(ctx, {
    title: ctx.t('bucket.wizard'),
    body: card(null, form(ctx, '/buckets/wizard', html`<p>${ctx.t('bucket.wizard_intro', { amount: f.money(free) })}</p>
      ${rows.map((r, i) => field(r.name, moneyInput(`amt_${r.id}`, inputMoney(shares[i]), { id: `f-amt_${r.id}` }), { id: `f-amt_${r.id}` }))}`, { submit: ctx.t('bucket.allocate_now') })),
  }));
});

post('/buckets/wizard', { access: 'auth', module: 'buckets' }, async (ctx) => {
  await ctx.as(async (q) => {
    const rows = await q.query<any>('select id from buckets where not archived and owner_id = hearth_uid()');
    for (const r of rows) {
      const amt = money(ctx.body[`amt_${r.id}`]);
      if (amt && amt > 0n) await bucketMove(q, ctx.user!.id, r.id, amt, 'allocate');
    }
  });
  return redirect(withFlash('/buckets', 'ok', 'saved'));
});

get('/buckets/:id', { access: 'auth', module: 'buckets' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const f = makeFmt(ctx.prefs, ctx.lang);
  const { b, moves, accounts, portfolios, contrib } = await ctx.as(async (q) => {
    const b = await q.one<any>('select * from buckets where id = $1', [id]);
    if (!b) throw new HttpError(404);
    return {
      b,
      moves: await q.query<any>(`select m.*, t.payee from bucket_movements m left join transactions t on t.id = m.transaction_id where m.bucket_id = $1 order by m.created_at desc limit 100`, [id]),
      accounts: await q.query<any>('select id, name from accounts where not archived and owner_id = hearth_uid()'),
      portfolios: ctx.prefs!.investment_enabled ? await q.query<any>('select id, name from portfolios where owner_id = hearth_uid()') : [],
      contrib: b.household_id ? await q.query<any>(`select coalesce(mem.display_name, '?') name, sum(m.amount)::bigint total from bucket_movements m left join members mem on mem.user_id = m.created_by and mem.household_id = $2
          where m.bucket_id = $1 and m.amount > 0 group by 1 order by 2 desc`, [id, b.household_id]) : [],
    };
  });
  const mine = b.owner_id === ctx.user!.id;
  return htmlRes(page(ctx, {
    title: b.name,
    body: html`
      <section class="stats"><div class="stat"><span class="stat-label">${ctx.t('bucket.balance')}</span><strong class="stat-value">${f.moneyHtml(b.balance)}</strong>${b.monthly_target ? html`<span class="stat-sub">${ctx.t('bucket.of_target', { target: f.money(b.monthly_target) })}</span>` : ''}</div></section>
      ${contrib.length ? card(ctx.t('bucket.contributions'), html`<ul class="rows">${contrib.map((c) => html`<li><span>${c.name}</span>${f.moneyHtml(c.total)}</li>`)}</ul>`) : ''}
      ${card(ctx.t('bucket.history'), moves.length ? html`<ul class="rows">${moves.map((m) => html`<li><span>${f.date(m.created_at)} · ${ctx.t(`bucket.kind.${m.kind}`)}${m.payee ? html` · ${m.payee}` : ''}${m.note ? html` · ${m.note}` : ''}</span>${f.moneyHtml(m.amount, { sign: true })}</li>`)}</ul>` : empty(ctx.t('common.no_data')))}
      ${mine ? card(ctx.t('common.edit'), form(ctx, `/buckets/${id}/edit`, bucketFields(ctx, b, accounts, portfolios), { submit: ctx.t('common.save') })) : ''}
      ${mine ? html`<p class="row-actions">${postButton(ctx, `/buckets/${id}/archive`, ctx.t('common.archive'))} ${postButton(ctx, `/buckets/${id}/delete`, ctx.t('common.delete'), { cls: 'danger sm', confirm: ctx.t('bucket.confirm_delete') })}</p>` : ''}`,
  }));
});

post('/buckets/:id/edit', { access: 'auth', module: 'buckets' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const b = parseBucket(ctx);
  const r = await ctx.as((q) => q.query(`update buckets set name=$2, type=$3, monthly_target=$4, rollover_policy=$5, color=$6, linked_account_id=$7, linked_portfolio_id=$8, household_id=$9, auto_percent_e4=$10, auto_fixed=$11, auto_priority=$12
     where id = $1 and owner_id = hearth_uid() returning id`, [id, b.name, b.type, b.monthly_target, b.rollover_policy, b.color, b.linked_account_id, b.linked_portfolio_id, b.household_id, b.auto_percent_e4, b.auto_fixed, b.auto_priority]));
  if (!r.length) throw new HttpError(404);
  return redirect(withFlash(`/buckets/${id}`, 'ok', 'saved'));
});

post('/buckets/:id/archive', { access: 'auth', module: 'buckets' }, async (ctx) => {
  await ctx.as((q) => q.query('update buckets set archived = true where id = $1 and owner_id = hearth_uid()', [requireUuid(ctx.params.id)]));
  return redirect(withFlash('/buckets', 'ok', 'saved'));
});

post('/buckets/:id/delete', { access: 'auth', module: 'buckets' }, async (ctx) => {
  const r = await ctx.as((q) => q.query('delete from buckets where id = $1 and owner_id = hearth_uid() returning id', [requireUuid(ctx.params.id)]));
  if (!r.length) throw new HttpError(404);
  return redirect(withFlash('/buckets', 'ok', 'deleted'));
});

export const _r = raw;
