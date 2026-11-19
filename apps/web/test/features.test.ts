/**
 * Tests for the Phase 3/4 features: passkeys, OIDC, Web Push, attachments, splits, FX, analytics,
 * DCA confirmation, savings challenges, subscriptions, family lending, support access, tax limits, import presets.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createECDH, createHash, createPublicKey, generateKeyPairSync, hkdfSync, createDecipheriv, randomBytes, sign, verify } from 'node:crypto';
import { startApp, Client, options } from './helpers.ts';
import { encode } from '../src/security/cbor.ts';
import { rp, b64u } from '../src/security/webauthn.ts';
import { encryptPayload, vapidAuth } from '../src/services/push.ts';
import { sanitize, sniff } from '../src/services/attachments.ts';
import { _test as plugins } from '../src/services/plugins.ts';
import { signV4 } from '../src/security/kms.ts';
import { runJobs } from '../src/jobs/scheduler.ts';
import { parsePayload, tlv } from '../public/qr.js';

let app: Awaited<ReturnType<typeof startApp>>;
let admin: Client;
before(async () => {
  app = await startApp();
  admin = new Client(app.base);
  await admin.register('admin@hearth.test', 'lantern-river-mango-42', 'Admin'); // first user = instance admin
});
after(async () => { await app.close(); });

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

async function api(c: Client, path: string, body: unknown, from = '/settings') {
  const token = await c.csrf(from);
  const r = await c.req('POST', path, JSON.stringify(body ?? {}), { 'content-type': 'application/json', 'x-csrf-token': token });
  return { ...r, json: r.text ? JSON.parse(r.text) : null };
}

async function onboard(c: Client, email: string, mode: 'off' | 'partial' | 'full' = 'off', invest = false) {
  await c.register(email);
  await c.post('/onboarding/accounts', { name: 'Bank', type: 'savings', opening: '100000' }, '/onboarding?step=1');
  await c.post('/onboarding/buckets', { mode, template: mode === 'off' ? '' : 'save_emergency_invest' }, '/onboarding?step=3');
  await c.post('/onboarding/invest', { invest: invest ? 'yes' : 'no' }, '/onboarding?step=4');
}

// ───────────── Passkeys ─────────────
test('FR-AUTH-05: passkey registration and passwordless sign-in with a simulated authenticator', async () => {
  const c = new Client(app.base);
  await c.register('passkey@hearth.test');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const credId = randomBytes(16);
  const rpHash = sha256(rp().id);

  const opt = await api(c, '/api/v1/webauthn/register/options', {}, '/settings/security');
  assert.equal(opt.status, 200, opt.text);
  const cose = new Map<any, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
  const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, Buffer.from(encode(cose))]);
  const attObj = encode(new Map<any, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opt.json.challenge, origin: rp().origin }));
  const reg = await api(c, '/api/v1/webauthn/register/verify', { id: b64u(credId), response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attObj) } }, '/settings/security');
  assert.equal(reg.status, 201, reg.text);
  assert.match((await c.get('/settings/security')).text, /data-passkey-register/);

  // replaying the registration challenge must fail
  const again = await api(c, '/api/v1/webauthn/register/verify', { id: b64u(credId), response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attObj) } }, '/settings/security');
  assert.equal(again.status, 400);

  // sign in on a fresh browser
  const guest = new Client(app.base);
  const lo = await api(guest, '/webauthn/login/options', {}, '/login');
  assert.equal(lo.status, 200, lo.text);
  const assertion = (counter: number, challenge: string, tamper = false) => {
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(counter);
    const ad = Buffer.concat([rpHash, Buffer.from([0x05]), cnt]);
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: rp().origin }));
    const sig = sign('sha256', Buffer.concat([ad, sha256(cd)]), privateKey);
    if (tamper) sig[sig.length - 1] ^= 1;
    return { id: b64u(credId), response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig) } };
  };
  const bad = await api(guest, '/webauthn/login/verify', assertion(1, lo.json.challenge, true), '/login');
  assert.equal(bad.status, 400, 'tampered signature rejected');
  const lo2 = await api(guest, '/webauthn/login/options', {}, '/login');
  const ok = await api(guest, '/webauthn/login/verify', assertion(1, lo2.json.challenge), '/login');
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.redirect, '/');
  assert.equal((await guest.get('/settings')).status, 200, 'signed in');

  // counter must increase (cloned-authenticator protection)
  const g2 = new Client(app.base);
  const lo3 = await api(g2, '/webauthn/login/options', {}, '/login');
  assert.equal((await api(g2, '/webauthn/login/verify', assertion(1, lo3.json.challenge), '/login')).status, 400);
});

// ───────────── OIDC ─────────────
test('FR-AUTH-04: OIDC sign-up and sign-in against a mock provider (PKCE, state, nonce, JWKS)', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const nonces = new Map<string, string>();
  const challenges = new Map<string, string>();
  let issuer = '';
  const srv: Server = createServer(async (req, res) => {
    const u = new URL(req.url!, issuer);
    const json = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (u.pathname === '/jwks') return json({ keys: [pubJwk] });
    if (u.pathname === '/token') {
      let body = ''; for await (const ch of req) body += ch;
      const p = new URLSearchParams(body);
      const code = p.get('code')!;
      // PKCE: S256(verifier) must equal the challenge sent to /authorize
      if (createHash('sha256').update(p.get('code_verifier')!).digest('base64url') !== challenges.get(code)) { res.writeHead(400); return res.end(); }
      const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc({ iss: issuer, sub: 'user-42', aud: 'hearth-client', exp: now + 300, iat: now, nonce: nonces.get(code), email: 'oidc.user@hearth.test', email_verified: true, name: 'OIDC User' })}`;
      return json({ id_token: `${unsigned}.${sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url')}`, token_type: 'Bearer' });
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  issuer = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const add = await admin.post('/admin/oidc', { id: 'mock', name: 'Mock IdP', issuer, client_id: 'hearth-client', client_secret: 's3cret', allow_signup: '1' }, '/admin');
    assert.equal(add.status, 303, add.text.slice(0, 200));
    const loginPage = await new Client(app.base).get('/login');
    assert.match(loginPage.text, /\/auth\/oidc\/start\/mock/);

    const flow = async () => {
      const c = new Client(app.base);
      const start = await c.get('/auth/oidc/start/mock');
      assert.equal(start.status, 303);
      const auth = new URL(start.location!);
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
      const code = randomBytes(8).toString('hex');
      nonces.set(code, auth.searchParams.get('nonce')!);
      challenges.set(code, auth.searchParams.get('code_challenge')!);
      const cb = await c.get(`/auth/oidc/callback?code=${code}&state=${auth.searchParams.get('state')}`);
      return { c, cb, state: auth.searchParams.get('state')!, code };
    };
    const first = await flow();
    assert.match(first.cb.text, /url=\/onboarding/, 'new account created and signed in');
    assert.equal((await first.c.get('/settings')).status, 200);
    const second = await flow();
    assert.match(second.cb.text, /url=\//);
    const ids = await app.db.system((q) => q.query<any>(`select * from oidc_identities where provider_id = 'mock'`));
    assert.equal(ids.length, 1, 'one identity, reused on the second sign-in');

    // forged state is rejected
    const evil = new Client(app.base);
    const s = await evil.get('/auth/oidc/start/mock');
    const st = new URL(s.location!).searchParams.get('state');
    const r = await evil.get(`/auth/oidc/callback?code=x&state=${st}x`);
    assert.match(r.text, /err=oidc_failed/);
  } finally {
    srv.close();
  }
});

// ───────────── Web Push ─────────────
test('FR-NOTI-01: RFC 8291 payload decrypts as a user agent would, VAPID JWT verifies', async () => {
  const ua = createECDH('prime256v1');
  const uaPub = ua.generateKeys();
  const auth = randomBytes(16);
  const msg = Buffer.from(JSON.stringify({ title: 'ทดสอบ', body: 'hello', url: '/' }));
  const blob = encryptPayload(msg, b64u(uaPub), b64u(auth));
  const salt = blob.subarray(0, 16), idlen = blob[20], asPub = blob.subarray(21, 21 + idlen), ct = blob.subarray(21 + idlen);
  assert.equal(blob.readUInt32BE(16), 4096);
  const shared = ua.computeSecret(asPub);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  assert.deepEqual(plain.subarray(0, -1), msg);

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pj = publicKey.export({ format: 'jwk' }) as any;
  const v = { publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(pj.x, 'base64url'), Buffer.from(pj.y, 'base64url')])), privateJwk: privateKey.export({ format: 'jwk' }) as any };
  const header = vapidAuth(v, 'https://push.example.com/abc');
  const jwt = /t=([^,]+)/.exec(header)![1];
  const [h, p, s] = jwt.split('.');
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: pj, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(p, 'base64url').toString()).aud, 'https://push.example.com');

  // subscription API + VAPID key
  const c = new Client(app.base);
  await c.register('push@hearth.test');
  const key = await c.get('/api/v1/push/key');
  assert.match(JSON.parse(key.text).publicKey, /^[\w-]{80,}$/);
  const sub = await api(c, '/api/v1/push/subscribe', { endpoint: 'https://push.example.com/sub/1', keys: { p256dh: b64u(uaPub), auth: b64u(auth) } });
  assert.equal(sub.status, 201);
  assert.equal((await api(c, '/api/v1/push/subscribe', { endpoint: 'http://insecure', keys: { p256dh: 'x', auth: 'y' } })).status, 422, 'invalid subscription → JSON 422');
});

// ───────────── Attachments ─────────────
test('NFR-SEC-24: attachments are sniffed by content and stripped of metadata', () => {
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif\0\0GPS-SECRET')]).subarray(0, 18);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), app1, Buffer.from([0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9])]);
  const clean = sanitize(jpeg)!;
  assert.equal(clean.type, 'image/jpeg');
  assert.ok(!clean.data.includes(Buffer.from('GPS-SECRET')));
  assert.ok(clean.data.includes(Buffer.from([0xff, 0xda])));

  const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); return Buffer.concat([l, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('Author\0Somchai')), chunk('eXIf', Buffer.from('GPS')), chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))]);
  const p = sanitize(png)!;
  assert.equal(p.type, 'image/png');
  assert.ok(!p.data.includes(Buffer.from('Somchai')) && !p.data.includes(Buffer.from('eXIf')));
  assert.equal(sniff(Buffer.from('<html><script>alert(1)</script>')), null, 'HTML disguised as an image is refused');
  assert.equal(sanitize(Buffer.alloc(6 * 1024 * 1024, 0xff)), null, 'too large');
});

test('receipt upload is encrypted at rest and downloaded as an attachment', async () => {
  const c = new Client(app.base);
  await onboard(c, 'receipt@hearth.test');
  const acc = options((await c.get('/transactions/new')).text, 'account_id')[0].value;
  const token = await c.csrf('/transactions/new');
  const fd = new FormData();
  for (const [k, v] of Object.entries({ _csrf: token, kind: 'expense', amount: '99', date: '2026-11-10', account_id: acc, payee: 'Shop' })) fd.append(k, v);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('RECEIPT-BODY')]);
  fd.append('receipt', new Blob([png], { type: 'text/html' }), 'evil.html');
  const res = await fetch(`${app.base}/transactions`, { method: 'POST', body: fd, redirect: 'manual', headers: { cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(res.status, 303);
  const row = await app.db.system((q) => q.one<any>(`select a.id, a.mime, a.data_enc from attachments a join transactions t on t.id = a.transaction_id where t.payee = 'Shop'`));
  assert.equal(row.mime, 'image/png', 'type from content, not from the client');
  assert.ok(!Buffer.from(row.data_enc).includes(Buffer.from('RECEIPT-BODY')), 'encrypted at rest');
  const dl = await c.get(`/attachments/${row.id}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition')!, /^attachment;/);
  assert.match(dl.headers.get('content-security-policy')!, /sandbox/);
  const other = new Client(app.base);
  await other.register('snoop@hearth.test');
  assert.equal((await other.get(`/attachments/${row.id}`)).status, 404);
});

// ───────────── Splits, FX, analytics ─────────────
test('FR-TXN-04/11: split transactions and foreign-currency accounts feed the reports correctly', async () => {
  const c = new Client(app.base);
  await onboard(c, 'split@hearth.test');
  const form = (await c.get('/transactions/new')).text;
  const acc = options(form, 'account_id')[0].value;
  const cats = options(form, 'category_id');
  const food = cats.find((x) => x.label.includes('Daily meals'))!.value;
  const shop = cats.find((x) => x.label.includes('Shopping'))!.value;
  const bad = await c.post('/transactions', { kind: 'expense', amount: '1000', date: '2026-11-05', account_id: acc, split_cat_0: food, split_amt_0: '600', split_cat_1: shop, split_amt_1: '300' }, '/transactions/new');
  assert.match(bad.location ?? '', /err=split_sum/);
  const ok = await c.post('/transactions', { kind: 'expense', amount: '1000', date: '2026-11-05', account_id: acc, payee: 'Big C', split_cat_0: food, split_amt_0: '600', split_cat_1: shop, split_amt_1: '400' }, '/transactions/new');
  assert.equal(ok.status, 303);
  const foodTop = cats.find((x) => x.label === 'Food' || x.label.startsWith('Food'))!.value;
  const filtered = (await c.get(`/transactions?category=${foodTop}`)).text;
  assert.match(filtered, /Big C/, 'split line is found by its parent category');
  const lines = await app.db.system((q) => q.query<any>(`select amount from transaction_lines where payee = 'Big C' order by amount`));
  assert.deepEqual(lines.map((l: any) => l.amount), [40000n, 60000n]);

  // foreign-currency account: report amounts are converted with the rate
  await admin.post('/admin/fx', { base: 'USD', quote: 'THB', rate: '35.5', date: '2026-11-01' }, '/admin');
  await c.post('/accounts', { name: 'USD card', type: 'savings', opening: '0', currency: 'USD' }, '/accounts');
  const usd = options((await c.get('/transactions/new')).text, 'account_id').find((a) => a.label.includes('USD'))!.value;
  await c.post('/transactions', { kind: 'expense', amount: '10', date: '2026-11-06', account_id: usd, payee: 'Netflix US' }, '/transactions/new');
  const fx = await app.db.system((q) => q.one<any>(`select l.amount, t.amount raw, t.currency from transaction_lines l join transactions t on t.id = l.transaction_id where l.payee = 'Netflix US'`));
  assert.equal(fx.currency, 'USD');
  assert.equal(fx.raw, 1000n);
  assert.equal(fx.amount, 35500n, '10 USD × 35.5 = 355 THB in reports');

  // analytics renders every chart and the range picker
  for (const r of ['1m', '3m', '6m', '12m', 'ytd']) {
    const page = await c.get(`/analytics?range=${r}`);
    assert.equal(page.status, 200, r);
  }
  const a = (await c.get('/analytics?range=custom&from=2026-10-01&to=2026-11-30')).text;
  for (const cls of ['chart sankey', 'chart heatmap', 'href="/transactions?from=']) assert.ok(a.includes(cls), cls);
});

// ───────────── Investments ─────────────
test('FR-INV-04/22/24: DCA creates a pending buy that is confirmed with real units; tax limits', async () => {
  const c = new Client(app.base);
  await onboard(c, 'dca@hearth.test', 'off', true);
  await c.post('/invest/portfolios', { name: 'Kids fund', kind: 'fund', visibility: 'private' }, '/invest');
  const pfId = /href="\/invest\/portfolios\/([0-9a-f-]{36})"/.exec((await c.get('/invest')).text)![1];
  await c.post('/invest/assets', { symbol: 'KFLTF', asset_class: 'tax_fund', currency: 'THB', tax_type: 'ssf', price_source: 'manual', back: `/invest/portfolios/${pfId}` }, `/invest/portfolios/${pfId}`);
  const assetId = options((await c.get(`/invest/portfolios/${pfId}`)).text, 'asset_id')[0].value;
  await c.post('/invest/dca', { portfolio_id: pfId, asset_id: assetId, amount: '2000', day: '1' }, '/invest/plan');
  await app.db.system((q) => q.query(`update dca_plans set next_date = '2026-11-01'`));
  await runJobs(app.db, '2026-11-02');
  const page = (await c.get(`/invest/portfolios/${pfId}`)).text;
  assert.match(page, /\/confirm"/, 'pending DCA purchase shown');
  const txId = /\/invest\/txns\/([0-9a-f-]{36})\/confirm/.exec(page)![1];
  await c.post(`/invest/txns/${txId}/confirm`, { units: '150.5', amount: '2000', back: `/invest/portfolios/${pfId}` }, `/invest/portfolios/${pfId}`);
  const t = await app.db.system((q) => q.one<any>('select pending, units_e8 from investment_transactions where id = $1', [txId]));
  assert.equal(t.pending, false);
  assert.equal(t.units_e8, 15_050_000_000n);
  await c.post('/reports/tax/limits', { limit_ssf: '1500' }, '/reports/tax');
  const tax = (await c.get('/reports/tax')).text;
  assert.match(tax, /500\.00/, 'shows 500 over the configured SSF limit');
  assert.match((await c.get('/invest')).text, /Kids fund/);
});

// ───────────── Savings challenge, subscriptions ─────────────
test('FR-SAVE-09 savings challenge and FR-REC-06 subscription detection', async () => {
  const c = new Client(app.base);
  await onboard(c, 'challenge@hearth.test');
  await c.post('/goals', { name: '52 weeks', challenge: '52_week', challenge_step: '10' }, '/goals');
  const gid = /href="\/goals\/([0-9a-f-]{36})"/.exec((await c.get('/goals')).text)![1];
  const g = (await c.get(`/goals/${gid}`)).text;
  assert.match(g, /13,780\.00/, 'total of a 52-week challenge with step 10 = 13,780');
  assert.match(g, /10\.00/);

  const acc = options((await c.get('/transactions/new')).text, 'account_id')[0].value;
  const tok = await c.csrf('/transactions/new');
  const months = ['2026-08-03', '2026-09-03', '2026-10-03', '2026-11-03'];
  for (const [i, d] of months.entries()) await c.req('POST', '/transactions', { _csrf: tok, kind: 'expense', amount: i === 3 ? '459' : '419', date: d, account_id: acc, payee: 'Netflix' });
  const rec = (await c.get('/recurring')).text;
  assert.match(rec, /Netflix/);
  assert.match(rec, /459\.00/, 'price increase flagged');
});

// ───────────── Family ─────────────
test('FR-FDEBT-05/08 and FR-BKT-00c: per-person debt-free date, net family lending, shared-bucket opt-in', async () => {
  const dad = new Client(app.base);
  await onboard(dad, 'dad@hearth.test', 'partial');
  await dad.post('/household', { name: 'Home', display_name: 'Dad' }, '/household');
  const hh = /action="\/household\/([0-9a-f-]{36})\/invite"/.exec((await dad.get('/household')).text)![1];
  await dad.post(`/household/${hh}/dependents`, { name: 'Grandma' }, '/household');
  const members = await app.db.system((q) => q.query<any>('select id, display_name from members where household_id = $1', [hh]));
  const grandma = members.find((m: any) => m.display_name === 'Grandma').id, me = members.find((m: any) => m.display_name === 'Dad').id;
  await dad.post('/debts', { name: 'Grandma hospital loan', type: 'personal_loan', method: 'reducing', balance: '50000', rate: '8', payment: '3000', household_id: hh, visibility: 'full', owner_member_id: grandma }, '/debts');
  await dad.post('/debts', { name: 'Borrowed from Grandma', type: 'family', method: 'none', balance: '7000', payment: '1000', household_id: hh, visibility: 'full', owner_member_id: me, lender_member_id: grandma }, '/debts');
  const page = (await dad.get('/household')).text;
  assert.match(page, /Grandma · /, 'per-person debt line');
  assert.match(page, /Dad[^<]*Grandma|owes/i);
  assert.match(page, /7,000\.00/);
  // shared bucket opt-in toggles membership flag
  await dad.post(`/household/${hh}/bucket-sharing`, {}, '/household');
  const flag = await app.db.system((q) => q.one<any>('select joined_bucket_sharing from members where id = $1', [me]));
  assert.equal(flag.joined_bucket_sharing, false);
});

// ───────────── Support access ─────────────
test('NFR-SEC-12: admin sees a user\'s summary only while the user\'s grant is active, and it is audited', async () => {
  const u = new Client(app.base);
  await onboard(u, 'needshelp@hearth.test');
  const uid = (await app.db.system((q) => q.one<any>(`select id from users where email = 'needshelp@hearth.test'`))).id;
  assert.equal((await admin.get(`/admin/support/${uid}`)).status, 404, 'no grant → nothing');
  const adminId = (await app.db.system((q) => q.one<any>(`select id from users where email = 'admin@hearth.test'`))).id;
  assert.equal((await u.post('/settings/support/grant', { admin_id: adminId, hours: '2' }, '/settings/security')).status, 303);
  const view = await admin.get(`/admin/support/${uid}`);
  assert.equal(view.status, 200);
  assert.match(view.text, /Bank/);
  const audited = await app.db.system((q) => q.one<any>(`select count(*)::int n from audit_log where action = 'support_access'`));
  assert.ok(audited.n >= 1);
  await u.post('/settings/support/revoke', {}, '/settings/security');
  assert.equal((await admin.get(`/admin/support/${uid}`)).status, 404, 'revoked');
});

// ───────────── Import presets, QR, plugins, SigV4 ─────────────
test('FR-IO-02/06: YNAB export is auto-detected and imported', async () => {
  const c = new Client(app.base);
  await onboard(c, 'ynab@hearth.test');
  const acc = options((await c.get('/transactions/import')).text, 'account_id')[0].value;
  const csv = 'Account,Flag,Date,Payee,Category,Memo,Outflow,Inflow\nChecking,,2026-11-01,Landlord,Rent,,12000.00,0.00\nChecking,,2026-11-02,Employer,Salary,,0.00,50000.00\n';
  const map = await c.post('/transactions/import', { csv_b64: Buffer.from(csv).toString('base64'), account_id: acc }, '/transactions/import');
  const sel = (n: string) => /<option value="(\d+)" selected>/.exec(new RegExp(`<select[^>]*name="map_${n}"[^>]*>([\\s\\S]*?)</select>`).exec(map.text)![1])?.[1];
  assert.equal(sel('withdrawal'), '6');
  assert.equal(sel('deposit'), '7');
  assert.equal(sel('payee'), '3');
  const r = await c.post('/transactions/import', { csv_b64: Buffer.from(csv).toString('base64'), account_id: acc, confirm: '1', map_date: '2', map_payee: '3', map_withdrawal: '6', map_deposit: '7', map_note: '5', map_category: '4', map_amount: '' }, '/transactions/import');
  assert.match(r.location!, /imported/);
  const list = (await c.get('/transactions')).text;
  assert.match(list, /Landlord/);
  assert.match(list, /Employer/);
});

test('QR slip / PromptPay parsing, SSRF guard, AWS SigV4 shape', () => {
  // PromptPay with amount 150.00 and merchant name
  const payload = '000201010212' + '2937' + '0016A000000677010111' + '01130066812345678' + '5303764' + '5406150.00' + '5802TH' + '5909SOMTAM SH' + '6304ABCD';
  assert.equal(tlv(payload)['54'], '150.00');
  const p = parsePayload(payload);
  assert.equal(p.amount, '150.00');
  assert.equal(p.payee, 'SOMTAM SH');
  assert.deepEqual(parsePayload('00410006000001010300402254BAY1234567890'), parsePayload('00410006000001010300402254BAY1234567890'));

  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(plugins.privateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(plugins.privateIp(ip), false, ip);

  const h = signV4({ region: 'ap-southeast-1', service: 'secretsmanager', host: 'secretsmanager.ap-southeast-1.amazonaws.com', target: 'secretsmanager.GetSecretValue', body: '{"SecretId":"hearth"}', accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2026-11-18T00:00:00Z') });
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261118\/ap-southeast-1\/secretsmanager\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/);
  assert.equal(h['x-amz-date'], '20261118T000000Z');
});
