import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(here, '..');

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

const env = process.env.NODE_ENV ?? 'development';

/** DATABASE_URL, optionally with the password read from a Docker secret file (HEARTH_DB_PASSWORD_FILE). */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? '';
  const file = process.env.HEARTH_DB_PASSWORD_FILE;
  if (!url || !file) return url;
  const u = new URL(url);
  u.password = encodeURIComponent(readFileSync(file, 'utf8').trim());
  return u.toString();
}

export const config = {
  env,
  isProd: env === 'production',
  port: int('PORT', 3000),
  host: process.env.HOST ?? '127.0.0.1',
  baseUrl: (process.env.HEARTH_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  /** postgres://… — when empty, an embedded PGlite database in dataDir is used (development / demo). */
  databaseUrl: databaseUrl(),
  dataDir: resolve(process.env.HEARTH_DATA_DIR ?? resolve(APP_ROOT, '../../data')),
  /**
   * Master keys for envelope encryption: "id:base64key,id2:base64key". First = current.
   * Read from env or HEARTH_MASTER_KEYS_FILE (Docker secret). Never stored in the database (NFR-SEC-15).
   */
  masterKeys: process.env.HEARTH_MASTER_KEYS ?? '',
  masterKeysFile: process.env.HEARTH_MASTER_KEYS_FILE ?? '',
  /** Secure cookies + HSTS. Defaults to true unless the base URL is plain http on localhost. */
  secureCookies: process.env.HEARTH_SECURE_COOKIES ? process.env.HEARTH_SECURE_COOKIES === 'true' : !/^http:\/\/(localhost|127\.0\.0\.1)/.test(process.env.HEARTH_BASE_URL ?? 'http://localhost:3000'),
  sessionIdleMinutes: int('HEARTH_SESSION_IDLE_MINUTES', 30),
  sessionMaxDays: int('HEARTH_SESSION_MAX_DAYS', 7),
  trustProxy: process.env.HEARTH_TRUST_PROXY === 'true',
  /** Mail transport: "outbox" writes .eml files to dataDir/outbox (default); "resend" uses the Resend API. */
  mailTransport: process.env.HEARTH_MAIL_TRANSPORT ?? 'outbox',
  mailFrom: process.env.HEARTH_MAIL_FROM || 'Hearth <no-reply@localhost>',
  /** Resend API key, from env or HEARTH_RESEND_API_KEY_FILE (Docker secret). */
  resendApiKey: process.env.HEARTH_RESEND_API_KEY_FILE ? readFileSync(process.env.HEARTH_RESEND_API_KEY_FILE, 'utf8').trim() : (process.env.HEARTH_RESEND_API_KEY ?? ''),
  /** Opt-in online breached-password check via k-anonymity (NFR-SEC-02). Off by default. */
  hibpOnline: process.env.HEARTH_HIBP_ONLINE === 'true',
  telemetry: false, // NFR-PRV-01: there is no telemetry.
  /** Database storage quota in MB for the admin usage bar (e.g. 1024 on Neon Free). 0 = unknown, show size only. */
  dbQuotaMb: int('HEARTH_DB_QUOTA_MB', 0),
  backupDir: process.env.HEARTH_BACKUP_DIR ?? '',
  backupIntervalHours: int('HEARTH_BACKUP_INTERVAL_HOURS', 24),
  logLevel: process.env.LOG_LEVEL ?? (env === 'production' ? 'info' : 'debug'),
};

export type Config = typeof config;
