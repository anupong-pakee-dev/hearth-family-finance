/**
 * Households, members, invitations, dependents, activity log (§4.1 FR-HH-*).
 */
import { get, post, htmlRes, redirect, withFlash, HttpError, type Ctx } from '../http/app.ts';
import { html } from '../views/html.ts';
import { page, guestPage, icon } from '../views/layout.ts';
import { field, input, select, form, postButton, empty, card } from '../views/ui.ts';
import { makeFmt, type Fmt } from '../views/format.ts';
import { debtTerms, nextDue } from '../services/summary.ts';
import { simulatePlan, minimumBudget, type PlanDebt } from '@hearth/engine';
import { text, oneOf, requireUuid } from '../services/common.ts';
import { randomToken, sha256 } from '../security/session.ts';
import { audit } from '../security/audit.ts';
import { sendMail, mailEnabled } from '../services/mail.ts';
import { config } from '../config.ts';

const SHARED_TABLES = ['accounts', 'categories', 'buckets', 'transactions', 'transaction_splits', 'bucket_movements', 'debts', 'debt_rate_schedule', 'debt_responsibilities', 'debt_payments', 'goals', 'goal_contributions', 'portfolios', 'investment_transactions', 'recurring_rules'];

function role(ctx: Ctx, hh: string) { return ctx.households.find((h) => h.id === hh)?.role ?? null; }
function canManage(ctx: Ctx, hh: string) { return ['owner', 'manager'].includes(role(ctx, hh) ?? ''); }

