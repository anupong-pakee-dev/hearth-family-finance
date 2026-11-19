/**
 * i18n (FR-SET-01). Dictionaries are flat JSON files so community translators can use Weblate/Crowdin.
 * Add a language: drop `xx.json` next to these files and add it to LANGS.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
export const LANGS = ['th', 'en'] as const;
export type Lang = (typeof LANGS)[number];

const dicts: Record<string, Record<string, string>> = {};
for (const l of LANGS) dicts[l] = JSON.parse(readFileSync(join(dir, `${l}.json`), 'utf8'));

export function translator(lang: Lang) {
  const d = dicts[lang] ?? dicts.en;
  return (key: string, vars?: Record<string, string | number>): string => {
    let s = d[key] ?? dicts.en[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
    return s;
  };
}

export function hasKey(key: string): boolean { return key in dicts.en; }
export function keysOf(lang: Lang): string[] { return Object.keys(dicts[lang]); }

export function pickLang(acceptLanguage: string | undefined): Lang {
  if (!acceptLanguage) return 'th';
  return /^\s*en/i.test(acceptLanguage) ? 'en' : 'th';
}
