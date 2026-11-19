/**
 * Envelope encryption (NFR-SEC-14/15/18).
 *
 *   master key (env / secret file / KMS adapter)  ──wraps──▶  per-user data key  ──encrypts──▶  fields
 *
 * Ciphertext format (bytea): [1 byte version=1][12 byte IV][16 byte tag][ciphertext]  — AES-256-GCM.
 * Wrapped data key format: "<masterKeyId>" stored alongside; blob = same AES-GCM layout.
 * Key rotation: add a new master key at the FRONT of HEARTH_MASTER_KEYS and run `npm run rotate-keys`;
 * old keys stay readable until every data key is re-wrapped. Deleting a user's wrapped data key
 * crypto-shreds all of their encrypted fields.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from '../config.ts';
import { log } from '../log.ts';

export interface KeyProvider {
  current(): { id: string; key: Buffer };
  get(id: string): Buffer;
}

function parseKeys(spec: string): { id: string; key: Buffer }[] {
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [id, b64] = entry.split(':');
    const key = Buffer.from(b64 ?? '', 'base64');
    if (!id || key.length !== 32) throw new Error('each master key must be "id:<32 bytes base64>"');
    return { id, key };
  });
}

/** Env/secret-file key provider. A Vault/KMS adapter can implement the same interface. */
export function envKeyProvider(): KeyProvider {
  let spec = config.masterKeys;
  if (!spec && config.masterKeysFile) spec = readFileSync(config.masterKeysFile, 'utf8').trim();
  if (!spec) {
    if (config.isProd) throw new Error('HEARTH_MASTER_KEYS (or HEARTH_MASTER_KEYS_FILE) is required in production');
    // Development convenience: generate a local key file once (outside the database).
    const file = `${config.dataDir}/dev-master.key`;
    if (!existsSync(file)) {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(file, `dev1:${randomBytes(32).toString('base64')}`, { mode: 0o600 });
      log.warn('generated development master key', { file });
    }
    spec = readFileSync(file, 'utf8').trim();
  }
  return keyProviderFromSpec(spec);
}

/** Build a provider from a "id:base64,old:base64" spec (used by the env, Vault and AWS adapters). */
export function keyProviderFromSpec(spec: string): KeyProvider {
  const keys = parseKeys(spec);
  if (!keys.length) throw new Error('no master keys configured');
  const map = new Map(keys.map((k) => [k.id, k.key]));
  return {
    current: () => keys[0],
    get: (id) => { const k = map.get(id); if (!k) throw new Error(`unknown master key ${id}`); return k; },
  };
}

const TAG_LEN = 16; // bytes; layout: [version 1][iv 12][tag 16][ciphertext]

export function seal(key: Buffer, plaintext: Buffer | string, aad?: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  if (aad) c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
}

export function open(key: Buffer, blob: Buffer, aad?: string): Buffer {
  if (blob.length < 29 || blob[0] !== 1) throw new Error('bad ciphertext');
  // Pin the tag length so a truncated tag can never be accepted (GCM forgery hardening).
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13), { authTagLength: TAG_LEN });
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(13, 29));
  return Buffer.concat([d.update(blob.subarray(29)), d.final()]);
}

let provider: KeyProvider | null = null;
export function keys(): KeyProvider { return (provider ??= envKeyProvider()); }
export function setKeyProvider(p: KeyProvider) { provider = p; dataKeyCache.clear(); }

/** Create a fresh data key for a user, wrapped by the current master key. */
export function newWrappedDataKey(userId: string): { enc: Buffer; version: string } {
  const dk = randomBytes(32);
  const mk = keys().current();
  return { enc: seal(mk.key, dk, `dk:${userId}`), version: mk.id };
}

export function rewrap(userId: string, enc: Buffer, version: string): { enc: Buffer; version: string } {
  const dk = open(keys().get(version), enc, `dk:${userId}`);
  const mk = keys().current();
  return { enc: seal(mk.key, dk, `dk:${userId}`), version: mk.id };
}

const dataKeyCache = new Map<string, { key: Buffer; at: number }>();

/** Resolve a user's data key (short in-memory cache). Callers pass the wrapped key loaded from users. */
export function unwrapDataKey(userId: string, enc: Buffer | null, version: string | null): Buffer | null {
  if (!enc || !version) return null; // crypto-shredded
  const cacheKey = `${userId}:${version}:${createHash('sha256').update(enc).digest('base64url').slice(0, 16)}`;
  const hit = dataKeyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.key;
  const key = open(keys().get(version), enc, `dk:${userId}`);
  dataKeyCache.set(cacheKey, { key, at: Date.now() });
  return key;
}

export function forgetDataKey(userId: string) {
  for (const k of dataKeyCache.keys()) if (k.startsWith(`${userId}:`)) dataKeyCache.delete(k);
}

/** Field helpers bound to a data key. */
export function fieldCipher(dataKey: Buffer | null) {
  return {
    enc(v: string | null | undefined): Buffer | null {
      if (v == null || v === '') return null;
      if (!dataKey) throw new Error('data key unavailable');
      return seal(dataKey, v, 'field');
    },
    dec(b: Buffer | Uint8Array | null | undefined): string {
      if (!b) return '';
      if (!dataKey) return '';
      try { return open(dataKey, Buffer.from(b), 'field').toString('utf8'); } catch { return ''; }
    },
  };
}
