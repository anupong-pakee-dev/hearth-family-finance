/**
 * System admin (§2.2). Admins manage users and instance settings but NEVER see financial data
 * (NFR-SEC-12): no route here touches a financial table.
 */
import { get, post, htmlRes, redirect, withFlash, HttpError, type Ctx } from '../http/app.ts';
import { html } from '../views/html.ts';
import { page, icon } from '../views/layout.ts';
import { field, input, form, postButton, card, checkbox } from '../views/ui.ts';
import { makeFmt, maskIp } from '../views/format.ts';
import { requireUuid, intIn } from '../services/common.ts';
import { audit, verifyChain } from '../security/audit.ts';
import { instanceSettings, clearSettingsCache } from '../services/instance.ts';
import { createBackup } from '../services/backup.ts';
import { keys, seal } from '../security/keys.ts';
import { config } from '../config.ts';
import { todayIso } from '@hearth/engine';

/** Human-readable size: B, KB, MB, GB (1024-based, like Neon's console). */
export function fmtBytes(n: number, locale = 'en'): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString(locale, { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`;
}

/** Database storage: used vs. quota as a bar (green → amber at 70% → red at 90%), plus the largest tables. */
function dbUsageCard(ctx: Ctx, used: number, tables: { name: string; bytes: string }[]) {
  const t = ctx.t;
  const loc = ctx.lang === 'th' ? 'th-TH' : 'en';
  const quota = config.dbQuotaMb * 1024 * 1024;
  const pct = quota ? Math.min(100, (used / quota) * 100) : 0;
  const body = quota
    ? html`<meter class="db-meter" min="0" max="${quota}" low="${quota * 0.7}" high="${quota * 0.9}" optimum="0" value="${Math.min(used, quota)}" aria-label="${t('admin.db_title')}"></meter>
      <p class="db-figures"><strong>${t('admin.db_used', { used: fmtBytes(used, loc), quota: fmtBytes(quota, loc), pct: pct.toLocaleString(loc, { maximumFractionDigits: 1 }) })}</strong>
      <span class="${pct >= 90 ? 'neg' : pct >= 70 ? 'warn-text' : 'ok-text'}">${t('admin.db_left', { left: fmtBytes(Math.max(0, quota - used), loc) })}</span></p>
      ${pct >= 90 ? html`<p class="flash err" role="alert">${t('admin.db_full_warn')}</p>` : ''}`
    : html`<p><strong>${t('admin.db_used_only', { used: fmtBytes(used, loc) })}</strong></p><p class="note">${t('admin.db_no_quota')}</p>`;
  return card(t('admin.db_title'), html`${body}
    ${tables.length ? html`<details class="db-tables"><summary>${t('admin.db_tables')}</summary><ul class="rows">${tables.map((r) => html`<li><span><code>${r.name}</code></span><span class="amt">${fmtBytes(Number(r.bytes), loc)}</span></li>`)}</ul></details>` : ''}
    <p class="note">${t('admin.db_note')}</p>`);
}

get('/admin', { access: 'admin' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const s = await instanceSettings(ctx.db);
  const { users, chain, events, providers, rates, grants, dbSize, tables } = await ctx.db.system(async (q) => ({
    dbSize: Number((await q.one<{ n: string }>('select pg_database_size(current_database())::text n'))!.n),
    tables: await q.query<{ name: string; bytes: string }>(`select c.relname name, pg_total_relation_size(c.oid)::text bytes from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by pg_total_relation_size(c.oid) desc limit 5`),
    providers: await q.query<any>('select id, name, issuer, client_id, allow_signup, enabled from oidc_providers order by name'),
    rates: await q.query<any>('select base, quote, date::text date, rate::text rate, source from exchange_rates order by date desc, base limit 20'),
    grants: await q.query<any>('select g.user_id, g.expires_at, u.display_name, u.email from support_grants g join users u on u.id = g.user_id where g.granted_to = $1 and g.expires_at > now()', [ctx.user!.id]),
    users: await q.query<any>(`select id, email, display_name, is_admin, totp_enabled, disabled, email_verified_at, created_at, delete_requested_at,
        (select max(at) from audit_log a where a.user_id = u.id and a.action = 'login') last_login from users u order by created_at limit 500`),
    chain: await verifyChain(q),
    // Security events only (who, what, when, approximate IP) — no financial data (NFR-SEC-12).
    events: await q.query<any>(`select a.id, a.at, a.action, a.user_id, a.ip, u.display_name, u.email from audit_log a left join users u on u.id = a.user_id order by a.id desc limit 30`),
  }));
  return htmlRes(page(ctx, {
    title: ctx.t('nav.admin'),
    body: html`
      <p class="note">${icon('lock')} ${ctx.t('admin.no_financial')}</p>
      ${dbUsageCard(ctx, dbSize, tables)}
      ${card(ctx.t('admin.instance'), form(ctx, '/admin/settings', html`
        ${checkbox('open_registration', ctx.t('admin.open_registration'), s.open_registration === true)}
        ${checkbox('enforce_2fa', ctx.t('admin.enforce_2fa'), s.enforce_2fa === true)}
        ${field(ctx.t('admin.idle_minutes'), input({ name: 'session_idle_minutes', type: 'number', min: 5, max: 240, value: Number(s.session_idle_minutes ?? 30) }), { id: 'f-idle' })}`, { submit: ctx.t('common.save') }))}
      ${card(ctx.t('admin.users'), html`<div class="table-wrap"><table class="tbl"><thead><tr><th>${ctx.t('auth.email')}</th><th>${ctx.t('auth.name')}</th><th>2FA</th><th>${ctx.t('admin.last_login')}</th><th>${ctx.t('admin.status')}</th><th></th></tr></thead><tbody>
        ${users.map((u) => html`<tr><td>${u.email}${u.is_admin ? html` <span class="tag">admin</span>` : ''}</td><td>${u.display_name}</td><td>${u.totp_enabled ? '✓' : '—'}</td><td>${u.last_login ? f.date(u.last_login) : '—'}</td>
          <td>${u.delete_requested_at ? ctx.t('admin.deleting') : u.disabled ? ctx.t('admin.disabled') : u.email_verified_at ? ctx.t('admin.active') : ctx.t('admin.unverified')}</td>
          <td>${u.id !== ctx.user!.id && !u.delete_requested_at ? html`${postButton(ctx, `/admin/users/${u.id}/disable`, u.disabled ? ctx.t('admin.enable') : ctx.t('admin.disable'), { cls: 'sm' })} ${postButton(ctx, `/admin/users/${u.id}/admin`, u.is_admin ? ctx.t('admin.revoke_admin') : ctx.t('admin.make_admin'), { cls: 'sm link', confirm: ctx.t('common.are_you_sure') })}` : ''}</td></tr>`)}
      </tbody></table></div>`)}
      ${card(ctx.t('admin.audit'), html`<p class="${chain.ok ? 'ok-text' : 'neg'}">${chain.ok ? ctx.t('admin.chain_ok') : ctx.t('admin.chain_broken', { id: chain.brokenAt ?? '?' })}</p>
        ${events.length ? html`<ul class="rows audit-rows">${events.map((e) => html`<li><span><strong>${ctx.t(`audit.${e.action}`)}</strong><small>${e.user_id ? (e.display_name || e.email || ctx.t('admin.deleted_user')) : ctx.t('admin.system')} · IP ${maskIp(e.ip)}</small></span><small class="audit-when">#${e.id} · ${f.date(e.at)} ${new Date(e.at).toLocaleTimeString(f.locale, { hour: '2-digit', minute: '2-digit' })}</small></li>`)}</ul>` : html`<p class="note">${ctx.t('admin.audit_empty')}</p>`}
        <p class="note">${ctx.t('admin.audit_note')}</p>`)}
      ${card(ctx.t('admin.support'), grants.length ? html`<ul class="rows">${grants.map((g: any) => html`<li><a href="/admin/support/${g.user_id}">${g.display_name || g.email}</a><small>${ctx.t('support.until', { date: f.date(g.expires_at) })}</small></li>`)}</ul>` : html`<p class="note">${ctx.t('admin.support_none')}</p>`)}
      ${card(ctx.t('admin.oidc'), html`${providers.length ? html`<ul class="rows">${providers.map((p: any) => html`<li><span><strong>${p.name}</strong><small>${p.issuer} · ${p.client_id}${p.allow_signup ? html` · ${ctx.t('admin.oidc_signup')}` : ''}</small></span>${postButton(ctx, `/admin/oidc/${p.id}/delete`, ctx.t('common.remove'), { cls: 'sm link', confirm: ctx.t('common.are_you_sure') })}</li>`)}</ul>` : ''}
        ${form(ctx, '/admin/oidc', html`<div class="grid3">
          ${field(ctx.t('admin.oidc_id'), input({ name: 'id', required: true, maxlength: 40, pattern: '[a-z0-9-]+', placeholder: 'google' }))}
          ${field(ctx.t('admin.oidc_name'), input({ name: 'name', required: true, maxlength: 60, placeholder: 'Google' }))}
          ${field(ctx.t('admin.oidc_issuer'), input({ name: 'issuer', type: 'url', required: true, placeholder: 'https://accounts.google.com' }))}
          ${field('Client ID', input({ name: 'client_id', required: true, maxlength: 300 }))}
          ${field('Client secret', input({ name: 'client_secret', type: 'password', maxlength: 500, autocomplete: 'new-password' }))}
          ${checkbox('allow_signup', ctx.t('admin.oidc_signup'), false)}</div>
          <p class="note">${ctx.t('admin.oidc_redirect', { url: `${config.baseUrl}/auth/oidc/callback` })}</p>`, { submit: ctx.t('common.add') })}`)}
      ${card(ctx.t('admin.fx'), html`<p class="note">${ctx.t('admin.fx_intro')}</p>
        ${rates.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>${ctx.t('txn.date')}</th><th>${ctx.t('admin.fx_pair')}</th><th class="num">${ctx.t('admin.fx_rate')}</th><th>${ctx.t('admin.fx_source')}</th></tr></thead><tbody>${rates.map((r: any) => html`<tr><td>${f.date(r.date)}</td><td>1 ${r.base} → ${r.quote}</td><td class="num">${r.rate}</td><td>${r.source}</td></tr>`)}</tbody></table></div>` : ''}
        ${form(ctx, '/admin/fx', html`<div class="grid4">${field(ctx.t('admin.fx_base'), input({ name: 'base', required: true, maxlength: 3, pattern: '[A-Za-z]{3}', placeholder: 'USD' }))}${field(ctx.t('admin.fx_quote'), input({ name: 'quote', required: true, maxlength: 3, pattern: '[A-Za-z]{3}', placeholder: 'THB' }))}${field(ctx.t('admin.fx_rate'), input({ name: 'rate', required: true, inputmode: 'decimal', placeholder: '36.25' }))}${field(ctx.t('txn.date'), input({ name: 'date', type: 'date', value: todayIso() }))}</div>`, { submit: ctx.t('common.add') })}`)}
      ${card(ctx.t('admin.backup'), html`<p>${ctx.t('admin.backup_intro')}</p>${postButton(ctx, '/admin/backup', ctx.t('admin.backup_now'), { cls: 'primary' })}`)}`,
  }));
});

