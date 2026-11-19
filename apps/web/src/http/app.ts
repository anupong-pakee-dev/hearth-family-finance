/**
 * Minimal, dependency-free HTTP framework.
 * Every route MUST declare its access level (deny by default — NFR-SEC-09); the route table is
 * exported so a test can assert that no route is missing one.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db, Q } from '../db/index.ts';
import type { SafeHtml } from '../views/html.ts';

export type Access = 'public' | 'guest' | 'mfa' | 'auth' | 'admin';
export type Module = 'buckets' | 'invest';

export interface RouteOpts {
  access: Access;
  /** Requires a recent re-authentication (NFR-SEC-06). */
  stepUp?: boolean;
  /** Route only exists when the user enabled this optional module (FR-BKT-00a, FR-INV-01). */
  module?: Module;
  /** Allow multipart bodies up to this size (bytes). */
  upload?: number;
  /** JSON API route: CSRF via X-CSRF-Token header. */
  api?: boolean;
}

export interface SessionInfo {
  id: string;
  user_id: string;
  csrf_token: string;
  mfa_pending: boolean;
  reauth_at: Date | null;
  created_at: Date;
}

export interface UserInfo {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  totp_enabled: boolean;
  email_verified_at: Date | null;
  data_key_enc: Buffer | null;
  data_key_version: string | null;
}

export interface Prefs {
  locale: 'th' | 'en';
  currency: string;
  date_era: 'be' | 'ce';
  month_start_day: number;
  theme: 'system' | 'light' | 'dark';
  privacy_mode: boolean;
  bucket_mode: 'off' | 'partial' | 'full';
  investment_enabled: boolean | null;
  onboarded: boolean;
  monthly_income: bigint;
  dsr_threshold_e4: number;
  budget_warn_e4: number;
  emergency_mode: 'months' | 'fixed';
  emergency_months: string;
  emergency_fixed: bigint;
  emergency_source: 'bucket' | 'account' | 'manual';
  emergency_account_id: string | null;
  emergency_manual: bigint;
  essential_override: bigint | null;
  emergency_first: boolean;
  invest_warn_rate_e4: number;
  invest_monthly_budget: bigint;
  cost_method: 'average' | 'fifo';
  networth_exclude: string[];
  scenario_rates: string[];
  notify_prefs: Record<string, Record<string, boolean>>;
  dashboard_hidden: string[];
  tax_limits: Record<string, string>;
  last_summary_sent: string | null;
}

export type View = 'mine' | 'household' | 'all';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  db: Db;
  url: URL;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, string>;
  bodyAll: Record<string, string[]>;
  files: { field: string; filename: string; type: string; data: Buffer }[];
  json: unknown;
  cookies: Record<string, string>;
  nonce: string;
  ip: string;
  ua: string;
  session: SessionInfo | null;
  user: UserInfo | null;
  prefs: Prefs | null;
  lang: 'th' | 'en';
  view: View;
  /** Households the user belongs to (loaded for authenticated requests). */
  households: { id: string; name: string; role: string; member_id: string }[];
  unread: number;
  t: (key: string, vars?: Record<string, string | number>) => string;
  csrf: string;
  setCookies: string[];
  /** Run as the current user with RLS. */
  as<T>(fn: (q: Q) => Promise<T>): Promise<T>;
}

export interface Res {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export type Handler = (ctx: Ctx) => Promise<Res>;

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  re: RegExp;
  keys: string[];
  opts: RouteOpts;
  handler: Handler;
}

export const routes: Route[] = [];

export class HttpError extends Error {
  status: number;
  constructor(status: number, message = '') { super(message); this.status = status; }
}

function compile(path: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return /id$/i.test(k) ? '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})' : '([^/]+)'; }) + '\\/?$');
  return { re, keys };
}

function add(method: 'GET' | 'POST', path: string, opts: RouteOpts, handler: Handler) {
  if (!opts || !opts.access) throw new Error(`route ${method} ${path} must declare access`);
  const { re, keys } = compile(path);
  routes.push({ method, path, re, keys, opts, handler });
}

export const get = (path: string, opts: RouteOpts, h: Handler) => add('GET', path, opts, h);
export const post = (path: string, opts: RouteOpts, h: Handler) => add('POST', path, opts, h);

export function match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}

export function pathExists(pathname: string): boolean {
  return routes.some((r) => r.re.test(pathname));
}

// ───────────── response helpers ─────────────
export function htmlRes(body: SafeHtml | string, status = 200): Res {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: typeof body === 'string' ? body : body.__html };
}

export function redirect(to: string, status = 303): Res {
  // only allow local redirects (open-redirect protection)
  const safe = to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\') ? to : '/';
  return { status, headers: { location: safe, 'cache-control': 'no-store' }, body: '' };
}

export function jsonRes(data: unknown, status = 200): Res {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  };
}

export function download(filename: string, type: string, body: string | Buffer): Res {
  return { status: 200, headers: { 'content-type': type, 'content-disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`, 'cache-control': 'no-store' }, body };
}

/** Append ?ok= / ?err= flash parameters to a local path. */
export function withFlash(path: string, kind: 'ok' | 'err', key: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(key)}`;
}

/** Safe "next" parameter: only local paths. */
export function safeNext(v: string | null | undefined, fallback = '/'): string {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return fallback;
  return v;
}
