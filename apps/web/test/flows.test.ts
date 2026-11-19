import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, Client, options } from './helpers.ts';
import { queryCounter } from '../src/db/index.ts';
import { runJobs } from '../src/jobs/scheduler.ts';
import { _test as csv } from '../src/routes/transactions.ts';
import { registry } from '../src/services/plugins.ts';
import { _resetRefreshCooldown } from '../src/services/fx.ts';

/** WCAG 1.3.1: every visible form control needs a label (for=id, wrapping <label> or aria-label). */
export function unlabeled(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<(input|select|textarea)([^>]*)>/g)) {
    const attrs = m[2];
    if (/type="(hidden|submit|button)"/.test(attrs) || /aria-label="/.test(attrs)) continue;
    const id = /id="([^"]+)"/.exec(attrs)?.[1];
    if (id && html.includes(`for="${id}"`)) continue;
    const before = html.slice(0, m.index);
    if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;
    out.push(m[0].slice(0, 80));
  }
  return out;
}

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const PAGES = ['/', '/analytics', '/analytics?range=12m', '/transactions', '/transactions/new', '/accounts', '/categories', '/debts', '/debts/plan', '/goals', '/emergency', '/budget', '/recurring',
  '/household', '/reports', '/reports/year', '/reports/debt', '/reports/health', '/reports/tax', '/settings', '/settings/colors', '/settings/security', '/notifications', '/more', '/transactions/import',
  '/calculator', '/calculator?q=1%2B', '/calculator/loan', '/calculator/savings', '/calculator/tax', '/calculator/split',
  '/currency', '/currency?amount=100&from=USD&to=THB'];

async function setup(email: string, mode: 'off' | 'partial' | 'full', invest: boolean) {
  const c = new Client(app.base);
  await c.register(email);
  await c.post('/onboarding/income', { income: '50000', start_day: '1' }, '/onboarding');
  await c.post('/onboarding/accounts', { name: 'Bank', type: 'savings', opening: '100000' }, '/onboarding?step=1');
  await c.post('/onboarding/accounts', { name: 'Cash', type: 'cash', opening: '2000' }, '/onboarding?step=1');
  await c.post('/onboarding/debts', { name: 'Card', type: 'credit_card', method: 'reducing', balance: '30000', rate: '16', payment: '2000' }, '/onboarding?step=2');
  await c.post('/onboarding/debts', { name: 'Car', type: 'auto', method: 'flat', balance: '300000', rate: '3', payment: '7500' }, '/onboarding?step=2');
  await c.post('/onboarding/buckets', { mode, template: mode === 'off' ? '' : mode === 'full' ? '50_30_20' : 'save_emergency_invest' }, '/onboarding?step=3');
  await c.post('/onboarding/invest', { invest: invest ? 'yes' : 'no' }, '/onboarding?step=4');
  return c;
}

