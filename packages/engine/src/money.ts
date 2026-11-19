/**
 * Money primitives (NFR-ACC-01/02).
 *
 * All monetary amounts are integers in the minor unit (satang for THB) held as `bigint`.
 * Floating point is never used for stored money. Rounding is banker's rounding
 * (round half to even) everywhere via {@link divRound}.
 *
 * Interest rates are integers: percent × 10 000 ("rateE4"), matching DB type decimal(7,4).
 *   18%      -> 180_000
 *   2.875%   -> 28_750
 */

export type Satang = bigint;

/** Integer division rounded half-to-even (banker's rounding). Works for negative values. */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  if (d < 0n) { n = -n; d = -d; }
  const neg = n < 0n;
  const a = neg ? -n : n;
  let q = a / d;
  const r = a % d;
  const twice = r * 2n;
  if (twice > d || (twice === d && q % 2n === 1n)) q += 1n;
  return neg ? -q : q;
}

export function bmin(a: bigint, b: bigint): bigint { return a < b ? a : b; }
export function bmax(a: bigint, b: bigint): bigint { return a > b ? a : b; }
export function babs(a: bigint): bigint { return a < 0n ? -a : a; }
export function bsum(values: Iterable<bigint>): bigint { let s = 0n; for (const v of values) s += v; return s; }

/**
 * Parse a user-entered decimal amount ("1,234.56", "-20", "฿1 000.5") into minor units.
 * Extra decimals beyond `scale` are rounded half-to-even. Returns null when invalid.
 */
export function parseMoney(input: string | null | undefined, scale = 2): Satang | null {
  if (input == null) return null;
  const cleaned = String(input).replace(/[\s,_฿$€£¥]/g, '');
  if (!/^[-+]?\d+(\.\d+)?$/.test(cleaned)) return null;
  return parseScaled(cleaned, scale);
}

/** Parse a decimal string into an integer scaled by 10^scale (exact, rounded half-even). */
export function parseScaled(text: string, scale: number): bigint | null {
  const m = /^([-+]?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2];
  const frac = m[3] ?? '';
  if (frac.length <= scale) {
    return sign * BigInt(intPart + frac.padEnd(scale, '0'));
  }
  const kept = BigInt(intPart + frac.slice(0, scale) + frac.slice(scale));
  const extra = 10n ** BigInt(frac.length - scale);
  return sign * divRound(kept, extra);
}

/** Render an integer scaled by 10^scale as a plain decimal string ("1234.50"). */
export function formatScaled(value: bigint, scale: number, minFraction = scale): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(scale);
  const intPart = abs / base;
  let frac = (abs % base).toString().padStart(scale, '0');
  while (frac.length > minFraction && frac.endsWith('0')) frac = frac.slice(0, -1);
  return (neg ? '-' : '') + intPart.toString() + (frac.length ? '.' + frac : '');
}

/** Satang -> "1234.56" */
export function toDecimalString(v: Satang): string { return formatScaled(v, 2); }

/** Parse a percent string ("18", "2.875") into rateE4. */
export function parseRateE4(input: string | null | undefined): number | null {
  if (input == null || String(input).trim() === '') return null;
  const v = parseScaled(String(input).replace(/[%\s]/g, ''), 4);
  if (v == null) return null;
  return Number(v);
}

/** amount × rateE4 / 1_000_000 (i.e. amount × percent / 100), banker's rounded. */
export function applyRate(amount: Satang, rateE4: number): Satang {
  return divRound(amount * BigInt(rateE4), 1_000_000n);
}

/** Convert satang to a JS number of major units — ONLY for estimates/projections and charts. */
export function toMajorNumber(v: Satang): number { return Number(v) / 100; }

/** Convert an estimate in major units back to satang (rounded). */
export function fromMajorNumber(n: number): Satang {
  if (!Number.isFinite(n)) throw new RangeError('non-finite amount');
  return BigInt(Math.round(n * 100));
}

/** Ratio a/b as a JS number (for percentages / display). Returns 0 when b == 0. */
export function ratio(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  return Number(a * 1_000_000n / b) / 1_000_000;
}