get('/household', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const data = await ctx.as(async (q) => {
    const hhs = await q.query<any>(`select h.* from households h where hearth_member_role(h.id) is not null order by h.created_at`);
    const members = hhs.length ? await q.query<any>('select * from members where household_id = any($1::uuid[]) order by role, display_name', [hhs.map((h) => h.id)]) : [];
    const invites = hhs.length ? await q.query<any>('select household_id, role, email, expires_at from household_invites where household_id = any($1::uuid[]) and used_at is null and expires_at > now()', [hhs.map((h) => h.id)]).catch(() => []) : [];
    const acts = hhs.length ? await q.query<any>(`select a.*, m.display_name who from activity_log a left join members m on m.user_id = a.actor_id and m.household_id = a.household_id where a.household_id = any($1::uuid[]) order by a.at desc limit 30`, [hhs.map((h) => h.id)]) : [];
    const debts = hhs.length ? await q.query<any>(`select d.* from debts d where d.household_id = any($1::uuid[]) and d.closed_at is null and d.visibility <> 'private'`, [hhs.map((h) => h.id)]) : [];
    return { hhs, members, invites, acts, debts };
  });
  const newLink = ctx.query.get('invite');
  return htmlRes(page(ctx, {
    title: ctx.t('nav.household'),
    body: html`
      ${newLink && /^[\w-]{20,60}$/.test(newLink) ? html`<div class="flash ok" role="status"><p>${ctx.t('hh.invite_created')}</p><input class="copy" readonly value="${inviteUrl(newLink)}" aria-label="${ctx.t('hh.invite_link')}"><p class="note">${ctx.t('hh.invite_link_hint')}</p></div>` : ''}
      ${data.hhs.length ? data.hhs.map((h) => card(h.name, html`<div class="hh-body">
        <ul class="rows">${data.members.filter((m) => m.household_id === h.id).map((m) => html`<li><span>${icon(m.user_id ? 'user' : 'child')} <strong>${m.display_name}</strong> <span class="tag">${ctx.t(`hh.role.${m.role}`)}</span>${m.user_id === ctx.user!.id ? html` <small>(${ctx.t('common.me')})</small>` : ''}</span>
          ${canManage(ctx, h.id) && m.user_id !== ctx.user!.id && m.role !== 'owner' ? html`<form method="post" action="/household/${h.id}/members/${m.id}/role" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <label class="sr-only" for="role-${m.id}">${ctx.t('hh.role_label')}</label>${select('role', (m.user_id ? ['manager', 'member', 'viewer'] : ['dependent']).map((r) => ({ value: r, label: ctx.t(`hh.role.${r}`) })), m.role, { id: `role-${m.id}` })}<button class="btn sm">${ctx.t('common.save')}</button></form>
            ${postButton(ctx, `/household/${h.id}/members/${m.id}/remove`, ctx.t('common.remove'), { cls: 'sm link', confirm: ctx.t('hh.confirm_remove') })}` : ''}</li>`)}</ul>
        ${familyDebtSummary(ctx, f, h.id, data.members.filter((m) => m.household_id === h.id), data.debts.filter((d) => d.household_id === h.id))}
        ${(() => { const me = data.members.find((m) => m.household_id === h.id && m.user_id === ctx.user!.id); return me && ctx.prefs!.bucket_mode !== 'off' ? html`<div class="row-actions">${postButton(ctx, `/household/${h.id}/bucket-sharing`, me.joined_bucket_sharing ? ctx.t('hh.leave_buckets') : ctx.t('hh.join_buckets'), { cls: 'sm' })} <small class="note">${ctx.t('hh.bucket_sharing_hint')}</small></div>` : ''; })()}
        ${data.invites.filter((i) => i.household_id === h.id).length ? html`<p class="note">${ctx.t('hh.pending_invites', { n: data.invites.filter((i) => i.household_id === h.id).length })}</p>` : ''}
        ${canManage(ctx, h.id) ? html`<div class="grid2 hh-forms">
          ${form(ctx, `/household/${h.id}/invite`, html`<h3>${ctx.t('hh.invite')}</h3>${mailEnabled() ? field(ctx.t('auth.email'), input({ name: 'email', type: 'email', id: `f-inv-email-${h.id}` }), { id: `f-inv-email-${h.id}`, hint: ctx.t('hh.invite_email_hint') }) : html`<p class="note">${ctx.t('hh.invite_link_only')}</p>`}
            ${field(ctx.t('hh.role_label'), select('role', ['member', 'manager', 'viewer'].map((r) => ({ value: r, label: ctx.t(`hh.role.${r}`) })), 'member', { id: `f-inv-role-${h.id}` }), { id: `f-inv-role-${h.id}` })}`, { submit: ctx.t('hh.create_link') })}
          ${form(ctx, `/household/${h.id}/dependents`, html`<h3>${ctx.t('hh.add_dependent')}</h3><p class="note">${ctx.t('hh.dependent_hint')}</p>${field(ctx.t('auth.name'), input({ name: 'name', required: true, maxlength: 80, id: `f-dep-${h.id}` }), { id: `f-dep-${h.id}` })}`, { submit: ctx.t('common.add') })}
        </div>` : ''}
        <div class="row-actions hh-danger">${role(ctx, h.id) === 'owner'
          ? html`${data.members.filter((m) => m.household_id === h.id && m.user_id && m.user_id !== ctx.user!.id).length ? html`<form method="post" action="/household/${h.id}/transfer" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
                <label class="sr-only" for="tr-${h.id}">${ctx.t('hh.transfer')}</label>${select('member_id', data.members.filter((m) => m.household_id === h.id && m.user_id && m.user_id !== ctx.user!.id).map((m) => ({ value: m.id, label: m.display_name })), '', { id: `tr-${h.id}` })}<button class="btn sm">${ctx.t('hh.transfer')}</button></form>` : ''}
              ${postButton(ctx, `/household/${h.id}/delete`, ctx.t('hh.delete'), { cls: 'danger sm', confirm: ctx.t('hh.confirm_delete') })}`
          : postButton(ctx, `/household/${h.id}/leave`, ctx.t('hh.leave'), { cls: 'sm', confirm: ctx.t('hh.confirm_leave') })}</div></div>`)) : ''}
      ${!data.hhs.length ? card(null, empty(ctx.t('hh.none'))) : ''}
      ${data.acts.length ? card(ctx.t('hh.activity'), html`<ul class="rows">${data.acts.map((a) => html`<li><span>${f.date(a.at)} · <strong>${a.who ?? '?'}</strong> ${ctx.t(`hh.act.${a.action}`)} ${ctx.t(`hh.entity.${a.entity}`)} ${a.summary}</span></li>`)}</ul>`) : ''}
      ${card(ctx.t('hh.create'), form(ctx, '/household', html`${field(ctx.t('hh.name'), input({ name: 'name', required: true, maxlength: 80, placeholder: ctx.t('hh.name_ph') }), { id: 'f-hh-name' })}
        ${field(ctx.t('hh.my_name'), input({ name: 'display_name', value: ctx.user!.display_name, required: true, maxlength: 80 }), { id: 'f-hh-display' })}`, { submit: ctx.t('hh.create') }))}
      <p class="note">${ctx.t('hh.privacy_note')}</p>`,
  }));
});

