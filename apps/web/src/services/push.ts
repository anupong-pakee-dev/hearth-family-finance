/**
 * Web Push (FR-NOTI-01) — RFC 8030 delivery, RFC 8291 message encryption (aes128gcm), RFC 8292 VAPID.
 * Implemented on node:crypto only (no third-party dependency).
 */
import { createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, sign } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { keys, seal, open } from '../security/keys.ts';
import { config } from '../config.ts';
import { log } from '../log.ts';

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

interface Vapid { publicKey: string; privateJwk: { kty: string; crv: string; x: string; y: string; d: string } }
let cached: Vapid | null = null;

/** Instance VAPID key pair; the private part is sealed with the master key in instance_settings. */
export async function vapid(db: Db): Promise<Vapid> {
  if (cached) return cached;
  const row = await db.system((q) => q.one<{ value: any }>(`select value from instance_settings where key = 'vapid'`));
  if (row) {
    const v = row.value;
    const d = open(keys().get(v.kid), Buffer.from(v.enc, 'base64'), 'vapid').toString('utf8');
    cached = { publicKey: v.publicKey, privateJwk: JSON.parse(d) };
    return cached;
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as Vapid['privateJwk'];
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
  const mk = keys().current();
  const value = { publicKey, kid: mk.id, enc: seal(mk.key, JSON.stringify(jwk), 'vapid').toString('base64') };
  await db.system((q) => q.query(`insert into instance_settings(key, value) values ('vapid', $1) on conflict (key) do nothing`, [JSON.stringify(value)]));
  cached = null;
  return vapid(db);
}

/** RFC 8291 aes128gcm encryption of one push message. */
export function encryptPayload(payload: Buffer, p256dh: string, authSecret: string, salt = randomBytes(16)) {
  const uaPublic = unb64u(p256dh);
  const auth = unb64u(authSecret);
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys(); // fresh ephemeral key per message
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** VAPID JWT (ES256) for the push service origin. */
export function vapidAuth(v: Vapid, endpoint: string, now = Math.floor(Date.now() / 1000)): string {
  const aud = new URL(endpoint).origin;
  const enc = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: now + 12 * 3600, sub: config.baseUrl.startsWith('https://') ? config.baseUrl : 'mailto:admin@localhost' })}`;
  const key = createPrivateKey({ key: v.privateJwk, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${v.publicKey}`;
}

export interface PushSub { id: string; endpoint: string; p256dh: string; auth: string }

/** Send to every subscription of a user; expired subscriptions (404/410) are removed. */
export async function sendPush(db: Db, userId: string, subs: PushSub[], msg: { title: string; body: string; url: string }) {
  if (!subs.length) return;
  const v = await vapid(db);
  const payload = Buffer.from(JSON.stringify(msg));
  for (const s of subs) {
    try {
      const url = new URL(s.endpoint);
      if (url.protocol !== 'https:') continue;
      const res = await fetch(s.endpoint, {
        method: 'POST',
        headers: { TTL: '86400', Urgency: 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuth(v, s.endpoint) },
        body: encryptPayload(payload, s.p256dh, s.auth),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404 || res.status === 410) await db.asUser(userId, (q) => q.query('delete from push_subscriptions where id = $1', [s.id]));
      else if (!res.ok) log.warn('push rejected', { status: res.status });
    } catch (e) {
      log.warn('push failed', { err: (e as Error).message });
    }
  }
}