post('/admin/settings', { access: 'admin', stepUp: true }, async (ctx) => {
  const vals = { open_registration: ctx.body.open_registration === '1', enforce_2fa: ctx.body.enforce_2fa === '1', session_idle_minutes: intIn(ctx.body.session_idle_minutes, 5, 240, 30) };
  await ctx.db.system(async (q) => {
    for (const [k, v] of Object.entries(vals)) await q.query('insert into instance_settings(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, JSON.stringify(v)]);
    await audit(q, 'admin_setting', ctx.user!.id, vals, ctx.ip);
  });
  clearSettingsCache();
  return redirect(withFlash('/admin', 'ok', 'saved'));
});

post('/admin/users/:uid/disable', { access: 'admin', stepUp: true }, async (ctx) => {
  const uid = requireUuid(ctx.params.uid);
  if (uid === ctx.user!.id) throw new HttpError(422, 'invalid');
  await ctx.db.system(async (q) => {
    await q.query('update users set disabled = not disabled where id = $1', [uid]);
    await q.query('delete from sessions where user_id = $1', [uid]);
    await audit(q, 'admin_user', ctx.user!.id, { target: uid, toggled: 'disabled' }, ctx.ip);
  });
  return redirect(withFlash('/admin', 'ok', 'saved'));
});

post('/admin/users/:uid/admin', { access: 'admin', stepUp: true }, async (ctx) => {
  const uid = requireUuid(ctx.params.uid);
  if (uid === ctx.user!.id) throw new HttpError(422, 'invalid');
  await ctx.db.system(async (q) => {
    await q.query('update users set is_admin = not is_admin where id = $1', [uid]);
    await q.query('delete from sessions where user_id = $1', [uid]); // privilege change → new session
    await audit(q, 'admin_user', ctx.user!.id, { target: uid, toggled: 'admin' }, ctx.ip);
  });
  return redirect(withFlash('/admin', 'ok', 'saved'));
});

post('/admin/oidc', { access: 'admin', stepUp: true }, async (ctx) => {
  const id = (ctx.body.id ?? '').trim().toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(id) || id === 'callback' || id === 'start') throw new HttpError(422, 'invalid');
  const issuer = (ctx.body.issuer ?? '').trim().replace(/\/$/, '');
  if (!/^https:\/\//.test(issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(issuer)) throw new HttpError(422, 'invalid');
  const mk = keys().current();
  const secret = (ctx.body.client_secret ?? '').trim();
  const enc = secret ? Buffer.from(`${mk.id}|${seal(mk.key, secret, 'oidc').toString('base64')}`) : null;
  await ctx.db.system(async (q) => {
    await q.query(`insert into oidc_providers(id, name, issuer, client_id, client_secret_enc, allow_signup) values ($1,$2,$3,$4,$5,$6)
      on conflict (id) do update set name = excluded.name, issuer = excluded.issuer, client_id = excluded.client_id, client_secret_enc = coalesce(excluded.client_secret_enc, oidc_providers.client_secret_enc), allow_signup = excluded.allow_signup`,
      [id, (ctx.body.name ?? id).slice(0, 60), issuer, (ctx.body.client_id ?? '').trim().slice(0, 300), enc, ctx.body.allow_signup === '1']);
    await audit(q, 'admin_setting', ctx.user!.id, { oidc_provider: id }, ctx.ip);
  });
  return redirect(withFlash('/admin', 'ok', 'saved'));
});

post('/admin/oidc/:provider/delete', { access: 'admin', stepUp: true }, async (ctx) => {
  await ctx.db.system(async (q) => {
    await q.query('delete from oidc_providers where id = $1', [ctx.params.provider]);
    await audit(q, 'admin_setting', ctx.user!.id, { oidc_removed: ctx.params.provider }, ctx.ip);
  });
  return redirect(withFlash('/admin', 'ok', 'deleted'));
});

/** Manual FX reference rates (FR-TXN-11); plugins can fill the same table automatically. */
post('/admin/fx', { access: 'admin' }, async (ctx) => {
  const base = (ctx.body.base ?? '').toUpperCase(), quote = (ctx.body.quote ?? '').toUpperCase();
  const rate = (ctx.body.rate ?? '').trim();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote) || base === quote || !/^\d{1,10}(\.\d{1,10})?$/.test(rate) || Number(rate) <= 0) throw new HttpError(422, 'invalid');
  const d = /^\d{4}-\d{2}-\d{2}$/.test(ctx.body.date ?? '') ? ctx.body.date : todayIso();
  await ctx.db.system((q) => q.query(`insert into exchange_rates(base, quote, date, rate, source) values ($1,$2,$3,$4,'manual') on conflict (base, quote, date) do update set rate = excluded.rate, source = 'manual'`, [base, quote, d, rate]));
  return redirect(withFlash('/admin', 'ok', 'saved'));
});

