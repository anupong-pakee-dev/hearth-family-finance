/**
 * Password hashing and policy.
 *  - Argon2id, memory 19 MiB, 2 iterations, parallelism 1 (OWASP minimum, NFR-SEC-01) via node:crypto.
 *  - NIST SP 800-63B policy: ≥ 12 chars, no composition rules, max 128, checked against a breached
 *    list shipped offline (NFR-SEC-02). Online k-anonymity check is opt-in.
 */
import { argon2, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };

function argon(password: string, salt: Buffer, p = PARAMS): Promise<Buffer> {
  return new Promise((res, rej) => {
    argon2('argon2id', { message: Buffer.from(password.normalize('NFKC'), 'utf8'), nonce: salt, ...p }, (err, key) => (err ? rej(err) : res(Buffer.from(key))));
  });
}

/** PHC string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await argon(password, salt);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5], 'base64url');
  const got = await argon(password, Buffer.from(m[4], 'base64url'), { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]), tagLength: expected.length });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function needsRehash(stored: string): boolean {
  return !stored.startsWith(`$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$`);
}

/** Constant-time dummy verification so unknown e-mails take as long as known ones (NFR-SEC-07). */
let dummy: string | null = null;
export async function dummyVerify(password: string) {
  dummy ??= await hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(dummy, password);
}

let breached: Set<string> | null = null;
function breachedSet(): Set<string> {
  if (breached) return breached;
  const file = join(dirname(fileURLToPath(import.meta.url)), 'breached-passwords.txt');
  breached = new Set(readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean));
  return breached;
}

export type PasswordProblem = 'too_short' | 'too_long' | 'breached' | 'contains_email';

export async function checkPassword(password: string, email?: string): Promise<PasswordProblem | null> {
  const len = [...password].length;
  if (len < 12) return 'too_short';
  if (len > 128) return 'too_long';
  const lower = password.toLowerCase();
  if (email && lower.includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) return 'contains_email';
  if (breachedSet().has(lower)) return 'breached';
  if (/^(.)\1+$/.test(password)) return 'breached';
  if (config.hibpOnline) {
    try {
      const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
      const r = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, { headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(3000) });
      if (r.ok && (await r.text()).split('\n').some((l) => l.startsWith(sha1.slice(5)) && !l.endsWith(':0'))) return 'breached';
    } catch { /* offline list already checked */ }
  }
  return null;
}
