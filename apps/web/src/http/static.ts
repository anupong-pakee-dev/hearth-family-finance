/**
 * Static assets: content-hashed URLs + immutable caching + pre-compressed Brotli/gzip (NFR-PERF-11).
 * Service worker and manifest are served at fixed paths with short caching.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
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
