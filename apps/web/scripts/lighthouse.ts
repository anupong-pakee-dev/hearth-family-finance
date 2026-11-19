/**
 * Local Lighthouse runner (NFR-PERF-01..04): mobile preset, authenticated pages, median of N runs.
 *
 *   npm run seed:demo          # once (DEMO_TXNS=50000 for the NFR-PERF-02 profile)
 *   npm run lighthouse:local   # LH_RUNS=3 LH_URLS=/,/debts  CHROME_PATH=... optional
 *
 * Exits non-zero when any category on any page is below 100.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = Number(process.env.LH_PORT ?? 3100);
const BASE = `http://localhost:${PORT}`;
const RUNS = Number(process.env.LH_RUNS ?? 1);
const URLS = (process.env.LH_URLS ?? '/login,/onboarding,/,/transactions,/debts,/debts/plan,/goals,/invest,/settings').split(',');
const EMAIL = process.env.DEMO_EMAIL ?? 'family@hearth.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-hearth-family-2026'; // demo seed (development only)

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

const keyFile = join(root, 'data/dev-master.key');
const server = spawn(process.execPath, ['apps/web/src/server.ts'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), HOST: '127.0.0.1', HEARTH_JOBS: 'off', HEARTH_BASE_URL: BASE, HEARTH_MASTER_KEYS: process.env.HEARTH_MASTER_KEYS ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start')), 30_000);
  server.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('Hearth listening')) { clearTimeout(t); res(); } });
});

let cached: string | null = null;
async function login(): Promise<string> {
  if (cached) return cached;
  const page = await fetch(`${BASE}/login`);
  const jar = new Map<string, string>();
  const take = (r: Response) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  take(page);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())![1];
  const r = await fetch(`${BASE}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: new URLSearchParams({ _csrf: csrf, email: EMAIL, password: PASSWORD }) });
  take(r);
  if (r.status !== 303) throw new Error(`login failed (${r.status}) — run npm run seed:demo first`);
  cached = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return cached;
}

const chrome = await chromeLauncher.launch({ chromePath: findChrome(), chromeFlags: ['--headless=new', '--no-sandbox'] });
// Cookies set through the DevTools protocol (extraHeaders are dropped by Lighthouse's storage reset).
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
async function setSession(cookie: string | undefined) {
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Network.clearBrowserCookies');
  await client.send('Network.clearBrowserCache'); // cold load, like a first visit
  await client.send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'service_workers,cache_storage' });
  for (const pair of (cookie ?? '').split('; ').filter(Boolean)) {
    const i = pair.indexOf('=');
    await client.send('Network.setCookie', { name: pair.slice(0, i), value: decodeURIComponent(pair.slice(i + 1)), url: BASE, httpOnly: true, sameSite: 'Strict' });
  }
  await page.close();
}
const results: Record<string, Record<string, number>> = {};
const failures: string[] = [];
mkdirSync(join(root, '.lighthouseci'), { recursive: true });
try {
  for (const path of URLS) {
    const runs: Record<string, number>[] = [];
    for (let i = 0; i < RUNS; i++) {
      const cookie = path === '/login' ? undefined : await login();
      await setSession(cookie);
      const r = await lighthouse(BASE + path, { port: chrome.port, output: 'json', logLevel: 'error', disableStorageReset: true, onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] });
      if (!r) throw new Error('no result');
      const lhr = r.lhr;
      if (lhr.finalDisplayedUrl && !lhr.finalDisplayedUrl.endsWith(path)) console.warn(`  ! ${path} redirected to ${lhr.finalDisplayedUrl}`);
      runs.push(Object.fromEntries(Object.entries(lhr.categories).map(([k, c]) => [k, Math.round((c.score ?? 0) * 100)])));
      if (i === RUNS - 1) {
        writeFileSync(join(root, '.lighthouseci', `${path.replace(/\W+/g, '_') || 'root'}.json`), JSON.stringify(lhr));
        for (const [catId, cat] of Object.entries(lhr.categories)) {
          for (const ref of cat.auditRefs) {
            const a = lhr.audits[ref.id];
            if (ref.weight > 0 && a.score !== null && a.score < 1) failures.push(`${path} [${catId}] ${a.id}: ${a.title} (${a.displayValue ?? a.score})`);
          }
        }
        const m = (id: string) => Math.round(lhr.audits[id]?.numericValue ?? NaN);
        console.log(`  ${path}: FCP ${m('first-contentful-paint')}ms · LCP ${m('largest-contentful-paint')}ms · TBT ${m('total-blocking-time')}ms · CLS ${lhr.audits['cumulative-layout-shift']?.numericValue?.toFixed(3)} · SI ${m('speed-index')}ms · bytes ${m('total-byte-weight')}`);
      }
    }
    const median = (k: string) => runs.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    results[path] = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, median(k)]));
  }
} finally {
  await browser.disconnect();
  await chrome.kill();
  server.kill();
}

console.table(results);
if (failures.length) console.log('\nAudits below 100:\n' + [...new Set(failures)].join('\n'));
const bad = Object.values(results).some((r) => Object.values(r).some((v) => v < 100));
process.exit(bad ? 1 : 0);
