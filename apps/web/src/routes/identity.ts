/**
 * Passkeys (FR-AUTH-05), OpenID Connect sign-in / linking (FR-AUTH-04) and consented support access (NFR-SEC-12).
 */
import { get, post, htmlRes, redirect, jsonRes, withFlash, HttpError, type Ctx } from '../http/app.ts';
import { html } from '../views/html.ts';
import { guestPage } from '../views/layout.ts';
import { createSession, destroySession, cookie, SESSION_COOKIE, sha256, randomToken, stepUpFresh } from '../security/session.ts';
import { audit } from '../security/audit.ts';
import { newChallenge, rp, b64u, verifyRegistration, verifyAssertion } from '../security/webauthn.ts';
import { discover, pkce, authorizeUrl, exchangeCode, verifyIdToken } from '../security/oidc.ts';
import { keys, open } from '../security/keys.ts';
import { instanceSettings } from '../services/instance.ts';
import { createUser, securityAlert } from '../services/users.ts';
import { intIn, requireUuid } from '../services/common.ts';
import { hit } from '../security/ratelimit.ts';
import { config } from '../config.ts';

const WA_COOKIE = config.secureCookies ? '__Host-hearth-wa' : 'hearth-wa';
const OIDC_COOKIE = config.secureCookies ? '__Host-hearth-oidc' : 'hearth-oidc';

async function saveChallenge(ctx: Ctx, id: string, purpose: string, challenge: string, userId: string | null, data: object = {}) {
  await ctx.db.system(async (q) => {
    await q.query('delete from auth_challenges where expires_at < now()');
    await q.query(`insert into auth_challenges(id, purpose, user_id, challenge, data, expires_at) values ($1,$2,$3,$4,$5, now() + interval '10 minutes')
      on conflict (id) do update set challenge = excluded.challenge, data = excluded.data, expires_at = excluded.expires_at`, [id, purpose, userId, challenge, JSON.stringify(data)]);
  });
}

async function takeChallenge(ctx: Ctx, id: string, purpose: string) {
  return ctx.db.system((q) => q.one<any>(`delete from auth_challenges where id = $1 and purpose = $2 and expires_at > now() returning challenge, user_id, data`, [id, purpose]));
}

/** Finish a sign-in: brand-new session (rotation), audit, new-device alert. */
async function signIn(ctx: Ctx, userId: string, action: 'passkey_login' | 'oidc_login', mfaPending = false) {
  const { token, isNewDevice } = await ctx.db.system(async (q) => {
    if (ctx.session) await destroySession(q, ctx.session.id);
    const s = await createSession(q, userId, ctx.ip, ctx.ua, mfaPending);
    await audit(q, action, userId, {}, ctx.ip);
    return s;
  });
  ctx.setCookies.push(cookie(SESSION_COOKIE, token));
  if (isNewDevice && !mfaPending) await securityAlert(ctx.db, userId, 'new_device', ctx.lang, { device: ctx.ua.slice(0, 80) });
}

// ───────────── Passkey registration (signed-in, recent re-authentication required) ─────────────
post('/api/v1/webauthn/register/options', { access: 'auth', api: true }, async (ctx) => {
  if (!stepUpFresh(ctx.session)) return jsonRes({ error: 'reauth', reauth: '/reauth?next=%2Fsettings%2Fsecurity' }, 401);
  const challenge = newChallenge();
  await saveChallenge(ctx, sha256(`reg:${ctx.session!.id}`), 'webauthn_register', challenge, ctx.user!.id);
  const existing = await ctx.db.system((q) => q.query<{ credential_id: string }>('select credential_id from webauthn_credentials where user_id = $1', [ctx.user!.id]));
  const r = rp();
  return jsonRes({
    challenge,
    rp: { id: r.id, name: r.name },
    user: { id: b64u(Buffer.from(ctx.user!.id.replace(/-/g, ''), 'hex')), name: ctx.user!.email, displayName: ctx.user!.display_name || ctx.user!.email },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.credential_id })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    attestation: 'none',
    timeout: 120_000,
  });
});

