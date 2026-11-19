import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, remainingPeriods, annuityPayment, flatRate, whatIf, splitPayment, creditCardMinimum, periodInterest, refinance, debtServiceRatio, type DebtTerms } from '../src/debt.ts';
import { simulatePlan, compareStrategies, minimumBudget, type PlanDebt } from '../src/strategy.ts';

// Reference: 1,000,000 THB, 6% p.a., 30 years -> standard annuity payment 5,995.51 THB
test('annuity payment matches the textbook mortgage example', () => {
  const p = annuityPayment(100_000_000n, 60_000, 360);
  assert.ok(p >= 599_551n && p <= 599_552n, `got ${p}`);
});

test('reducing balance schedule closes in the expected number of months and sums exactly', () => {
  const terms: DebtTerms = { balance: 100_000_000n, method: 'reducing', rateE4: 60_000, payment: 599_552n };
  const r = simulate(terms, { startDate: '2026-01-01' });
  assert.equal(r.neverPaysOff, false);
  assert.ok(r.months >= 359 && r.months <= 360, `months=${r.months}`);
  // total interest ≈ 1,158,381 THB for this loan
  assert.ok(Math.abs(Number(r.totalInterest) - 115_838_100) < 50_000, `interest=${r.totalInterest}`);
  const principalSum = r.schedule.reduce((s, x) => s + x.principal, 0n);
  assert.equal(principalSum, 100_000_000n);
  assert.equal(r.totalPaid, 100_000_000n + r.totalInterest);
  // First month interest = 1,000,000 × 6% / 12 = 5,000
  assert.equal(r.schedule[0].interest, 500_000n);
});

test('closed form remaining periods agrees with simulation', () => {
  const n = remainingPeriods(100_000_000n, 60_000, 599_552n);
  assert.ok(n > 359 && n <= 360, `n=${n}`);
  assert.equal(remainingPeriods(100_000n, 240_000, 1_000n), Infinity); // 2,000 interest > 10 payment
  assert.equal(remainingPeriods(100_000n, 0, 10_000n), 10);
});

test('never pays off when payment does not cover interest (§8.1 warning)', () => {
  const r = simulate({ balance: 10_000_000n, method: 'reducing', rateE4: 250_000, payment: 100_000n });
  assert.equal(r.neverPaysOff, true);
  assert.equal(r.payoffDate, null);
});

// Reference: car hire purchase 500,000 THB, 3% flat, 48 months -> interest 60,000; installment 11,666.67; EIR ≈ 5.6%
test('flat rate hire purchase', () => {
  const f = flatRate(50_000_000n, 30_000, 48);
  assert.equal(f.totalInterest, 6_000_000n);
  assert.equal(f.installment, 1_166_667n);
  assert.ok(f.effectiveAnnualPercent > 5.4 && f.effectiveAnnualPercent < 5.8, `eir=${f.effectiveAnnualPercent}`);
  const r = simulate({ balance: 50_000_000n, principalOriginal: 50_000_000n, method: 'flat', rateE4: 30_000, payment: f.installment });
  assert.ok(r.months === 48 || r.months === 47, `months=${r.months}`);
  assert.equal(r.schedule[0].interest, 125_000n); // 1,250 per month
});

test('credit card daily interest and minimum payment (§8.3)', () => {
  const terms: DebtTerms = { balance: 1_000_000n, method: 'credit_card', rateE4: 160_000, payment: 0n, minPercentE4: 80_000, minFloor: 100_000n };
  // 10,000 × 16% × 30 / 365 = 131.51
  assert.equal(periodInterest(terms, 1_000_000n, 0, '2026-05-01'), 13_151n); // April has 30 days
  assert.equal(creditCardMinimum(terms, 1_000_000n), 100_000n); // max(800, 1000)
  assert.equal(creditCardMinimum(terms, 5_000_000n), 400_000n);
  assert.equal(creditCardMinimum(terms, 50_000n), 50_000n); // never more than owed
  const r = simulate(terms, { startDate: '2026-01-01' });
  assert.equal(r.neverPaysOff, false);
});

test('interest-free family loan', () => {
  const r = simulate({ balance: 3_000_000n, method: 'none', rateE4: 0, payment: 500_000n });
  assert.equal(r.months, 6);
  assert.equal(r.totalInterest, 0n);
});

test('what-if: extra payment shortens the loan and saves interest (FR-DEBT-07)', () => {
  const terms: DebtTerms = { balance: 20_000_000n, method: 'reducing', rateE4: 120_000, payment: 500_000n };
  const w = whatIf(terms, { extraMonthly: 200_000n, startDate: '2026-01-01' });
  assert.ok(w.monthsSaved > 0);
  assert.ok(w.interestSaved > 0n);
  const lump = whatIf(terms, { lumpSum: 5_000_000n, lumpSumMonth: 0, startDate: '2026-01-01' });
  assert.ok(lump.monthsSaved > 0);
});

test('rate schedule changes interest after the fixed period (FR-DEBT-13)', () => {
  const terms: DebtTerms = { balance: 100_000_000n, method: 'reducing', rateE4: 30_000, payment: 700_000n, rateSchedule: [{ fromMonth: 36, rateE4: 65_000 }] };
  const r = simulate(terms, { startDate: '2026-01-01' });
  assert.equal(r.schedule[0].interest, 250_000n);
  assert.ok(r.schedule[36].interest > r.schedule[35].interest);
});

