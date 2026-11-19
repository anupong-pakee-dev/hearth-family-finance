import type { Db } from '../db/index.ts';

let cache: { at: number; v: Record<string, any> } | null = null;

/** Instance-wide admin settings (open registration, enforce 2FA, session idle minutes). */
export async function instanceSettings(db: Db): Promise<Record<string, any>> {
  if (cache && Date.now() - cache.at < 10_000) return cache.v;
  const rows = await db.system((q) => q.query<{ key: string; value: unknown }>('select key, value from instance_settings'));
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = { at: Date.now(), v };
  return v;
}

export function clearSettingsCache() { cache = null; }