test('full user journey: every page renders, money adds up', async () => {
  const c = await setup('journey@hearth.test', 'partial', true);
  const form = (await c.get('/transactions/new')).text;
  const acc = options(form, 'account_id');
  const cats = options(form, 'category_id');
  const bank = acc.find((a) => a.label === 'Bank')!.value;
  const cash = acc.find((a) => a.label === 'Cash')!.value;
  const salary = cats.find((x) => x.label.includes('Salary'))!.value;
  const food = cats.find((x) => x.label.includes('Daily meals'))!.value;

  assert.equal((await c.post('/transactions', { kind: 'income', amount: '50000', date: '2026-11-01', account_id: bank, category_id: salary, payee: 'ACME' }, '/transactions/new')).status, 303);
  await c.post('/transactions', { kind: 'expense', amount: '120.50', date: '2026-11-02', account_id: cash, category_id: food, payee: 'Noodles', note: 'lunch', tags: 'food' }, '/transactions/new');
  await c.post('/transactions', { kind: 'transfer', amount: '1000', date: '2026-11-03', account_id: bank, to_account_id: cash }, '/transactions/new');

  // balances: Bank 100000 + 50000 − 1000 = 149000; Cash 2000 − 120.50 + 1000 = 2879.50
  const accounts = (await c.get('/accounts')).text;
  assert.match(accounts, /149,000\.00/);
  assert.match(accounts, /2,879\.50/);

  // partial mode + template: income was auto-allocated 10% to three buckets
  const buckets = (await c.get('/buckets')).text;
  assert.equal((buckets.match(/5,000\.00/g) ?? []).length >= 3, true, 'each bucket received 10% of 50,000');

  for (const p of [...PAGES, '/buckets', '/invest', '/invest/plan', '/invest/allocation']) {
    const r = await c.get(p);
    assert.equal(r.status, 200, `${p} -> ${r.status}`);
    assert.deepEqual(unlabeled(r.text), [], `unlabelled form controls on ${p}`);
  }

  // debt payment with automatic split + what-if + schedule
  const debtId = /href="\/debts\/([0-9a-f-]{36})"/.exec((await c.get('/debts')).text)![1];
  assert.equal((await c.post(`/debts/${debtId}/payments`, { amount: '2000', date: '2026-11-15', account_id: bank }, `/debts/${debtId}`)).status, 303);
  const debtPage = await c.get(`/debts/${debtId}?extra=1000`);
  assert.equal(debtPage.status, 200);
  assert.match(debtPage.text, /sooner|เร็วขึ้น/);

  // goal with contributions, emergency deposit, budget line, recurring rule
  await c.post('/goals', { name: 'Trip', target: '30000', target_date: '2027-06-01' }, '/goals');
  const goalId = /href="\/goals\/([0-9a-f-]{36})"/.exec((await c.get('/goals')).text)![1];
  await c.post(`/goals/${goalId}/contribute`, { amount: '5000', date: '2026-11-05' }, `/goals/${goalId}`);
  assert.equal((await c.get(`/goals/${goalId}`)).status, 200);
  await c.post('/emergency/events', { direction: 'deposit', amount: '20000', date: '2026-11-05' }, '/emergency');
  assert.equal((await c.post('/emergency/events', { direction: 'withdraw', amount: '100', date: '2026-11-06' }, '/emergency')).location, '/emergency?err=reason_required');
  await c.post('/budget', { category_id: food, amount: '100', period: 'monthly', month: '2026-11' }, '/budget');
  await c.post('/recurring', { name: 'Rent', kind: 'expense', amount: '8000', account_id: bank, frequency: 'monthly', interval: '1', next_date: '2026-11-20', auto: '1' }, '/recurring');

  // investments: asset, buy, price, holdings P/L
  const pf = await c.post('/invest/portfolios', { name: 'Funds', kind: 'fund', visibility: 'private' }, '/invest');
  assert.equal(pf.status, 303);
  const pfId = /href="\/invest\/portfolios\/([0-9a-f-]{36})"/.exec((await c.get('/invest')).text)![1];
  await c.post('/invest/assets', { symbol: 'TESTFUND', name: 'Test fund', asset_class: 'mutual_fund', currency: 'THB', back: `/invest/portfolios/${pfId}` }, `/invest/portfolios/${pfId}`);
  const pfPage = (await c.get(`/invest/portfolios/${pfId}`)).text;
  const assetId = options(pfPage, 'asset_id')[0].value;
  await c.post(`/invest/portfolios/${pfId}/txns`, { type: 'buy', asset_id: assetId, date: '2026-10-01', units: '100', amount: '1000', fee: '0' }, `/invest/portfolios/${pfId}`);
  await c.post('/invest/prices', { asset_id: assetId, price: '12.5', date: '2026-11-10', back: `/invest/portfolios/${pfId}` }, `/invest/portfolios/${pfId}`);
  const holdings = (await c.get(`/invest/portfolios/${pfId}`)).text;
  assert.match(holdings, /1,250\.00/); // 100 units × 12.50
  assert.match(holdings, /\+[^<]*250\.00/); // unrealised gain

  // jobs: recurring auto-post, budget alert, snapshots — run twice to check idempotency
  await runJobs(app.db, '2026-11-20');
  await runJobs(app.db, '2026-11-20');
  const tx = (await c.get('/transactions')).text;
  assert.equal((tx.match(/>Rent</g) ?? []).length, 1, 'recurring rent posted exactly once');
  const noti = (await c.get('/notifications')).text;
  assert.match(noti, /budget|งบ/i);

  // dashboard after everything
  const dash = await c.get('/');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Net worth|ความมั่งคั่งสุทธิ/);
});

