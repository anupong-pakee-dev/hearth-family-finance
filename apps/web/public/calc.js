// Hearth — money calculator (Tools › Calculator).
// A small, safe expression language: its own tokenizer and parser, never eval/Function (CSP + safety).
// Shared by the server (no-JavaScript results) and the browser (live results, history, maths in amount fields).
//
//   2,500 * 12            thousands separators are fine outside function calls
//   1200 + 7%             percent of the left side: 1200 + 84 = 1284   (and 1200 - 10% = 1080)
//   50% * 300             a bare percent is a fraction: 150
//   installment(500000, 6.5, 60)       functions take commas or semicolons between arguments
//   rent = 8500           remember a value for later lines; `ans` is the last result

export class CalcError extends Error {
  constructor(code, detail = '') { super(detail ? `${code}: ${detail}` : code); this.code = code; this.detail = detail; }
}

const MAX_LEN = 500;
const MAX_DEPTH = 60;

const mrate = (pctYear) => pctYear / 100 / 12;
const need = (cond, code = 'args') => { if (!cond) throw new CalcError(code); };
const positive = (n) => Number.isFinite(n) && n > 0;

/** name → [minArgs, maxArgs, fn]. Rates are percent per year; terms are months unless the name says years. */
const FN = {
  // basics
  sqrt: [1, 1, (x) => { need(x >= 0, 'domain'); return Math.sqrt(x); }],
  abs: [1, 1, Math.abs],
  round: [1, 2, (x, d = 0) => { need(Number.isInteger(d) && d >= -6 && d <= 10); const k = 10 ** d; return Math.round((x + Math.sign(x) * Number.EPSILON) * k) / k; }],
  floor: [1, 1, Math.floor],
  ceil: [1, 1, Math.ceil],
  min: [1, 100, Math.min],
  max: [1, 100, Math.max],
  sum: [1, 100, (...a) => a.reduce((s, v) => s + v, 0)],
  avg: [1, 100, (...a) => a.reduce((s, v) => s + v, 0) / a.length],
  pow: [2, 2, Math.pow],
  ln: [1, 1, (x) => { need(x > 0, 'domain'); return Math.log(x); }],
  log: [1, 1, (x) => { need(x > 0, 'domain'); return Math.log10(x); }],
  exp: [1, 1, Math.exp],
  // percentages and prices
  pct: [2, 2, (part, whole) => { need(whole !== 0, 'div0'); return (part / whole) * 100; }],
  change: [2, 2, (from, to) => { need(from !== 0, 'div0'); return ((to - from) / Math.abs(from)) * 100; }],
  discount: [2, 2, (price, p) => price * (1 - p / 100)],
  markup: [2, 2, (cost, p) => cost * (1 + p / 100)],
  // Thai VAT (7%) and withholding tax
  vat: [1, 2, (x, rate = 7) => (x * rate) / 100],
  withvat: [1, 2, (x, rate = 7) => x * (1 + rate / 100)],
  exvat: [1, 2, (x, rate = 7) => x / (1 + rate / 100)],
  wht: [1, 2, (x, rate = 3) => (x * rate) / 100],
  // loans
  installment: [3, 3, (principal, rate, months) => {
    need(positive(months) && rate >= 0);
    const r = mrate(rate);
    return r === 0 ? principal / months : (principal * r) / (1 - (1 + r) ** -months);
  }],
  flatinstallment: [3, 3, (principal, rate, months) => {
    need(positive(months) && rate >= 0);
    return (principal + (principal * rate * months) / 1200) / months;
  }],
  interest: [3, 3, (principal, rate, months) => FN.installment[2](principal, rate, months) * months - principal],
  nper: [3, 3, (payment, rate, principal) => {
    need(positive(payment) && rate >= 0);
    const r = mrate(rate);
    if (r === 0) return Math.ceil(principal / payment);
    need(payment > principal * r, 'never');
    return Math.ceil(-Math.log(1 - (principal * r) / payment) / Math.log(1 + r));
  }],
  // saving and growth
  fv: [3, 4, (monthly, rate, months, start = 0) => {
    need(months >= 0 && rate >= 0);
    const r = mrate(rate);
    return r === 0 ? start + monthly * months : start * (1 + r) ** months + (monthly * ((1 + r) ** months - 1)) / r;
  }],
  pv: [3, 3, (payment, rate, months) => {
    need(positive(months) && rate >= 0);
    const r = mrate(rate);
    return r === 0 ? payment * months : (payment * (1 - (1 + r) ** -months)) / r;
  }],
  saving: [3, 4, (target, rate, months, start = 0) => {
    need(positive(months) && rate >= 0);
    const r = mrate(rate);
    const grown = start * (1 + r) ** months;
    const m = r === 0 ? (target - start) / months : ((target - grown) * r) / ((1 + r) ** months - 1);
    return Math.max(0, m);
  }],
  compound: [3, 4, (principal, rate, years, timesPerYear = 1) => {
    need(years >= 0 && positive(timesPerYear) && rate >= 0);
    return principal * (1 + rate / 100 / timesPerYear) ** (timesPerYear * years);
  }],
  // sharing
  split: [2, 3, (total, people, servicePct = 0) => { need(Number.isInteger(people) && people > 0); return (total * (1 + servicePct / 100)) / people; }],
};