/**
 * FR-FDEBT-05: debt-free date per person and for the whole household; FR-FDEBT-08: net amounts family members
 * owe each other (debts with both a debtor and a lender member).
 */
function familyDebtSummary(ctx: Ctx, f: Fmt, hhId: string, members: any[], debts: any[]) {
  if (!debts.length) return '';
  const memberOf = (d: any) => d.owner_member_id ?? members.find((m) => m.user_id === d.owner_id)?.id ?? null;
  const start = nextDue(1);
  const plan = (list: any[]) => {
    const pd: PlanDebt[] = list.map((d) => ({ ...debtTerms(d, [], start), id: d.id, name: d.name }));
    return simulatePlan(pd, minimumBudget(pd, start), 'avalanche', { startDate: start });
  };
  const people = members.map((m) => ({ m, list: debts.filter((d) => !d.is_receivable && !d.lender_member_id && memberOf(d) === m.id) })).filter((x) => x.list.length);
  const whole = plan(debts.filter((d) => !d.is_receivable && !d.lender_member_id));
  // net lending between members
  const net = new Map<string, bigint>();
  for (const d of debts.filter((x) => x.lender_member_id && memberOf(x))) {
    const a = memberOf(d), b = d.lender_member_id;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    net.set(key, (net.get(key) ?? 0n) + (a < b ? d.balance_current : -d.balance_current));
  }
  const name = (id: string) => members.find((m) => m.id === id)?.display_name ?? '?';
  const nets = [...net.entries()].filter(([, v]) => v !== 0n).map(([k, v]) => { const [a, b] = k.split('|'); return v > 0n ? { from: a, to: b, amount: v } : { from: b, to: a, amount: -v }; });
  return html`<h3>${ctx.t('hh.debt_free_people')}</h3><ul class="rows">
    ${people.map(({ m, list }) => { const r = plan(list); return html`<li><span>${m.display_name} · ${f.money(list.reduce((s: bigint, d: any) => s + d.balance_current, 0n))}</span><span>${r.neverPaysOff ? ctx.t('debt.never') : f.date(r.payoffDate)}</span></li>`; })}
    <li><strong>${ctx.t('hh.whole_household')}</strong><strong>${whole.neverPaysOff ? ctx.t('debt.never') : whole.payoffDate ? f.date(whole.payoffDate) : '—'}</strong></li></ul>
    ${nets.length ? html`<h3>${ctx.t('hh.net_lending')}</h3><ul class="rows">${nets.map((n) => html`<li><span>${ctx.t('hh.owes', { from: name(n.from), to: name(n.to) })}</span>${f.moneyHtml(n.amount)}</li>`)}</ul>` : ''}`;
}

post('/household/:hhid/bucket-sharing', { access: 'auth' }, async (ctx) => {
  const hh = requireUuid(ctx.params.hhid);
  await ctx.as((q) => q.query('update members set joined_bucket_sharing = not joined_bucket_sharing where household_id = $1 and user_id = hearth_uid()', [hh]));
  return redirect(withFlash('/household', 'ok', 'saved'));
});

post('/household', { access: 'auth' }, async (ctx) => {
  await ctx.as(async (q) => {
    const h = await q.one<any>('insert into households(name, created_by) values ($1, hearth_uid()) returning id', [text(ctx.body.name, 80, true)]);
    await q.query(`insert into members(household_id, user_id, display_name, role) values ($1, hearth_uid(), $2, 'owner')`, [h.id, text(ctx.body.display_name, 80, true)]);
  });
  await ctx.db.system((q) => audit(q, 'household_created', ctx.user!.id, {}, ctx.ip));
  return redirect(withFlash('/household', 'ok', 'saved'));
});

post('/household/:hhid/invite', { access: 'auth' }, async (ctx) => {
  const hh = requireUuid(ctx.params.hhid);
  if (!canManage(ctx, hh)) throw new HttpError(404);
  const token = randomToken(24);
  const email = mailEnabled() ? text(ctx.body.email, 320) : '';
  const r = oneOf(ctx.body.role, ['member', 'manager', 'viewer'] as const, 'member');
  await ctx.as((q) => q.query(`insert into household_invites(token_hash, household_id, role, email, created_by, expires_at) values ($1,$2,$3,$4,hearth_uid(), now() + interval '7 days')`, [sha256(token), hh, r, email || null]));
  if (email && mailEnabled()) await sendMail(email, ctx.t('mail.invite_subject'), ctx.t('mail.invite_body', { name: ctx.user!.display_name, link: inviteUrl(token) }));
  return redirect(`/household?invite=${token}`);
});

