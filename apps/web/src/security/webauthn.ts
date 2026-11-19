/**
 * WebAuthn / passkeys (FR-AUTH-05, NFR-SEC-03) — attestation "none", ES256 and RS256 credentials.
 * Verifies challenge, origin, RP ID hash, user-presence/verification flags, signature and counter.
 */
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { decode, decodeFirst, type CborValue } from './cbor.ts';
import { config } from '../config.ts';

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();
export const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
export const unb64u = (s: string) => Buffer.from(s, 'base64url');

export function rp() {
  const u = new URL(config.baseUrl);
  return { id: u.hostname, name: 'Hearth Family Finance', origin: u.origin };
}

export function newChallenge(): string { return b64u(randomBytes(32)); }

interface AuthData { rpIdHash: Buffer; flags: number; signCount: number; credentialId?: Buffer; publicKey?: Map<CborValue, CborValue> }

export function parseAuthData(b: Buffer): AuthData {
  if (b.length < 37) throw new Error('authenticator data too short');
  const out: AuthData = { rpIdHash: b.subarray(0, 32), flags: b[32], signCount: b.readUInt32BE(33) };
  if (out.flags & 0x40) { // attested credential data
    const len = b.readUInt16BE(53);
    out.credentialId = b.subarray(55, 55 + len);
    const { value } = decodeFirst(b.subarray(55 + len));
    if (!(value instanceof Map)) throw new Error('bad COSE key');
    out.publicKey = value;
  }
  return out;
}

/** COSE_Key → JWK (EC2 P-256 / RSA). */
export function coseToJwk(m: Map<CborValue, CborValue>): JsonWebKey & { alg: string } {
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1) {
    return { kty: 'EC', crv: 'P-256', x: b64u(m.get(-2) as Uint8Array), y: b64u(m.get(-3) as Uint8Array), alg: 'ES256' };
  }
  if (kty === 3 && alg === -257) {
    return { kty: 'RSA', n: b64u(m.get(-1) as Uint8Array), e: b64u(m.get(-2) as Uint8Array), alg: 'RS256' };
  }
  throw new Error('unsupported credential algorithm');
}

function checkClientData(clientDataJSON: Buffer, type: string, challenge: string) {
  const cd = JSON.parse(clientDataJSON.toString('utf8'));
  if (cd.type !== type) throw new Error('wrong ceremony type');
  if (cd.challenge !== challenge) throw new Error('challenge mismatch');
  if (cd.origin !== rp().origin) throw new Error('origin mismatch');
  if (cd.crossOrigin === true) throw new Error('cross-origin ceremony');
}

function checkFlags(ad: AuthData) {
  if (!ad.rpIdHash.equals(sha256(rp().id))) throw new Error('RP ID mismatch');
  if (!(ad.flags & 0x01)) throw new Error('user not present');
  if (!(ad.flags & 0x04)) throw new Error('user not verified');
}

export function verifyRegistration(resp: { clientDataJSON: string; attestationObject: string }, challenge: string) {
  const clientData = unb64u(resp.clientDataJSON);
  checkClientData(clientData, 'webauthn.create', challenge);
  const att = decode(unb64u(resp.attestationObject));
  if (!(att instanceof Map)) throw new Error('bad attestation object');
  const fmt = att.get('fmt');
  if (fmt !== 'none' && fmt !== 'packed') throw new Error('unsupported attestation format');
  const ad = parseAuthData(Buffer.from(att.get('authData') as Uint8Array));
  checkFlags(ad);
  if (!ad.credentialId || !ad.publicKey) throw new Error('no credential');
  return { credentialId: b64u(ad.credentialId), jwk: coseToJwk(ad.publicKey), signCount: ad.signCount };
}

export function verifyAssertion(resp: { clientDataJSON: string; authenticatorData: string; signature: string }, challenge: string, cred: { public_key_jwk: any; sign_count: bigint | number }) {
  const clientData = unb64u(resp.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', challenge);
  const authData = unb64u(resp.authenticatorData);
  const ad = parseAuthData(authData);
  checkFlags(ad);
  const jwk = cred.public_key_jwk;
  const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, n: jwk.n, e: jwk.e }, format: 'jwk' });
  const data = Buffer.concat([authData, sha256(clientData)]);
  const ok = verify('sha256', data, jwk.kty === 'EC' ? { key, dsaEncoding: 'der' } : key, unb64u(resp.signature));
  if (!ok) throw new Error('bad signature');
  const prev = Number(cred.sign_count);
  if ((ad.signCount !== 0 || prev !== 0) && ad.signCount <= prev) throw new Error('signature counter did not increase (cloned authenticator?)');
  return { signCount: ad.signCount };
}
