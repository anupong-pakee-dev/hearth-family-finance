/**
 * Plugin host (§6 "Plugin system"): notification channels (FR-NOTI-02), price feeds (FR-INV-11),
 * FX feeds (FR-TXN-11) and bank-statement importers (FR-IO-02). No provider is built into the core:
 * the admin enables plugins with HEARTH_PLUGINS="notify-telegram,price-coingecko,…" (files in /plugins).
 * Plugins only ever run for users who turned them on themselves (NFR-PRV-03).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { log } from '../log.ts';

export interface ChannelField { key: string; label: string; secret?: boolean; placeholder?: string }
export interface NotificationChannelPlugin {
  kind: string;
  name: string;
  fields: ChannelField[];
  send(config: Record<string, string>, msg: { title: string; body: string; url: string }): Promise<void>;
}
export interface PricePlugin {
  id: string;
  name: string;
  /** Returns latest prices in each asset's own currency (major units). */
  fetchPrices(assets: { symbol: string; currency: string; asset_class: string }[]): Promise<Map<string, number>>;
}
export interface FxPlugin {
  id: string;
  name: string;
  fetchRates(base: string, quotes: string[]): Promise<Record<string, number>>;
}
export interface ImportPreset {
  id: string;
  name: string;
  /** Header regexes for each target field. */
  columns: Partial<Record<'date' | 'amount' | 'withdrawal' | 'deposit' | 'payee' | 'note' | 'category', string>>;
  /** Amount column holds positive spending (YNAB outflow style) rather than signed values. */
  invertAmount?: boolean;
}

export interface Registry {
  channels: Map<string, NotificationChannelPlugin>;
  prices: Map<string, PricePlugin>;
  fx: Map<string, FxPlugin>;
  importers: Map<string, ImportPreset>;
}

export const registry: Registry = { channels: new Map(), prices: new Map(), fx: new Map(), importers: new Map() };

const PLUGIN_DIR = resolve(join(dirname(fileURLToPath(import.meta.url)), '../../../../plugins'));

export async function loadPlugins(list = process.env.HEARTH_PLUGINS ?? '') {
  for (const name of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!/^[a-z0-9-]+$/.test(name)) { log.warn('ignoring invalid plugin name', { name }); continue; }
    try {
      const mod = await import(pathToFileURL(join(PLUGIN_DIR, `${name}.ts`)).href);
      mod.default.register(registry);
      log.info('plugin loaded', { name });
    } catch (e) {
      log.error('plugin failed to load', { name, err: (e as Error).message });
    }
  }
}

function privateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:')) return l.startsWith('::ffff:') ? privateIp(l.slice(7)) : true;
    return false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/**
 * fetch() for user-supplied URLs (webhooks): https only, no credentials in URL, and the resolved address must
 * not be private/loopback/link-local (SSRF protection). Redirects are not followed.
 */
export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error('only https URLs without credentials are allowed');
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error('destination address is not allowed');
  return fetch(u, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
}

export const _test = { privateIp };
