/**
 * Master-key rotation without downtime (NFR-SEC-15).
 *   1. Put the NEW key first in HEARTH_MASTER_KEYS, keep the old one after it:  "k2:<new>,k1:<old>"
 *   2. Restart the app (it can read both), then run:  npm run rotate-keys
 *   3. When it reports 0 remaining, remove the old key from the configuration.
 * Only the per-user data keys are re-wrapped; field ciphertext never has to be rewritten.
 */
import { openDb } from '../src/db/index.ts';
import { keys, rewrap } from '../src/security/keys.ts';
import { audit } from '../src/security/audit.ts';

await (await import('../src/security/kms.ts')).initKeys();
const db = await openDb();
const current = keys().current().id;
const rows = await db.system((q) => q.query<{ id: string; data_key_enc: Buffer; data_key_version: string }>(
  'select id, data_key_enc, data_key_version from users where data_key_enc is not null and data_key_version <> $1', [current]));
let done = 0;
for (const r of rows) {
  const w = rewrap(r.id, Buffer.from(r.data_key_enc), r.data_key_version);
  await db.system((q) => q.query('update users set data_key_enc = $1, data_key_version = $2 where id = $3 and data_key_version = $4', [w.enc, w.version, r.id, r.data_key_version]));
  done++;
}
await db.system((q) => audit(q, 'key_rotation', null, { rewrapped: done, to: current }));
const left = await db.system((q) => q.one<{ n: number }>('select count(*)::int n from users where data_key_enc is not null and data_key_version <> $1', [current]));
console.log(`re-wrapped ${done} data keys with ${current}; remaining on old keys: ${left?.n ?? 0}`);
await db.close();
