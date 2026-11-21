/**
 * Admin page shows database storage: size only without a quota, a usage bar with one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, Client } from './helpers.ts';
import { config } from '../src/config.ts';
import { fmtBytes } from '../src/routes/admin.ts';

let app: Awaited<ReturnType<typeof startApp>>;
let admin: Client;
before(async () => {
  app = await startApp();
  admin = new Client(app.base);
  await admin.register('admin-db@hearth.test'); // first user is admin
});
after(async () => { await app.close(); });

test('fmtBytes', () => {
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(1024 * 1024 * 1024), '1 GB');
});

test('admin: database size without quota, usage bar with quota', async () => {
  const saved = config.dbQuotaMb;
  try {
    config.dbQuotaMb = 0;
    let page = (await admin.get('/admin')).text;
    assert.match(page, /Database storage/);
    assert.match(page, /Database size: [\d.,]+ (KB|MB)/);
    assert.match(page, /HEARTH_DB_QUOTA_MB/);
    assert.ok(!page.includes('class="db-meter"'));

    config.dbQuotaMb = 1024;
    page = (await admin.get('/admin')).text;
    assert.match(page, /<meter class="db-meter" min="0" max="1073741824"/);
    assert.match(page, /Used [\d.,]+ (KB|MB) of 1 GB \([\d.]+%\)/);
    assert.match(page, /left/);

    config.dbQuotaMb = 1; // tiny quota → almost-full warning
    assert.match((await admin.get('/admin')).text, /Storage is almost full/);
  } finally { config.dbQuotaMb = saved; }
});

test('admin: non-admins cannot see it', async () => {
  const user = new Client(app.base);
  await user.register('plain-db@hearth.test');
  const r = await user.get('/admin');
  assert.equal(r.status, 404);
});