const inviteUrl = (token: string) => `${config.baseUrl}/invite?token=${token}`;

/**
 * Invite link landing (works signed in or out). Signed in → the join page. Signed out → who invited you, then
 * "create an account" (keeps the invite, so registration works even when sign-ups are closed) or "sign in".
 */
get('/invite', { access: 'public' }, async (ctx) => {
  const token = ctx.query.get('token') ?? '';
  if (!/^[\w-]{20,60}$/.test(token)) return redirect(withFlash('/login', 'err', 'token_invalid'));
  const joinPath = `/household/join?token=${token}`;
  if (ctx.user && !ctx.session!.mfa_pending) return redirect(joinPath);
  const inv = await ctx.db.system((q) => q.one<any>(`select i.role, h.name, u.display_name inviter from household_invites i join households h on h.id = i.household_id left join users u on u.id = i.created_by where i.token_hash = $1 and i.used_at is null and i.expires_at > now()`, [sha256(token)]));
  if (!inv) return htmlRes(guestPage(ctx, { title: ctx.t('invite.title'), body: html`<p class="flash err" role="alert">${ctx.t('error.token_invalid')}</p><p class="links"><a href="/login">${ctx.t('auth.back_to_login')}</a></p>` }), 404);
  return htmlRes(guestPage(ctx, {
    title: ctx.t('invite.title'),
    body: html`<p>${ctx.t('invite.intro', { inviter: inv.inviter ?? '?', name: inv.name, role: ctx.t(`hh.role.${inv.role}`) })}</p>
      <div class="alt-login"><a class="btn primary" href="/register?invite=${token}">${ctx.t('invite.register')}</a>
      <a class="btn" href="/login?next=${encodeURIComponent(joinPath)}">${ctx.t('invite.login')}</a></div>
      <p class="note">${ctx.t('invite.note')}</p>`,
  }));
});

get('/household/join', { access: 'auth' }, async (ctx) => {
  const token = ctx.query.get('token') ?? '';
  const inv = await ctx.db.system((q) => q.one<any>(`select i.*, h.name from household_invites i join households h on h.id = i.household_id where i.token_hash = $1 and i.used_at is null and i.expires_at > now()`, [sha256(token)]));
  if (!inv) return redirect(withFlash('/household', 'err', 'token_invalid'));
  return htmlRes(page(ctx, {
    title: ctx.t('hh.join'),
    body: card(null, form(ctx, '/household/join', html`<p>${ctx.t('hh.join_intro', { name: inv.name, role: ctx.t(`hh.role.${inv.role}`) })}</p><input type="hidden" name="token" value="${token}">
      ${field(ctx.t('hh.my_name'), input({ name: 'display_name', value: ctx.user!.display_name, required: true, maxlength: 80 }), { id: 'f-dn' })}<p class="note">${ctx.t('hh.privacy_note')}</p>`, { submit: ctx.t('hh.join') })),
  }));
});

post('/household/join', { access: 'auth' }, async (ctx) => {
  const token = ctx.body.token ?? '';
  const ok = await ctx.db.system(async (q) => {
    const inv = await q.one<any>(`update household_invites set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning household_id, role`, [sha256(token)]);
    if (!inv) return false;
    await q.query(`insert into members(household_id, user_id, display_name, role) values ($1,$2,$3,$4) on conflict (household_id, user_id) do nothing`, [inv.household_id, ctx.user!.id, text(ctx.body.display_name, 80, true), inv.role]);
    await audit(q, 'role_changed', ctx.user!.id, { joined: inv.household_id, role: inv.role }, ctx.ip);
    return true;
  });
  return redirect(withFlash('/household', ok ? 'ok' : 'err', ok ? 'joined' : 'token_invalid'));
});

post('/household/:hhid/dependents', { access: 'auth' }, async (ctx) => {
  const hh = requireUuid(ctx.params.hhid);
  if (!canManage(ctx, hh)) throw new HttpError(404);
  await ctx.as((q) => q.query(`insert into members(household_id, user_id, display_name, role) values ($1, null, $2, 'dependent')`, [hh, text(ctx.body.name, 80, true)]));
  return redirect(withFlash('/household', 'ok', 'saved'));
});

