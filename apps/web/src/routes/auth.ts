import { get, post, htmlRes, redirect, jsonRes, safeNext, withFlash, HttpError, type Ctx } from '../http/app.ts';
import { html } from '../views/html.ts';
import { guestPage, page, csrfField, navMore } from '../views/layout.ts';
import { field, input, form } from '../views/ui.ts';
import { verifyPassword, dummyVerify, checkPassword, hashPassword, needsRehash } from '../security/password.ts';
import { createSession, destroySession, cookie, SESSION_COOKIE, sha256 } from '../security/session.ts';
import { verifyTotp, hashRecoveryCode } from '../security/totp.ts';
import { fieldCipher, unwrapDataKey } from '../security/keys.ts';
import { audit } from '../security/audit.ts';
import { hit, recordFailure, clearFailures, delayFor, sleep } from '../security/ratelimit.ts';
import { createUser, sendReset, sendVerification, securityAlert } from '../services/users.ts';
import { instanceSettings } from '../services/instance.ts';
import { LANGS, type Lang } from '../i18n/index.ts';
import { config } from '../config.ts';
import { mailEnabled } from '../services/mail.ts';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function setSession(ctx: Ctx, token: string) {
  ctx.setCookies.push(cookie(SESSION_COOKIE, token));
}

// ───────────── Login ─────────────
function loginForm(ctx: Ctx, email = '', providers: { id: string; name: string }[] = []) {
  return html`${form(ctx, `/login?next=${encodeURIComponent(safeNext(ctx.query.get('next')))}`, html`
    ${field(ctx.t('auth.email'), input({ name: 'email', type: 'email', value: email, required: true, autocomplete: 'username', autofocus: !email }), { id: 'f-email' })}
    ${field(ctx.t('auth.password'), input({ name: 'password', type: 'password', required: true, autocomplete: 'current-password', autofocus: !!email }), { id: 'f-password' })}
  `, { submit: ctx.t('auth.login') })}
  <div class="alt-login">
    <button class="btn" type="button" data-passkey-login hidden>${ctx.t('auth.passkey_login')}</button>
    ${providers.map((p) => html`<a class="btn" href="/auth/oidc/start/${p.id}">${ctx.t('auth.continue_with', { name: p.name })}</a>`)}
    <p class="note" data-passkey-status role="status"></p>
  </div>
  <p class="links">${forgotLink(ctx)} · <a href="${registerHref(ctx)}">${ctx.t('auth.register')}</a></p>`;
}

/** "Forgot password" needs e-mail; without it the link is shown disabled with the reason. */
function forgotLink(ctx: Ctx) {
  return mailEnabled()
    ? html`<a href="/forgot">${ctx.t('auth.forgot')}</a>`
    : html`<span class="link-disabled" aria-disabled="true" title="${ctx.t('mail.disabled_hint')}">${ctx.t('auth.forgot')}</span>`;
}

/** When the login was reached from a household invite link, "create account" keeps the invite. */
function inviteFromNext(ctx: Ctx): string {
  const m = /^\/household\/join\?token=([\w-]{20,60})$/.exec(safeNext(ctx.query.get('next')));
  return m ? m[1] : '';
}
function registerHref(ctx: Ctx) {
  const inv = inviteFromNext(ctx);
  return inv ? `/register?invite=${inv}` : '/register';
}

get('/login', { access: 'guest' }, async (ctx) => {
  const providers = await ctx.db.system((q) => q.query<{ id: string; name: string }>('select id, name from oidc_providers where enabled order by name'));
  return htmlRes(guestPage(ctx, { title: ctx.t('auth.login'), body: loginForm(ctx, '', providers), scripts: ['webauthn.js'] }));
});