test('FR-BKT-00a / FR-INV-01: modules that are off are completely hidden', async () => {
  const c = await setup('minimal@hearth.test', 'off', false);
  assert.equal((await c.get('/buckets')).status, 404);
  assert.equal((await c.get('/invest')).status, 404);
  const form = (await c.get('/transactions/new')).text;
  assert.doesNotMatch(form, /name="bucket_id"/, 'no bucket field when buckets are off');
  const dash = (await c.get('/')).text;
  assert.doesNotMatch(dash, /href="\/buckets"/);
  assert.doesNotMatch(dash, /href="\/invest"/);
  assert.doesNotMatch(dash, /To be allocated|ยังไม่จัดสรร/);
  // switching buckets on and off never deletes data (FR-BKT-00b)
  await c.post('/settings/modules', { bucket_mode: 'partial', investment: 'off' }, '/settings');
  await c.post('/buckets', { name: 'Keep me', type: 'savings' }, '/buckets');
  await c.post('/settings/modules', { bucket_mode: 'off', investment: 'off' }, '/settings');
  const archived = await app.db.system((q) => q.query<any>(`select archived from buckets where name = 'Keep me'`));
  assert.equal(archived[0].archived, true);
  await c.post('/settings/modules', { bucket_mode: 'full', investment: 'off' }, '/settings');
  assert.match((await c.get('/buckets')).text, /Keep me/);
});

test('households: invite, shared items, viewer is read-only, leave keeps data', async () => {
  const owner = await setup('owner@hearth.test', 'off', false);
  await owner.post('/household', { name: 'Home', display_name: 'Dad' }, '/household');
  const inv = await owner.post(`/household/${/action="\/household\/([0-9a-f-]{36})\/invite"/.exec((await owner.get('/household')).text)![1]}/invite`, { role: 'member' }, '/household');
  const token = /invite=([\w-]+)/.exec(inv.location!)![1];
  const member = await setup('member@hearth.test', 'off', false);
  await member.post('/household/join', { token, display_name: 'Mom' }, `/household/join?token=${token}`);
  const hh = (await member.get('/household')).text;
  assert.match(hh, /Dad/);
  assert.match(hh, /Mom/);
  // owner shares a debt with the household (full visibility)
  const hhId = /action="\/household\/([0-9a-f-]{36})\/invite"/.exec((await owner.get('/household')).text)![1];
  await owner.post('/debts', { name: 'Owner private loan', type: 'personal_loan', method: 'reducing', balance: '5000', rate: '10', payment: '500' }, '/debts');
  await owner.post('/debts', { name: 'Family mortgage', type: 'mortgage', method: 'reducing', balance: '1000000', rate: '6', payment: '7000', household_id: hhId, visibility: 'full' }, '/debts');
  const seen = (await member.get('/debts')).text;
  assert.match(seen, /Family mortgage/);
  // private items stay private
  assert.doesNotMatch(seen, /Owner private loan/);
  // member leaves; the shared debt stays with its owner
  await member.post(`/household/${hhId}/leave`, {}, '/household');
  assert.doesNotMatch((await member.get('/debts')).text, /Family mortgage/);
  assert.match((await owner.get('/debts')).text, /Family mortgage/);
});

test('NFR-PERF-21: transaction list query count does not grow with data (no N+1)', async () => {
  const c = await setup('perf@hearth.test', 'partial', false);
  const acc = options((await c.get('/transactions/new')).text, 'account_id')[0].value;
  const measure = async (path: string) => {
    const t0 = Date.now();
    const r = await c.get(path);
    const q = Number(/queries=(\d+)/.exec(r.headers.get('server-timing') ?? '')?.[1] ?? NaN);
    return { status: r.status, ms: Date.now() - t0, q };
  };
  const tok = await c.csrf('/transactions/new');
  const add = async (n: number) => { for (let i = 0; i < n; i++) await c.req('POST', '/transactions', { _csrf: tok, kind: 'expense', amount: String(10 + i), date: '2026-11-01', account_id: acc, payee: `shop ${i}` }); };
  await add(3);
  const small = { list: await measure('/transactions'), dash: await measure('/') };
  await add(60);
  const big = { list: await measure('/transactions'), dash: await measure('/') };
  assert.equal(big.list.status, 200);
  assert.ok(Number.isFinite(small.list.q) && small.list.q > 0);
  assert.equal(big.list.q, small.list.q, `transactions: ${small.list.q} vs ${big.list.q} queries`);
  assert.equal(big.dash.q, small.dash.q, `dashboard: ${small.dash.q} vs ${big.dash.q} queries`);
  assert.ok(big.list.ms < 1500, `list rendered in ${big.list.ms} ms`);
  void queryCounter;
});

