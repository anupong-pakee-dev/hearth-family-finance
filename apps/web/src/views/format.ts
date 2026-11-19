/**
 * Display formatting (FR-SET-02): currency, number format, Buddhist / Gregorian era, privacy mode.
 */
import { formatScaled, parseIso } from '@hearth/engine';
import type { Prefs } from '../http/app.ts';
import { html, type SafeHtml } from './html.ts';

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface Fmt {
  money(v: bigint | null | undefined, opts?: { sign?: boolean; currency?: string; compact?: boolean }): string;
  moneyHtml(v: bigint | null | undefined, opts?: { sign?: boolean; currency?: string }): SafeHtml;
  date(d: string | Date | null | undefined): string;
  month(key: string): string;
  monthShort(key: string): string;
  pct(v: number, digits?: number): string;
  num(v: number, digits?: number): string;
  units(e8: bigint): string;
  privacy: boolean;
  locale: string;
}

export function makeFmt(prefs: Prefs | null, lang: 'th' | 'en'): Fmt {
  const locale = lang === 'th' ? 'th-TH' : 'en-US';
  const currency = prefs?.currency ?? 'THB';
  const era = prefs?.date_era ?? (lang === 'th' ? 'be' : 'ce');
  const privacy = !!prefs?.privacy_mode;
  const nfCache = new Map<string, Intl.NumberFormat>();
  const nf = (cur: string, compact = false) => {
    const k = `${cur}|${compact}`;
    let f = nfCache.get(k);
    if (!f) {
      f = new Intl.NumberFormat(locale, compact
        ? { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 1 }
        : { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 });
      nfCache.set(k, f);
    }
    return f;
  };
  const months = lang === 'th' ? TH_MONTHS : EN_MONTHS;
  const year = (y: number) => (era === 'be' ? y + 543 : y);

  const money: Fmt['money'] = (v, opts = {}) => {
    if (v == null) return '—';
    if (privacy) return '•••••';
    // exact decimal string -> Intl (string input keeps full precision, no float rounding)
    const s = formatScaled(v, 2);
    const out = nf(opts.currency ?? currency, !!opts.compact).format(s as unknown as number);
    return opts.sign && v > 0n ? `+${out}` : out;
  };
  return {
    privacy,
    locale,
    money,
    moneyHtml(v, opts = {}) {
      const cls = v == null || privacy ? 'amt' : v < 0n ? 'amt neg' : v > 0n && opts.sign ? 'amt pos' : 'amt';
      return html`<span class="${cls}">${money(v, opts)}</span>`;
    },
    date(d) {
      if (!d) return '—';
      const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
      const { y, m, day } = parseIso(iso);
      return `${day} ${months[m - 1]} ${year(y)}`;
    },
    month(key) {
      const [y, m] = key.split('-').map(Number);
      return `${months[m - 1]} ${year(y)}`;
    },
    monthShort(key) {
      const [, m] = key.split('-').map(Number);
      return months[m - 1];
    },
    pct(v, digits = 1) {
      if (!Number.isFinite(v)) return '∞';
      return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(v);
    },
    num(v, digits = 1) {
      if (!Number.isFinite(v)) return '∞';
      return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v);
    },
    units(e8) { return privacy ? '•••' : formatScaled(e8, 8, 0); },
  };
}

/** Value for <input> fields (plain decimal, no grouping). */
export function inputMoney(v: bigint | null | undefined): string {
  return v == null ? '' : formatScaled(v, 2);
}
export function inputRate(e4: number | null | undefined): string {
  return e4 == null ? '' : formatScaled(BigInt(e4), 4, 0);
}