post('/login', { access: 'guest' }, async (ctx) => {
  const email = (ctx.body.email ?? '').trim().toLowerCase().slice(0, 320);
  const password = ctx.body.password ?? '';
  const next = safeNext(ctx.query.get('next'));
  const fail = () => htmlRes(guestPage(ctx, { title: ctx.t('auth.login'), body: html`<p class="flash err" role="alert">${ctx.t('auth.invalid_credentials')}</p>${loginForm(ctx, email)}` }), 401);

  if (!hit(`login-ip:${ctx.ip}`, 30, 10 * 60_000) || !hit(`login-email:${email}`, 10, 15 * 60_000)) {
    return htmlRes(guestPage(ctx, { title: ctx.t('auth.login'), body: html`<p class="flash err" role="alert">${ctx.t('auth.too_many')}</p>${loginForm(ctx, email)}` }), 429);
  }
  const d = delayFor(`login-email:${email}`);
  if (d) await sleep(d);

  const u = await ctx.db.system((q) => q.one<any>('select id, password_hash, totp_enabled, locked_until, disabled from users where lower(email) = $1', [email]));
  if (!u) { await dummyVerify(password); recordFailure(`login-email:${email}`); return fail(); }
  const locked = u.locked_until && new Date(u.locked_until).getTime() > Date.now();
  const ok = await verifyPassword(u.password_hash, password);
  if (!ok || locked || u.disabled) {
    recordFailure(`login-email:${email}`);
    await ctx.db.system(async (q) => {
      const r = await q.one<{ failed_logins: number }>('update users set failed_logins = failed_logins + 1 where id = $1 returning failed_logins', [u.id]);
      if ((r?.failed_logins ?? 0) >= 10) await q.query(`update users set locked_until = now() + interval '15 minutes', failed_logins = 0 where id = $1`, [u.id]);
      await audit(q, 'login_failed', u.id, { locked: !!locked }, ctx.ip);
    });
    return fail();
  }
  clearFailures(`login-email:${email}`);
  if (needsRehash(u.password_hash)) {
    const h = await hashPassword(password);
    await ctx.db.system((q) => q.query('update users set password_hash = $1 where id = $2', [h, u.id]));
  }
  if (ctx.session) await ctx.db.system((q) => destroySession(q, ctx.session!.id));
  const { token, isNewDevice } = await ctx.db.system(async (q) => {
    await q.query('update users set failed_logins = 0, locked_until = null where id = $1', [u.id]);
    const s = await createSession(q, u.id, ctx.ip, ctx.ua, u.totp_enabled);
    if (!u.totp_enabled) await audit(q, 'login', u.id, { mfa: false }, ctx.ip);
    return s;
  });
  setSession(ctx, token);
  if (u.totp_enabled) return redirect(`/login/2fa?next=${encodeURIComponent(next)}`);
  if (isNewDevice) await securityAlert(ctx.db, u.id, 'new_device', ctx.lang, { device: ctx.ua.slice(0, 80) });
  return redirect(next);
});

// ───────────── Second factor ─────────────
get('/login/2fa', { access: 'mfa' }, async (ctx) => htmlRes(guestPage(ctx, {
  title: ctx.t('auth.two_factor'),
  body: html`<p>${ctx.t('auth.enter_code')}</p>${form(ctx, `/login/2fa?next=${encodeURIComponent(safeNext(ctx.query.get('next')))}`, html`
    ${field(ctx.t('auth.code'), input({ name: 'code', required: true, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 11, autofocus: true }), { id: 'f-code', hint: ctx.t('auth.code_hint') })}`, { submit: ctx.t('auth.verify') })}
    <form method="post" action="/logout">${csrfField(ctx)}<button class="btn link">${ctx.t('common.cancel')}</button></form>`,
})));

post('/login/2fa', { access: 'mfa' }, async (ctx) => {
  const userId = ctx.user!.id;
  if (!hit(`mfa:${userId}`, 8, 10 * 60_000)) return redirect(withFlash('/login/2fa', 'err', 'too_many'));
  const code = (ctx.body.code ?? '').replace(/\s/g, '');
  const u = await ctx.db.system((q) => q.one<any>('select totp_secret_enc, totp_last_step, data_key_enc, data_key_version from users where id = $1', [userId]));
  const c = fieldCipher(unwrapDataKey(userId, u.data_key_enc ? Buffer.from(u.data_key_enc) : null, u.data_key_version));
  let ok = false;
  let usedRecovery = false;
  if (/^\d{6}$/.test(code)) {
    const step = verifyTotp(c.dec(u.totp_secret_enc), code, u.totp_last_step);
    if (step != null) { ok = true; await ctx.db.system((q) => q.query('update users set totp_last_step = $1 where id = $2', [step, userId])); }
  } else if (code.length >= 10) {
    const r = await ctx.db.system((q) => q.one<{ id: string }>('update recovery_codes set used_at = now() where user_id = $1 and code_hash = $2 and used_at is null returning id', [userId, hashRecoveryCode(code)]));
    ok = !!r; usedRecovery = ok;
  }
  if (!ok) {
    await ctx.db.system((q) => audit(q, 'mfa_failed', userId, {}, ctx.ip));
    return redirect(withFlash(`/login/2fa?next=${encodeURIComponent(safeNext(ctx.query.get('next')))}`, 'err', 'bad_code'));
  }
  // rotate: drop the pending session and issue a brand-new full session (NFR-SEC-05)
  const { token, isNewDevice } = await ctx.db.system(async (q) => {
    await destroySession(q, ctx.session!.id);
    const s = await createSession(q, userId, ctx.ip, ctx.ua, false);
    await audit(q, usedRecovery ? 'recovery_code_used' : 'login', userId, { mfa: true }, ctx.ip);
    return s;
  });
  setSession(ctx, token);
  if (isNewDevice) await securityAlert(ctx.db, userId, 'new_device', ctx.lang, { device: ctx.ua.slice(0, 80) });
  if (usedRecovery) await securityAlert(ctx.db, userId, 'recovery_used', ctx.lang);
  return redirect(safeNext(ctx.query.get('next')));
});

