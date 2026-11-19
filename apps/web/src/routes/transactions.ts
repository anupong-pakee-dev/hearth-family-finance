/**
 * Income / expense / transfer (FR-TXN-*), CSV import with column mapping + duplicate detection (FR-IO-01/03).
 */
import { createHash } from 'node:crypto';
import { get, post, htmlRes, redirect, withFlash, HttpError, type Ctx } from '../http/app.ts';
import { html, raw, type SafeHtml } from '../views/html.ts';
import { page, icon, csrfField } from '../views/layout.ts';
import { field, input, moneyInput, dateInput, select, form, postButton, empty, pager, card } from '../views/ui.ts';
import { makeFmt, inputMoney } from '../views/format.ts';
import { money, date, text, oneOf, uuidOrNull, requireUuid, scope, cipher, cipherFor, shareTarget, activity, today, notify, BUCKETS_JOINED } from '../services/common.ts';
import { createTransaction, applyLines } from '../services/finance.ts';
import { sanitize, MAX_ATTACHMENT } from '../services/attachments.ts';
import { registry } from '../services/plugins.ts';
import { parseMoney, isIsoDate } from '@hearth/engine';

const SPLIT_ROWS = 4;

const KINDS = ['expense', 'income', 'transfer'] as const;
const PAGE = 50;

async function lookups(ctx: Ctx) {
  return ctx.as(async (q) => ({
    accounts: await q.query<any>(`select id, name, type, owner_id, currency from accounts where not archived order by owner_id = hearth_uid() desc, created_at`),
    members: ctx.households.length ? await q.query<any>(`select distinct on (user_id) user_id, display_name from members where user_id is not null and household_id = any($1::uuid[]) order by user_id`, [ctx.households.map((h) => h.id)]) : [],
    categories: await q.query<any>(`select c.id, c.name, c.kind, p.name parent from categories c left join categories p on p.id = c.parent_id where not c.archived and c.owner_id = hearth_uid() order by c.kind, coalesce(p.sort, c.sort), c.parent_id nulls first, c.sort`),
    buckets: ctx.prefs!.bucket_mode !== 'off' ? await q.query<any>(`select id, name, balance from buckets where not archived and ${BUCKETS_JOINED} order by sort, created_at`) : [],
  }));
}

function categoryOptions(ctx: Ctx, cats: any[], kind?: string) {
  return cats.filter((c) => !kind || c.kind === kind).map((c) => ({ value: c.id, label: c.parent ? `${c.parent} › ${c.name}` : c.name, group: ctx.t(`txn.kind.${c.kind}`) }));
}