const CONSTS = { pi: Math.PI, e: Math.E };

/** Function reference for the help panel: [group, [name, args, example]]. Descriptions live in i18n (`calc.fn.<name>`). */
export const FUNCTION_GROUPS = [
  ['loan', [['installment', 'principal; rate%; months', 'installment(500000; 6.5; 60)'], ['flatinstallment', 'principal; rate%; months', 'flatinstallment(600000; 2.79; 72)'], ['interest', 'principal; rate%; months', 'interest(500000; 6.5; 60)'], ['nper', 'payment; rate%; principal', 'nper(5000; 16; 40000)']]],
  ['saving', [['saving', 'target; rate%; months; [start]', 'saving(120000; 2; 18)'], ['fv', 'monthly; rate%; months; [start]', 'fv(3000; 4; 120)'], ['pv', 'payment; rate%; months', 'pv(10000; 5; 240)'], ['compound', 'principal; rate%; years; [times/yr]', 'compound(100000; 3.5; 10; 12)']]],
  ['tax', [['vat', 'amount; [rate%]', 'vat(1500)'], ['withvat', 'amount; [rate%]', 'withvat(1500)'], ['exvat', 'amount; [rate%]', 'exvat(1605)'], ['wht', 'amount; [rate%]', 'wht(20000; 3)']]],
  ['price', [['pct', 'part; whole', 'pct(8500; 52000)'], ['change', 'from; to', 'change(38000; 33550)'], ['discount', 'price; %', 'discount(2990; 15)'], ['markup', 'cost; %', 'markup(120; 30)'], ['split', 'total; people; [service%]', 'split(3450; 4; 10)']]],
  ['basic', [['round', 'x; [digits]', 'round(1234.567; 2)'], ['sum', 'a; b; …', 'sum(1200; 450; 89)'], ['avg', 'a; b; …', 'avg(41000; 38000; 36000)'], ['min', 'a; b; …', 'min(3; 7)'], ['max', 'a; b; …', 'max(3; 7)'], ['sqrt', 'x', 'sqrt(144)'], ['pow', 'x; y', 'pow(1.05; 10)'], ['abs', 'x', 'abs(-250)'], ['floor', 'x', 'floor(9.9)'], ['ceil', 'x', 'ceil(9.1)'], ['ln', 'x', 'ln(2)'], ['log', 'x', 'log(1000)'], ['exp', 'x', 'exp(1)']]],
];

const THAI_DIGITS = /[๐-๙]/g;

function tokenize(src) {
  const s = src.replace(THAI_DIGITS, (d) => String(d.charCodeAt(0) - 0x0e50)).replace(/[×✕]/g, '*').replace(/[÷]/g, '/').replace(/[−–]/g, '-').replace(/[，]/g, ',');
  const out = [];
  const parens = []; // true = opened by a function call (commas separate arguments there)
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const inCall = parens.length > 0 && parens[parens.length - 1];
      const re = inCall ? /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/ : /^(\d{1,3}(,\d{3})+(\.\d*)?|\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;
      const m = re.exec(s.slice(i));
      if (!m) throw new CalcError('syntax', c);
      const v = Number(m[0].replace(/,/g, ''));
      if (!Number.isFinite(v)) throw new CalcError('syntax', m[0]);
      out.push({ t: 'num', v });
      i += m[0].length;
      continue;
    }
    const id = /^[A-Za-z_฀-๿][A-Za-z0-9_฀-๿]*/.exec(s.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    if ('+-*/^%()=,;'.includes(c)) {
      if (c === '(') parens.push(out.length > 0 && out[out.length - 1].t === 'id');
      if (c === ')') parens.pop();
      out.push({ t: 'op', v: c === ';' ? ',' : c });
      i++;
      continue;
    }
    throw new CalcError('syntax', c);
  }
  return out;
}