post('/api/v1/webauthn/register/verify', { access: 'auth', api: true }, async (ctx) => {
  const b = (ctx.json ?? {}) as any;
  const ch = await takeChallenge(ctx, sha256(`reg:${ctx.session!.id}`), 'webauthn_register');
  if (!ch || ch.user_id !== ctx.user!.id) throw new HttpError(400, 'challenge');
  let reg;
  try { reg = verifyRegistration({ clientDataJSON: String(b.response?.clientDataJSON ?? ''), attestationObject: String(b.response?.attestationObject ?? '') }, ch.challenge); }
  catch (e) { return jsonRes({ error: (e as Error).message }, 400); }
  const name = String(b.name ?? '').slice(0, 60) || ctx.ua.slice(0, 60);
  await ctx.db.system(async (q) => {
    await q.query('insert into webauthn_credentials(user_id, credential_id, public_key_jwk, sign_count, name, transports) values ($1,$2,$3,$4,$5,$6)',
      [ctx.user!.id, reg.credentialId, JSON.stringify(reg.jwk), reg.signCount, name, Array.isArray(b.response?.transports) ? b.response.transports.slice(0, 5).map(String) : []]);
    await audit(q, 'passkey_added', ctx.user!.id, {}, ctx.ip);
  });
  await securityAlert(ctx.db, ctx.user!.id, 'passkey_added', ctx.lang);
  return jsonRes({ ok: true }, 201);
});

post('/settings/passkeys/:id/delete', { access: 'auth', stepUp: true }, async (ctx) => {
  await ctx.db.system(async (q) => {
    const r = await q.query('delete from webauthn_credentials where id = $1 and user_id = $2 returning id', [requireUuid(ctx.params.id), ctx.user!.id]);
    if (!r.length) throw new HttpError(404);
    await audit(q, 'passkey_removed', ctx.user!.id, {}, ctx.ip);
  });
  return redirect(withFlash('/settings/security', 'ok', 'deleted'));
});

// ───────────── Passkey sign-in (discoverable credentials) ─────────────
post('/webauthn/login/options', { access: 'guest', api: true }, async (ctx) => {
  if (!hit(`wa-login:${ctx.ip}`, 30, 10 * 60_000)) throw new HttpError(429);
  const handle = randomToken(24);
  const challenge = newChallenge();
  await saveChallenge(ctx, sha256(handle), 'webauthn_login', challenge, null);
  ctx.setCookies.push(cookie(WA_COOKIE, handle, { maxAge: 600 }));
  return jsonRes({ challenge, rpId: rp().id, userVerification: 'required', allowCredentials: [], timeout: 120_000 });
});

post('/webauthn/login/verify', { access: 'guest', api: true }, async (ctx) => {
  const b = (ctx.json ?? {}) as any;
  const handle = ctx.cookies[WA_COOKIE] ?? '';
  ctx.setCookies.push(cookie(WA_COOKIE, '', { maxAge: 0 }));
  const ch = handle ? await takeChallenge(ctx, sha256(handle), 'webauthn_login') : null;
  if (!ch) return jsonRes({ error: 'challenge' }, 400);
  const cred = await ctx.db.system((q) => q.one<any>('select c.*, u.disabled from webauthn_credentials c join users u on u.id = c.user_id where c.credential_id = $1', [String(b.id ?? '')]));
  if (!cred || cred.disabled) return jsonRes({ error: 'unknown credential' }, 400);
  try {
    const r = verifyAssertion({ clientDataJSON: String(b.response?.clientDataJSON ?? ''), authenticatorData: String(b.response?.authenticatorData ?? ''), signature: String(b.response?.signature ?? '') }, ch.challenge, cred);
    await ctx.db.system((q) => q.query('update webauthn_credentials set sign_count = $2, last_used_at = now() where id = $1', [cred.id, r.signCount]));
  } catch (e) {
    await ctx.db.system((q) => audit(q, 'login_failed', cred.user_id, { passkey: true }, ctx.ip));
    return jsonRes({ error: (e as Error).message }, 400);
  }
  // a user-verified passkey is possession + biometric/PIN: it satisfies the second factor on its own
  await signIn(ctx, cred.user_id, 'passkey_login');
  return jsonRes({ redirect: '/' });
});