/**
 * Read-only support view (NFR-SEC-12): only while the USER's grant to THIS admin is active; every view is audited.
 * Shows balances and recent activity — never notes, account numbers or other encrypted fields.
 */
get('/admin/support/:uid', { access: 'admin' }, async (ctx) => {
  const uid = requireUuid(ctx.params.uid);
  const f = makeFmt(ctx.prefs, ctx.lang);
  const grant = await ctx.db.system(async (q) => {
    const g = await q.one<any>('select u.display_name, u.email from support_grants g join users u on u.id = g.user_id where g.user_id = $1 and g.granted_to = $2 and g.expires_at > now()', [uid, ctx.user!.id]);
    if (g) await audit(q, 'support_access', ctx.user!.id, { target: uid }, ctx.ip);
    return g;
  });
  if (!grant) throw new HttpError(404);
  const data = await ctx.db.asUser(uid, async (q) => ({
    accounts: await q.query<any>('select name, type, balance, currency from accounts where owner_id = $1 and not archived order by created_at', [uid]),
    debts: await q.query<any>('select name, type, balance_current, interest_method from debts where owner_id = $1 and closed_at is null', [uid]),
    txns: await q.query<any>('select date::text date, kind, amount, payee from transactions where owner_id = $1 order by date desc, created_at desc limit 20', [uid]),
    prefs: await q.one<any>('select bucket_mode, investment_enabled, onboarded, locale from user_preferences where user_id = $1', [uid]),
  }));
  return htmlRes(page(ctx, {
    title: ctx.t('admin.support_view', { name: grant.display_name || grant.email }),
    body: html`<p class="flash warn">${ctx.t('admin.support_readonly')}</p>
      ${card(ctx.t('nav.settings'), html`<p>bucket_mode=${data.prefs?.bucket_mode} · investment=${String(data.prefs?.investment_enabled)} · onboarded=${String(data.prefs?.onboarded)} · ${data.prefs?.locale}</p>`)}
      ${card(ctx.t('nav.accounts'), html`<ul class="rows">${data.accounts.map((a: any) => html`<li><span>${a.name} · ${a.type}</span>${f.moneyHtml(a.balance, { currency: a.currency })}</li>`)}</ul>`)}
      ${card(ctx.t('nav.debts'), html`<ul class="rows">${data.debts.map((d: any) => html`<li><span>${d.name} · ${d.interest_method}</span>${f.moneyHtml(d.balance_current)}</li>`)}</ul>`)}
      ${card(ctx.t('nav.transactions'), html`<ul class="rows">${data.txns.map((t: any) => html`<li><span>${f.date(t.date)} · ${t.kind} · ${t.payee ?? ''}</span>${f.moneyHtml(t.amount)}</li>`)}</ul>`)}`,
  }));
});

post('/admin/backup', { access: 'admin', stepUp: true }, async (ctx) => {
  await createBackup(ctx.db, ctx.user!.id);
  return redirect(withFlash('/admin', 'ok', 'backup_done'));
});
