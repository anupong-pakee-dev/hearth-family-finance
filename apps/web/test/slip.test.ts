/**
 * FR-TXN-06: on-device slip reading — OCR text parser, OCR asset serving, and the form never submitting the slip.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, Client } from './helpers.ts';
import { parseSlipText } from '../public/slip.js';
import { OCR_BASE } from '../src/http/static.ts';

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => {
  app = await startApp();
  await new Client(app.base).register('admin@hearth.test', 'lantern-river-mango-42', 'Admin');
});
after(async () => { await app.close(); });

test('K PLUS style slip (no labels, 2-digit Buddhist year)', () => {
  const text = `โอนเงินสำเร็จ
19 พ.ย. 69 14:32 น.
นาย สมชาย ใจดี
ธ.กสิกรไทย
xxx-x-x1234-x
นางสาว สมหญิง รักดี
ธ.ไทยพาณิชย์
xxx-x-x5678-x
เลขที่รายการ:
015323143220BTF01234
จำนวน:
1,500.00 บาท
ค่าธรรมเนียม:
0.00 บาท`;
  assert.deepEqual(parseSlipText(text), { amount: '1500.00', date: '2026-11-19', payee: 'นางสาว สมหญิง รักดี', ref: '015323143220BTF01234' });
});

test('SCB style slip (labelled recipient, 4-digit Buddhist year)', () => {
  const text = `โอนเงินสำเร็จ
19 พ.ย. 2569 - 09:05
รหัสอ้างอิง: 202611190905ABC1234
จาก นาย สมชาย ใจดี xxx-xxx123-4
ไปยัง ร้านส้มตำป้าแดง
จำนวนเงิน 85.00`;
  assert.deepEqual(parseSlipText(text), { amount: '85.00', date: '2026-11-19', payee: 'ร้านส้มตำป้าแดง', ref: '202611190905ABC1234' });
});

test('English slip, payee on the next line, fee and balance ignored', () => {
  const text = `Transfer successful
Date 03 Nov 2026 18:20
To
Somtam Shop Co., Ltd.
Fee 10.00
Amount
THB 12,345.67
Available balance 99,999.99
Ref No. 7788AB123456`;
  assert.deepEqual(parseSlipText(text), { amount: '12345.67', date: '2026-11-03', payee: 'Somtam Shop Co., Ltd.', ref: '7788AB123456' });
});

test('noisy OCR: Thai digits, decomposed sara am, spaces inside numbers', () => {
  const text = 'จํา น วน เงิน ๒, ๕๐๐ . ๐๐ บาท\nวันที่ 05/12/2569';
  const r = parseSlipText(text);
  assert.equal(r.amount, '2500.00');
  assert.equal(r.date, '2026-12-05');
});

test('falls back to the largest amount; nothing found yields undefined fields', () => {
  assert.equal(parseSlipText('ค่าธรรมเนียม 5.00\n320.50\n12.00').amount, '320.50');
  assert.deepEqual(parseSlipText('a photo of a cat'), { amount: undefined, date: undefined, payee: undefined, ref: undefined });
  assert.equal(parseSlipText('31 ก.พ. 69').date, undefined, 'impossible dates are rejected');
});

test('OCR engine is served locally with a worker-only CSP; unknown files 404', async () => {
  const w = await fetch(`${app.base}${OCR_BASE}worker.min.js`, { headers: { 'accept-encoding': 'br' } });
  assert.equal(w.status, 200);
  assert.match(w.headers.get('content-type')!, /javascript/);
  assert.match(w.headers.get('content-security-policy')!, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.equal(w.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(w.headers.get('cache-control')!, /immutable/);
  await w.arrayBuffer();
  const lang = await fetch(`${app.base}${OCR_BASE}lang/tha.traineddata.gz`);
  assert.equal(lang.status, 200);
  assert.equal(lang.headers.get('content-encoding'), null, 'the gzip data file is passed through as-is');
  assert.deepEqual([...new Uint8Array(await lang.arrayBuffer()).slice(0, 2)], [0x1f, 0x8b]);
  for (const bad of ['../package.json', 'core/../../package.json', 'nope.js']) {
    const r = await fetch(`${app.base}${OCR_BASE}${bad}`);
    assert.equal(r.status, 404, bad);
    await r.arrayBuffer();
  }
});

test('new-transaction form offers the slip reader; its file input is never submitted', async () => {
  const c = new Client(app.base);
  await c.register('slip@hearth.test');
  await c.post('/onboarding/accounts', { name: 'Bank', type: 'savings', opening: '1000' }, '/onboarding?step=1');
  await c.post('/onboarding/buckets', { mode: 'off', template: '' }, '/onboarding?step=3');
  await c.post('/onboarding/invest', { invest: 'no' }, '/onboarding?step=4');
  const r = await c.get('/transactions/new');
  assert.equal(r.status, 200);
  const box = /<div class="slip-reader"[\s\S]*?<\/div>/.exec(r.text)?.[0] ?? '';
  assert.match(box, /hidden data-slip/, 'hidden until JavaScript shows it');
  assert.ok(box.includes(`data-ocr="${OCR_BASE}"`));
  const fileInput = /<input[^>]*type="file"[^>]*>/.exec(box)?.[0] ?? '';
  assert.ok(fileInput && !/\bname=/.test(fileInput), 'no name attribute, so the slip is never sent');
  assert.match(r.text, /slip\.[\w-]+\.js/);
  assert.match(r.headers.get('content-security-policy')!, /trusted-types hearth default/);
});
