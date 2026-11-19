/**
 * Restore an encrypted instance backup (FR-IO-05). CLI only — deliberately not exposed over HTTP.
 *   npm run restore -- /path/to/hearth-2026-11-17T....hbk --yes
 * WARNING: replaces ALL data in the target database.
 */
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { readBackup, restoreBackup } from '../src/services/backup.ts';
import { audit } from '../src/security/audit.ts';

const file = process.argv[2];
if (!file) { console.error('usage: npm run restore -- <backup.hbk> --yes'); process.exit(2); }
await (await import('../src/security/kms.ts')).initKeys();
const buf = readFileSync(file);
const info = readBackup(buf);
console.log(`backup from ${info.at}: ${Object.entries(info.dump).map(([t, r]) => `${t}=${r.length}`).filter((s) => !s.endsWith('=0')).join(', ')}`);
if (!process.argv.includes('--yes')) { console.error('add --yes to replace ALL current data with this backup'); process.exit(1); }
const db = await openDb();
await migrate(db);
await restoreBackup(db, buf);
await db.system((q) => audit(q, 'restore', null, { from: info.at }));
console.log('restore complete');
await db.close();
