/**
 * Automatic, reversible migrations (NFR-OPS-02).
 *   node apps/web/src/db/migrate.ts          -> apply pending "up" migrations
 *   node apps/web/src/db/migrate.ts down     -> roll back the latest migration
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from './index.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function list(): { id: string; up: string; down: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.up.sql'))
    .sort()
    .map((f) => {
      const id = f.replace('.up.sql', '');
      return { id, up: join(dir, f), down: join(dir, `${id}.down.sql`) };
    });
}

export async function migrate(db: Db): Promise<string[]> {
  const applied: string[] = [];
  await db.system(async (q) => {
    await q.exec('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())');
  });
  const done = new Set((await db.system((q) => q.query<{ id: string }>('select id from schema_migrations'))).map((r) => r.id));
  for (const m of list()) {
    if (done.has(m.id)) continue;
    await db.system(async (q) => {
      await q.exec(readFileSync(m.up, 'utf8'));
      await q.query('insert into schema_migrations(id) values ($1)', [m.id]);
    });
    applied.push(m.id);
  }
  return applied;
}

export async function rollback(db: Db): Promise<string | null> {
  const last = await db.system((q) => q.one<{ id: string }>('select id from schema_migrations order by id desc limit 1'));
  if (!last) return null;
  const m = list().find((x) => x.id === last.id);
  if (!m) throw new Error(`missing migration files for ${last.id}`);
  await db.system(async (q) => {
    await q.exec(readFileSync(m.down, 'utf8'));
    await q.query('delete from schema_migrations where id = $1', [m.id]);
  });
  return m.id;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const db = await openDb();
  if (process.argv[2] === 'down') console.log('rolled back', await rollback(db));
  else console.log('applied', await migrate(db));
  await db.close();
}
