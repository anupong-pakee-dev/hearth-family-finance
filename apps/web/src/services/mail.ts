/**
 * Outgoing e-mail. Default transport "outbox" writes RFC 822 files to <dataDir>/outbox so a self-hoster
 * can wire any MTA (or inspect mail in development). Mail content is never logged (NFR-SEC-17).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { log } from '../log.ts';

export async function sendMail(to: string, subject: string, text: string) {
  if (config.mailTransport === 'outbox') {
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
    return;
  }
  log.warn('unknown mail transport; message dropped', { transport: config.mailTransport });
}