// ───────────── OpenID Connect ─────────────
async function provider(ctx: Ctx, id: string) {
  const p = await ctx.db.system((q) => q.one<any>('select * from oidc_providers where id = $1 and enabled', [id]));
  if (!p) throw new HttpError(404);
  // stored as "<masterKeyId>|<base64 sealed secret>" (bytea → Uint8Array with PGlite, Buffer with pg)
  const [kid, blob] = p.client_secret_enc ? Buffer.from(p.client_secret_enc).toString('utf8').split('|') : [];
  return { ...p, client_secret: kid && blob ? open(keys().get(kid), Buffer.from(blob, 'base64'), 'oidc').toString('utf8') : null };
}

const redirectUri = () => `${config.baseUrl}/auth/oidc/callback`;

get('/auth/oidc/start/:provider', { access: 'public' }, async (ctx) => {
  if (!/^[a-z0-9-]{1,40}$/.test(ctx.params.provider)) throw new HttpError(404);
  if (!hit(`oidc:${ctx.ip}`, 30, 10 * 60_000)) throw new HttpError(429);
  const p = await provider(ctx, ctx.params.provider);
  const d = await discover(p.issuer);
  const state = randomToken(24), nonce = randomToken(24), { verifier, challenge } = pkce();
  const linking = ctx.user && !ctx.session?.mfa_pending ? ctx.user.id : null;
  await saveChallenge(ctx, sha256(state), 'oidc', nonce, linking, { provider: p.id, verifier });
  // SameSite=Lax: the provider redirects back with a cross-site top-level GET
  ctx.setCookies.push(cookie(OIDC_COOKIE, state, { maxAge: 600, sameSite: 'Lax' }));
  return { status: 303, headers: { location: authorizeUrl(d, p, redirectUri(), state, nonce, challenge), 'cache-control': 'no-store' }, body: '' };
});

/** Cross-site redirects drop SameSite=Strict cookies, so finish with a same-site navigation. */
function continuePage(ctx: Ctx, to: string) {
  return htmlRes(guestPage(ctx, { title: ctx.t('auth.signing_in'), body: html`<meta http-equiv="refresh" content="0;url=${to}"><p><a class="btn primary" href="${to}">${ctx.t('common.next')}</a></p>` }));
}

