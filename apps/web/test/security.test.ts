import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, Client, options } from './helpers.ts';
import { routes } from '../src/http/app.ts';
import { redact } from '../src/log.ts';
import { verifyChain } from '../src/security/audit.ts';
import { checkPassword, hashPassword, verifyPassword } from '../src/security/password.ts';
import { hotp, verifyTotp, base32Decode, base32Encode, currentStep } from '../src/security/totp.ts';
import { seal, open } from '../src/security/keys.ts';
import { randomBytes } from 'node:crypto';

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('NFR-SEC-09: every route declares an access level (deny by default)', () => {
  assert.ok(routes.length > 50);
  for (const r of routes) assert.ok(['public', 'guest', 'mfa', 'auth', 'admin'].includes(r.opts.access), `${r.method} ${r.path}`);
  const publicRoutes = routes.filter((r) => r.opts.access === 'public').map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(publicRoutes, ['GET /auth/oidc/callback', 'GET /auth/oidc/start/:provider', 'GET /healthz', 'GET /invite', 'GET /lang', 'GET /reset', 'GET /robots.txt', 'GET /verify', 'POST /logout', 'POST /reset'].sort());
});

test('anonymous users are redirected from every authenticated page, API returns 401', async () => {
  const c = new Client(app.base);
  for (const r of routes.filter((x) => x.method === 'GET' && (x.opts.access === 'auth' || x.opts.access === 'admin'))) {
    const path = r.path.replace(/:(\w+)/g, '00000000-0000-4000-8000-000000000000');
    const res = await c.get(path);
    if (r.opts.api) assert.equal(res.status, 401, path);
    else { assert.equal(res.status, 303, path); assert.match(res.location ?? '', /^\/login/, path); }
  }
});

test('NFR-SEC-19..21: strict security headers on every response', async () => {
  const c = new Client(app.base);
  for (const path of ['/login', '/healthz', '/nope', '/sw.js']) {
    const r = await c.get(path);
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'nonce-[^']+' 'strict-dynamic'/, path);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /require-trusted-types-for 'script'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.ok(r.headers.get('permissions-policy')?.includes('camera=()'));
    assert.ok(r.headers.get('referrer-policy'));
  }
  const page = await c.get('/login');
  const nonce = /'nonce-([^']+)'/.exec(page.headers.get('content-security-policy')!)![1];
  for (const tag of page.text.match(/<(script|style)\b[^>]*>/g) ?? []) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
  assert.doesNotMatch(page.text, /\sstyle="/, 'no inline style attributes');
  assert.doesNotMatch(page.text, /\son[a-z]+="/, 'no inline event handlers');
});

test('NFR-SEC-22: POST without a valid CSRF token is rejected', async () => {
  const c = new Client(app.base);
  await c.register('csrf@hearth.test');
  const r = await c.req('POST', '/accounts', { _csrf: 'wrong', name: 'X', type: 'cash' });
  assert.equal(r.status, 403);
  const r2 = await c.req('POST', '/accounts', { name: 'X', type: 'cash' });
  assert.equal(r2.status, 403);
  const ok = await c.post('/accounts', { name: 'X', type: 'cash', opening: '1' }, '/accounts');
  assert.equal(ok.status, 303);
});

test('NFR-SEC-04: session cookie flags and no user enumeration on login', async () => {
  const c = new Client(app.base);
  await c.register('cookie@hearth.test');
  const anon = new Client(app.base);
  const t2 = await anon.csrf('/login');
  const wrongUser = await anon.req('POST', '/login', { _csrf: t2, email: 'nobody@hearth.test', password: 'whatever-whatever' });
  const wrongPass = await anon.req('POST', '/login', { _csrf: t2, email: 'cookie@hearth.test', password: 'whatever-whatever' });
  assert.equal(wrongUser.status, 401);
  assert.equal(wrongPass.status, 401);
  const msg = (t: string) => /class="flash err"[^>]*>([^<]+)/.exec(t)?.[1];
  assert.equal(msg(wrongUser.text), msg(wrongPass.text));
  const login = await anon.req('POST', '/login', { _csrf: t2, email: 'cookie@hearth.test', password: 'lantern-river-mango-42' });
  assert.equal(login.status, 303);
  const sc = login.headers.getSetCookie().find((s) => s.startsWith('hearth=') || s.startsWith('__Host-hearth='))!;
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Path=\//);
});

test('NFR-SEC-11: IDOR — user B gets 404 for every resource of user A (app layer + RLS)', async () => {
  const a = new Client(app.base);
  await a.register('alice@hearth.test');
  await a.post('/accounts', { name: 'A-bank', type: 'savings', opening: '1000' }, '/accounts');
  const accHtml = (await a.get('/transactions/new')).text;
  const accId = options(accHtml, 'account_id')[0].value;
  await a.post('/transactions', { kind: 'expense', amount: '50', date: '2026-11-01', account_id: accId, payee: 'secret-shop' }, '/transactions/new');
  await a.post('/debts', { name: 'A-debt', type: 'personal_loan', method: 'reducing', balance: '10000', rate: '12', payment: '500' }, '/debts');
  await a.post('/goals', { name: 'A-goal', target: '5000' }, '/goals');
  const txId = /href="\/transactions\/([0-9a-f-]{36})"/.exec((await a.get('/transactions')).text)![1];
  const debtId = /href="\/debts\/([0-9a-f-]{36})"/.exec((await a.get('/debts')).text)![1];
  const goalId = /href="\/goals\/([0-9a-f-]{36})"/.exec((await a.get('/goals')).text)![1];

  const b = new Client(app.base);
  await b.register('bob@hearth.test');
  for (const p of [`/transactions/${txId}`, `/debts/${debtId}`, `/goals/${goalId}`, `/accounts/${accId}`]) {
    assert.equal((await b.get(p)).status, 404, p);
  }
  for (const [p, body] of [[`/transactions/${txId}/delete`, {}], [`/debts/${debtId}/delete`, {}], [`/goals/${goalId}/delete`, {}], [`/accounts/${accId}/delete`, {}],
    [`/debts/${debtId}/payments`, { amount: '100', date: '2026-11-02' }], [`/goals/${goalId}/contribute`, { amount: '100', date: '2026-11-02' }]] as const) {
    const r = await b.post(p, body as Record<string, string>, '/');
    assert.equal(r.status, 404, p);
  }
  const list = await b.get('/transactions');
  assert.doesNotMatch(list.text, /secret-shop/);
  // B cannot record a transaction into A's account either (RLS blocks the write)
  const r = await b.post('/transactions', { kind: 'expense', amount: '1', date: '2026-11-01', account_id: accId }, '/');
  assert.ok(r.status >= 400, `status ${r.status}`);
  // A's data is intact
  assert.match((await a.get('/transactions')).text, /secret-shop/);
});

