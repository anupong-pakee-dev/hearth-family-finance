/**
 * Exchange rates (FR-TXN-11): reference rates from an FX plugin (e.g. fx-frankfurter, ECB) plus each person's own
 * rates. Network access only happens when the admin has enabled an FX plugin (HEARTH_PLUGINS) — nothing by default.
 */
import type { Db, Q } from '../db/index.ts';
import { registry, type FxPlugin } from './plugins.ts';
import { log } from '../log.ts';

/** Currencies the ECB publishes (what fx-frankfurter can update), offered in pickers. Manual rates work for any ISO code. */
export const COMMON_CURRENCIES = ['THB', 'USD', 'EUR', 'JPY', 'CNY', 'GBP', 'SGD', 'HKD', 'KRW', 'TWD', 'AUD', 'NZD', 'CAD', 'CHF', 'MYR', 'IDR', 'PHP', 'INR',
  'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'ISK', 'ILS', 'TRY', 'ZAR', 'MXN', 'BRL'] as const;
export const isCurrency = (c: unknown): c is string => typeof c === 'string' && /^[A-Z]{3}$/.test(c);

export function fxProvider(): FxPlugin | null {
  return registry.fx.values().next().value ?? null;
}

export interface Rate { rate: number; date: string; source: string; personal: boolean; prev: number | null }

const SRC = `
  select base as cur, rate, date, 'personal'::text as source, 1 as pri from user_exchange_rates where owner_id = hearth_uid() and quote = $2 and base = any($1)
  union all select quote, 1 / rate, date, 'personal', 1 from user_exchange_rates where owner_id = hearth_uid() and base = $2 and quote = any($1)
  union all select base, rate, date, source, 0 from exchange_rates where quote = $2 and base = any($1)
  union all select quote, 1 / rate, date, source, 0 from exchange_rates where base = $2 and quote = any($1)`;

/** Latest known rate (1 unit of each currency = ? main) and the one before it; currencies with no rate are absent. */
export async function latestRates(q: Q, currencies: string[], main: string): Promise<Map<string, Rate>> {
  const curs = [...new Set(currencies.filter((c) => isCurrency(c) && c !== main))];
  const out = new Map<string, Rate>();
  if (!curs.length) return out;
  const rows = await q.query<{ cur: string; rate: string; date: string; source: string; rn: number }>(`
    with src as (${SRC}),
    per_day as (select distinct on (cur, date) cur, rate, date, source, pri from src order by cur, date, pri desc),
    ranked as (select *, row_number() over (partition by cur order by date desc) rn from per_day)
    select cur, rate::text rate, date::text date, source, rn::int rn from ranked where rn <= 2`, [curs, main]);
  for (const r of rows.filter((x) => x.rn === 1)) out.set(r.cur.trim(), { rate: Number(r.rate), date: r.date, source: r.source, personal: r.source === 'personal', prev: null });
  for (const r of rows.filter((x) => x.rn === 2)) { const cur = out.get(r.cur.trim()); if (cur) cur.prev = Number(r.rate); }
  return out;
}

/** Daily rate history (1 unit = ? main) for a chart. */
export async function rateHistory(q: Q, cur: string, main: string, days = 90): Promise<{ date: string; rate: number }[]> {
  const rows = await q.query<{ date: string; rate: string }>(`
    with src as (${SRC})
    select distinct on (date) date::text date, rate::text rate from src where date >= current_date - $3::int order by date, pri desc`, [[cur], main, days]);
  return rows.map((r) => ({ date: r.date, rate: Number(r.rate) }));
}

/** Currencies a person deals with: their accounts, assets and watch-list (excluding the main currency). */
export async function myCurrencies(q: Q, main: string, watch: string[]): Promise<string[]> {
  const rows = await q.query<{ c: string }>(`
    select distinct currency c from accounts where owner_id = hearth_uid() and not archived
    union select distinct currency from assets where owner_id = hearth_uid()`);
  return [...new Set([...rows.map((r) => r.c.trim()), ...watch])].filter((c) => isCurrency(c) && c !== main).sort();
}

/** Every main-currency → foreign-currencies set across the instance (for the daily job). */
export async function allPairs(db: Db): Promise<Map<string, string[]>> {
  const rows = await db.system((q) => q.query<{ cur: string; main: string }>(`
    select distinct a.currency cur, p.currency main from accounts a join user_preferences p on p.user_id = a.owner_id where a.currency <> p.currency
    union select distinct s.currency, p.currency from assets s join user_preferences p on p.user_id = s.owner_id where s.currency <> p.currency
    union select distinct w, p.currency from user_preferences p, unnest(p.fx_watch) w where w <> p.currency`));
  const byMain = new Map<string, string[]>();
  for (const r of rows) byMain.set(r.main.trim(), [...(byMain.get(r.main.trim()) ?? []), r.cur.trim()]);
  return byMain;
}

/**
 * Fetch reference rates for the given pairs from the enabled FX plugin and store them for `today`.
 * Returns how many rates were stored; `provider` is null when no FX plugin is enabled.
 */
export async function refreshRates(db: Db, today: string, pairs: Map<string, string[]>): Promise<{ provider: string | null; updated: number; failed: boolean }> {
  const fx = fxProvider();
  if (!fx) return { provider: null, updated: 0, failed: false };
  let updated = 0, failed = false;
  for (const [main, curs] of pairs) {
    const want = [...new Set(curs.filter((c) => isCurrency(c) && c !== main))];
    if (!want.length) continue;
    try {
      const rates = await fx.fetchRates(main, want); // 1 main = r cur
      for (const [cur, r] of Object.entries(rates)) {
        if (!isCurrency(cur) || !(r > 0) || !Number.isFinite(r)) continue;
        await db.system((q) => q.query(`insert into exchange_rates(base, quote, date, rate, source) values ($1,$2,$3,$4,$5)
          on conflict (base, quote, date) do update set rate = excluded.rate, source = excluded.source`, [cur, main, today, (1 / r).toFixed(10), fx.id]));
        updated++;
      }
    } catch (e) { failed = true; log.warn('fx plugin failed', { plugin: fx.id, err: (e as Error).message }); }
  }
  return { provider: fx.id, updated, failed };
}

/** "Update now" is shared reference data, so one refresh per main currency every few minutes is plenty. */
const lastManual = new Map<string, number>();
export const REFRESH_COOLDOWN_MS = 5 * 60_000;
export function mayRefresh(main: string, now = Date.now()): boolean {
  const t = lastManual.get(main);
  if (t != null && now - t < REFRESH_COOLDOWN_MS) return false;
  lastManual.set(main, now);
  return true;
}
export function _resetRefreshCooldown() { lastManual.clear(); }
