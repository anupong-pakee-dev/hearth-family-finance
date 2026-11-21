/**
 * Mail transports: Resend request shape, and that delivery failures never throw.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.HEARTH_SILENT = process.env.HEARTH_SILENT ?? '1';
const { config } = await import('../src/config.ts');
const { sendMail } = await import('../src/services/mail.ts');

const realFetch = globalThis.fetch;
const saved = { mailTransport: config.mailTransport, resendApiKey: config.resendApiKey, mailFrom: config.mailFrom };
afterEach(() => { globalThis.fetch = realFetch; Object.assign(config, saved); });

function useResend(key = 're_test_123') {
  Object.assign(config, { mailTransport: 'resend', resendApiKey: key, mailFrom: 'Hearth <no-reply@mail.example.com>' });
}

test('resend: posts a plain-text message with bearer auth', async () => {
  useResend();
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"id":"x"}', { status: 200 }); }) as typeof fetch;
  await sendMail('a@example.com', 'สวัสดี', 'body text');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h.authorization, 'Bearer re_test_123');
  assert.ok(h['idempotency-key']);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { from: 'Hearth <no-reply@mail.example.com>', to: ['a@example.com'], subject: 'สวัสดี', text: 'body text' });
});

test('resend: API error and network failure do not throw', async () => {
  useResend();
  globalThis.fetch = (async () => new Response('{"message":"domain not verified"}', { status: 403 })) as typeof fetch;
  await sendMail('a@example.com', 's', 't');
  globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  await sendMail('a@example.com', 's', 't');
});

test('resend: missing API key sends nothing', async () => {
  useResend('');
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response(''); }) as typeof fetch;
  await sendMail('a@example.com', 's', 't');
  assert.equal(called, false);
});
