/**
 * Account deletion removes the user's rows immediately and leaves other people's households alone.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.ts';
import { createUser, requestDeletion } from '../src/services/users.ts';

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const userCols = ['owner_id', 'user_id', 'created_by', 'actor_id', 'granted_to'];

async function rowsOf(userId: string) {
  const cols = await app.db.system((q) => q.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
     where table_schema = 'public' and data_type = 'uuid' and column_name = any($1) and table_name <> 'audit_log'`, [userCols]));
  const out: Record<string, number> = {};
  for (const c of cols) {
    const r = await app.db.system((q) => q.one<{ n: number }>(`select count(*)::int n from ${c.table_name} where ${c.column_name} = $1`, [userId]));
    if (r!.n) out[`${c.table_name}.${c.column_name}`] = r!.n;
  }
  return out;
}

test('delete account: rows are gone at once, audit entry kept, shared household survives', async () => {
  const mk = (email: string) => createUser(app.db, { email, password: 'correct horse battery staple 42', name: email, lang: 'en', ip: '127.0.0.1' });
  const a = await mk('leaver@example.com');
  const b = await mk('stayer@example.com');

  // A created the household, then handed ownership to B (created_by still points at A).
  const hh = await app.db.system(async (q) => {
    const h = await q.one<{ id: string }>('insert into households(name, created_by) values ($1, $2) returning id', ['Shared', a]);
    await q.query(`insert into members(household_id, user_id, display_name, role) values ($1,$2,'A','member'), ($1,$3,'B','owner')`, [h!.id, a, b]);
    return h!.id;
  });
  // A's own household with nobody else in it goes with A.
  const solo = await app.db.system(async (q) => {
    const h = await q.one<{ id: string }>('insert into households(name, created_by) values ($1, $2) returning id', ['Solo', a]);
    await q.query(`insert into members(household_id, user_id, display_name, role) values ($1,$2,'A','owner')`, [h!.id, a]);
    return h!.id;
  });
  assert.ok(Object.keys(await rowsOf(a)).length > 0);

  await requestDeletion(app.db, a, '127.0.0.1');

  assert.deepEqual(await rowsOf(a), {});
  const state = await app.db.system(async (q) => ({
    user: await q.one('select 1 from users where id = $1', [a]),
    shared: await q.one<{ created_by: string }>('select created_by from households where id = $1', [hh]),
    solo: await q.one('select 1 from households where id = $1', [solo]),
    members: (await q.query<{ user_id: string }>('select user_id from members where household_id = $1', [hh])).map((m) => m.user_id),
    audit: await q.one('select 1 from audit_log where user_id = $1 and action = $2', [a, 'account_delete_requested']),
  }));
  assert.equal(state.user, null);
  assert.equal(state.shared?.created_by, b);
  assert.deepEqual(state.members, [b]);
  assert.equal(state.solo, null);
  assert.ok(state.audit);
  assert.ok(Object.keys(await rowsOf(b)).length > 0);
});
