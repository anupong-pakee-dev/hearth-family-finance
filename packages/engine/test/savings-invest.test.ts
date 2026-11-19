import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredMonthly, monthsToTarget, goalProgress, distributeByPriority, growthSeries } from '../src/savings.ts';
import { runwayMonths, tierFor, targetAmount, averageMonthly, refillPlan, shouldPrioritiseEmergency } from '../src/emergency.ts';
import { computeHoldings, valuation, xirr, cashFlowsFor, projectValue, scenarios, retirementPlan, rebalance, averageCostE8, E8, type InvTxn } from '../src/invest.ts';
import { healthScore, savingsRate } from '../src/health.ts';
import { allocateIncome, distribute, BUCKET_TEMPLATES, toBeAllocated, rollover } from '../src/buckets.ts';

test('required monthly saving without and with return (§8.5)', () => {
  assert.equal(requiredMonthly(12_000_000n, 0n, 12), 1_000_000n);
  assert.equal(requiredMonthly(10_000_000n, 0n, 3), 3_333_334n); // rounds up so the goal is reached
  assert.equal(requiredMonthly(100n, 200n, 5), 0n);
  // 100,000 in 24 months at 3%/yr -> PMT ≈ 4,048.x
  const pmt = requiredMonthly(10_000_000n, 0n, 24, 30_000);
  assert.ok(pmt > 404_000n && pmt < 406_000n, `pmt=${pmt}`);
  assert.equal(monthsToTarget(12_000_000n, 0n, 1_000_000n), 12);
  assert.equal(monthsToTarget(12_000_000n, 0n, 0n), Infinity);
  assert.ok(monthsToTarget(10_000_000n, 0n, pmt, 30_000) <= 24);
});

test('goal progress status (FR-SAVE-03/04)', () => {
  const behind = goalProgress({ target: 12_000_000n, current: 1_000_000n, targetDate: '2027-01-01', today: '2026-07-01', startedOn: '2026-01-01', recentMonthlyAvg: 100_000n });
  assert.equal(behind.status, 'behind');
  const ahead = goalProgress({ target: 12_000_000n, current: 10_000_000n, targetDate: '2027-01-01', today: '2026-07-01', startedOn: '2026-01-01', recentMonthlyAvg: 2_000_000n });
  assert.equal(ahead.status, 'ahead');
  const done = goalProgress({ target: 100n, current: 100n, targetDate: null, today: '2026-07-01', startedOn: '2026-01-01', recentMonthlyAvg: 0n });
  assert.equal(done.status, 'done');
  const open = goalProgress({ target: null, current: 5n, targetDate: null, today: '2026-07-01', startedOn: '2026-01-01', recentMonthlyAvg: 0n });
  assert.equal(open.status, 'no_deadline');
});

test('priority distribution and growth (FR-SAVE-07)', () => {
  const d = distributeByPriority(1_000n, [{ id: 'a', need: 300n, remaining: 500n }, { id: 'b', need: 400n, remaining: 400n }]);
  assert.deepEqual(d, { a: 500n, b: 400n });
  assert.deepEqual(growthSeries(0n, 100n, 3), [100n, 200n, 300n]);
});

test('emergency fund runway and tiers (FR-EMG)', () => {
  assert.equal(runwayMonths(9_000_000n, 3_000_000n), 3);
  assert.equal(runwayMonths(1_000_000n, 3_000_000n), 0.3);
  assert.equal(runwayMonths(1n, 0n), Infinity);
  assert.equal(tierFor(0.5), 'none');
  assert.equal(tierFor(1), 'starter');
  assert.equal(tierFor(4), 'basic');
  assert.equal(tierFor(6), 'secure');
  assert.equal(targetAmount({ mode: 'months', months: 6, essentialMonthly: 2_000_000n }), 12_000_000n);
  assert.equal(targetAmount({ mode: 'fixed', fixed: 5n, essentialMonthly: 2_000_000n }), 5n);
  assert.equal(averageMonthly([300n, 0n, 600n]), 450n);
  assert.deepEqual(refillPlan(1_000n, 3), [333n, 333n, 334n]);
  assert.equal(shouldPrioritiseEmergency(0.5), true);
});

const txns: InvTxn[] = [
  { date: '2025-01-01', type: 'buy', assetId: 'X', unitsE8: 100n * E8, amount: 1_000_000n, fee: 1_000n },
  { date: '2025-06-01', type: 'buy', assetId: 'X', unitsE8: 100n * E8, amount: 1_200_000n },
  { date: '2025-09-01', type: 'dividend', assetId: 'X', unitsE8: 0n, amount: 50_000n, tax: 5_000n },
  { date: '2025-12-01', type: 'sell', assetId: 'X', unitsE8: 50n * E8, amount: 700_000n, fee: 1_000n },
];

