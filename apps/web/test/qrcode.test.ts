import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrSvg } from '../src/views/qrcode.ts';

const otp = 'otpauth://totp/Hearth%20Family%20Finance:family%40hearth.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Hearth%20Family%20Finance&algorithm=SHA1&digits=6&period=30';

/** 7×7 finder: dark ring, light ring, 3×3 dark core. */
function hasFinder(m: boolean[][], x0: number, y0: number) {
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
    if (m[y0 + y][x0 + x] !== (d !== 2)) return false;
  }
  return true;
}

test('qr: picks the smallest version and draws finder patterns', () => {
  assert.equal(qrMatrix('A').length, 21); // version 1
  const m = qrMatrix(otp);
  assert.equal((m.length - 17) % 4, 0);
  assert.ok(hasFinder(m, 0, 0) && hasFinder(m, m.length - 7, 0) && hasFinder(m, 0, m.length - 7));
  assert.equal(m[m.length - 8][8], true); // dark module
});

test('qr: deterministic, and rejects payloads beyond version 40', () => {
  assert.deepEqual(qrMatrix(otp), qrMatrix(otp));
  assert.throws(() => qrMatrix('x'.repeat(2400)), /too long/);
});

test('qr: svg has a quiet zone and an escaped label', () => {
  const svg = qrSvg('A', 'QR "test" <x>');
  assert.match(svg, /viewBox="0 0 29 29"/);
  assert.ok(!svg.includes('<x>'));
});
