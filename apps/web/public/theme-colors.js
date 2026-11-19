// Hearth — user colour palettes (Settings › Colours & theme).
// Shared by the server (builds the CSS variables for every page) and the browser (live preview on /settings/colors).
// Whatever colour a person picks, text and chart marks are nudged lighter/darker until they stay readable
// (WCAG: 4.5:1 for text, 3:1 for graphics) in both light and dark mode.

/** Palette slots. `cN` slots feed the chart series --s0..--s4 (biggest category first). */
export const SLOTS = ['primary', 'inc', 'exp', 'heat', 'c1', 'c2', 'c3', 'c4', 'c5'];

/** The first preset is the default and must match app.css exactly. */
export const PRESETS = [
  { id: 'sage', primary: '#2f6f62', inc: '#2f6f62', exp: '#d07a5a', heat: '#d07a5a', c1: '#2f6f62', c2: '#8fb8ac', c3: '#d98a6c', c4: '#c9a54e', c5: '#5b7fa6' },
  { id: 'ocean', primary: '#3c6e91', inc: '#2e7d6b', exp: '#c2573a', heat: '#4f86b5', c1: '#3c6e91', c2: '#7fb0d3', c3: '#e3a15b', c4: '#5ba58c', c5: '#9aa6b2' },
  { id: 'clay', primary: '#7a6a4f', inc: '#5e8a5a', exp: '#b4532f', heat: '#c0613e', c1: '#7a6a4f', c2: '#c9a54e', c3: '#c0613e', c4: '#8fa86b', c5: '#b7a58c' },
  { id: 'lavender', primary: '#6b5b95', inc: '#3e8573', exp: '#b5506a', heat: '#8e78c2', c1: '#6b5b95', c2: '#a99bd1', c3: '#e39a7c', c4: '#6fae9c', c5: '#b3a9a0' },
  { id: 'cvd', primary: '#0072b2', inc: '#0072b2', exp: '#d55e00', heat: '#e69f00', c1: '#0072b2', c2: '#e69f00', c3: '#009e73', c4: '#cc79a7', c5: '#56b4e9' },
];

const HEX = /^#[0-9a-f]{6}$/;
const LIGHT_SURFACE = '#ffffff';
const DARK_SURFACE = '#1e2422';

/** Keep only known slots with valid #rrggbb values (lower-cased) plus a known preset id. */
export function sanitize(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of SLOTS) {
    const v = typeof input[k] === 'string' ? input[k].trim().toLowerCase() : '';
    if (HEX.test(v)) out[k] = v;
  }
  if (PRESETS.some((p) => p.id === input.preset)) out.preset = input.preset;
  return out;
}

/** Stored form: `{}` when it equals the default palette, otherwise the preset id plus every slot. */
export function normalize(input) {
  const c = sanitize(input);
  const base = PRESETS.find((p) => p.id === c.preset) ?? PRESETS[0];
  const full = { preset: base.id };
  for (const k of SLOTS) full[k] = c[k] ?? base[k];
  return SLOTS.every((k) => full[k] === PRESETS[0][k]) ? {} : full;
}

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
const lum = (h) => { const c = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const readableOn = (bg) => (contrast('#ffffff', bg) >= contrast('#14201c', bg) ? '#ffffff' : '#14201c');
/** Move a colour toward white (dark mode) or black (light mode) until it reaches `target` contrast on `bg`. */
function ensure(c, bg, target, dark) {
  let out = c;
  for (let t = 0.05; contrast(out, bg) < target && t <= 1.0001; t += 0.05) out = mix(c, dark ? '#ffffff' : '#000000', t);
  return out;
}

/** CSS custom properties for one mode. Only slots present in `colors` are emitted, so app.css defaults stay in charge otherwise. */
export function themeVars(colors, dark) {
  const c = sanitize(colors);
  const s = dark ? DARK_SURFACE : LIGHT_SURFACE;
  const v = {};
  if (c.primary) {
    let p = dark ? ensure(c.primary, s, 4.5, true) : c.primary;
    // mid-tones (e.g. #777777) reach 4.5:1 with neither white nor dark text — shift the button colour itself
    if (contrast(readableOn(p), p) < 4.5) p = dark ? ensure(p, '#14201c', 4.5, true) : ensure(p, '#ffffff', 4.5, false);
    const soft = mix(s, p, dark ? 0.2 : 0.14);
    v['--primary'] = p;
    v['--primary-ink'] = readableOn(p);
    v['--primary-soft'] = soft;
    v['--primary-strong'] = ensure(p, soft, 4.5, dark);
  }
  if (c.inc) { v['--inc'] = ensure(c.inc, s, 3, dark); v['--inc-text'] = ensure(c.inc, s, 4.5, dark); }
  if (c.exp) { v['--exp'] = ensure(c.exp, s, 3, dark); v['--exp-text'] = ensure(c.exp, s, 4.5, dark); }
  if (c.heat) v['--heat'] = ensure(c.heat, s, 3, dark);
  ['c1', 'c2', 'c3', 'c4', 'c5'].forEach((k, i) => { if (c[k]) v[`--s${i}`] = ensure(c[k], s, 3, dark); });
  return v;
}

const decl = (vars) => Object.entries(vars).map(([k, val]) => `${k}:${val}`).join(';');

/** Full stylesheet (light, system-dark, forced-dark) mirroring app.css theme selectors; '' for the default palette. */
export function cssFor(colors) {
  const light = decl(themeVars(colors, false));
  if (!light) return '';
  const dark = decl(themeVars(colors, true));
  return `:root{${light}}@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${dark}}}:root[data-theme=dark]{${dark}}`;
}

// ── Browser: live preview on /settings/colors (progressive enhancement; the form works without it) ──
if (typeof document !== 'undefined') {
  const form = document.querySelector('form[data-colors]');
  if (form) {
    const root = document.documentElement;
    const isDark = () => root.dataset.theme === 'dark' || (root.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    const field = (k) => form.elements.namedItem(k);
    let applied = [];
    const apply = () => {
      const colors = {};
      for (const k of SLOTS) { const el = field(k); if (el && 'value' in el) colors[k] = el.value; }
      for (const k of applied) root.style.removeProperty(k);
      // the default palette is exactly app.css — show that rather than a recomputed approximation
      const vars = Object.keys(normalize(colors)).length ? themeVars(colors, isDark()) : {};
      for (const [k, val] of Object.entries(vars)) root.style.setProperty(k, val);
      applied = Object.keys(vars);
    };
    form.addEventListener('input', apply);
    form.addEventListener('change', (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.name === 'preset') {
        const p = PRESETS.find((x) => x.id === t.value);
        if (p) for (const k of SLOTS) { const el = field(k); if (el instanceof HTMLInputElement) el.value = p[k]; }
      }
      apply();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
  }
}