/** Number tidy-up: hide binary floating-point noise such as 0.1 + 0.2 = 0.30000000000000004. */
export function tidy(n) { return n === 0 ? 0 : Number.parseFloat(n.toPrecision(12)); }

/**
 * Evaluate one line. `env` holds remembered names (and `ans`); a line like `rent = 8500` assigns.
 * Returns { value, name? }. Throws CalcError with code: empty, syntax, unknown, args, div0, domain, never, too_long, too_complex, invalid.
 */
export function evaluate(src, env = {}) {
  const text = String(src ?? '').trim();
  if (!text) throw new CalcError('empty');
  if (text.length > MAX_LEN) throw new CalcError('too_long');
  const tokens = tokenize(text);
  let i = 0;
  let depth = 0;
  const peek = () => tokens[i];
  const isOp = (v) => tokens[i]?.t === 'op' && tokens[i].v === v;
  const expect = (v) => { if (!isOp(v)) throw new CalcError('syntax', v); i++; };

  function expr() {
    if (++depth > MAX_DEPTH) throw new CalcError('too_complex');
    let left = term().v;
    while (isOp('+') || isOp('-')) {
      const op = tokens[i++].v;
      const r = term();
      const rv = r.pct ? left * r.v : r.v; // 1200 + 7%  →  1200 + 1200 × 0.07
      left = op === '+' ? left + rv : left - rv;
    }
    depth--;
    return left;
  }
  function term() {
    let f = unary();
    let v = f.v, pct = f.pct;
    while (isOp('*') || isOp('/')) {
      const op = tokens[i++].v;
      const r = unary().v;
      if (op === '/') { if (r === 0) throw new CalcError('div0'); v /= r; } else v *= r;
      pct = false;
    }
    return { v, pct };
  }
  function unary() {
    if (isOp('-') || isOp('+')) { const op = tokens[i++].v; const u = unary(); return { v: op === '-' ? -u.v : u.v, pct: u.pct }; }
    return power();
  }
  function power() {
    const b = postfix();
    if (isOp('^')) { i++; const e = unary(); return { v: b.v ** e.v, pct: false }; }
    return b;
  }
  function postfix() {
    let v = primary();
    let pct = false;
    while (isOp('%')) { i++; v /= 100; pct = true; }
    return { v, pct };
  }
  function primary() {
    const t = tokens[i++];
    if (!t) throw new CalcError('syntax');
    if (t.t === 'num') return t.v;
    if (t.t === 'op' && t.v === '(') { const v = expr(); expect(')'); return v; }
    if (t.t === 'id') {
      const name = t.v.toLowerCase();
      if (isOp('(')) {
        i++;
        const args = [];
        if (!isOp(')')) { args.push(expr()); while (isOp(',')) { i++; args.push(expr()); } }
        expect(')');
        const fn = Object.hasOwn(FN, name) ? FN[name] : null;
        if (!fn) throw new CalcError('unknown', t.v);
        if (args.length < fn[0] || args.length > fn[1]) throw new CalcError('args', t.v);
        return fn[2](...args);
      }
      if (Object.hasOwn(CONSTS, name)) return CONSTS[name];
      if (Object.hasOwn(env, name)) return env[name];
      throw new CalcError('unknown', t.v);
    }
    throw new CalcError('syntax', t.v);
  }

  let name;
  if (tokens.length > 2 && tokens[0].t === 'id' && tokens[1].t === 'op' && tokens[1].v === '=') {
    name = tokens[0].v.toLowerCase();
    if (Object.hasOwn(FN, name) || Object.hasOwn(CONSTS, name) || name === 'ans') throw new CalcError('reserved', tokens[0].v);
    i = 2;
  }
  const value = expr();
  if (i !== tokens.length) throw new CalcError('syntax', String(tokens[i].v));
  if (!Number.isFinite(value)) throw new CalcError('invalid');
  const out = tidy(value);
  if (name) env[name] = out;
  env.ans = out;
  return name ? { value: out, name } : { value: out };
}

