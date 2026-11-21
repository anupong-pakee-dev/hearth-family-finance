/**
 * Outgoing e-mail. Transports (HEARTH_MAIL_TRANSPORT):
 *  - "outbox" (default) writes RFC 822 files to <dataDir>/outbox so a self-hoster can wire any MTA
 *    (or inspect mail in development).
 *  - "resend" sends through the Resend HTTPS API (HEARTH_RESEND_API_KEY). Works on hosts that block SMTP ports.
 * Mail content and recipients are never logged (NFR-SEC-17). Delivery failures are logged and swallowed so a
 * mail outage never breaks sign-up, password reset or background jobs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { log } from '../log.ts';

const RESEND_URL = 'https://api.resend.com/emails';

export async function sendMail(to: string, subject: string, text: string) {
  if (config.mailTransport === 'outbox') return writeOutbox(to, subject, text);
  if (config.mailTransport === 'resend') return sendResend(to, subject, text);
  log.warn('unknown mail transport; message dropped', { transport: config.mailTransport });
}

function writeOutbox(to: string, subject: string, text: string) {
  const dir = `${config.dataDir}/outbox`;
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const msg = [
    `From: ${config.mailFrom}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id}@hearth>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
  ].join('\r\n');
  writeFileSync(`${dir}/${Date.now()}-${id}.eml`, msg, { mode: 0o600 });
  log.info('mail queued to outbox', { id });
}

async function sendResend(to: string, subject: string, text: string) {
  if (!config.resendApiKey) {
    log.error('HEARTH_RESEND_API_KEY is not set; message dropped', { transport: 'resend' });
    return;
  }
  const id = randomUUID();
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
        'user-agent': 'hearth-family-finance',
        'idempotency-key': id,
      },
      body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Resend's error body names the problem (e.g. unverified domain) and never echoes the message content.
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      log.error('resend rejected message', { id, status: res.status, detail });
      return;
    }
    log.info('mail sent via resend', { id });
  } catch (e) {
    log.error('resend request failed', { id, error: (e as Error).message.slice(0, 200) });
  }
}
