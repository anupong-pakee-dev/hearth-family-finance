/**
 * Server-side sessions (NFR-SEC-04/05).
 *  - Cookie: random 256-bit token, HttpOnly, Secure, SameSite=Strict, `__Host-` prefix (when HTTPS).
 *  - DB stores only sha256(token). Idle timeout 30 min (configurable), absolute max 7 days.
 *  - A NEW session (new ID) is created on every login / MFA completion / privilege change.
 */
import { randomBytes, createHash } from 'node:crypto';
import { config } from '../config.ts';
import type { Q } from '../db/index.ts';
import type { SessionInfo, UserInfo } from '../http/app.ts';

export const SESSION_COOKIE = config.secureCookies ? '__Host-hearth' : 'hearth';
export const CSRF_COOKIE = config.secureCookies ? '__Host-hearth-csrf' : 'hearth-csrf';

export function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }
export function randomToken(bytes = 32): string { return randomBytes(bytes).toString('base64url'); }

export function cookie(name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean; sameSite?: 'Strict' | 'Lax' } = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${opts.sameSite ?? 'Strict'}`];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (config.secureCookies) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

export function deviceHash(ua: string): string {
  // coarse device fingerprint: browser family + OS, used only for "new device" alerts (NFR-SEC-08)
  const fam = /(Firefox|Edg|OPR|Chrome|Safari)/.exec(ua)?.[1] ?? 'other';
  const os = /(Windows|Android|iPhone|iPad|Mac OS X|Linux)/.exec(ua)?.[1] ?? 'other';
  return sha256(`${fam}|${os}`).slice(0, 16);
}

export async function createSession(q: Q, userId: string, ip: string, ua: string, mfaPending: boolean): Promise<{ token: string; isNewDevice: boolean }> {
  const token = randomToken();
  const dh = deviceHash(ua);
  const seen = await q.one('select 1 from sessions where user_id = $1 and device_hash = $2 limit 1', [userId, dh]);
  const prior = await q.one('select 1 from audit_log where user_id = $1 and action = $2 limit 1', [userId, 'login']);
  await q.query(
    `insert into sessions(id, user_id, csrf_token, mfa_pending, reauth_at, expires_at, ip, user_agent, device_hash)
     values ($1,$2,$3,$4,$5, now() + make_interval(days => $6), $7, $8, $9)`,
    [sha256(token), userId, randomToken(), mfaPending, mfaPending ? null : new Date(), config.sessionMaxDays, ip, ua.slice(0, 300), dh],
  );
  return { token, isNewDevice: !seen && !!prior };
}

export async function loadSession(q: Q, token: string, idleMinutes: number): Promise<{ session: SessionInfo; user: UserInfo } | null> {
  if (!token || token.length > 100) return null;
  const row = await q.one<any>(
    `select s.id, s.user_id, s.csrf_token, s.mfa_pending, s.reauth_at, s.created_at, s.last_seen_at, s.expires_at,
            u.email, u.display_name, u.is_admin, u.totp_enabled, u.email_verified_at, u.data_key_enc, u.data_key_version, u.disabled
       from sessions s join users u on u.id = s.user_id where s.id = $1`,
    [sha256(token)],
  );
  if (!row) return null;
  const now = Date.now();
  const idleMs = (row.mfa_pending ? 10 : idleMinutes) * 60_000;
  if (row.disabled || new Date(row.expires_at).getTime() < now || new Date(row.last_seen_at).getTime() + idleMs < now) {
    await q.query('delete from sessions where id = $1', [row.id]);
    return null;
  }
  if (now - new Date(row.last_seen_at).getTime() > 60_000) {
    await q.query('update sessions set last_seen_at = now() where id = $1', [row.id]);
  }
  return {
    session: { id: row.id, user_id: row.user_id, csrf_token: row.csrf_token, mfa_pending: row.mfa_pending, reauth_at: row.reauth_at, created_at: row.created_at },
    user: { id: row.user_id, email: row.email, display_name: row.display_name, is_admin: row.is_admin, totp_enabled: row.totp_enabled, email_verified_at: row.email_verified_at, data_key_enc: row.data_key_enc ? Buffer.from(row.data_key_enc) : null, data_key_version: row.data_key_version },
  };
}

export async function destroySession(q: Q, sessionId: string) {
  await q.query('delete from sessions where id = $1', [sessionId]);
}

export function stepUpFresh(s: SessionInfo | null, maxAgeMs = 10 * 60_000): boolean {
  return !!s?.reauth_at && Date.now() - new Date(s.reauth_at).getTime() < maxAgeMs;
}