get('/auth/oidc/callback', { access: 'public' }, async (ctx) => {
  const state = ctx.query.get('state') ?? '';
  const code = ctx.query.get('code') ?? '';
  const cookieState = ctx.cookies[OIDC_COOKIE] ?? '';
  ctx.setCookies.push(cookie(OIDC_COOKIE, '', { maxAge: 0, sameSite: 'Lax' }));
  if (!state || state !== cookieState || !code) return continuePage(ctx, withFlash('/login', 'err', 'oidc_failed'));
  const ch = await takeChallenge(ctx, sha256(state), 'oidc');
  if (!ch) return continuePage(ctx, withFlash('/login', 'err', 'oidc_failed'));
  let claims;
  const p = await provider(ctx, ch.data.provider);
  try {
    const d = await discover(p.issuer);
    const idToken = await exchangeCode(d, p, code, ch.data.verifier, redirectUri());
    claims = await verifyIdToken(idToken, d, p.client_id, ch.challenge);
  } catch {
    return continuePage(ctx, withFlash('/login', 'err', 'oidc_failed'));
  }
  const existing = await ctx.db.system((q) => q.one<any>('select i.user_id, u.totp_enabled, u.disabled from oidc_identities i join users u on u.id = i.user_id where i.provider_id = $1 and i.subject = $2', [p.id, claims.sub]));
  if (ch.user_id) {
    // linking an identity to the signed-in account
    if (existing && existing.user_id !== ch.user_id) return continuePage(ctx, withFlash('/settings/security', 'err', 'oidc_taken'));
    await ctx.db.system(async (q) => {
      await q.query('insert into oidc_identities(provider_id, subject, user_id, email) values ($1,$2,$3,$4) on conflict do nothing', [p.id, claims.sub, ch.user_id, claims.email ?? null]);
      await audit(q, 'oidc_linked', ch.user_id, { provider: p.id }, ctx.ip);
    });
    return continuePage(ctx, withFlash('/settings/security', 'ok', 'saved'));
  }
  if (existing) {
    if (existing.disabled) return continuePage(ctx, withFlash('/login', 'err', 'oidc_failed'));
    // TOTP still applies to OIDC sign-ins when the user enabled it
    await signIn(ctx, existing.user_id, 'oidc_login', existing.totp_enabled);
    return continuePage(ctx, existing.totp_enabled ? '/login/2fa' : '/');
  }
  // New identity: never auto-link to an existing account by e-mail (account-takeover risk)
  const settings = await instanceSettings(ctx.db);
  if (!p.allow_signup || settings.open_registration !== true || !claims.email || claims.email_verified !== true) return continuePage(ctx, withFlash('/login', 'err', 'oidc_no_account'));
  const taken = await ctx.db.system((q) => q.one('select 1 from users where lower(email) = lower($1)', [claims.email]));
  if (taken) return continuePage(ctx, withFlash('/login', 'err', 'oidc_link_first'));
  const userId = await createUser(ctx.db, { email: claims.email, password: randomToken(32), name: (claims.name ?? claims.email.split('@')[0]).slice(0, 80), lang: ctx.lang, ip: ctx.ip });
  await ctx.db.system(async (q) => {
    await q.query('update users set email_verified_at = now() where id = $1', [userId]);
    await q.query('insert into oidc_identities(provider_id, subject, user_id, email) values ($1,$2,$3,$4)', [p.id, claims.sub, userId, claims.email]);
  });
  await signIn(ctx, userId, 'oidc_login');
  return continuePage(ctx, '/onboarding');
});

post('/settings/oidc/:provider/unlink', { access: 'auth', stepUp: true }, async (ctx) => {
  await ctx.db.system(async (q) => {
    await q.query('delete from oidc_identities where provider_id = $1 and user_id = $2', [ctx.params.provider, ctx.user!.id]);
    await audit(q, 'oidc_unlinked', ctx.user!.id, { provider: ctx.params.provider }, ctx.ip);
  });
  return redirect(withFlash('/settings/security', 'ok', 'saved'));
});

// ───────────── Support access (NFR-SEC-12): the USER grants a time-limited, audited, read-only view ─────────────
post('/settings/support/grant', { access: 'auth', stepUp: true }, async (ctx) => {
  const hours = intIn(ctx.body.hours, 1, 72, 24);
  const admin = requireUuid(ctx.body.admin_id);
  await ctx.db.system(async (q) => {
    const ok = await q.one('select 1 from users where id = $1 and is_admin and not disabled', [admin]);
    if (!ok) throw new HttpError(404);
    await q.query(`insert into support_grants(user_id, granted_to, expires_at) values ($1,$2, now() + make_interval(hours => $3))`, [ctx.user!.id, admin, hours]);
    await audit(q, 'support_granted', ctx.user!.id, { to: admin, hours }, ctx.ip);
  });
  return redirect(withFlash('/settings/security', 'ok', 'saved'));
});

post('/settings/support/revoke', { access: 'auth' }, async (ctx) => {
  await ctx.db.system(async (q) => {
    await q.query('delete from support_grants where user_id = $1', [ctx.user!.id]);
    await audit(q, 'support_revoked', ctx.user!.id, {}, ctx.ip);
  });
  return redirect(withFlash('/settings/security', 'ok', 'saved'));
});