function txnForm(ctx: Ctx, lk: Awaited<ReturnType<typeof lookups>>, v: any = {}, action = '/transactions') {
  const kind = v.kind ?? ctx.query.get('kind') ?? 'expense';
  const accOpts = lk.accounts.map((a) => ({ value: a.id, label: a.currency !== ctx.prefs!.currency ? `${a.name} (${a.currency})` : a.name }));
  const foreign = lk.accounts.some((a) => a.currency !== ctx.prefs!.currency);
  const splits: any[] = v.splits ?? [];
  const catOpts = categoryOptions(ctx, lk.categories);
  return form(ctx, action, html`
    <fieldset class="seg" role="radiogroup" aria-label="${ctx.t('txn.kind')}">
      ${KINDS.map((k) => html`<label><input type="radio" name="kind" value="${k}" ${kind === k ? raw('checked') : ''}><span>${ctx.t(`txn.kind.${k}`)}</span></label>`)}
    </fieldset>
    <div class="amount-row">${field(ctx.t('txn.amount'), moneyInput('amount', v.amount != null ? inputMoney(v.amount) : '', { required: true, autofocus: !v.id, id: 'f-amount' }), { id: 'f-amount' })}</div>
    <div class="grid2">
      ${field(ctx.t('txn.category'), select('category_id', categoryOptions(ctx, lk.categories), v.category_id ?? '', { empty: ctx.t('txn.uncategorized') }), { hint: ctx.t('txn.category_hint') })}
      ${field(ctx.t('txn.date'), dateInput('date', v.date ?? today(), true), { id: 'f-date' })}
      ${field(ctx.t('txn.account'), select('account_id', accOpts, v.account_id ?? lk.accounts[0]?.id, { required: true }))}
      ${field(ctx.t('txn.to_account'), select('to_account_id', accOpts, v.to_account_id ?? '', { empty: '—' }), { hint: ctx.t('txn.to_account_hint') })}
      ${lk.buckets.length ? field(ctx.t('txn.bucket'), select('bucket_id', lk.buckets.map((b) => ({ value: b.id, label: b.name })), v.bucket_id ?? '', { empty: ctx.t('txn.no_bucket') }), { hint: ctx.prefs!.bucket_mode === 'full' ? ctx.t('txn.bucket_hint_full') : ctx.t('common.optional') }) : ''}
      ${field(ctx.t('txn.payee'), input({ name: 'payee', value: v.payee, maxlength: 120, autocomplete: 'off' }), { id: 'f-payee' })}
    </div>
    <details ${v.note || v.tags?.length ? raw('open') : ''}><summary>${ctx.t('common.more_fields')}</summary>
      ${field(ctx.t('txn.note'), html`<textarea id="f-note" name="note" rows="2" maxlength="1000">${v.note ?? ''}</textarea>`, { id: 'f-note', hint: ctx.t('common.encrypted_hint') })}
      ${field(ctx.t('txn.tags'), input({ name: 'tags', value: (v.tags ?? []).join(', '), maxlength: 200 }), { id: 'f-tags', hint: ctx.t('txn.tags_hint') })}
      ${ctx.households.length ? field(ctx.t('common.share_with'), select('household_id', ctx.households.filter((h) => h.role !== 'viewer').map((h) => ({ value: h.id, label: h.name })), v.household_id ?? '', { empty: ctx.t('common.private') })) : ''}
      ${foreign ? field(ctx.t('txn.fx_rate'), input({ name: 'fx_rate', value: v.fx_rate ?? '', inputmode: 'decimal', pattern: '[0-9]*[.]?[0-9]{0,10}' }), { hint: ctx.t('txn.fx_rate_hint', { cur: ctx.prefs!.currency }) }) : ''}
      ${field(ctx.t('txn.receipt'), html`<input id="f-receipt" type="file" name="receipt" accept="image/jpeg,image/png,image/webp,application/pdf">`, { hint: ctx.t('txn.receipt_hint') })}
      ${!v.id ? field(ctx.t('txn.scan_qr'), html`<input id="f-qr" type="file" accept="image/*" data-qr>`, { hint: ctx.t('txn.scan_qr_hint') }) : ''}
    </details>
    <details ${splits.length ? raw('open') : ''}><summary>${ctx.t('txn.split')}</summary>
      <p class="note">${ctx.t('txn.split_hint')}</p>
      ${Array.from({ length: SPLIT_ROWS }, (_, i) => html`<div class="grid3 split-row">
        ${field(`${ctx.t('txn.category')} #${i + 1}`, select(`split_cat_${i}`, catOpts, splits[i]?.category_id ?? '', { empty: '—' }))}
        ${lk.buckets.length ? field(`${ctx.t('txn.bucket')} #${i + 1}`, select(`split_bucket_${i}`, lk.buckets.map((b) => ({ value: b.id, label: b.name })), splits[i]?.bucket_id ?? '', { empty: '—' })) : ''}
        ${field(`${ctx.t('txn.amount')} #${i + 1}`, moneyInput(`split_amt_${i}`, splits[i] ? inputMoney(splits[i].amount) : '', { id: `f-split_amt_${i}` }))}
      </div>`)}
    </details>`, { submit: v.id ? ctx.t('common.save') : ctx.t('txn.save'), cls: 'stack txn-form', multipart: true });
}

function parseTxn(ctx: Ctx) {
  const kind = oneOf(ctx.body.kind, KINDS);
  return {
    kind,
    amount: money(ctx.body.amount, { required: true })!,
    date: date(ctx.body.date, today()),
    accountId: requireUuid(ctx.body.account_id),
    toAccountId: kind === 'transfer' ? uuidOrNull(ctx.body.to_account_id) : null,
    categoryId: kind === 'transfer' ? null : uuidOrNull(ctx.body.category_id),
    bucketId: ctx.prefs!.bucket_mode === 'off' ? null : uuidOrNull(ctx.body.bucket_id),
    payee: text(ctx.body.payee, 120) || null,
    note: text(ctx.body.note, 1000),
    tags: text(ctx.body.tags, 200).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10),
    householdId: shareTarget(ctx, ctx.body.household_id),
    splits: kind === 'transfer' ? [] : parseSplits(ctx),
    fxRate: /^\d{1,10}(\.\d{1,10})?$/.test((ctx.body.fx_rate ?? '').trim()) && Number(ctx.body.fx_rate) > 0 ? ctx.body.fx_rate.trim() : null,
  };
}

