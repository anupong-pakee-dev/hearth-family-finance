/**
 * Accounts (FR-TXN-12, FR-TXN-10 reconcile) and categories (FR-TXN-03, FR-TXN-09, FR-EMG-02 essential flag).
 */
import { get, post, htmlRes, redirect, withFlash, HttpError } from '../http/app.ts';
import { html, raw } from '../views/html.ts';
import { page, icon } from '../views/layout.ts';
import { field, input, moneyInput, select, form, postButton, empty, card, checkbox } from '../views/ui.ts';
import { makeFmt, inputMoney } from '../views/format.ts';
import { money, text, oneOf, requireUuid, uuidOrNull, scope, cipher, cipherFor, shareTarget, today } from '../services/common.ts';
import { createAccount, createTransaction, ACCOUNT_TYPES } from '../services/finance.ts';

get('/accounts', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const rows = await ctx.as((q) => q.query<any>(`select * from accounts where ${scope(ctx.view)} order by archived, owner_id = hearth_uid() desc, created_at`));
  const total = rows.filter((r) => !r.archived).reduce((s, r) => s + r.balance, 0n);
  const shareOpts = ctx.households.filter((h) => h.role !== 'viewer').map((h) => ({ value: h.id, label: h.name }));
  return htmlRes(page(ctx, {
    title: ctx.t('nav.accounts'),
    actions: html`<a class="btn" href="/categories">${icon('tag')} ${ctx.t('nav.categories')}</a>`,
    body: html`
      ${card(ctx.t('account.list'), rows.length ? html`<ul class="rows">${rows.map((a) => html`<li class="${a.archived ? 'muted' : ''}">
        <a href="/accounts/${a.id}">${icon(a.type === 'credit_card' ? 'card' : a.type === 'cash' ? 'cash' : 'bank')} <span><strong>${a.name}</strong><small>${ctx.t(`account.type.${a.type}`)}${a.household_id ? html` · ${icon('users')} ${ctx.t('common.shared')}` : ''}${a.archived ? html` · ${ctx.t('common.archived')}` : ''}</small></span></a>
        ${f.moneyHtml(a.balance)}</li>`)}</ul>
        <p class="total">${ctx.t('common.total')}: ${f.moneyHtml(total)}</p>` : empty(ctx.t('account.none')))}
      ${card(ctx.t('account.add'), form(ctx, '/accounts', html`<div class="grid3">
        ${field(ctx.t('account.name'), input({ name: 'name', required: true, maxlength: 80 }), { id: 'f-name' })}
        ${field(ctx.t('account.type'), select('type', ACCOUNT_TYPES.map((v) => ({ value: v, label: ctx.t(`account.type.${v}`) })), 'savings'))}
        ${field(ctx.t('account.balance'), moneyInput('opening'), { id: 'f-opening', hint: ctx.t('account.balance_hint') })}
        ${field(ctx.t('account.number'), input({ name: 'account_no', maxlength: 40 }), { id: 'f-account_no', hint: ctx.t('common.encrypted_hint') })}
        ${field(ctx.t('common.currency'), input({ name: 'currency', value: ctx.prefs!.currency, maxlength: 3, pattern: '[A-Za-z]{3}' }), { id: 'f-currency' })}
        ${shareOpts.length ? field(ctx.t('common.share_with'), select('household_id', shareOpts, '', { empty: ctx.t('common.private') })) : ''}
      </div>`, { submit: ctx.t('common.add') }))}`,
  }));
});

post('/accounts', { access: 'auth' }, async (ctx) => {
  const c = cipher(ctx);
  await ctx.as((q) => createAccount(q, ctx.user!.id, {
    name: text(ctx.body.name, 80, true), type: oneOf(ctx.body.type, ACCOUNT_TYPES), opening: money(ctx.body.opening, { allowNegative: true }) ?? 0n,
    householdId: shareTarget(ctx, ctx.body.household_id), accountNoEnc: c.enc(text(ctx.body.account_no, 40)),
    currency: /^[A-Za-z]{3}$/.test(ctx.body.currency ?? '') ? ctx.body.currency.toUpperCase() : ctx.prefs!.currency,
  }));
  return redirect(withFlash('/accounts', 'ok', 'saved'));
});