/** Changing roles requires step-up re-authentication (NFR-SEC-06). */
post('/household/:hhid/members/:mid/role', { access: 'auth', stepUp: true }, async (ctx) => {
  const hh = requireUuid(ctx.params.hhid);
  if (!canManage(ctx, hh)) throw new HttpError(404);
  const r = oneOf(ctx.body.role, ['manager', 'member', 'viewer', 'dependent'] as const);
  if (r === 'manager' && role(ctx, hh) !== 'owner') throw new HttpError(403);
  const upd = await ctx.as((q) => q.query(`update members set role = $3 where id = $1 and household_id = $2 and role <> 'owner' and ((user_id is null) = ($3 = 'dependent')) returning id`, [requireUuid(ctx.params.mid), hh, r]));
  if (!upd.length) throw new HttpError(422, 'invalid');
  await ctx.db.system((q) => audit(q, 'role_changed', ctx.user!.id, { household: hh, member: ctx.params.mid, role: r }, ctx.ip));
  return redirect(withFlash('/household', 'ok', 'saved'));
});

post('/household/:hhid/members/:mid/remove', { access: 'auth' }, async (ctx) => {
  const hh = requireUuid(ctx.params.hhid);
  if (!canManage(ctx, hh)) throw new HttpError(404);
  const mid = requireUuid(ctx.params.mid);
  const m = await ctx.as((q) => q.one<any>(`delete from members where id = $1 and household_id = $2 and role <> 'owner' returning user_id`, [mid, hh]));
  if (m?.user_id) await detachShared(ctx, hh, m.user_id);
  return redirect(withFlash('/household', 'ok', 'deleted'));
});

/** A member's shared items become private again — never deleted (FR-HH-06). */
async function detachShared(ctx: Ctx, hh: string, userId: string) {
  await ctx.db.system(async (q) => {
    for (const t of SHARED_TABLES) await q.query(`update ${t} set household_id = null where household_id = $1 and owner_id = $2`, [hh, userId]);
  });
}

post('/household/:hhid/leave', { access: 'auth' }, async (ctx) => {
  const hh = requireUuid(ctx.params.hhid);
  if (role(ctx, hh) === 'owner') return redirect(withFlash('/household', 'err', 'owner_cannot_leave'));
  await detachShared(ctx, hh, ctx.user!.id);
  await ctx.as((q) => q.query('delete from members where household_id = $1 and user_id = hearth_uid()', [hh]));
  await ctx.db.system((q) => audit(q, 'household_left', ctx.user!.id, { household: hh }, ctx.ip));
  return redirect(withFlash('/household', 'ok', 'left'));
});

post('/household/:hhid/transfer', { access: 'auth', stepUp: true }, async (ctx) => {
  const hh = requireUuid(ctx.params.hhid);
  if (role(ctx, hh) !== 'owner') throw new HttpError(404);
  const mid = requireUuid(ctx.body.member_id);
  await ctx.db.system(async (q) => {
    const m = await q.one<any>('select id from members where id = $1 and household_id = $2 and user_id is not null', [mid, hh]);
    if (!m) throw new HttpError(404);
    await q.query(`update members set role = 'manager' where household_id = $1 and user_id = $2`, [hh, ctx.user!.id]);
    await q.query(`update members set role = 'owner' where id = $1`, [mid]);
    await audit(q, 'role_changed', ctx.user!.id, { household: hh, transfer_to: mid }, ctx.ip);
  });
  return redirect(withFlash('/household', 'ok', 'saved'));
});

post('/household/:hhid/delete', { access: 'auth', stepUp: true }, async (ctx) => {
  const hh = requireUuid(ctx.params.hhid);
  if (role(ctx, hh) !== 'owner') throw new HttpError(404);
  await ctx.db.system(async (q) => {
    for (const t of SHARED_TABLES) await q.query(`update ${t} set household_id = null where household_id = $1`, [hh]);
    await q.query('delete from households where id = $1', [hh]);
    await audit(q, 'household_left', ctx.user!.id, { deleted: hh }, ctx.ip);
  });
  return redirect(withFlash('/household', 'ok', 'deleted'));
});
