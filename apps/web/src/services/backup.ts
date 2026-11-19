/**
 * Instance backup / restore for admins (FR-IO-05, NFR-OPS-04). Backups are ALWAYS encrypted (NFR-SEC-16)
 * with AES-256-GCM using a key derived from the current master key. Format: HEARTHBK1 | keyId | blob.
 * Restore is a CLI-only operation (scripts/restore.ts) to keep it off the web attack surface.
 */
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { keys, seal, open } from '../security/keys.ts';
import { config } from '../config.ts';
import { audit } from '../security/audit.ts';

const TABLES = ['users', 'recovery_codes', 'instance_settings', 'households', 'members', 'household_invites', 'activity_log', 'user_preferences', 'accounts', 'categories', 'buckets',
  'transactions', 'transaction_splits', 'bucket_movements', 'categorize_rules', 'debts', 'debt_rate_schedule', 'debt_responsibilities', 'debt_payments', 'debt_plans',
  'goals', 'goal_contributions', 'emergency_events', 'portfolios', 'assets', 'investment_transactions', 'price_history', 'allocation_targets', 'dca_plans',
  'budget_lines', 'recurring_rules', 'notifications', 'net_worth_snapshots', 'attachments', 'support_grants', 'audit_log'];

function backupKey(masterKey: Buffer): Buffer {
  return createHash('sha256').update(Buffer.concat([Buffer.from('hearth-backup-v1'), masterKey])).digest();
}

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? { $big: v.toString() } : v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString('base64') } : v);
const reviver = (_k: string, v: any) => (v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v && typeof v === 'object' && '$bytes' in v ? Buffer.from(v.$bytes, 'base64') : v);

export async function createBackup(db: Db, actorId: string | null): Promise<string> {
  const dump: Record<string, unknown[]> = {};
  await db.system(async (q) => { for (const t of TABLES) dump[t] = await q.query(`select * from ${t}`); });
  const mk = keys().current();
  const blob = seal(backupKey(mk.key), gzipSync(Buffer.from(JSON.stringify({ v: 1, at: new Date().toISOString(), dump }, replacer))), 'backup');
  const dir = config.backupDir || `${config.dataDir}/backups`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/hearth-${new Date().toISOString().replace(/[:.]/g, '-')}.hbk`;
  writeFileSync(file, Buffer.concat([Buffer.from(`HEARTHBK1|${mk.id}|`), blob]), { mode: 0o600 });
  await db.system((q) => audit(q, 'backup', actorId, { file: file.split(/[\\/]/).pop() }));
  // keep the latest 14 backups
  const files = readdirSync(dir).filter((f) => f.endsWith('.hbk')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 14))) unlinkSync(`${dir}/${f}`);
  return file;
}

export function readBackup(buf: Buffer): { at: string; dump: Record<string, any[]> } {
  const head = buf.subarray(0, 64).toString('utf8');
  const m = /^HEARTHBK1\|([^|]+)\|/.exec(head);
  if (!m) throw new Error('not a Hearth backup');
  const blob = buf.subarray(m[0].length);
  const json = gunzipSync(open(backupKey(keys().get(m[1])), blob, 'backup')).toString('utf8');
  return JSON.parse(json, reviver);
}

export async function restoreBackup(db: Db, buf: Buffer) {
  const { dump } = readBackup(buf);
  await db.system(async (q) => {
    await q.exec('alter table audit_log disable trigger audit_log_no_update');
    for (const t of [...TABLES].reverse()) await q.exec(`delete from ${t}`);
    await q.exec(`set session_replication_role = replica`); // skip FK + balance triggers while loading
    for (const t of TABLES) {
      for (const row of dump[t] ?? []) {
        const cols = Object.keys(row).filter((c) => !(t === 'audit_log' && c === 'id'));
        await q.query(`insert into ${t}(${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => (row[c] !== null && typeof row[c] === 'object' && !(row[c] instanceof Buffer) && !Array.isArray(row[c]) && !(row[c] instanceof Date) ? JSON.stringify(row[c]) : row[c])));
      }
    }
    await q.exec(`set session_replication_role = origin`);
    await q.exec('alter table audit_log enable trigger audit_log_no_update');
  });
}