post('/logout', { access: 'public' }, async (ctx) => {
  if (ctx.session) await ctx.db.system(async (q) => { await destroySession(q, ctx.session!.id); await audit(q, 'logout', ctx.user!.id, {}, ctx.ip); });
  ctx.setCookies.push(cookie(SESSION_COOKIE, '', { maxAge: 0 }));
  return redirect('/login');
});

// ───────────── Registration ─────────────
function registerForm(ctx: Ctx, v: { email?: string; name?: string } = {}, invite = '') {
  return html`${form(ctx, '/register', html`
    ${invite ? html`<input type="hidden" name="invite" value="${invite}">` : ''}
    ${field(ctx.t('auth.name'), input({ name: 'name', value: v.name, required: true, autocomplete: 'name', maxlength: 80 }), { id: 'f-name' })}
    ${field(ctx.t('auth.email'), input({ name: 'email', type: 'email', value: v.email, required: true, autocomplete: 'email' }), { id: 'f-email' })}
    ${field(ctx.t('auth.password'), input({ name: 'password', type: 'password', required: true, autocomplete: 'new-password', min: undefined }), { id: 'f-password', hint: ctx.t('auth.password_rule') })}
    <p class="note">${ctx.t('auth.privacy_consent')}</p>
  `, { submit: ctx.t('auth.create_account') })}
  <p class="links"><a href="${invite ? `/login?next=${encodeURIComponent(`/household/join?token=${invite}`)}` : '/login'}">${ctx.t('auth.have_account')}</a></p>`;
}

get('/register', { access: 'guest' }, async (ctx) => {
  const s = await instanceSettings(ctx.db);
  const invite = ctx.query.get('invite') ?? '';
  if (s.open_registration !== true && !invite) return htmlRes(guestPage(ctx, { title: ctx.t('auth.register'), body: html`<p>${ctx.t('auth.registration_closed')}</p>` }), 403);
  return htmlRes(guestPage(ctx, { title: ctx.t('auth.register'), body: registerForm(ctx, {}, invite) }));
});

post('/register', { access: 'guest' }, async (ctx) => {
  if (!hit(`register:${ctx.ip}`, Number(process.env.HEARTH_REGISTER_PER_HOUR ?? 10), 60 * 60_000)) throw new HttpError(429);
  const s = await instanceSettings(ctx.db);
  const invite = (ctx.body.invite ?? '').slice(0, 100);
  const inviteRow = invite ? await ctx.db.system((q) => q.one<any>('select * from household_invites where token_hash = $1 and used_at is null and expires_at > now()', [sha256(invite)])) : null;
  if (s.open_registration !== true && !inviteRow) throw new HttpError(403);
  const email = (ctx.body.email ?? '').trim().slice(0, 320);
  const name = (ctx.body.name ?? '').trim().slice(0, 80);
  const password = ctx.body.password ?? '';
  const again = (err: string) => htmlRes(guestPage(ctx, { title: ctx.t('auth.register'), body: html`<p class="flash err" role="alert">${ctx.t(`error.${err}`)}</p>${registerForm(ctx, { email, name }, invite)}` }), 422);
  if (!EMAIL_RE.test(email) || !name) return again('invalid');
  const problem = await checkPassword(password, email);
  if (problem) return again(`password_${problem}`);
  const exists = await ctx.db.system((q) => q.one('select 1 from users where lower(email) = lower($1)', [email]));
  if (exists) {
    const next = invite ? `/household/join?token=${encodeURIComponent(invite)}` : '';
    // Without e-mail there is no way to notify the owner, so point to sign-in instead of a mail that never comes.
    if (!mailEnabled()) return redirect(withFlash(next ? `/login?next=${encodeURIComponent(next)}` : '/login', 'err', 'account_exists'));
    // Do not reveal account existence: behave like success, tell the owner by e-mail instead.
    await sendReset(ctx.db, email, ctx.lang);
    return redirect(withFlash('/login', 'ok', 'check_email'));
  }
  const userId = await createUser(ctx.db, { email, password, name, lang: ctx.lang, ip: ctx.ip });
  const { token } = await ctx.db.system(async (q) => {
    const r = await createSession(q, userId, ctx.ip, ctx.ua, false);
    await audit(q, 'login', userId, { mfa: false, first: true }, ctx.ip);
    return r;
  });
  setSession(ctx, token);
  return redirect(invite ? `/household/join?token=${encodeURIComponent(invite)}` : '/onboarding');
});

