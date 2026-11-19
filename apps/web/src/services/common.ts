import type { Ctx, Prefs, View } from '../http/app.ts';
import { HttpError } from '../http/app.ts';
import type { Q } from '../db/index.ts';
import { isUuid } from '../db/index.ts';
import { fieldCipher, unwrapDataKey } from '../security/keys.ts';
import { parseMoney, parseRateE4, isIsoDate, todayIso } from '@hearth/engine';

/** SQL predicate for the "mine / household / all" switch (FR-HH-05). RLS already limits visibility. */
export function scope(view: View, alias = ''): string {
  const a = alias ? `${alias}.` : '';
  if (view === 'mine') return `${a}owner_id = hearth_uid()`;
  if (view === 'household') return `${a}household_id is not null`;
  return 'true';
}

/** Encryption helper bound to the CURRENT user's data key. */
export function cipher(ctx: Ctx) {
  const u = ctx.user!;
  return fieldCipher(unwrapDataKey(u.id, u.data_key_enc, u.data_key_version));
}

/** Decrypt fields owned by other household members (shared rows). */
export async function cipherFor(ctx: Ctx, ownerId: string) {
  if (ownerId === ctx.user!.id) return cipher(ctx);
  const row = await ctx.db.system((q) => q.one<any>('select data_key_enc, data_key_version from users where id = $1', [ownerId]));
  return fieldCipher(row ? unwrapDataKey(ownerId, row.data_key_enc ? Buffer.from(row.data_key_enc) : null, row.data_key_version) : null);
}

export async function loadPrefs(q: Q): Promise<Prefs | null> {
  return q.one<Prefs>('select * from user_preferences where user_id = hearth_uid()');
}

// ───────── input parsing ─────────
export function money(v: string | undefined, { required = false, allowNegative = false, allowZero = false } = {}): bigint | null {
  if (v == null || v.trim() === '') { if (required) throw new HttpError(422, 'amount'); return null; }
  const m = parseMoney(v);
  if (m == null || (!allowNegative && m < 0n) || (!allowZero && m === 0n && required) || m > 100_000_000_000_000n || m < -100_000_000_000_000n) throw new HttpError(422, 'amount');
  return m;
}

export function rate(v: string | undefined): number {
  if (!v || !v.trim()) return 0;
  const r = parseRateE4(v);
  if (r == null || r < 0 || r > 9_999_999) throw new HttpError(422, 'rate');
  return r;
}

export function date(v: string | undefined, fallback?: string): string {
  if (!v) { if (fallback) return fallback; throw new HttpError(422, 'date'); }
  if (!isIsoDate(v)) throw new HttpError(422, 'date');
  return v;
}

export function optDate(v: string | undefined): string | null {
  if (!v) return null;
  return date(v);
}

export function uuidOrNull(v: string | undefined): string | null {
  if (!v) return null;
  if (!isUuid(v)) throw new HttpError(422, 'invalid');
  return v;
}

export function requireUuid(v: string | undefined): string {
  if (!isUuid(v)) throw new HttpError(404);
  return v!;
}

export function text(v: string | undefined, max = 200, required = false): string {
  const s = (v ?? '').trim().slice(0, max);
  if (required && !s) throw new HttpError(422, 'required');
  return s;
}

export function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], fallback?: T): T {
  if (v && (allowed as readonly string[]).includes(v)) return v as T;
  if (fallback !== undefined) return fallback;
  throw new HttpError(422, 'invalid');
}

export function intIn(v: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function today(): string { return todayIso(); }

/** Household id to share an item with (FR-HH-04). Validates membership + write role. */
export function shareTarget(ctx: Ctx, v: string | undefined): string | null {
  if (!v) return null;
  const hh = ctx.households.find((h) => h.id === v);
  if (!hh || !['owner', 'manager', 'member'].includes(hh.role)) throw new HttpError(403);
  return hh.id;
}

/** In-app notification (FR-NOTI-01/03). dedupeKey prevents duplicates for the same event. */
export async function notify(q: Q, ownerId: string, kind: string, title: string, body = '', link: string | null = null, dedupeKey: string | null = null) {
  await q.query(
    `insert into notifications(owner_id, kind, title, body, link, dedupe_key) values ($1,$2,$3,$4,$5,$6)
     on conflict (owner_id, dedupe_key) do nothing`,
    [ownerId, kind, title, body, link, dedupeKey],
  );
}

/** Activity log for shared data (FR-HH-07). */
export async function activity(q: Q, ctx: Ctx, householdId: string | null, action: string, entity: string, entityId: string | null, summary: string) {
  if (!householdId) return;
  await q.query('insert into activity_log(household_id, owner_id, actor_id, action, entity, entity_id, summary) values ($1,$2,$2,$3,$4,$5,$6)', [householdId, ctx.user!.id, action, entity, entityId, summary.slice(0, 200)]);
}

/**
 * FR-BKT-00c: shared household buckets only apply to members who opted in (members.joined_bucket_sharing);
 * one's own buckets always do.
 */
export const BUCKETS_JOINED = `(owner_id = hearth_uid() or household_id in (select m.household_id from members m where m.user_id = hearth_uid() and m.joined_bucket_sharing))`;