get('/accounts/:id', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const f = makeFmt(ctx.prefs, ctx.lang);
  const a = await ctx.as((q) => q.one<any>('select * from accounts where id = $1', [id]));
  if (!a) throw new HttpError(404);
  const c = await cipherFor(ctx, a.owner_id);
  const mine = a.owner_id === ctx.user!.id;
  return htmlRes(page(ctx, {
    title: a.name,
    actions: html`<a class="btn" href="/transactions?account=${a.id}">${ctx.t('nav.transactions')}</a>`,
    body: html`
      <section class="stats">${html`<div class="stat"><span class="stat-label">${ctx.t('account.balance_now')}</span><strong class="stat-value">${f.moneyHtml(a.balance)}</strong>${a.reconciled_at ? html`<span class="stat-sub">${ctx.t('account.reconciled_on', { date: f.date(a.reconciled_at) })}</span>` : ''}</div>`}</section>
      ${mine ? card(ctx.t('common.edit'), form(ctx, `/accounts/${id}/edit`, html`<div class="grid3">
        ${field(ctx.t('account.name'), input({ name: 'name', value: a.name, required: true, maxlength: 80 }), { id: 'f-name' })}
        ${field(ctx.t('account.number'), input({ name: 'account_no', value: c.dec(a.account_no_enc), maxlength: 40 }), { id: 'f-account_no' })}
        ${ctx.households.length ? field(ctx.t('common.share_with'), select('household_id', ctx.households.filter((h) => h.role !== 'viewer').map((h) => ({ value: h.id, label: h.name })), a.household_id ?? '', { empty: ctx.t('common.private') })) : ''}
        ${checkbox('is_liquid', ctx.t('account.liquid'), a.is_liquid)}</div>`, { submit: ctx.t('common.save') })) : ''}
      ${card(ctx.t('account.reconcile'), form(ctx, `/accounts/${id}/reconcile`, html`<p>${ctx.t('account.reconcile_intro')}</p>
        ${field(ctx.t('account.statement_balance'), moneyInput('actual', inputMoney(a.balance), { required: true }), { id: 'f-actual' })}`, { submit: ctx.t('account.reconcile') }))}
      ${mine ? html`<div class="row-actions">${postButton(ctx, `/accounts/${id}/archive`, a.archived ? ctx.t('common.unarchive') : ctx.t('common.archive'))}
        ${postButton(ctx, `/accounts/${id}/delete`, ctx.t('common.delete'), { cls: 'danger sm', confirm: ctx.t('account.confirm_delete') })}</div>` : ''}`,
  }));
});

post('/accounts/:id/edit', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const c = cipher(ctx);
  const r = await ctx.as((q) => q.query('update accounts set name = $2, account_no_enc = $3, household_id = $4, is_liquid = $5 where id = $1 and owner_id = hearth_uid() returning id',
    [id, text(ctx.body.name, 80, true), c.enc(text(ctx.body.account_no, 40)), shareTarget(ctx, ctx.body.household_id), ctx.body.is_liquid === '1']));
  if (!r.length) throw new HttpError(404);
  return redirect(withFlash(`/accounts/${id}`, 'ok', 'saved'));
});

/** Reconcile: record the difference as an adjustment transaction (FR-TXN-10). */
post('/accounts/:id/reconcile', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const actual = money(ctx.body.actual, { required: true, allowNegative: true, allowZero: true })!;
  await ctx.as(async (q) => {
    const a = await q.one<any>('select balance, owner_id, household_id from accounts where id = $1', [id]);
    if (!a) throw new HttpError(404);
    const diff = actual - a.balance;
    if (diff !== 0n) await createTransaction(q, a.owner_id, { kind: diff > 0n ? 'income' : 'expense', amount: diff > 0n ? diff : -diff, date: today(), accountId: id, payee: ctx.t('account.adjustment'), householdId: a.household_id });
    await q.query('update accounts set reconciled_balance = $2, reconciled_at = $3 where id = $1', [id, actual, today()]);
  });
  return redirect(withFlash(`/accounts/${id}`, 'ok', 'reconciled'));
});

post('/accounts/:id/archive', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  await ctx.as((q) => q.query('update accounts set archived = not archived where id = $1 and owner_id = hearth_uid()', [id]));
  return redirect(withFlash('/accounts', 'ok', 'saved'));
});

post('/accounts/:id/delete', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const r = await ctx.as((q) => q.query('delete from accounts where id = $1 and owner_id = hearth_uid() returning id', [id]));
  if (!r.length) throw new HttpError(404);
  return redirect(withFlash('/accounts', 'ok', 'deleted'));
});