// ───────────── E-mail verification / password reset ─────────────
get('/verify', { access: 'public' }, async (ctx) => {
  const token = ctx.query.get('token') ?? '';
  const r = await ctx.db.system(async (q) => {
    const row = await q.one<any>(`update email_tokens set used_at = now() where token_hash = $1 and purpose = 'verify' and used_at is null and expires_at > now() returning user_id`, [sha256(token)]);
    if (row) { await q.query('update users set email_verified_at = now() where id = $1', [row.user_id]); await audit(q, 'email_verified', row.user_id, {}, ctx.ip); }
    return row;
  });
  return redirect(withFlash(ctx.user ? '/' : '/login', r ? 'ok' : 'err', r ? 'email_verified' : 'token_invalid'));
});

post('/verify/resend', { access: 'auth' }, async (ctx) => {
  if (!mailEnabled()) return redirect(withFlash('/settings', 'err', 'mail_disabled'));
  if (!hit(`verify:${ctx.user!.id}`, 3, 60 * 60_000)) throw new HttpError(429);
  await sendVerification(ctx.db, ctx.user!.id, ctx.user!.email, ctx.lang);
  return redirect(withFlash('/settings', 'ok', 'check_email'));
});

get('/forgot', { access: 'guest' }, async (ctx) => htmlRes(guestPage(ctx, {
  title: ctx.t('auth.forgot'),
  body: !mailEnabled() ? html`<p>${ctx.t('auth.forgot_no_mail')}</p><p class="links"><a href="/login">${ctx.t('auth.back_to_login')}</a></p>` : form(ctx, '/forgot', field(ctx.t('auth.email'), input({ name: 'email', type: 'email', required: true, autocomplete: 'email' }), { id: 'f-email' }), { submit: ctx.t('auth.send_reset') }),
})));

post('/forgot', { access: 'guest' }, async (ctx) => {
  if (!mailEnabled()) return redirect('/forgot');
  const email = (ctx.body.email ?? '').trim().slice(0, 320);
  if (hit(`forgot:${ctx.ip}`, 5, 60 * 60_000) && hit(`forgot:${email.toLowerCase()}`, 3, 60 * 60_000) && EMAIL_RE.test(email)) await sendReset(ctx.db, email, ctx.lang);
  return redirect(withFlash('/login', 'ok', 'check_email')); // identical response either way
});

get('/reset', { access: 'public' }, async (ctx) => htmlRes(guestPage(ctx, {
  title: ctx.t('auth.reset'),
  body: form(ctx, '/reset', html`<input type="hidden" name="token" value="${ctx.query.get('token') ?? ''}">
    ${field(ctx.t('auth.new_password'), input({ name: 'password', type: 'password', required: true, autocomplete: 'new-password' }), { id: 'f-password', hint: ctx.t('auth.password_rule') })}`, { submit: ctx.t('auth.reset') }),
})));