test('colours & theme: presets and custom colours apply to every page, reset restores the default', async () => {
  const c = new Client(app.base);
  await c.register('colors@hearth.test');
  const view = async (path = '/settings/colors') => { const r = await c.get(path); assert.equal(r.status, 200, path); return r.text; };
  assert.doesNotMatch(await view(), /:root{--primary:#/, 'default palette adds no CSS');

  let r = await c.post('/settings/colors', { action: 'preset', preset: 'ocean', primary: '#000000' }, '/settings/colors');
  assert.equal(r.status, 303);
  let page = await view('/settings');
  assert.match(page, /:root\{--primary:#3c6e91;/, 'preset ignores leftover custom inputs');
  assert.match(page, /:root\[data-theme=dark\]\{--primary:#/, 'dark-mode variant is emitted');

  r = await c.post('/settings/colors', { action: 'custom', preset: 'ocean', primary: '#AA2233', heat: 'red;}body{x', c1: '#123456' }, '/settings/colors');
  assert.equal(r.status, 303);
  page = await view('/settings');
  assert.match(page, /--primary:#aa2233/);
  assert.match(page, /--s0:#/);
  assert.doesNotMatch(page, /body\{x/, 'invalid values are dropped, never injected');
  assert.match(await view(), /name="primary" value="#aa2233"/);

  r = await c.post('/settings/colors/reset', {}, '/settings/colors');
  assert.equal(r.status, 303);
  assert.doesNotMatch(await view(), /:root{--primary:#/);
});

test('calculator: works without JavaScript and hands results to a new transaction', async () => {
  const c = await setup('calc@hearth.test', 'off', false);
  const text = async (path: string) => { const r = await c.get(path); assert.equal(r.status, 200, path); return r.text; };

  let page = await text(`/calculator?q=${encodeURIComponent('2,500*12 + 7%')}`);
  assert.match(page, /data-calc-out>32,100</);
  assert.match(page, /href="\/transactions\/new\?amount=32100\.00"/);
  page = await text(`/calculator?q=${encodeURIComponent('1/0')}`);
  assert.match(page, /role="alert" data-calc-err>[^<]+</, 'errors are explained');
  assert.match(page, /<script[^>]+calc\.[\w-]+\.js/, 'calc.js is loaded');

  assert.match(await text('/calculator/loan?principal=500000&rate=6.5&months=60&method=reducing'), /9,783\.08/);
  assert.match(await text('/calculator/loan?principal=600000&rate=2.79&months=72&method=flat'), /9,728\.33/);
  assert.match(await text('/calculator/loan?principal=abc&rate=6.5&months=60'), /class="flash err"/);
  const tax = await text('/calculator/tax?amount=1605&mode=inclusive&vat=7&wht=3');
  assert.match(tax, /1,500\.00/);
  assert.match(tax, /105\.00/);
  assert.match(tax, /1,560\.00/, '1,605 − 3% of 1,500');
  assert.match(await text('/calculator/split?total=3450&people=4&service=10'), /948\.75/);
  assert.match(await text('/calculator/savings?target=120000&months=18&rate=2&start='), /6,572\.73/);

  assert.match(await text('/transactions/new?amount=165.50'), /name="amount"[^>]*value="165\.50"/);
  assert.doesNotMatch(await text('/transactions/new?amount=%22%3E%3Cscript%3E'), /value="&quot;/, 'only plain amounts are prefilled');
  assert.match(await text('/transactions/new'), /name="amount"[^>]*data-calc/, 'amount fields accept maths');
});

test('exchange rates: personal rates, converter, update now, privacy and calculator names', async () => {
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10); // Asia/Bangkok, like the app
  const a = await setup('fx-a@hearth.test', 'off', false);
  const b = await setup('fx-b@hearth.test', 'off', false);
  const text = async (c: Client, path: string) => { const r = await c.get(path); assert.equal(r.status, 200, path); return r.text; };
  const uid = async (email: string) => (await app.db.system((q) => q.one<{ id: string }>('select id from users where email = $1', [email])))!.id;

  // no rate yet: say so instead of silently converting 1:1
  assert.equal((await a.post('/currency/watch', { cur: 'USD', op: 'add' }, '/currency')).status, 303);
  let page = await text(a, '/currency?amount=100&from=USD&to=THB');
  assert.match(page, /No rate yet/);
  assert.match(page, /class="flash warn" role="alert">No exchange rate for USD/);
  assert.match(page, /Automatic rate updates are off/);

  // my own rate drives the converter, the calculator and hearth_fx (net worth, new transactions)
  assert.equal((await a.post('/currency/rate', { cur: 'USD', rate: '35.5', date: today }, '/currency')).status, 303);
  assert.match(await text(a, '/currency?amount=100&from=USD&to=THB'), /3,550\.00 THB/);
  assert.match(await text(a, '/currency?amount=3550&from=THB&to=USD'), /100\.00 USD/);
  assert.match(await text(a, `/calculator?q=${encodeURIComponent('100*usd')}`), /data-calc-out>3,550</);
  const fxOf = async (email: string) => Number((await app.db.asUser(await uid(email), (q) => q.one<{ r: string }>(`select hearth_fx('USD', 'THB')::text r`)))!.r);
  assert.equal(await fxOf('fx-a@hearth.test'), 35.5);
  assert.equal(await fxOf('fx-b@hearth.test'), 1, 'nobody else sees my rate');

  // "update now" through the FX plugin (fake provider: no network in tests)
  registry.fx.set('test-fx', { id: 'test-fx', name: 'Test FX', fetchRates: async (_base, quotes) => Object.fromEntries(quotes.map((q) => [q, q === 'USD' ? 1 / 36 : 0.5])) });
  try {
    _resetRefreshCooldown();
    let r = await a.post('/currency/refresh', {}, '/currency');
    assert.match(r.location ?? '', /ok=fx_updated/);
    r = await a.post('/currency/refresh', {}, '/currency');
    assert.match(r.location ?? '', /err=fx_recent/, 'cooled down');
    assert.equal(await fxOf('fx-a@hearth.test'), 35.5, 'same day: my own rate still wins');
    assert.equal(await fxOf('fx-b@hearth.test'), 36, 'reference rate is shared');
    assert.equal((await a.post('/currency/rate/delete', { cur: 'USD', date: today }, '/currency')).status, 303);
    assert.equal(await fxOf('fx-a@hearth.test'), 36);
    page = await text(a, '/currency?amount=100&from=USD&to=THB');
    assert.match(page, /3,600\.00 THB/);
    assert.match(page, /Test FX/);
    assert.match(page, /Update rates now/);
  } finally { registry.fx.delete('test-fx'); _resetRefreshCooldown(); }

  // bad input is refused; watch-list removal works
  const refused = async (path: string, body: Record<string, string>) => assert.match((await a.post(path, body, '/currency')).location ?? '', /err=invalid/, path);
  await refused('/currency/rate', { cur: 'usd;', rate: '35' });
  await refused('/currency/rate', { cur: 'USD', rate: '-1' });
  await refused('/currency/watch', { cur: 'THB', op: 'add' }); // the main currency is not a foreign currency
  assert.equal(await fxOf('fx-a@hearth.test'), 36, 'refused input changed nothing');
  assert.equal((await a.post('/currency/watch', { cur: 'USD', op: 'remove' }, '/currency')).status, 303);
  assert.match(await text(a, '/currency'), /Your accounts all use your main currency/);
  void b;
});

test('CSV parsing handles quotes, BOM, semicolons and Buddhist-era dates', () => {
  assert.deepEqual(csv.parseCsv('﻿a,b\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.deepEqual(csv.parseCsv('a;b\r\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.equal(csv.normDate('15/11/2569'), '2026-11-15');
  assert.equal(csv.normDate('2026-11-15'), '2026-11-15');
  assert.equal(csv.normDate('31/02/2026'), null);
});