/** True when a field value looks like maths rather than a plain amount (so amount fields only touch real expressions). */
export function isExpression(s) { return /[-+*/^%()×÷]/.test(String(s).trim().replace(/^-/, '')); }

/** Display with thousands separators and up to `max` decimals (no trailing zeros). */
export function formatNumber(n, max = 6) { return n.toLocaleString('en-US', { maximumFractionDigits: max }); }

// ── Browser ─────────────────────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  // 1) Amount fields: type 120+45 or 1500*3 and it becomes 165.00 / 4500.00 when you leave the field or press Enter.
  const settle = (el) => {
    if (!isExpression(el.value)) return;
    try {
      const v = evaluate(el.value).value;
      el.value = (Math.round(v * 100) / 100).toFixed(2);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch { /* leave it; the field's own validation explains */ }
  };
  document.addEventListener('focusout', (e) => { const t = e.target; if (t instanceof HTMLInputElement && t.hasAttribute('data-calc')) settle(t); });
  document.addEventListener('keydown', (e) => { const t = e.target; if (e.key === 'Enter' && t instanceof HTMLInputElement && t.hasAttribute('data-calc')) settle(t); }, true);

  // 2) Calculator page: live result, keypad, history, remembered names.
  const form = document.querySelector('form[data-calc-page]');
  if (form) {
    const input = form.querySelector('[data-calc-input]');
    const out = form.querySelector('[data-calc-out]');
    const err = form.querySelector('[data-calc-err]');
    const list = document.querySelector('[data-calc-history]');
    const useLink = document.querySelector('[data-calc-use]');
    const msg = (code) => form.dataset[`err${code.replace(/(^|_)(\w)/g, (_, __, ch) => ch.toUpperCase())}`] ?? form.dataset.errSyntax;
    form.querySelector('[data-calc-keys]')?.removeAttribute('hidden'); // keypad and history need JavaScript
    document.querySelector('[data-calc-side]')?.removeAttribute('hidden');
    const KEY = 'hearth.calc.history';
    const env = {};
    let history = [];
    try { history = JSON.parse(sessionStorage.getItem(KEY) ?? '[]').slice(0, 30); } catch { history = []; }
    try { for (const h of history.slice().reverse()) evaluate(h.expr, env); } catch { /* old entries may no longer parse */ }

    const show = (value) => {
      out.textContent = value == null ? '' : formatNumber(value);
      if (useLink) {
        useLink.hidden = value == null || value === 0;
        if (value != null) useLink.href = `/transactions/new?amount=${(Math.round(Math.abs(value) * 100) / 100).toFixed(2)}`;
      }
    };
    const render = () => {
      if (!list) return;
      list.replaceChildren(...history.map((h) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'calc-hist';
        const ex = document.createElement('span'); ex.textContent = h.expr;
        const val = document.createElement('strong'); val.textContent = (h.name ? `${h.name} = ` : '') + formatNumber(h.value);
        b.append(ex, val);
        b.addEventListener('click', () => { input.value = h.expr; input.focus(); live(); });
        li.append(b);
        return li;
      }));
    };
    const live = () => {
      err.textContent = '';
      try { show(evaluate(input.value, { ...env }).value); } catch { show(null); }
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      try {
        const r = evaluate(input.value, env);
        history.unshift({ expr: input.value.trim(), value: r.value, name: r.name });
        history = history.slice(0, 30);
        try { sessionStorage.setItem(KEY, JSON.stringify(history)); } catch { /* private mode */ }
        render();
        show(r.value);
        input.select();
      } catch (ex) {
        err.textContent = msg(ex instanceof CalcError ? ex.code : 'syntax');
      }
    });
    input.addEventListener('input', live);
    form.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => {
      const k = b.getAttribute('data-key');
      if (k === 'C') input.value = '';
      else if (k === '⌫') input.value = input.value.slice(0, -1);
      else if (k === '=') { form.requestSubmit(); return; }
      else input.value += k;
      input.focus();
      live();
    }));
    document.querySelectorAll('[data-calc-example]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      input.value = a.getAttribute('data-calc-example');
      input.focus();
      live();
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }));
    document.querySelector('[data-calc-clear]')?.addEventListener('click', () => {
      history = [];
      try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
      for (const k of Object.keys(env)) delete env[k];
      render();
    });
    render();
    live();
  }
}
