/**
 * OpenID Connect relying party (FR-AUTH-04): authorization code flow + PKCE (S256), state and nonce,
 * id_token signature verification against the provider's JWKS (RS256 / ES256), iss/aud/exp/nonce checks.
 */
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
const discoveryCache = new Map<string, { at: number; d: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: any[] }>();

function allowedUrl(u: string) {
  const url = new URL(u);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('OIDC endpoints must use https');
  return url;
}

export async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.d;
  const res = await fetch(allowedUrl(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`discovery failed (${res.status})`);
  const d = (await res.json()) as Discovery;
  if (d.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) throw new Error('issuer mismatch in discovery');
  discoveryCache.set(issuer, { at: Date.now(), d });
  return d;
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(d: Discovery, p: { client_id: string; scopes: string }, redirectUri: string, state: string, nonce: string, challenge: string) {
  const u = allowedUrl(d.authorization_endpoint);
  const q = u.searchParams;
  q.set('response_type', 'code'); q.set('client_id', p.client_id); q.set('redirect_uri', redirectUri); q.set('scope', p.scopes);
  q.set('state', state); q.set('nonce', nonce); q.set('code_challenge', challenge); q.set('code_challenge_method', 'S256');
  return u.toString();
}

export async function exchangeCode(d: Discovery, p: { client_id: string; client_secret: string | null }, code: string, verifier: string, redirectUri: string): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: p.client_id, code_verifier: verifier });
  if (p.client_secret) body.set('client_secret', p.client_secret);
  const res = await fetch(allowedUrl(d.token_endpoint), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error('no id_token');
  return json.id_token;
}

async function jwks(uri: string, force = false): Promise<any[]> {
  const hit = jwksCache.get(uri);
  if (hit && !force && Date.now() - hit.at < 3_600_000) return hit.keys;
  const res = await fetch(allowedUrl(uri), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error('jwks fetch failed');
  const keys = ((await res.json()) as { keys: any[] }).keys;
  jwksCache.set(uri, { at: Date.now(), keys });
  return keys;
}

export interface IdClaims { iss: string; sub: string; aud: string | string[]; exp: number; iat: number; nonce?: string; email?: string; email_verified?: boolean; name?: string }

export async function verifyIdToken(token: string, d: Discovery, clientId: string, nonce: string, now = Math.floor(Date.now() / 1000)): Promise<IdClaims> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('malformed id_token');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (!['RS256', 'ES256'].includes(header.alg)) throw new Error('unsupported id_token alg');
  let keys = await jwks(d.jwks_uri);
  let jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : null);
  if (!jwk) { keys = await jwks(d.jwks_uri, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error('signing key not found');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad id_token signature');
  const c = JSON.parse(Buffer.from(p, 'base64url').toString()) as IdClaims;
  if (c.iss.replace(/\/$/, '') !== d.issuer.replace(/\/$/, '')) throw new Error('iss mismatch');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) throw new Error('aud mismatch');
  if (typeof c.exp !== 'number' || c.exp < now - 60) throw new Error('id_token expired');
  if (c.nonce !== nonce) throw new Error('nonce mismatch');
  if (!c.sub) throw new Error('no subject');
  return c;
}
