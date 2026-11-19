import { test } from 'node:test';
import assert from 'node:assert/strict';
import { divRound, parseMoney, parseRateE4, applyRate, formatScaled, toDecimalString } from '../src/money.ts';
import { addMonths, cycleFor, lastBusinessDay, monthsBetween, isIsoDate, nextOccurrence } from '../src/dates.ts';

test('divRound uses banker\'s rounding', () => {
  assert.equal(divRound(5n, 2n), 2n);   // 2.5 -> 2
  assert.equal(divRound(7n, 2n), 4n);   // 3.5 -> 4
  assert.equal(divRound(-5n, 2n), -2n);
  assert.equal(divRound(-7n, 2n), -4n);
  assert.equal(divRound(10n, 3n), 3n);
  assert.equal(divRound(11n, 3n), 4n);
  assert.equal(divRound(5n, -2n), -2n);
  assert.throws(() => divRound(1n, 0n));
});

test('parseMoney parses Thai-style input exactly', () => {
  assert.equal(parseMoney('1,234.56'), 123456n);
  assert.equal(parseMoney('฿ 20'), 2000n);
  assert.equal(parseMoney('-0.5'), -50n);
  assert.equal(parseMoney('0.125'), 12n);   // half-even
  assert.equal(parseMoney('0.135'), 14n);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney(undefined), null);
});

test('rates and formatting', () => {
  assert.equal(parseRateE4('18'), 180000);
  assert.equal(parseRateE4('2.875%'), 28750);
  assert.equal(parseRateE4(''), null);
  assert.equal(applyRate(1_000_000n, 180000), 180_000n); // 18% of 10,000.00
  assert.equal(formatScaled(123450n, 2), '1234.50');
  assert.equal(formatScaled(123450n, 4, 0), '12.345');
  assert.equal(toDecimalString(-5n), '-0.05');
});

test('date helpers', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
  assert.equal(addMonths('2026-03-15', -3), '2025-12-15');
  assert.equal(monthsBetween('2026-01-15', '2026-03-14'), 1);
  assert.equal(monthsBetween('2026-01-15', '2026-03-15'), 2);
  assert.deepEqual(cycleFor('2026-11-17', 25), { start: '2026-10-25', end: '2026-11-24' });
  assert.deepEqual(cycleFor('2026-11-26', 25), { start: '2026-11-25', end: '2026-12-24' });
  assert.deepEqual(cycleFor('2026-11-17', 1), { start: '2026-11-01', end: '2026-11-30' });
  assert.equal(lastBusinessDay('2026-05-10'), '2026-05-29'); // May 31 2026 is Sunday
  assert.equal(nextOccurrence('2026-05-29', 'last_business_day'), '2026-06-30');
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-02-28'), true);
});