function parseSplits(ctx: Ctx) {
  const out: { categoryId: string | null; bucketId: string | null; amount: bigint }[] = [];
  for (let i = 0; i < SPLIT_ROWS; i++) {
    const amt = money(ctx.body[`split_amt_${i}`]);
    if (!amt) continue;
    out.push({ categoryId: uuidOrNull(ctx.body[`split_cat_${i}`]), bucketId: ctx.prefs!.bucket_mode === 'off' ? null : uuidOrNull(ctx.body[`split_bucket_${i}`]), amount: amt });
  }
  return out;
}

/** Store the uploaded receipt, encrypted with the owner's data key (FR-TXN-05, NFR-SEC-24). */
async function saveReceipt(ctx: Ctx, q: import('../db/index.ts').Q, txnId: string, ownerId: string, householdId: string | null, c: ReturnType<typeof cipher>) {
  const f = ctx.files.find((x) => x.field === 'receipt');
  if (!f) return;
  const clean = sanitize(f.data);
  if (!clean) throw new HttpError(422, 'attachment');
  const enc = c.enc(clean.data.toString('base64'));
  await q.query('insert into attachments(owner_id, household_id, transaction_id, mime, size, data_enc) values ($1,$2,$3,$4,$5,$6)', [ownerId, householdId, txnId, clean.type, clean.data.length, enc]);
}

get('/transactions/new', { access: 'auth' }, async (ctx) => {
  const lk = await lookups(ctx);
  if (!lk.accounts.length) return redirect(withFlash('/accounts', 'err', 'need_account'));
  return htmlRes(page(ctx, { title: ctx.t('txn.add'), body: card(null, txnForm(ctx, lk)), scripts: ['qr.js'] }));
});

post('/transactions', { access: 'auth', upload: MAX_ATTACHMENT + 256 * 1024 }, async (ctx) => {
  const v = parseTxn(ctx);
  const c = cipher(ctx);
  const id = await ctx.as(async (q) => {
    const id = await createTransaction(q, ctx.user!.id, { ...v, noteEnc: c.enc(v.note) }, { autoAllocate: ctx.prefs!.bucket_mode !== 'off' });
    await saveReceipt(ctx, q, id, ctx.user!.id, v.householdId, c);
    await activity(q, ctx, v.householdId, 'create', 'transaction', id, `${v.kind} ${v.date}`);
    if (v.householdId) {
      const others = await q.query<{ user_id: string }>('select user_id from members where household_id = $1 and user_id is not null and user_id <> hearth_uid()', [v.householdId]);
      for (const o of others) await notify(q, o.user_id, 'household_txn', ctx.t('noti.household_txn', { name: ctx.user!.display_name }), v.payee ?? '', '/transactions').catch(() => {});
    }
    return id;
  });
  const warn = ctx.prefs!.bucket_mode === 'full' && !v.bucketId && v.kind === 'expense';
  return redirect(warn ? withFlash('/transactions', 'err', 'bucket_missing') : withFlash('/transactions', 'ok', 'saved'));
});