post('/reset', { access: 'public' }, async (ctx) => {
  const token = ctx.body.token ?? '';
  const row = await ctx.db.system((q) => q.one<any>(`select t.user_id, u.email from email_tokens t join users u on u.id = t.user_id where t.token_hash = $1 and t.purpose = 'reset' and t.used_at is null and t.expires_at > now()`, [sha256(token)]));
  if (!row) return redirect(withFlash('/forgot', 'err', 'token_invalid'));
  const problem = await checkPassword(ctx.body.password ?? '', row.email);
  if (problem) return redirect(withFlash(`/reset?token=${encodeURIComponent(token)}`, 'err', `password_${problem}`));
  const hash = await hashPassword(ctx.body.password);
  await ctx.db.system(async (q) => {
    await q.query('update email_tokens set used_at = now() where token_hash = $1', [sha256(token)]);
    await q.query('update users set password_hash = $1, failed_logins = 0, locked_until = null, email_verified_at = coalesce(email_verified_at, now()) where id = $2', [hash, row.user_id]);
    await q.query('delete from sessions where user_id = $1', [row.user_id]); // log out everywhere
    await audit(q, 'password_reset', row.user_id, {}, ctx.ip);
  });
  await securityAlert(ctx.db, row.user_id, 'password_changed', ctx.lang);
  return redirect(withFlash('/login', 'ok', 'password_changed'));
});

// ───────────── Step-up re-authentication (NFR-SEC-06) ─────────────
get('/reauth', { access: 'auth' }, async (ctx) => htmlRes(page(ctx, {
  title: ctx.t('auth.reauth'),
  body: html`<section class="card"><p>${ctx.t('auth.reauth_why')}</p>${form(ctx, `/reauth?next=${encodeURIComponent(safeNext(ctx.query.get('next')))}`, html`
    ${field(ctx.t('auth.password'), input({ name: 'password', type: 'password', required: true, autocomplete: 'current-password', autofocus: true }), { id: 'f-password' })}
    ${ctx.user!.totp_enabled ? field(ctx.t('auth.code'), input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 6 }), { id: 'f-code' }) : ''}`, { submit: ctx.t('auth.confirm') })}</section>`,
})));

post('/reauth', { access: 'auth' }, async (ctx) => {
  const userId = ctx.user!.id;
  if (!hit(`reauth:${userId}`, 8, 15 * 60_000)) throw new HttpError(429);
  const next = safeNext(ctx.query.get('next'));
  const u = await ctx.db.system((q) => q.one<any>('select password_hash, totp_enabled, totp_secret_enc, totp_last_step from users where id = $1', [userId]));
  let ok = await verifyPassword(u.password_hash, ctx.body.password ?? '');
  if (ok && u.totp_enabled) {
    const c = fieldCipher(unwrapDataKey(userId, ctx.user!.data_key_enc, ctx.user!.data_key_version));
    const step = verifyTotp(c.dec(u.totp_secret_enc), (ctx.body.code ?? '').trim(), u.totp_last_step);
    ok = step != null;
    if (ok) await ctx.db.system((q) => q.query('update users set totp_last_step = $1 where id = $2', [step, userId]));
  }
  if (!ok) return redirect(withFlash(`/reauth?next=${encodeURIComponent(next)}`, 'err', 'reauth_failed'));
  await ctx.db.system(async (q) => {
    await q.query('update sessions set reauth_at = now() where id = $1', [ctx.session!.id]);
    await audit(q, 'reauth', userId, {}, ctx.ip);
  });
  return redirect(next);
});

// ───────────── misc ─────────────
get('/lang', { access: 'public' }, async (ctx) => {
  const l = ctx.query.get('l') as Lang;
  if (LANGS.includes(l)) ctx.setCookies.push(cookie('lang', l, { maxAge: 31_536_000, httpOnly: true }));
  return redirect(ctx.user ? '/settings' : '/login');
});

post('/view', { access: 'auth' }, async (ctx) => {
  const v = ['mine', 'household', 'all'].includes(ctx.body.view) ? ctx.body.view : 'all';
  ctx.setCookies.push(cookie('view', v, { maxAge: 31_536_000 }));
  return redirect(safeNext(ctx.body.next));
});

get('/more', { access: 'auth' }, async (ctx) => htmlRes(page(ctx, { title: ctx.t('nav.more'), body: navMore(ctx) })));

get('/healthz', { access: 'public' }, async (ctx) => {
  try {
    await ctx.db.system((q) => q.one('select 1'));
    return jsonRes({ status: 'ok', db: ctx.db.kind, version: '0.2.0' });
  } catch {
    return jsonRes({ status: 'error' }, 503);
  }
});

get('/robots.txt', { access: 'public' }, async () => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'User-agent: *\nAllow: /\n' })); // every private page requires a session, so crawlers only ever see /login

export const _internal = { EMAIL_RE, config };
