import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, SLOTS, normalize, sanitize, themeVars, cssFor, contrast } from '../public/theme-colors.js';

test('colours: the default palette stores and emits nothing', () => {
  assert.deepEqual(normalize({}), {});
  assert.deepEqual(normalize({ preset: 'sage' }), {});
  assert.deepEqual(normalize({ ...PRESETS[0] }), {});
  assert.equal(cssFor({}), '');
});

test('colours: only known slots with #rrggbb values survive', () => {
  const c = sanitize({ primary: '#ABCDEF', inc: 'red', exp: '#12345', heat: '#00ff00;x', c9: '#000000', preset: 'nope' });
  assert.deepEqual(c, { primary: '#abcdef' });
  const n = normalize({ preset: 'ocean', primary: '#112233' });
  assert.equal(n.preset, 'ocean');
  assert.equal(n.primary, '#112233');
  for (const k of SLOTS) assert.match(n[k], /^#[0-9a-f]{6}$/);
});

test('colours: any pick stays readable in light and dark mode', () => {
  const picks = ['#ffffff', '#000000', '#ffff00', '#0000ff', '#777777', '#2f6f62', '#e69f00', '#1e2422'];
  for (const p of picks) {
    for (const dark of [false, true]) {
      const surface = dark ? '#1e2422' : '#ffffff';
      const v = themeVars({ primary: p, inc: p, exp: p, heat: p, c1: p }, dark);
      assert.ok(contrast(v['--primary-ink'], v['--primary']) >= 4.5, `button text on ${p} (${dark ? 'dark' : 'light'})`);
      assert.ok(contrast(v['--primary-strong'], v['--primary-soft']) >= 4.5, `selected menu text for ${p}`);
      assert.ok(contrast(v['--inc-text'], surface) >= 4.5, `income text ${p}`);
      assert.ok(contrast(v['--exp-text'], surface) >= 4.5, `spending text ${p}`);
      for (const k of ['--inc', '--exp', '--heat', '--s0']) assert.ok(contrast(v[k], surface) >= 3, `${k} graphic ${p}`);
    }
  }
});