test('refinance comparison (FR-DEBT-12)', () => {
  const terms: DebtTerms = { balance: 50_000_000n, method: 'reducing', rateE4: 70_000, payment: 600_000n };
  const r = refinance(terms, { rateE4: 40_000, payment: 600_000n, fees: 1_000_000n });
  assert.ok(r.interestSaved > 0n);
});

test('payment split into fee / interest / principal (FR-DEBT-04)', () => {
  const terms: DebtTerms = { balance: 10_000_000n, method: 'reducing', rateE4: 120_000, payment: 500_000n };
  const s = splitPayment(terms, 10_000_000n, 500_000n, '2026-02-01', '2026-01-01', 1_000n);
  assert.equal(s.fee, 1_000n);
  assert.equal(s.interest, 100_000n); // 100,000 × 12% / 12
  assert.equal(s.principal, 399_000n);
  assert.equal(s.newBalance, 9_601_000n);
});

test('DSR', () => {
  assert.equal(debtServiceRatio(2_000_000n, 5_000_000n), 0.4);
  assert.equal(debtServiceRatio(1n, 0n), Infinity);
});

const debts: PlanDebt[] = [
  { id: 'card', name: 'Card', balance: 5_000_000n, method: 'reducing', rateE4: 160_000, payment: 150_000n },
  { id: 'car', name: 'Car', balance: 30_000_000n, method: 'reducing', rateE4: 50_000, payment: 800_000n },
  { id: 'friend', name: 'Friend', balance: 1_000_000n, method: 'none', rateE4: 0, payment: 100_000n },
];

test('snowball pays the smallest balance first, avalanche the highest rate (FR-DEBT-08)', () => {
  const budget = 1_500_000n;
  const snow = simulatePlan(debts, budget, 'snowball', { startDate: '2026-01-01' });
  const ava = simulatePlan(debts, budget, 'avalanche', { startDate: '2026-01-01' });
  const order = (r: typeof snow) => [...r.debts].sort((a, b) => (a.payoffMonth ?? 999) - (b.payoffMonth ?? 999)).map((d) => d.id);
  assert.equal(order(snow)[0], 'friend');
  assert.equal(order(ava)[0], 'card');
  assert.ok(ava.totalInterest <= snow.totalInterest, 'avalanche never costs more interest');
  assert.equal(snow.neverPaysOff, false);
  assert.equal(snow.shortfall, 0n);
  // money conservation: everything paid = principal + interest
  const principal = debts.reduce((s, d) => s + d.balance, 0n);
  assert.equal(snow.totalPaid, principal + snow.totalInterest);
  // First month suggested payments spend the whole budget (FR-DEBT-09)
  const first = Object.values(snow.firstMonth).reduce((a, b) => a + b, 0n);
  assert.equal(first, budget);
});

test('custom order and shortfall detection', () => {
  const custom = simulatePlan(debts, 1_500_000n, 'custom', { customOrder: ['car', 'card', 'friend'] });
  assert.equal(custom.neverPaysOff, false);
  const min = minimumBudget(debts);
  assert.equal(min, 1_050_000n);
  const tight = simulatePlan(debts, 500_000n, 'avalanche');
  assert.equal(tight.shortfall, 550_000n);
  const all = compareStrategies(debts, 1_500_000n);
  assert.ok(all.snowball.months > 0 && all.avalanche.months > 0 && all.custom.months > 0);
});

test('plan of 10 debts over 30 years computes in < 100 ms (NFR-PERF-18)', () => {
  const many: PlanDebt[] = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, name: `D${i}`, balance: 100_000_000n + BigInt(i) * 7_000_000n, method: 'reducing', rateE4: 30_000 + i * 15_000, payment: 400_000n + BigInt(i) * 50_000n }));
  const t0 = performance.now();
  const r = compareStrategies(many, 8_000_000n);
  const ms = performance.now() - t0;
  assert.ok(r.avalanche.months <= 360);
  assert.ok(ms < 300, `took ${ms} ms (3 strategies)`);
});

test('avalanche ranks flat-rate loans by their effective rate on the remaining balance', () => {
  const mixed: PlanDebt[] = [
    { id: 'home', name: 'Home', balance: 220_000_000n, method: 'reducing', rateE4: 32_500, payment: 1_080_000n },
    { id: 'car', name: 'Car', balance: 35_600_000n, principalOriginal: 48_000_000n, method: 'flat', rateE4: 27_900, payment: 1_111_600n },
  ];
  const ava = simulatePlan(mixed, 3_000_000n, 'avalanche', { startDate: '2026-01-01' });
  const snow = simulatePlan(mixed, 3_000_000n, 'snowball', { startDate: '2026-01-01' });
  const custHomeFirst = simulatePlan(mixed, 3_000_000n, 'custom', { customOrder: ['home', 'car'], startDate: '2026-01-01' });
  assert.ok(ava.totalInterest <= custHomeFirst.totalInterest, `avalanche ${ava.totalInterest} vs home-first ${custHomeFirst.totalInterest}`);
  assert.ok(ava.totalInterest <= snow.totalInterest);
});
