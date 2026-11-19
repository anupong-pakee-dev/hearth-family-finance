/**
 * Append-only, hash-chained audit log (NFR-SEC-33). Each row's hash covers the previous row's hash,
 * so any edit or deletion (also blocked by a DB trigger) breaks the chain and is detected by verifyChain().
 */
import { createHash } from 'node:crypto';
import type { Q } from '../db/index.ts';

export type AuditAction =
  | 'login' | 'login_failed' | 'logout' | 'mfa_enabled' | 'mfa_disabled' | 'mfa_failed' | 'password_changed'
  | 'password_reset' | 'email_verified' | 'session_revoked' | 'export' | 'account_delete_requested'
  | 'role_changed' | 'household_created' | 'household_left' | 'admin_setting' | 'admin_user' | 'support_access'
  | 'recovery_code_used' | 'register' | 'reauth' | 'backup' | 'restore' | 'key_rotation'
  | 'passkey_added' | 'passkey_removed' | 'passkey_login' | 'oidc_login' | 'oidc_linked' | 'oidc_unlinked' | 'support_granted' | 'support_revoked';

function digest(prev: string, at: string, userId: string | null, action: string, detail: unknown, ip: string | null) {
  return createHash('sha256').update(JSON.stringify([prev, at, userId, action, detail, ip])).digest('hex');
}

export async function audit(q: Q, action: AuditAction, userId: string | null, detail: Record<string, unknown> = {}, ip: string | null = null) {
  // Serialise writers so the chain stays linear.
  await q.query(`select pg_advisory_xact_lock(424242)`);
  const last = await q.one<{ hash: string }>('select hash from audit_log order by id desc limit 1');
  const prev = last?.hash ?? 'genesis';
  const at = new Date().toISOString();
  const hash = digest(prev, at, userId, action, detail, ip);
  await q.query('insert into audit_log(at, user_id, action, detail, ip, prev_hash, hash) values ($1,$2,$3,$4,$5,$6,$7)', [at, userId, action, JSON.stringify(detail), ip, prev, hash]);
}

export async function verifyChain(q: Q): Promise<{ ok: boolean; brokenAt?: number }> {
  const rows = await q.query<{ id: bigint; at: Date; user_id: string | null; action: string; detail: unknown; ip: string | null; prev_hash: string; hash: string }>('select * from audit_log order by id');
  let prev = 'genesis';
  for (const r of rows) {
    const at = new Date(r.at).toISOString();
    if (r.prev_hash !== prev || digest(prev, at, r.user_id, r.action, r.detail, r.ip) !== r.hash) return { ok: false, brokenAt: Number(r.id) };
    prev = r.hash;
  }
  return { ok: true };
}
