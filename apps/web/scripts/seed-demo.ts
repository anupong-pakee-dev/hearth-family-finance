/**
 * Demo data (§6 "Demo instance"): a Thai family with accounts, 12 months of transactions, debts,
 * goals, buckets and an investment portfolio.
 *
 *   npm run seed:demo                      # family@hearth.test  (password below, development only)
 *   DEMO_TXNS=50000 npm run seed:demo      # NFR-PERF-02 load profile: 50k transactions, 10 debts, 50 assets
 */
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createUser } from '../src/services/users.ts';
import { createAccount, createTransaction, createDebt, applyBucketTemplate, setBucketMode, bucketMove } from '../src/services/finance.ts';
import { translator } from '../src/i18n/index.ts';
import { addMonths, todayIso, E8, annuityPayment } from '@hearth/engine';

const EMAIL = process.env.DEMO_EMAIL ?? 'family@hearth.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-hearth-family-2026'; // development/demo only
const LANG = (process.env.DEMO_LANG ?? 'th') as 'th' | 'en';
const N = Number(process.env.DEMO_TXNS ?? 0);

const db = await openDb();
await migrate(db);
const exists = await db.system((q) => q.one('select 1 from users where lower(email) = lower($1)', [EMAIL]));
if (exists) { console.log(`demo user ${EMAIL} already exists`); process.exit(0); }

const userId = await createUser(db, { email: EMAIL, password: PASSWORD, name: LANG === 'th' ? 'คุณสมชาย' : 'Somchai', lang: LANG, ip: '127.0.0.1' });
await db.system((q) => q.query('update users set email_verified_at = now() where id = $1', [userId]));
const t = translator(LANG);
const today = todayIso();
let seed = 42;
const rnd = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
const baht = (n: number) => BigInt(Math.round(n * 100));

