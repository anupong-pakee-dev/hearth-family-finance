import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, CalcError, isExpression, FUNCTION_GROUPS } from '../public/calc.js';
import { annuityPayment, flatRate } from '@hearth/engine';

const v = (s: string, env?: Record<string, number>) => evaluate(s, env).value;
const code = (s: string) => { try { evaluate(s); return 'ok'; } catch (e) { return e instanceof CalcError ? e.code : 'crash'; } };

test('calculator: arithmetic, precedence and tidy decimals', () => {
  assert.equal(v('0.1+0.2'), 0.3);
  assert.equal(v('2+3*4'), 14);
  assert.equal(v('(2+3)*4'), 20);
  assert.equal(v('-2^2'), -4);
  assert.equal(v('2^3^2'), 512);
  assert.equal(v('10/4'), 2.5);
  assert.equal(v('2,500*12'), 30000);
  assert.equal(v('๑๐๐×๓'), 300);
  assert.equal(v('7 ÷ 2'), 3.5);
});

test('calculator: percent works like a shop calculator', () => {
  assert.equal(v('1200+7%'), 1284);
  assert.equal(v('1200-10%'), 1080);
  assert.equal(v('50%*300'), 150);
  assert.equal(v('200*15%'), 30);
});

test('calculator: money functions agree with the engine', () => {
  assert.equal(Math.ceil(v('installment(500000; 6.5; 60)') * 100), Number(annuityPayment(50_000_000n, 65_000, 60)));
  assert.equal(v('installment(500000, 6.5, 60)'), v('installment(500000; 6.5; 60)'), 'commas separate arguments inside calls');
  assert.equal(Math.round(v('flatinstallment(600000; 2.79; 72)') * 100), Number(flatRate(60_000_000n, 27_900, 72).installment));
  assert.equal(v('installment(1200; 0; 12)'), 100);
  assert.equal(v('nper(5000; 16; 40000)'), 9);
  assert.equal(v('withvat(1500)'), 1605);
  assert.equal(v('exvat(1605)'), 1500);
  assert.equal(v('vat(1000; 10)'), 100);
  assert.equal(v('wht(20000)'), 600);
  assert.equal(v('split(3450; 4; 10)'), 948.75);
  assert.equal(v('round(change(38000; 33550); 2)'), -11.71);
  assert.equal(v('round(compound(100000; 12; 1; 12); 2)'), 112682.5);
  const goal = v('saving(120000; 2; 18)');
  assert.ok(Math.abs(v(`fv(${goal}; 2; 18)`) - 120000) < 0.01, 'saving() and fv() are inverses');
  assert.equal(v('saving(1000; 0; 10; 2000)'), 0, 'already reached → 0');
});

test('calculator: names, ans and errors', () => {
  const env: Record<string, number> = {};
  assert.deepEqual(evaluate('rent = 8500', env), { value: 8500, name: 'rent' });
  assert.equal(v('RENT*12', env), 102000);
  assert.equal(v('ans/2', env), 51000);
  assert.equal(code(''), 'empty');
  assert.equal(code('2+'), 'syntax');
  assert.equal(code('2 3'), 'syntax');
  assert.equal(code('1/0'), 'div0');
  assert.equal(code('sqrt(-1)'), 'domain');
  assert.equal(code('foo(1)'), 'unknown');
  assert.equal(code('round()'), 'args');
  assert.equal(code('nper(100; 16; 40000)'), 'never');
  assert.equal(code('sum = 5'), 'reserved');
  assert.equal(code('1'.repeat(501)), 'too_long');
  assert.equal(code('('.repeat(80) + '1' + ')'.repeat(80)), 'too_complex');
  assert.equal(code('10^400'), 'invalid');
});

test('calculator: no way to reach JavaScript', () => {
  for (const s of ['constructor', 'toString(1)', '__proto__', 'hasOwnProperty(1)', 'alert(1)', 'this', 'globalThis', 'eval(1)', '"a"', '`x`', '[1]', 'a.b', 'x=>1']) {
    assert.notEqual(code(s), 'ok', s);
    assert.notEqual(code(s), 'crash', s);
  }
});

test('calculator: amount fields only treat real maths as expressions', () => {
  assert.equal(isExpression('120+45'), true);
  assert.equal(isExpression('1500*3'), true);
  assert.equal(isExpression('-250'), false);
  assert.equal(isExpression('1,250.50'), false);
  for (const [, fns] of FUNCTION_GROUPS) for (const [, , example] of fns) assert.equal(code(example), 'ok', example);
});
