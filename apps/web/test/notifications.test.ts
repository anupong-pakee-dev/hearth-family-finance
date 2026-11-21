/**
 * Deleting notifications: one or all; alerts with a dedupe key stay hidden and are not re-sent.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, Client } from './helpers.ts';
import { dispatch, newOutbox } from '../src/jobs/scheduler.ts';

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

async function userWithNotes(email: string) {
  const c = new Client(app.base);
  await c.register(email);
  const uid = (await app.db.system((q) => q.one<{ id: string }>('select id from users where email = $1', [email])))!.id;
  await app.db.system(async (q) => {
    await q.query('delete from notifications where owner_id = $1', [uid]);
    await q.query(`insert into notifications(owner_id, kind, title, dedupe_key) values ($1,'info','Plain note',null), ($1,'debt_due','Card is due','debt_due:card:2026-12-01')`, [uid]);
  });
  const ids = await app.db.system((q) => q.query<{ id: string; title: string }>('select id, title from notifications where owner_id = $1', [uid]));
  return { c, uid, id: (title: string) => ids.find((r) => r.title === title)!.id };
}

test('notifications: delete one — plain rows are removed, deduped rows hidden and not re-created', async () => {
  const { c, uid, id } = await userWithNotes('noti1@hearth.test');
  let page = (await c.get('/notifications')).text;
  assert.match(page, /Plain note/);
  assert.match(page, /Card is due/);
  assert.match(page, /\/notifications\/[0-9a-f-]{36}\/delete/);

  await c.post(`/notifications/${id('Plain note')}/delete`, {}, '/notifications');
  await c.post(`/notifications/${id('Card is due')}/delete`, {}, '/notifications');
  page = (await c.get('/notifications')).text;
  assert.ok(!page.includes('Plain note') && !page.includes('Card is due'));

  const rows = await app.db.system((q) => q.query<{ title: string; dismissed_at: Date | null }>('select title, dismissed_at from notifications where owner_id = $1', [uid]));
  assert.deepEqual(rows.map((r) => r.title), ['Card is due']);
  assert.ok(rows[0].dismissed_at);

  // The scheduler sees the dedupe key and does not create the same alert again.
  const prefs = { notify_prefs: {} } as any;
  await app.db.system((q) => dispatch(newOutbox(), q, uid, prefs, 'debt_due', 'Card is due', '', null, 'debt_due:card:2026-12-01'));
  assert.ok(!(await c.get('/notifications')).text.includes('Card is due'));
});

test('notifications: delete all, and unread badge ignores deleted ones', async () => {
  const { c, uid } = await userWithNotes('noti2@hearth.test');
  assert.match((await c.get('/notifications')).text, /Delete all/);
  const r = await c.post('/notifications/delete-all', {}, '/notifications');
  assert.equal(r.location, '/notifications?ok=deleted');
  const page = (await c.get('/notifications')).text;
  assert.ok(!page.includes('Plain note') && !page.includes('Card is due'));
  const unread = await app.db.system((q) => q.one<{ n: number }>('select count(*)::int n from notifications where owner_id = $1 and read_at is null and dismissed_at is null', [uid]));
  assert.equal(unread!.n, 0);
});

test('notifications: cannot delete someone else’s', async () => {
  const a = await userWithNotes('noti3@hearth.test');
  const b = await userWithNotes('noti4@hearth.test');
  await b.c.post(`/notifications/${a.id('Plain note')}/delete`, {}, '/notifications');
  assert.match((await a.c.get('/notifications')).text, /Plain note/);
});
