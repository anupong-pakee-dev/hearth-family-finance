/**
 * Database access. Two interchangeable backends speaking the same PostgreSQL SQL:
 *   - `pg` Pool when DATABASE_URL is set (production / docker compose)
 *   - embedded PGlite (PostgreSQL in WASM) in HEARTH_DATA_DIR otherwise (development / demo / tests)
 *
 * Financial data is ONLY accessed through {@link Db.asUser}, which runs inside a transaction with
 * `SET LOCAL ROLE hearth_app` and `app.user_id` set, so PostgreSQL Row-Level Security is the last
 * line of defence even if an application-level check is missed (NFR-SEC-10).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { config } from '../config.ts';

export type Row = Record<string, any>;

export interface Q {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
}

export interface Db {
  /** Runs fn in a transaction as the table owner (auth layer, jobs, migrations). */
  system<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  /** Runs fn in a transaction as hearth_app with app.user_id = userId (RLS enforced). */
  asUser<T>(userId: string, fn: (q: Q) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'pg' | 'pglite';
}

/** Per-request query counter (used by the N+1 guard test, NFR-PERF-21). */
export const queryCounter = new AsyncLocalStorage<{ count: number }>();

function normalizeParams(params: unknown[] = []): unknown[] {
  return params.map((p) => {
    if (typeof p === 'bigint') return p.toString();
    if (Array.isArray(p)) return p.map((x) => (typeof x === 'bigint' ? x.toString() : x));
    if (p === undefined) return null;
    return p;
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string { return typeof v === 'string' && UUID_RE.test(v); }

type RawRunner = { query(sql: string, params: unknown[]): Promise<{ rows: Row[] }>; exec(sql: string): Promise<void> };

function wrap(raw: RawRunner): Q {
  const q: Q = {
    async query<T>(sql: string, params?: unknown[]) {
      const c = queryCounter.getStore();
      if (c) c.count++;
      const r = await raw.query(sql, normalizeParams(params));
      return r.rows as T[];
    },
    async one<T>(sql: string, params?: unknown[]) {
      const rows = await q.query<T>(sql, params);
      return rows[0] ?? null;
    },
    exec: (sql: string) => raw.exec(sql),
  };
  return q;
}

/**
 * Nested transactions are a bug: with PGlite (single connection) they deadlock, with pg they silently
 * use a second connection outside the outer transaction. Fail fast instead.
 */
const inTx = new AsyncLocalStorage<boolean>();
function assertNotNested() {
  if (inTx.getStore()) throw new Error('nested database transaction: do not call db.system/asUser inside another transaction');
}

async function setUser(q: Q, userId: string) {
  if (!isUuid(userId)) throw new Error('invalid user id');
  await q.exec('set local role hearth_app');
  await q.query(`select set_config('app.user_id', $1, true)`, [userId]);
}

async function createPg(): Promise<Db> {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v: string) => BigInt(v));      // int8 -> bigint
  pg.types.setTypeParser(1082, (v: string) => v);            // date -> 'YYYY-MM-DD'
  pg.types.setTypeParser(1700, (v: string) => v);            // numeric -> string
  pg.types.setTypeParser(1016 as any, (v: string) => (v === '{}' ? [] : v.slice(1, -1).split(',').map((x) => BigInt(x)))); // int8[]
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: Number(process.env.PG_POOL_MAX ?? 20) });
  async function run<T>(userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
    assertNotNested();
    const client = await pool.connect();
    const q = wrap({ query: (s, p) => client.query(s, p), exec: async (s) => { await client.query(s); } });
    try {
      await client.query('begin');
      if (userId) await setUser(q, userId);
      const out = await inTx.run(true, () => fn(q));
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return { kind: 'pg', system: (fn) => run(null, fn), asUser: (id, fn) => run(id, fn), close: () => pool.end() };
}

async function createPglite(dir: string | null): Promise<Db> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  if (dir) mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir ?? undefined, {
    parsers: {
      [types.INT8]: (v: string) => BigInt(v),
      [types.DATE]: (v: string) => v,
      [types.NUMERIC]: (v: string) => v,
    },
  } as any);
  async function run<T>(userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
    assertNotNested();
    return db.transaction(async (tx: any) => {
      const q = wrap({ query: (s, p) => tx.query(s, p), exec: async (s) => { await tx.exec(s); } });
      if (userId) await setUser(q, userId);
      return inTx.run(true, () => fn(q));
    });
  }
  return { kind: 'pglite', system: (fn) => run(null, fn), asUser: (id, fn) => run(id, fn), close: () => db.close() };
}

let instance: Db | null = null;

export async function openDb(opts: { memory?: boolean } = {}): Promise<Db> {
  if (instance && !opts.memory) return instance;
  const db = config.databaseUrl && !opts.memory ? await createPg() : await createPglite(opts.memory ? null : `${config.dataDir}/pgdata`);
  if (!opts.memory) instance = db;
  return db;
}
