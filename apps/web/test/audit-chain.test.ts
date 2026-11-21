/**
 * Audit hash chain: jsonb key reordering is not tampering; real edits still are. Admin sees recent events.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startApp, Client } from './helpers.ts';
import { audit, verifyChain } from '../src/security/audit.ts';

let app: Awaited<ReturnType<typeof startApp>>;
let admin: Client;
before(async () => {
  app = await startApp();
  admin = new Client(app.base);
  await admin.register('audit-admin@hearth.test');
});
after(async () => { await app.close(); });

const verify = () => app.db.system((q) => verifyChain(q));

test('chain stays valid when jsonb reorders detail keys', async () => {
  await app.db.system((q) => audit(q, 'role_changed', null, { joined: 'hh-1', role: 'member' }, '10.0.0.1'));
  await app.db.system((q) => audit(q, 'role_changed', null, { household: 'hh-1', member: 'm-1', role: 'viewer' }, '10.0.0.1'));
  assert.deepEqual(await verify(), { ok: true });
});

test('rows written before canonical hashing (insertion-order detail) still verify', async () => {
  await app.db.system(async (q) => {
    const last = await q.one<{ hash: string }>('select hash from audit_log order by id desc limit 1');
    const prev = last!.hash;
    const at = new Date().toISOString();
    const detail = { joined: 'hh-legacy', role: 'member' }; // old code hashed this order; jsonb stores {role, joined}
    const hash = createHash('sha256').update(JSON.stringify([prev, at, null, 'role_changed', detail, '10.0.0.2'])).digest('hex');
    await q.query('insert into audit_log(at, user_id, action, detail, ip, prev_hash, hash) values ($1,$2,$3,$4,$5,$6,$7)', [at, null, 'role_changed', JSON.stringify(detail), '10.0.0.2', prev, hash]);
  });
  assert.deepEqual(await verify(), { ok: true });
});

test('a real edit is still detected', async () => {
  await app.db.system((q) => audit(q, 'login', null, { mfa: false }, '10.0.0.3'));
  const id = await app.db.system(async (q) => {
    const r = await q.one<{ id: string }>('select id::text from audit_log order by id desc limit 1');
    await q.query('alter table audit_log disable trigger audit_log_no_update');
    await q.query(`update audit_log set ip = '6.6.6.6' where id = $1`, [r!.id]);
    await q.query('alter table audit_log enable trigger audit_log_no_update');
    return Number(r!.id);
  });
  assert.deepEqual(await verify(), { ok: false, brokenAt: id });
  // restore for the next test
  await app.db.system(async (q) => {
    await q.query('alter table audit_log disable trigger audit_log_no_update');
    await q.query(`update audit_log set ip = '10.0.0.3' where id = $1`, [id]);
    await q.query('alter table audit_log enable trigger audit_log_no_update');
  });
  assert.deepEqual(await verify(), { ok: true });
});

test('admin page lists recent events with masked IPs', async () => {
  const page = (await admin.get('/admin')).text;
  assert.match(page, /Audit log intact/i);
  assert.match(page, /class="rows audit-rows"/);
  assert.match(page, /IP 10\.0\.x\.x/);
  assert.ok(!page.includes('10.0.0.3'));
});