get('/transactions', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const qp = ctx.query;
  const pageNo = Math.max(1, Math.min(10_000, Number.parseInt(qp.get('page') ?? '1', 10) || 1));
  const where: string[] = [scope(ctx.view, 't')];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
  if (qp.get('from') && isIsoDate(qp.get('from'))) add('t.date >= ?', qp.get('from'));
  if (qp.get('to') && isIsoDate(qp.get('to'))) add('t.date <= ?', qp.get('to'));
  if (KINDS.includes(qp.get('kind') as any)) add('t.kind = ?', qp.get('kind'));
  const cat = qp.get('category'); if (cat && /^[0-9a-f-]{36}$/.test(cat)) add('(t.category_id = ? or t.category_id in (select id from categories where parent_id = ?) or exists (select 1 from transaction_splits s left join categories sc on sc.id = s.category_id where s.transaction_id = t.id and (s.category_id = ? or sc.parent_id = ?)))', cat);
  const who = qp.get('who'); if (who && /^[0-9a-f-]{36}$/.test(who)) add('t.created_by = ?', who);
  const acc = qp.get('account'); if (acc && /^[0-9a-f-]{36}$/.test(acc)) add('(t.account_id = ? or t.to_account_id = ?)', acc);
  const bkt = qp.get('bucket'); if (bkt && /^[0-9a-f-]{36}$/.test(bkt)) add('t.bucket_id = ?', bkt);
  if (qp.get('tag')) add('? = any(t.tags)', qp.get('tag')!.slice(0, 40));
  if (qp.get('q')) add(`t.payee ilike ?`, `%${qp.get('q')!.slice(0, 60).replace(/[%_\\]/g, (m) => '\\' + m)}%`);
  const min = parseMoney(qp.get('min')); if (min != null) add('t.amount >= ?', min);
  const max = parseMoney(qp.get('max')); if (max != null) add('t.amount <= ?', max);
  params.push(PAGE + 1, (pageNo - 1) * PAGE);
  const rows = await ctx.as((q) => q.query<any>(`select t.id, t.kind, t.date::text date, t.amount, t.payee, t.tags, t.owner_id, t.household_id, c.name cat, a.name acc, a2.name acc2, b.name bucket
        from transactions t left join categories c on c.id = t.category_id join accounts a on a.id = t.account_id
        left join accounts a2 on a2.id = t.to_account_id left join buckets b on b.id = t.bucket_id
       where ${where.join(' and ')} order by t.date desc, t.created_at desc limit $${params.length - 1} offset $${params.length}`, params));
  const lk = await lookups(ctx);
  const hasNext = rows.length > PAGE;
  const list = rows.slice(0, PAGE);
  const filters = html`<form method="get" action="/transactions" class="filters">
    <details ${[...qp.keys()].some((k) => k !== 'page' && k !== 'ok' && k !== 'err') ? raw('open') : ''}><summary>${icon('filter')} ${ctx.t('common.filter')}</summary>
    <div class="grid4">
      ${field(ctx.t('common.from'), dateInput('from', qp.get('from')))}
      ${field(ctx.t('common.to'), dateInput('to', qp.get('to')))}
      ${field(ctx.t('txn.kind'), select('kind', KINDS.map((k) => ({ value: k, label: ctx.t(`txn.kind.${k}`) })), qp.get('kind'), { empty: ctx.t('common.all') }))}
      ${field(ctx.t('txn.category'), select('category', categoryOptions(ctx, lk.categories), qp.get('category'), { empty: ctx.t('common.all') }))}
      ${field(ctx.t('txn.account'), select('account', lk.accounts.map((a) => ({ value: a.id, label: a.name })), qp.get('account'), { empty: ctx.t('common.all') }))}
      ${field(ctx.t('txn.payee'), input({ name: 'q', value: qp.get('q') }))}
      ${field(ctx.t('txn.tags'), input({ name: 'tag', value: qp.get('tag') }))}
      ${lk.members.length ? field(ctx.t('txn.recorded_by'), select('who', lk.members.map((m: any) => ({ value: m.user_id, label: m.display_name })), qp.get('who'), { empty: ctx.t('common.all') })) : ''}
      ${field(ctx.t('common.amount_range'), html`<span class="range">${input({ name: 'min', value: qp.get('min'), inputmode: 'decimal', id: 'f-min' })}–${input({ name: 'max', value: qp.get('max'), inputmode: 'decimal', id: 'f-max' })}</span>`)}
    </div><div class="actions"><button class="btn">${ctx.t('common.apply')}</button> <a class="btn link" href="/transactions">${ctx.t('common.reset')}</a></div></details></form>`;
  const body = html`${filters}
    ${list.length ? html`<ul class="txn-list">${list.map((r) => html`<li>
      <a href="/transactions/${r.id}">
        <span class="txn-main"><strong>${r.payee || r.cat || ctx.t(`txn.kind.${r.kind}`)}</strong>
          <small>${f.date(r.date)} · ${r.kind === 'transfer' ? html`${r.acc} → ${r.acc2}` : html`${r.cat ?? ctx.t('txn.uncategorized')} · ${r.acc}`}${r.bucket ? html` · ${icon('jar')}${r.bucket}` : ''}${r.household_id ? html` · ${icon('users')}` : ''}${r.tags?.length ? html` · #${r.tags.join(' #')}` : ''}</small></span>
        ${f.moneyHtml(r.kind === 'expense' ? -r.amount : r.amount, { sign: r.kind === 'income' })}
      </a></li>`)}</ul>${pager(ctx, pageNo, hasNext)}` : empty(ctx.t('txn.none'), html`<a class="btn primary" href="/transactions/new">${ctx.t('txn.add')}</a>`)}`;
  return htmlRes(page(ctx, {
    title: ctx.t('nav.transactions'),
    actions: html`<span class="head-actions"><a class="btn" href="/transactions/import">${icon('upload')} ${ctx.t('io.import')}</a><a class="btn primary" href="/transactions/new">${icon('plus')} ${ctx.t('txn.add')}</a></span>`,
    body,
  }));
});

get('/transactions/:id', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const f = makeFmt(ctx.prefs, ctx.lang);
  const data = await ctx.as(async (q) => ({
    row: await q.one<any>('select *, date::text date, fx_rate::text fx_rate from transactions where id = $1', [id]),
    splits: await q.query<any>('select category_id, bucket_id, amount from transaction_splits where transaction_id = $1 order by amount desc', [id]),
    files: await q.query<any>('select id, mime, size, created_at from attachments where transaction_id = $1 order by created_at', [id]),
  }));
  const row = data.row;
  if (!row) throw new HttpError(404);
  const lk = await lookups(ctx);
  const c = await cipherFor(ctx, row.owner_id);
  const canEdit = row.owner_id === ctx.user!.id || ctx.households.some((h) => h.id === row.household_id && h.role !== 'viewer');
  const files = data.files.length ? card(ctx.t('txn.receipts'), html`<ul class="rows">${data.files.map((a: any) => html`<li><a href="/attachments/${a.id}">${icon('doc')} ${a.mime.split('/')[1].toUpperCase()} · ${Math.ceil(a.size / 1024)} KB · ${f.date(a.created_at)}</a>
      ${canEdit ? postButton(ctx, `/attachments/${a.id}/delete`, ctx.t('common.remove'), { cls: 'sm link', confirm: ctx.t('common.confirm_delete') }) : ''}</li>`)}</ul>`) : '';
  return htmlRes(page(ctx, {
    title: ctx.t('txn.edit'),
    body: html`${card(null, canEdit ? txnForm(ctx, lk, { ...row, note: c.dec(row.note_enc), splits: data.splits }, `/transactions/${id}`) : html`<p>${ctx.t('common.read_only')}</p>`)}
      ${files}
      ${canEdit ? html`<p>${postButton(ctx, `/transactions/${id}/delete`, ctx.t('common.delete'), { cls: 'danger', confirm: ctx.t('common.confirm_delete') })}</p>` : ''}`,
  }));
});

post('/transactions/:id', { access: 'auth', upload: MAX_ATTACHMENT + 256 * 1024 }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  const v = parseTxn(ctx);
  const owner = await ctx.as((q) => q.one<{ owner_id: string }>('select owner_id from transactions where id = $1', [id]));
  if (!owner) throw new HttpError(404);
  const c = await cipherFor(ctx, owner.owner_id); // notes and receipts are encrypted with the OWNER's data key
  await ctx.as(async (q) => {
    const old = await q.one<any>('select owner_id, household_id from transactions where id = $1', [id]);
    if (!old) throw new HttpError(404);
    // re-create splits and bucket movements so balances stay exact
    await q.query('delete from bucket_movements where transaction_id = $1', [id]);
    await q.query('delete from transaction_splits where transaction_id = $1', [id]);
    const hh = old.owner_id === ctx.user!.id ? v.householdId : old.household_id;
    const upd = await q.query(`update transactions set kind=$2, amount=$3, date=$4, account_id=$5, to_account_id=$6, category_id=$7, bucket_id=$8, payee=$9, note_enc=$10, tags=$11, household_id=$12,
        fx_rate = coalesce($13::numeric, fx_rate) where id=$1 returning id`,
      [id, v.kind, v.amount, v.date, v.accountId, v.toAccountId, v.categoryId, v.splits.length ? null : v.bucketId, v.payee, c.enc(v.note), v.tags, hh, v.fxRate]);
    if (!upd.length) throw new HttpError(404);
    await applyLines(q, old.owner_id, id, { ...v, householdId: hh });
    await saveReceipt(ctx, q, id, old.owner_id, hh, c);
    await activity(q, ctx, old.household_id, 'update', 'transaction', id, `${v.kind} ${v.date}`);
  });
  return redirect(withFlash('/transactions', 'ok', 'saved'));
});

/** Attachments are served from their own path as downloads, never rendered inline (NFR-SEC-24). */
get('/attachments/:id', { access: 'auth' }, async (ctx) => {
  const a = await ctx.as((q) => q.one<any>('select owner_id, mime, data_enc, created_at from attachments where id = $1', [requireUuid(ctx.params.id)]));
  if (!a) throw new HttpError(404);
  const c = await cipherFor(ctx, a.owner_id);
  const data = Buffer.from(c.dec(a.data_enc), 'base64');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[a.mime as string] ?? 'bin';
  return { status: 200, headers: { 'content-type': a.mime, 'content-disposition': `attachment; filename="receipt-${ctx.params.id.slice(0, 8)}.${ext}"`, 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox" }, body: data };
});

post('/attachments/:id/delete', { access: 'auth' }, async (ctx) => {
  const r = await ctx.as((q) => q.one<any>('delete from attachments where id = $1 returning transaction_id', [requireUuid(ctx.params.id)]));
  if (!r) throw new HttpError(404);
  return redirect(withFlash(r.transaction_id ? `/transactions/${r.transaction_id}` : '/transactions', 'ok', 'deleted'));
});

post('/transactions/:id/delete', { access: 'auth' }, async (ctx) => {
  const id = requireUuid(ctx.params.id);
  await ctx.as(async (q) => {
    const r = await q.one<any>('delete from transactions where id = $1 returning household_id', [id]);
    if (!r) throw new HttpError(404);
    await activity(q, ctx, r.household_id, 'delete', 'transaction', id, '');
  });
  return redirect(withFlash('/transactions', 'ok', 'deleted'));
});

// ───────────── CSV import (FR-IO-01/03) ─────────────
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  const delim = (s.split('\n')[0].match(/;/g)?.length ?? 0) > (s.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c.trim())) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function normDate(v: string): string | null {
  const s = v.trim();
  if (isIsoDate(s)) return s;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  if (y > 2400) y -= 543; // Buddhist era
  const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

const MAP_FIELDS = ['date', 'amount', 'withdrawal', 'deposit', 'payee', 'note', 'category'] as const;

get('/transactions/import', { access: 'auth' }, async (ctx) => {
  const lk = await lookups(ctx);
  return htmlRes(page(ctx, {
    title: ctx.t('io.import'),
    body: card(null, form(ctx, '/transactions/import', html`<p>${ctx.t('io.import_intro')}</p>
      ${field(ctx.t('io.file'), html`<input id="f-file" type="file" name="file" accept=".csv,text/csv" required>`, { id: 'f-file' })}
      ${field(ctx.t('txn.account'), select('account_id', lk.accounts.map((a) => ({ value: a.id, label: a.name })), lk.accounts[0]?.id, { required: true }))}
      ${field(ctx.t('io.preset'), select('preset', [...registry.importers.values()].map((p) => ({ value: p.id, label: p.name })), '', { empty: ctx.t('io.preset_auto') }), { hint: ctx.t('io.preset_hint') })}`, { submit: ctx.t('io.next_mapping'), multipart: true })),
  }));
});

post('/transactions/import', { access: 'auth', upload: 5 * 1024 * 1024 }, async (ctx) => {
  const file = ctx.files.find((f) => f.field === 'file');
  const csvText = file ? file.data.toString('utf8') : Buffer.from(ctx.body.csv_b64 ?? '', 'base64').toString('utf8');
  if (!csvText) return redirect(withFlash('/transactions/import', 'err', 'invalid'));
  const rows = parseCsv(csvText);
  if (rows.length < 2) return redirect(withFlash('/transactions/import', 'err', 'invalid'));
  const header = rows[0];
  const accountId = requireUuid(ctx.body.account_id);
  if (!ctx.body.confirm) {
    // FR-IO-02/06: bank / app presets; "auto" picks the preset matching the most headers
    const builtIn: Record<string, string> = { date: 'date|วันที่', amount: '^amount|จำนวน', withdrawal: 'withdraw|ถอน|debit', deposit: 'deposit|ฝาก|credit', payee: 'payee|desc|รายการ|merchant', note: 'note|memo|หมายเหตุ', category: 'categ|หมวด' };
    const score = (cols: Record<string, string | undefined>) => Object.values(cols).filter((re) => re && header.some((h) => new RegExp(re, 'i').test(h.trim()))).length;
    const chosen = registry.importers.get(ctx.body.preset ?? '') ?? [...registry.importers.values()].sort((a, b) => score(b.columns) - score(a.columns))[0];
    const cols: Record<string, string | undefined> = chosen && score(chosen.columns) >= 3 ? chosen.columns : builtIn;
    const guess = (f: string) => (cols[f] ? header.findIndex((h) => new RegExp(cols[f]!, 'i').test(h.trim())) : -1);
    const opts = [{ value: '', label: '—' }, ...header.map((h, i) => ({ value: String(i), label: h || `#${i + 1}` }))];
    return htmlRes(page(ctx, {
      title: ctx.t('io.mapping'),
      body: html`${card(null, html`<form method="post" action="/transactions/import" class="stack">${csrfField(ctx)}
        <input type="hidden" name="csv_b64" value="${Buffer.from(csvText).toString('base64')}"><input type="hidden" name="account_id" value="${accountId}"><input type="hidden" name="confirm" value="1">
        <div class="grid3">${MAP_FIELDS.map((fname) => field(ctx.t(`io.field.${fname}`), select(`map_${fname}`, opts, guess(fname) >= 0 ? String(guess(fname)) : '')))}</div>
        <p class="note">${ctx.t('io.mapping_hint')}</p>
        <div class="table-wrap"><table><thead><tr>${header.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${rows.slice(1, 6).map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>
        <div class="actions"><button class="btn primary">${ctx.t('io.import_n', { n: rows.length - 1 })}</button></div></form>`)}`,
    }));
  }
  const col = (f: string) => { const v = ctx.body[`map_${f}`]; return v === '' || v == null ? -1 : Number(v); };
  const c = cipher(ctx);
  let imported = 0, dupes = 0, failed = 0;
  await ctx.as(async (q) => {
    const cats = await q.query<any>('select id, name, kind from categories where owner_id = hearth_uid()');
    for (const r of rows.slice(1)) {
      const d = normDate(r[col('date')] ?? '');
      let amt: bigint | null = null;
      if (col('amount') >= 0) amt = parseMoney(r[col('amount')]);
      else {
        const w = col('withdrawal') >= 0 ? parseMoney(r[col('withdrawal')] || '0') : 0n;
        const dep = col('deposit') >= 0 ? parseMoney(r[col('deposit')] || '0') : 0n;
        amt = w != null && dep != null ? dep - w : null;
      }
      if (!d || amt == null || amt === 0n) { failed++; continue; }
      const payee = col('payee') >= 0 ? (r[col('payee')] ?? '').trim().slice(0, 120) : '';
      const hash = createHash('sha256').update(`${accountId}|${d}|${amt}|${payee}`).digest('hex');
      if (await q.one('select 1 from transactions where owner_id = hearth_uid() and import_hash = $1', [hash])) { dupes++; continue; }
      const catName = col('category') >= 0 ? (r[col('category')] ?? '').trim().toLowerCase() : '';
      const kind = amt < 0n ? 'expense' : 'income';
      const cat = catName ? cats.find((x) => x.name.toLowerCase() === catName && x.kind === kind) : null;
      await createTransaction(q, ctx.user!.id, { kind, date: d, amount: amt < 0n ? -amt : amt, accountId, categoryId: cat?.id ?? null, payee: payee || null, noteEnc: c.enc(col('note') >= 0 ? r[col('note')] : null), importHash: hash });
      imported++;
    }
  });
  return redirect(`/transactions?ok=imported&n=${imported}&dupes=${dupes}&failed=${failed}`);
});

export const _test = { parseCsv, normDate };