// ───────────── Categories ─────────────
get('/categories', { access: 'auth' }, async (ctx) => {
  const { cats, rules } = await ctx.as(async (q) => ({
    cats: await q.query<any>('select * from categories where owner_id = hearth_uid() and not archived order by kind, parent_id nulls first, sort'),
    rules: await q.query<any>('select r.id, r.pattern, c.name from categorize_rules r join categories c on c.id = r.category_id where r.owner_id = hearth_uid()'),
  }));
  const parents = cats.filter((c) => !c.parent_id);
  const opts = cats.map((c) => ({ value: c.id, label: c.parent_id ? `${cats.find((p) => p.id === c.parent_id)?.name ?? ''} › ${c.name}` : c.name, group: ctx.t(`txn.kind.${c.kind}`) }));
  return htmlRes(page(ctx, {
    title: ctx.t('nav.categories'),
    body: html`
      ${(['expense', 'income'] as const).map((kind) => card(ctx.t(`txn.kind.${kind}`), html`<ul class="cat-tree">${parents.filter((p) => p.kind === kind).map((p) => html`<li>
        <div class="cat-row"><strong>${p.name}</strong>${p.essential ? html`<span class="tag">${ctx.t('cat.essential')}</span>` : ''}
          ${kind === 'expense' ? postButton(ctx, `/categories/${p.id}/essential`, p.essential ? ctx.t('cat.unmark_essential') : ctx.t('cat.mark_essential'), { cls: 'sm link' }) : ''}
          ${postButton(ctx, `/categories/${p.id}/archive`, ctx.t('common.remove'), { cls: 'sm link', confirm: ctx.t('common.confirm_delete') })}</div>
        <ul>${cats.filter((c) => c.parent_id === p.id).map((c) => html`<li><div class="cat-row">${c.name}${c.essential ? html`<span class="tag">${ctx.t('cat.essential')}</span>` : ''}
          ${kind === 'expense' ? postButton(ctx, `/categories/${c.id}/essential`, c.essential ? ctx.t('cat.unmark_essential') : ctx.t('cat.mark_essential'), { cls: 'sm link' }) : ''}
          ${postButton(ctx, `/categories/${c.id}/archive`, ctx.t('common.remove'), { cls: 'sm link' })}</div></li>`)}</ul></li>`)}</ul>`))}
      ${card(ctx.t('cat.add'), form(ctx, '/categories', html`<div class="grid3">
        ${field(ctx.t('cat.name'), input({ name: 'name', required: true, maxlength: 60 }), { id: 'f-name' })}
        ${field(ctx.t('txn.kind'), select('kind', [{ value: 'expense', label: ctx.t('txn.kind.expense') }, { value: 'income', label: ctx.t('txn.kind.income') }], 'expense'))}
        ${field(ctx.t('cat.parent'), select('parent_id', parents.map((p) => ({ value: p.id, label: p.name, group: ctx.t(`txn.kind.${p.kind}`) })), '', { empty: ctx.t('cat.top_level') }))}
        ${checkbox('essential', ctx.t('cat.essential'), false)}</div>`, { submit: ctx.t('common.add') }))}
      ${card(ctx.t('cat.rules'), html`<p class="note">${ctx.t('cat.rules_intro')}</p>
        ${rules.length ? html`<ul class="rows">${rules.map((r) => html`<li><span>“${r.pattern}” → ${r.name}</span>${postButton(ctx, `/categories/rules/${r.id}/delete`, ctx.t('common.remove'), { cls: 'sm link' })}</li>`)}</ul>` : ''}
        ${form(ctx, '/categories/rules', html`<div class="grid2">${field(ctx.t('cat.rule_pattern'), input({ name: 'pattern', required: true, maxlength: 60 }), { id: 'f-pattern' })}${field(ctx.t('txn.category'), select('category_id', opts, '', { required: true }))}</div>`, { submit: ctx.t('common.add') })}`)}`,
  }));
});

post('/categories', { access: 'auth' }, async (ctx) => {
  const parent = uuidOrNull(ctx.body.parent_id);
  await ctx.as(async (q) => {
    let kind = oneOf(ctx.body.kind, ['expense', 'income'] as const);
    if (parent) {
      const p = await q.one<any>('select kind from categories where id = $1 and owner_id = hearth_uid()', [parent]);
      if (!p) throw new HttpError(404);
      kind = p.kind;
    }
    await q.query('insert into categories(owner_id, parent_id, name, kind, essential, sort) values (hearth_uid(), $1, $2, $3, $4, 999)', [parent, text(ctx.body.name, 60, true), kind, ctx.body.essential === '1']);
  });
  return redirect(withFlash('/categories', 'ok', 'saved'));
});

post('/categories/:id/essential', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query('update categories set essential = not essential where id = $1 and owner_id = hearth_uid()', [requireUuid(ctx.params.id)]));
  return redirect('/categories');
});

post('/categories/:id/archive', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query('update categories set archived = true where (id = $1 or parent_id = $1) and owner_id = hearth_uid()', [requireUuid(ctx.params.id)]));
  return redirect(withFlash('/categories', 'ok', 'deleted'));
});

post('/categories/rules', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query('insert into categorize_rules(owner_id, pattern, category_id) select hearth_uid(), $1, id from categories where id = $2 and owner_id = hearth_uid()', [text(ctx.body.pattern, 60, true), requireUuid(ctx.body.category_id)]));
  return redirect(withFlash('/categories', 'ok', 'saved'));
});

post('/categories/rules/:id/delete', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query('delete from categorize_rules where id = $1 and owner_id = hearth_uid()', [requireUuid(ctx.params.id)]));
  return redirect('/categories');
});

export const _raw = raw;