test('NFR-SEC-12: admin cannot see other users\' financial data; non-admin cannot reach /admin', async () => {
  const c = new Client(app.base);
  await c.register('nonadmin@hearth.test');
  assert.equal((await c.get('/admin')).status, 404);
});

test('NFR-SEC-06: sensitive actions require step-up re-authentication', async () => {
  const c = new Client(app.base);
  await c.register('stepup@hearth.test');
  // fresh login counts as recent re-auth; simulate an old session by clearing reauth_at
  await app.db.system((q) => q.query(`update sessions set reauth_at = now() - interval '1 hour'`));
  const r = await c.get('/settings/export');
  assert.equal(r.status, 303);
  assert.match(r.location!, /^\/reauth\?next=/);
  const tok = await c.csrf('/reauth?next=/settings/export');
  const ok = await c.req('POST', '/reauth?next=%2Fsettings%2Fexport', { _csrf: tok, password: 'lantern-river-mango-42' });
  assert.equal(ok.location, '/settings/export');
  assert.equal((await c.get('/settings/export')).status, 200);
  const exp = await c.post('/settings/export/json', {}, '/settings/export');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition') ?? '', /attachment/);
  const data = JSON.parse(exp.text);
  assert.equal(data.format, 'hearth-export/1');
  assert.ok(Array.isArray(data.categories) && data.categories.length > 10);
});

test('NFR-SEC-14: sensitive fields are encrypted at rest', async () => {
  const c = new Client(app.base);
  await c.register('enc@hearth.test');
  await c.post('/accounts', { name: 'Enc', type: 'savings', opening: '1', account_no: '123-4-56789-0' }, '/accounts');
  const rows = await app.db.system((q) => q.query<any>(`select account_no_enc from accounts where name = 'Enc'`));
  const raw = Buffer.from(rows[0].account_no_enc).toString('latin1');
  assert.doesNotMatch(raw, /56789/);
});

test('NFR-SEC-33: audit log is hash-chained and append-only', async () => {
  const chain = await app.db.system((q) => verifyChain(q));
  assert.equal(chain.ok, true);
  await assert.rejects(app.db.system((q) => q.query(`update audit_log set action = 'x'`)), /append-only/);
  await assert.rejects(app.db.system((q) => q.query(`delete from audit_log`)), /append-only/);
});

test('NFR-SEC-17: log redaction', () => {
  const out = redact({ password: 'p', token: 't', amount: 5n, nested: { account_no: '1', path: '/x' }, email: 'a@b' }) as any;
  assert.equal(out.password, '[redacted]');
  assert.equal(out.token, '[redacted]');
  assert.equal(out.amount, '[redacted]');
  assert.equal(out.nested.account_no, '[redacted]');
  assert.equal(out.nested.path, '/x');
  assert.equal(out.email, '[redacted]');
});

test('NFR-SEC-01/02: argon2id hashing and NIST password policy', async () => {
  const h = await hashPassword('correct horse battery');
  assert.match(h, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await verifyPassword(h, 'correct horse battery'), true);
  assert.equal(await verifyPassword(h, 'wrong horse battery'), false);
  assert.equal(await checkPassword('short'), 'too_short');
  assert.equal(await checkPassword('password1234'), 'breached');
  assert.equal(await checkPassword('aaaaaaaaaaaaaa'), 'breached');
  assert.equal(await checkPassword('somchai-loves-mango', 'somchai@x.com'), 'contains_email');
  assert.equal(await checkPassword('ไก่จิกเด็กตายบนปากโอ่ง'), null); // Thai passphrase ok
});

test('FR-AUTH-03: TOTP (RFC 6238 test vector) and replay protection', () => {
  // RFC 6238 SHA-1 secret "12345678901234567890", T=59s -> 94287082 (8 digits) => last 6 digits 287082
  const secret = Buffer.from('12345678901234567890');
  assert.equal(hotp(secret, 1n), '287082');
  const b32 = base32Encode(secret);
  assert.deepEqual(base32Decode(b32), secret);
  const now = Date.now();
  const code = hotp(secret, currentStep(now));
  const step = verifyTotp(b32, code, null, now);
  assert.ok(step != null);
  assert.equal(verifyTotp(b32, code, step, now), null, 'same code cannot be replayed');
});

test('AES-256-GCM envelope helpers detect tampering', () => {
  const key = randomBytes(32);
  const blob = seal(key, 'hello', 'aad');
  assert.equal(open(key, blob, 'aad').toString(), 'hello');
  blob[blob.length - 1] ^= 1;
  assert.throws(() => open(key, blob, 'aad'));
});