await db.asUser(userId, async (q) => {
  await q.query(`update user_preferences set onboarded = true, monthly_income = $1, month_start_day = 25, bucket_mode = 'partial', investment_enabled = true, emergency_source = 'bucket' where user_id = $2`, [baht(65_000), userId]);
  await setBucketMode(q, 'partial');
  await applyBucketTemplate(q, userId, 'save_emergency_invest', t);
  const bank = await createAccount(q, userId, { name: LANG === 'th' ? 'ออมทรัพย์ (เงินเดือน)' : 'Salary account', type: 'savings', opening: baht(120_000) });
  const cash = await createAccount(q, userId, { name: LANG === 'th' ? 'เงินสด' : 'Cash', type: 'cash', opening: baht(4_000) });
  const wallet = await createAccount(q, userId, { name: 'TrueMoney', type: 'ewallet', opening: baht(1_500) });
  const cats = await q.query<any>('select c.id, c.name, p.name parent, c.kind from categories c left join categories p on p.id = c.parent_id where c.owner_id = $1', [userId]);
  const cat = (th: string, en: string) => cats.find((c) => c.name === (LANG === 'th' ? th : en))?.id ?? null;
  const buckets = await q.query<any>('select id, type from buckets where owner_id = $1', [userId]);
  await bucketMove(q, userId, buckets.find((b) => b.type === 'emergency').id, baht(90_000), 'allocate');

  const salary = cat('เงินเดือน', 'Salary');
  const rent = cat('ค่าเช่า/ผ่อนบ้าน', 'Rent / mortgage');
  const food = cat('อาหารประจำวัน', 'Daily meals');
  const grocery = cat('ของใช้/ซูเปอร์มาร์เก็ต', 'Groceries');
  const elec = cat('ค่าไฟ', 'Electricity');
  const net = cat('อินเทอร์เน็ต/โทรศัพท์', 'Internet & phone');
  const fuel = cat('น้ำมัน', 'Fuel');
  const fun = cat('บันเทิง', 'Entertainment');
  const shop = cat('ช้อปปิ้ง', 'Shopping');
  const parents = cat('ให้พ่อแม่', 'Support parents');

  for (let m = 11; m >= 0; m--) {
    const base = addMonths(today, -m).slice(0, 7);
    const d = (day: number) => { const s = `${base}-${String(day).padStart(2, '0')}`; return s > today ? today : s; };
    if (`${base}-25` <= today) await createTransaction(q, userId, { kind: 'income', amount: baht(65_000), date: d(25), accountId: bank, categoryId: salary, payee: 'ACME Co., Ltd.' }, { autoAllocate: true });
    await createTransaction(q, userId, { kind: 'expense', amount: baht(12_000), date: d(1), accountId: bank, categoryId: rent, payee: LANG === 'th' ? 'คอนโด' : 'Condo' });
    await createTransaction(q, userId, { kind: 'expense', amount: baht(5_000), date: d(2), accountId: bank, categoryId: parents, payee: LANG === 'th' ? 'แม่' : 'Mom' });
    await createTransaction(q, userId, { kind: 'expense', amount: baht(1_600 + rnd() * 900), date: d(12), accountId: bank, categoryId: elec, payee: 'MEA' });
    await createTransaction(q, userId, { kind: 'expense', amount: baht(599), date: d(15), accountId: bank, categoryId: net, payee: 'AIS Fibre' });
    for (let k = 0; k < 18; k++) await createTransaction(q, userId, { kind: 'expense', amount: baht(60 + rnd() * 240), date: d(1 + Math.floor(rnd() * 27)), accountId: k % 3 ? cash : wallet, categoryId: food, payee: ['7-Eleven', 'Makro', 'ร้านข้าวมันไก่', 'Café Amazon'][k % 4] });
    await createTransaction(q, userId, { kind: 'expense', amount: baht(2_500 + rnd() * 2_000), date: d(8), accountId: bank, categoryId: grocery, payee: 'Big C' });
    await createTransaction(q, userId, { kind: 'expense', amount: baht(1_500 + rnd() * 600), date: d(18), accountId: bank, categoryId: fuel, payee: 'PTT' });
    await createTransaction(q, userId, { kind: 'expense', amount: baht(800 + rnd() * 2_500), date: d(20), accountId: bank, categoryId: rnd() > 0.5 ? shop : fun, payee: rnd() > 0.5 ? 'Shopee' : 'Major Cineplex' });
    await createTransaction(q, userId, { kind: 'transfer', amount: baht(3_000), date: d(3), accountId: bank, toAccountId: cash });
  }

  const card = await createDebt(q, userId, { name: LANG === 'th' ? 'บัตรเครดิต KTC' : 'KTC credit card', type: 'credit_card', principal: baht(48_000), balance: baht(42_500), method: 'credit_card', rateE4: 160_000, payment: baht(4_000), minType: 'percent_of_balance', minValue: 80_000n, minFloor: baht(1_000), dueDay: 5 });
  const car = await createDebt(q, userId, { name: LANG === 'th' ? 'เช่าซื้อรถ' : 'Car loan', type: 'auto', principal: baht(480_000), balance: baht(356_000), method: 'flat', rateE4: 27_900, payment: baht(11_116), dueDay: 10, termMonths: 48, startDate: addMonths(today, -14) });
  const home = await createDebt(q, userId, { name: LANG === 'th' ? 'สินเชื่อบ้าน' : 'Mortgage', type: 'mortgage', principal: baht(2_400_000), balance: baht(2_210_000), method: 'reducing', rateE4: 32_500, payment: annuityPayment(baht(2_210_000), 32_500, 300), dueDay: 1, dailyAccrual: true });
  await createDebt(q, userId, { name: LANG === 'th' ? 'ยืมพี่สาว' : 'Loan from sister', type: 'family', principal: baht(30_000), balance: baht(18_000), method: 'none', rateE4: 0, payment: baht(3_000), dueDay: 28 });
  await q.query(`insert into debt_rate_schedule(debt_id, owner_id, from_date, annual_rate_e4) values ($1, $2, $3, 65000)`, [home, userId, addMonths(today, 24)]);
  void card; void car;
  await q.query(`insert into debt_plans(owner_id, strategy, monthly_budget) values ($1, 'avalanche', $2)`, [userId, baht(32_000)]);

  const trip = await q.one<any>(`insert into goals(owner_id, name, target_amount, target_date, priority) values ($1, $2, $3, $4, 1) returning id`, [userId, LANG === 'th' ? 'เที่ยวญี่ปุ่น' : 'Trip to Japan', baht(80_000), addMonths(today, 9)]);
  const edu = await q.one<any>(`insert into goals(owner_id, name, target_amount, target_date, expected_return_e4, priority) values ($1, $2, $3, $4, 40000, 2) returning id`, [userId, LANG === 'th' ? 'ทุนการศึกษาลูก' : "Kid's education", baht(1_000_000), addMonths(today, 120)]);
  for (let m = 5; m >= 0; m--) {
    await q.query('insert into goal_contributions(goal_id, owner_id, date, amount, created_by) values ($1,$2,$3,$4,$2)', [trip.id, userId, addMonths(today, -m), baht(6_000)]);
    await q.query('insert into goal_contributions(goal_id, owner_id, date, amount, created_by) values ($1,$2,$3,$4,$2)', [edu.id, userId, addMonths(today, -m), baht(5_000)]);
  }

  const pf = await q.one<any>(`insert into portfolios(owner_id, name, kind) values ($1, $2, 'fund') returning id`, [userId, LANG === 'th' ? 'กองทุนรวม' : 'Mutual funds']);
  const assets = [
    { symbol: 'K-USXNDQ-A', cls: 'foreign_stock', price: 19.8 },
    { symbol: 'SCBSET50', cls: 'thai_stock', price: 11.2 },
    { symbol: 'KFLTFDIV-SSF', cls: 'tax_fund', price: 13.4 },
    { symbol: 'GOLD99', cls: 'gold', price: 41_800 },
    { symbol: 'KFAFIX-A', cls: 'bond', price: 10.6 },
  ];
  const extra = N ? 45 : 0; // NFR-PERF-02: 50 assets
  for (let i = 0; i < extra; i++) assets.push({ symbol: `FUND${i}`, cls: 'mutual_fund', price: 10 + i / 10 });
  for (const a of assets) {
    const r = await q.one<any>(`insert into assets(owner_id, symbol, name, asset_class) values ($1,$2,$2,$3) returning id`, [userId, a.symbol, a.cls]);
    for (let m = 11; m >= 0; m--) {
      const price = a.price * (0.85 + 0.15 * ((12 - m) / 12) + (rnd() - 0.5) * 0.04);
      const amount = a.cls === 'gold' ? (m % 3 === 0 ? 10_000 : 0) : 2_000;
      if (!amount) continue;
      const units = BigInt(Math.round((amount / price) * 1e8));
      await q.query(`insert into investment_transactions(portfolio_id, asset_id, owner_id, type, date, units_e8, price_e8, amount, created_by) values ($1,$2,$3,'buy',$4,$5,$6,$7,$3)`,
        [pf.id, r.id, userId, addMonths(today, -m), units, BigInt(Math.round(price * 1e8)), baht(amount)]);
    }
    await q.query(`insert into price_history(asset_id, owner_id, date, price_e8) values ($1,$2,$3,$4)`, [r.id, userId, today, BigInt(Math.round(a.price * 1e8))]);
  }
  await q.query(`insert into allocation_targets(owner_id, asset_class, percent_e4) values ($1,'foreign_stock',400000),($1,'thai_stock',200000),($1,'tax_fund',150000),($1,'bond',150000),($1,'gold',100000)`, [userId]);
  await q.query(`update user_preferences set invest_monthly_budget = $1 where user_id = $2`, [baht(10_000), userId]);
  await q.query(`insert into budget_lines(owner_id, month, category_id, amount) values ($1,$2,$3,$4),($1,$2,$5,$6),($1,$2,$7,$8)`,
    [userId, (today.slice(8) >= '25' ? today : addMonths(today, -1)).slice(0, 7), cats.find((c) => c.id === food)?.id ? food : null, baht(7_000), shop, baht(2_000), fuel, baht(2_000)]);
  await q.query(`insert into recurring_rules(owner_id, name, kind, amount, account_id, category_id, frequency, next_date, auto_create) values
     ($1,$2,'income',$3,$4,$5,'monthly',$6,true), ($1,'Netflix','expense',$7,$4,$8,'monthly',$9,false)`,
    [userId, LANG === 'th' ? 'เงินเดือน' : 'Salary', baht(65_000), bank, salary, addMonths(`${today.slice(0, 7)}-25`, today.slice(8) >= '25' ? 1 : 0), baht(419), fun, addMonths(today, 0).slice(0, 8) + '28']);

  // NFR-PERF-02 load profile
  for (let i = 0; i < N; i++) {
    await createTransaction(q, userId, { kind: 'expense', amount: baht(20 + rnd() * 500), date: addMonths(today, -Math.floor(rnd() * 60)), accountId: cash, categoryId: food, payee: `Shop ${i % 500}` });
    if (i % 5000 === 0 && i) console.log(`  ${i} transactions…`);
  }
});

console.log(`Demo user ready: ${EMAIL} (password: see DEMO_PASSWORD in apps/web/scripts/seed-demo.ts)`);
await db.close();
