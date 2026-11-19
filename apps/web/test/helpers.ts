/**
 * Integration-test harness: boots the real server on a random port with an in-memory PGlite database.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.HEARTH_JOBS = 'off';
process.env.HEARTH_REGISTER_PER_HOUR = '1000';
process.env.HEARTH_SILENT = process.env.HEARTH_SILENT ?? '1';
process.env.HEARTH_DATA_DIR = mkdtempSync(join(tmpdir(), 'hearth-test-'));
process.env.HEARTH_MASTER_KEYS = `t1:${Buffer.alloc(32, 7).toString('base64')}`;

const { openDb } = await import('../src/db/index.ts');
const { createApp } = await import('../src/server.ts');

export async function startApp() {
  const db = await openDb({ memory: true });
  const server = await createApp(db);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, base, close: async () => { server.close(); await db.close(); } };
}

export class Client {
  cookies = new Map<string, string>();
  base: string;
  constructor(base: string) { this.base = base; }

  private cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }

  async req(method: string, path: string, body?: Record<string, string> | string, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, redirect: 'manual', headers: { cookie: this.cookieHeader(), 'accept-language': 'en', ...headers }, signal: AbortSignal.timeout(20_000) };
    if (body !== undefined) {
      if (typeof body === 'string') init.body = body;
      else { init.body = new URLSearchParams(body).toString(); (init.headers as Record<string, string>)['content-type'] = 'application/x-www-form-urlencoded'; }
    }
    const res = await fetch(this.base + path, init);
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Max-Age=0/i.test(sc)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text };
  }

  async get(path: string) { return this.req('GET', path); }

  /** Fetch a page, extract its CSRF token, then POST the form. */
  async csrf(path = '/login'): Promise<string> {
    let r = await this.get(path);
    if (r.status === 303 && r.location) r = await this.get(r.location);
    const m = /name="_csrf" value="([^"]+)"/.exec(r.text);
    if (!m) throw new Error(`no csrf token on ${path} (status ${r.status})`);
    return m[1];
  }

  async post(path: string, body: Record<string, string>, from = '/') {
    const token = await this.csrf(from);
    return this.req('POST', path, { _csrf: token, ...body });
  }

  async register(email: string, password = 'lantern-river-mango-42', name = 'Tester') {
    const token = await this.csrf('/register');
    const r = await this.req('POST', '/register', { _csrf: token, email, password, name });
    if (r.status !== 303) throw new Error(`register failed ${r.status}: ${r.text.slice(0, 200)}`);
    return r;
  }
}

/** Extract <option value> list of a <select name=...> */
export function options(html: string, name: string): { value: string; label: string }[] {
  const m = new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  if (!m) return [];
  return [...m[1].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((x) => ({ value: x[1], label: x[2].trim() }));
}
