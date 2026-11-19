/**
 * Static assets: content-hashed URLs + immutable caching + pre-compressed Brotli/gzip (NFR-PERF-11).
 * Service worker and manifest are served at fixed paths with short caching.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { brotliCompressSync, gzipSync, brotliCompress, gzip as gzipCb, constants } from 'node:zlib';

const brotli = promisify(brotliCompress);
const gzip = promisify(gzipCb);
import { APP_ROOT } from '../config.ts';

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

interface Asset { type: string; raw: Buffer; br: Buffer; gz: Buffer; etag: string; hashed: string }
const assets = new Map<string, Asset>();
const byHashed = new Map<string, Asset>();
const FIXED = new Set(['sw.js', 'manifest.webmanifest', 'robots.txt', 'favicon.ico', 'icon.svg']);

export function loadAssets() {
  const dir = join(APP_ROOT, 'public');
  for (const name of readdirSync(dir)) {
    const raw = readFileSync(join(dir, name));
    const ext = extname(name);
    const hash = createHash('sha256').update(raw).digest('base64url').slice(0, 10);
    const hashed = `${name.slice(0, -ext.length)}.${hash}${ext}`;
    const a: Asset = {
      type: TYPES[ext] ?? 'application/octet-stream',
      raw,
      br: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
      gz: gzipSync(raw, { level: 9 }),
      etag: `"${hash}"`,
      hashed,
    };
    assets.set(name, a);
    byHashed.set(hashed, a);
  }
}

/** URL for an asset in templates. */
export function asset(name: string): string {
  const a = assets.get(name);
  return a ? `/static/${a.hashed}` : `/static/${name}`;
}

export function assetSource(name: string): string { return assets.get(name)?.raw.toString('utf8') ?? ''; }

// ───────────── On-device slip OCR (FR-TXN-06) ─────────────
// tesseract.js runs in a Web Worker in the browser, so slip images never reach the server.
// Its files are served straight from node_modules (nothing vendored), loaded only when the user picks a slip.
const require = createRequire(import.meta.url);
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));
const OCR_VERSION: string = require('tesseract.js/package.json').version;
export const OCR_BASE = `/static/ocr/${OCR_VERSION}/`;
const OCR_FILES: Record<string, () => string> = {
  'tesseract.esm.min.js': () => join(pkgDir('tesseract.js'), 'dist/tesseract.esm.min.js'),
  'worker.min.js': () => join(pkgDir('tesseract.js'), 'dist/worker.min.js'),
  ...Object.fromEntries(['tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']
    .map((f) => [`core/${f}`, () => join(pkgDir('tesseract.js-core'), f)])),
  ...Object.fromEntries(['tha', 'eng'].map((l) => [`lang/${l}.traineddata.gz`, () => join(pkgDir(`@tesseract.js-data/${l}`), '4.0.0_best_int', `${l}.traineddata.gz`)])),
};
// The worker needs WebAssembly and same-origin importScripts/fetch, nothing else.
const OCR_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'";
const ocrCache = new Map<string, Promise<Asset>>();

async function loadOcr(file: string): Promise<Asset> {
  const raw = await readFile(OCR_FILES[file]());
  const text = file.endsWith('.js'); // .traineddata.gz is already compressed (tesseract inflates it itself)
  return {
    type: text ? TYPES['.js'] : 'application/octet-stream',
    raw,
    br: text ? await brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }) : raw,
    gz: text ? await gzip(raw, { level: 9 }) : raw,
    etag: `"${OCR_VERSION}"`,
    hashed: file,
  };
}

export async function serveOcr(pathname: string, acceptEncoding: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer } | null> {
  if (!pathname.startsWith(OCR_BASE)) return null;
  const file = pathname.slice(OCR_BASE.length);
  if (!Object.hasOwn(OCR_FILES, file)) return null;
  let p = ocrCache.get(file);
  if (!p) { p = loadOcr(file); ocrCache.set(file, p); p.catch(() => ocrCache.delete(file)); }
  const a = await p;
  const headers: Record<string, string> = {
    'content-type': a.type,
    'cache-control': 'public, max-age=31536000, immutable',
    etag: a.etag,
    'content-security-policy': OCR_CSP,
  };
  let body = a.raw;
  if (a.br !== a.raw) {
    headers.vary = 'Accept-Encoding';
    if (/\bbr\b/.test(acceptEncoding)) { body = a.br; headers['content-encoding'] = 'br'; }
    else if (/\bgzip\b/.test(acceptEncoding)) { body = a.gz; headers['content-encoding'] = 'gzip'; }
  }
  return { status: 200, headers, body };
}

export function serveStatic(pathname: string, acceptEncoding: string): { status: number; headers: Record<string, string>; body: Buffer } | null {
  let a: Asset | undefined;
  let immutable = false;
  if (pathname.startsWith('/static/')) {
    a = byHashed.get(pathname.slice(8));
    immutable = true;
  } else if (FIXED.has(pathname.slice(1))) {
    a = assets.get(pathname.slice(1));
  }
  if (!a) return null;
  const headers: Record<string, string> = {
    'content-type': a.type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
    etag: a.etag,
    vary: 'Accept-Encoding',
  };
  if (pathname === '/sw.js') headers['service-worker-allowed'] = '/';
  let body = a.raw;
  if (/\bbr\b/.test(acceptEncoding)) { body = a.br; headers['content-encoding'] = 'br'; }
  else if (/\bgzip\b/.test(acceptEncoding)) { body = a.gz; headers['content-encoding'] = 'gzip'; }
  return { status: 200, headers, body };
}
