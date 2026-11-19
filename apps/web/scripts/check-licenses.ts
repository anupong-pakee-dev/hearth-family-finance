/**
 * Licence gate for production dependencies (CI "dependencies" job).
 * Walks `npm ls --omit=dev --all` (which understands npm workspaces) and fails if any
 * third-party package is not under an allowed licence. Our own workspace packages are skipped.
 *   node apps/web/scripts/check-licenses.ts
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0']);

const out = execSync('npm ls --omit=dev --all --parseable', { encoding: 'utf8' });
const dirs = [...new Set(out.split(/\r?\n/).filter(Boolean))].filter((d) => d.includes(`${sep}node_modules${sep}`) || d.includes('/node_modules/'));

const licenceOf = (pkg: any): string => {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x.type)).join(' OR ');
  return l?.type ?? 'UNKNOWN';
};
// Accept an SPDX expression if every alternative of an OR (or every term of an AND) is allowed.
const allowed = (expr: string): boolean => {
  const e = expr.replace(/[()]/g, '').trim();
  if (e.includes(' OR ')) return e.split(' OR ').some((x) => allowed(x));
  if (e.includes(' AND ')) return e.split(' AND ').every((x) => allowed(x));
  return ALLOWED.has(e);
};

const bad: string[] = [];
const seen = new Set<string>();
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.name?.startsWith('@hearth/')) continue; // our own workspace packages
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const lic = licenceOf(pkg);
  if (!allowed(lic)) bad.push(`${id}: ${lic}`);
}

if (bad.length) {
  console.error(`Disallowed licences:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`Licence check passed: ${seen.size} production packages.`);
