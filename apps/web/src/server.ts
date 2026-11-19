/**
 * Hearth Family Finance — HTTP server entry point.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { log } from './log.ts';
import { openDb, queryCounter, type Db } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { match, HttpError, htmlRes, redirect, type Ctx, type Res, type View } from './http/app.ts';
import { parseCookies, readBody, parseUrlEncoded, parseMultipart } from './http/body.ts';
import { securityHeaders } from './http/headers.ts';
import { loadAssets, serveStatic, serveOcr } from './http/static.ts';
import { loadSession, SESSION_COOKIE, CSRF_COOKIE, cookie, randomToken, stepUpFresh } from './security/session.ts';
import { translator, pickLang, LANGS, type Lang } from './i18n/index.ts';
import { loadPrefs } from './services/common.ts';
import { instanceSettings } from './services/instance.ts';
import { guestPage } from './views/layout.ts';
import { html } from './views/html.ts';
import { startJobs } from './jobs/scheduler.ts';
import { loadPlugins, registry } from './services/plugins.ts';
import './routes/index.ts';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);



function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? '';
}

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && A.length > 0 && timingSafeEqual(A, B);
}

function errorPage(ctx: Ctx, status: number): Res {
  const key = status === 404 ? 'error.not_found' : status === 403 ? 'error.forbidden' : status === 413 ? 'error.too_large' : status === 422 ? 'error.invalid' : 'error.server';
  const body = guestPage(ctx, { title: ctx.t(key), body: html`<p>${ctx.t('error.code', { code: status })}</p><p><a class="btn" href="/">${ctx.t('common.home')}</a></p>` });
  return htmlRes(body, status);
}

const SKIP_ONBOARDING = /^\/(onboarding|logout|settings|lang|healthz|notifications|admin|reauth)/;
const MFA_SETUP_ALLOWED = /^\/(settings\/security|logout|reauth|lang)/;

export async function handle(db: Db, req: IncomingMessage, res: ServerResponse) {
  const nonce = randomBytes(16).toString('base64');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = (req.method ?? 'GET').toUpperCase();
  const ae = String(req.headers['accept-encoding'] ?? '');

  const send = async (r: Res) => {
    const headers: Record<string, string | string[]> = { ...securityHeaders(nonce), ...r.headers };
    let body = r.body;
    const type = r.headers['content-type'] ?? '';
    if (typeof body === 'string') body = Buffer.from(body, 'utf8');
    if (body.length > 1024 && /^(text\/|application\/json)/.test(type) && !r.headers['content-encoding']) {
      if (/\bbr\b/.test(ae)) { body = await brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }); headers['content-encoding'] = 'br'; }
      else if (/\bgzip\b/.test(ae)) { body = await gz(body); headers['content-encoding'] = 'gzip'; }
      headers.vary = 'Accept-Encoding';
    }
    if (ctx.setCookies.length) headers['set-cookie'] = ctx.setCookies;
    if (!config.isProd) headers['server-timing'] = `db;desc="queries=${queryCounter.getStore()?.count ?? 0}"`;
    headers['content-length'] = String(body.length);
    res.writeHead(r.status, headers);
    res.end(method === 'HEAD' ? undefined : body);
  };

  // Static assets first (no session work)
  if (method === 'GET' || method === 'HEAD') {
    const st = serveStatic(url.pathname, ae) ?? await serveOcr(url.pathname, ae);
    if (st) {
      res.writeHead(st.status, { ...securityHeaders(nonce), ...st.headers, 'content-length': String(st.body.length) });
      res.end(method === 'HEAD' ? undefined : st.body);
      return;
    }
  }

  const cookies = parseCookies(req.headers.cookie);
  const cookieLang = LANGS.includes(cookies.lang as Lang) ? (cookies.lang as Lang) : null;
  let lang: Lang = cookieLang ?? pickLang(req.headers['accept-language'] as string | undefined);
  const ctx: Ctx = {
    req, res, db, url, method, path: url.pathname, params: {}, query: url.searchParams,
    body: {}, bodyAll: {}, files: [], json: null, cookies, nonce, ip: clientIp(req), ua: String(req.headers['user-agent'] ?? '').slice(0, 300),
    session: null, user: null, prefs: null, lang, view: 'all', households: [], unread: 0,
    t: translator(lang), csrf: '', setCookies: [],
    as: (fn) => { if (!ctx.user) throw new HttpError(401); return db.asUser(ctx.user.id, fn); },
  };

  let isApi = false;
  try {
    const m = match(method, url.pathname);
    if (!m) { await send(errorPage(ctx, 404)); return; }
    const { route, params } = m;
    isApi = !!route.opts.api;
    ctx.params = params;

    // Session
    const settings = await instanceSettings(db);
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const s = await db.system((q) => loadSession(q, token, Number(settings.session_idle_minutes ?? config.sessionIdleMinutes)));
      if (s) { ctx.session = s.session; ctx.user = s.user; ctx.csrf = s.session.csrf_token; }
      else ctx.setCookies.push(cookie(SESSION_COOKIE, '', { maxAge: 0 }));
    }
    if (ctx.user && !ctx.session!.mfa_pending) {
      const [prefs, hh, unread] = await db.asUser(ctx.user.id, async (q) => [
        await loadPrefs(q),
        await q.query<any>(`select h.id, h.name, m.role, m.id member_id from members m join households h on h.id = m.household_id where m.user_id = hearth_uid() order by h.created_at`),
        (await q.one<{ n: number }>('select count(*)::int n from notifications where owner_id = hearth_uid() and read_at is null'))?.n ?? 0,
      ] as const);
      ctx.prefs = prefs;
      ctx.households = hh;
      ctx.unread = unread;
      if (prefs) { lang = prefs.locale; ctx.lang = lang; ctx.t = translator(lang); }
      const v = cookies.view as View;
      ctx.view = hh.length === 0 ? 'mine' : (['mine', 'household', 'all'] as View[]).includes(v) ? v : 'all';
    }
    if (!ctx.csrf) {
      ctx.csrf = cookies[CSRF_COOKIE] && /^[\w-]{20,64}$/.test(cookies[CSRF_COOKIE]) ? cookies[CSRF_COOKIE] : randomToken(24);
      if (cookies[CSRF_COOKIE] !== ctx.csrf) ctx.setCookies.push(cookie(CSRF_COOKIE, ctx.csrf));
    }

    // Access control (deny by default)
    const a = route.opts.access;
    const authed = !!ctx.user && !ctx.session!.mfa_pending;
    if (a === 'guest' && authed) { await send(redirect('/')); return; }
    if (a === 'mfa' && !(ctx.user && ctx.session!.mfa_pending)) { await send(redirect(authed ? '/' : '/login')); return; }
    if ((a === 'auth' || a === 'admin') && !authed) {
      if (route.opts.api) { await send({ status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":"unauthorized"}' }); return; }
      await send(redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`)); return;
    }
    if (a === 'admin' && !ctx.user!.is_admin) { await send(errorPage(ctx, 404)); return; }
    if (route.opts.module === 'buckets' && ctx.prefs?.bucket_mode === 'off') { await send(errorPage(ctx, 404)); return; }
    if (route.opts.module === 'invest' && !ctx.prefs?.investment_enabled) { await send(errorPage(ctx, 404)); return; }
    if (authed && settings.enforce_2fa === true && !ctx.user!.totp_enabled && !MFA_SETUP_ALLOWED.test(url.pathname) && !route.opts.api) {
      await send(redirect('/settings/security?err=mfa_required')); return;
    }
    if (authed && ctx.prefs && !ctx.prefs.onboarded && method === 'GET' && url.pathname === '/' && !SKIP_ONBOARDING.test(url.pathname)) {
      await send(redirect('/onboarding')); return;
    }

    // Body + CSRF (NFR-SEC-22)
    if (method === 'POST') {
      const ct = String(req.headers['content-type'] ?? '');
      const limit = route.opts.upload ?? 256 * 1024;
      const raw = await readBody(req, limit);
      if (ct.startsWith('application/x-www-form-urlencoded')) { const p = parseUrlEncoded(raw); ctx.body = p.body; ctx.bodyAll = p.all; }
      else if (ct.startsWith('multipart/form-data') && route.opts.upload) { const p = parseMultipart(raw, ct); ctx.body = p.body; ctx.bodyAll = p.all; ctx.files = p.files; }
      else if (ct.startsWith('application/json') && route.opts.api) { try { ctx.json = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400); } }
      else if (raw.length) throw new HttpError(415);
      const provided = route.opts.api ? String(req.headers['x-csrf-token'] ?? '') : ctx.body._csrf ?? '';
      const origin = req.headers.origin;
      if (origin && origin !== config.baseUrl && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, 'origin');
      if (!safeEqual(provided, ctx.csrf)) throw new HttpError(403, 'csrf');
    }

    if (route.opts.stepUp && !stepUpFresh(ctx.session)) {
      // For POSTs, return to the page the form was on (the user re-submits after confirming).
      let back = url.pathname + url.search;
      if (method !== 'GET') {
        try { const r = new URL(String(req.headers.referer ?? ''), 'http://x'); back = r.pathname + r.search; } catch { back = '/'; }
      }
      await send(redirect(`/reauth?next=${encodeURIComponent(back)}`)); return;
    }

    const r = await route.handler(ctx);
    await send(r);
  } catch (e) {
    // 42501 = RLS / reference guard denial → behave exactly like "not found" (no existence oracle).
    const pgCode = (e as { code?: string })?.code;
    const status = e instanceof HttpError ? e.status : pgCode === '42501' ? 404 : pgCode === '23505' || pgCode === '23503' ? 422 : 500;
    if (status === 500) log.error('request failed', { path: url.pathname, err: (e as Error).message, stack: (e as Error).stack });
    else log.debug('request rejected', { path: url.pathname, status, reason: (e as Error).message });
    if (status === 422 && method === 'POST' && e instanceof HttpError && !isApi) {
      const back = typeof req.headers.referer === 'string' ? new URL(req.headers.referer, 'http://x').pathname : '/';
      await send(redirect(`${back}?err=${encodeURIComponent(e.message || 'invalid')}`));
      return;
    }
    try { await send(isApi ? { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify({ error: status === 500 ? 'server_error' : (e as Error).message || 'error' }) } : errorPage(ctx, status)); } catch { res.destroy(); }
  }
}

export async function createApp(db: Db) {
  loadAssets();
  await migrate(db);
  if (!registry.importers.size) await loadPlugins(['import-presets', process.env.HEARTH_PLUGINS ?? ''].join(','));
  return createServer((req, res) => {
    const t0 = performance.now();
    queryCounter.run({ count: 0 }, () => {
      handle(db, req, res).finally(() => {
        const c = queryCounter.getStore();
        log.debug('req', { m: req.method, p: (req.url ?? '').split('?')[0], s: res.statusCode, ms: Math.round(performance.now() - t0), q: c?.count });
      });
    });
  });
}

if (process.argv[1] && import.meta.filename === (await import('node:path')).resolve(process.argv[1])) {
  await (await import('./security/kms.ts')).initKeys();
  const db = await openDb();
  const server = await createApp(db);
  server.listen(config.port, config.host, () => log.info('Hearth listening', { url: `http://${config.host}:${config.port}`, db: db.kind }));
  startJobs(db);
  const stop = async () => { server.close(); await db.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