test('holdings with average cost (FR-INV-09/13)', () => {
  const h = computeHoldings(txns).get('X')!;
  assert.equal(h.unitsE8, 150n * E8);
  // cost before sale 2,201,000 → avg 11,005 satang/unit, 50 units cost 550,250
  assert.equal(h.costBasis, 2_201_000n - 550_250n);
  assert.equal(h.realizedPL, 699_000n - 550_250n);
  assert.equal(h.income, 45_000n);
  assert.equal(averageCostE8(h), 11_005_000_000n); // 110.05 THB per unit
  const v = valuation(h, 130n * E8); // price 130 THB per unit
  assert.equal(v.marketValue, 1_950_000n); // 150 units × 130 THB = 19,500.00
  assert.equal(v.unrealizedPL, 1_950_000n - h.costBasis);
});

test('FIFO cost method', () => {
  const h = computeHoldings(txns, 'fifo').get('X')!;
  // FIFO sells 50 of the first lot (cost 1,001,000 for 100) = 500,500
  assert.equal(h.realizedPL, 699_000n - 500_500n);
});

test('split multiplies units', () => {
  const h = computeHoldings([...txns, { date: '2026-01-01', type: 'split', assetId: 'X', unitsE8: 2n * E8, amount: 0n }]).get('X')!;
  assert.equal(h.unitsE8, 300n * E8);
});

test('XIRR of a simple one-year 10% investment', () => {
  const r = xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }]);
  assert.ok(r !== null && Math.abs(r - 0.1) < 1e-6, `r=${r}`);
  assert.equal(xirr([{ date: '2025-01-01', amount: -1000 }]), null);
  const flows = cashFlowsFor(txns, 1_950_000n, '2026-01-01');
  const r2 = xirr(flows);
  assert.ok(r2 !== null && Number.isFinite(r2));
});

test('projection and scenarios (FR-INV-20)', () => {
  const v = projectValue(0n, 100_000n, 0, 12);
  assert.equal(v[11], 1_200_000n);
  const s = scenarios(100_000n, 100_000n, 480, { conservative: 3, moderate: 6, optimistic: 9 });
  assert.ok(s.optimistic[479] > s.moderate[479] && s.moderate[479] > s.conservative[479]);
  assert.equal(s.contributed[479], 100_000n + 100_000n * 480n);
});

test('retirement plan (FR-INV-21)', () => {
  const r = retirementPlan({ currentAge: 30, retireAge: 60, lifeExpectancy: 85, monthlyExpenseToday: 3_000_000n, inflationPercent: 3, returnBeforePercent: 6, returnAfterPercent: 4, currentSavings: 50_000_000n });
  assert.ok(r.nestEgg > 0n && r.monthlyRequired > 0n);
  assert.equal(r.yearsToRetire, 30);
});

test('rebalance (FR-INV-16/17)', () => {
  const r = rebalance({ equity: 7_000n, bond: 2_000n, gold: 1_000n }, { equity: 600_000, bond: 300_000, gold: 100_000 });
  const eq = r.rows.find((x) => x.assetClass === 'equity')!;
  assert.equal(eq.difference, -1_000n);
  assert.equal(r.rows.find((x) => x.assetClass === 'bond')!.difference, 1_000n);
});

test('health score', () => {
  assert.equal(savingsRate(10_000n, 8_000n), 0.2);
  const h = healthScore({ monthlyIncome: 5_000_000n, monthlyExpense: 3_500_000n, monthlyDebtPayments: 1_000_000n, emergencyRunwayMonths: 6, liquidAssets: 30_000_000n, netWorth: 100n, netWorthPrev: 50n });
  assert.ok(h.score >= 90 && h.score <= 100, `score=${h.score}`);
  const bad = healthScore({ monthlyIncome: 0n, monthlyExpense: 1_000n, monthlyDebtPayments: 1_000n, emergencyRunwayMonths: 0, liquidAssets: 0n, netWorth: -5n });
  assert.ok(bad.score < 20);
});

test('bucket allocation rules (FR-BKT-05/06)', () => {
  const r = allocateIncome(10_000_000n, BUCKET_TEMPLATES['50_30_20'].map((t) => ({ kind: 'percent' as const, bucketId: t.key, percentE4: t.percentE4 })));
  assert.deepEqual(r.allocations, { needs: 5_000_000n, wants: 3_000_000n, savings: 2_000_000n });
  assert.equal(r.unallocated, 0n);
  const fill = allocateIncome(1_000n, [{ kind: 'fill', bucketId: 'em', upTo: 800n }, { kind: 'fixed', bucketId: 'inv', amount: 500n }], { em: 500n });
  assert.deepEqual(fill.allocations, { em: 300n, inv: 500n });
  assert.equal(fill.unallocated, 200n);
  assert.deepEqual(distribute(100n, [1, 1, 1]), [34n, 33n, 33n]);
  assert.equal(toBeAllocated(1_000n, 600n), 400n);
  assert.deepEqual(rollover(50n, 'carry'), { keep: 50n, release: 0n });
  assert.deepEqual(rollover(50n, 'return'), { keep: 0n, release: 50n });
});
