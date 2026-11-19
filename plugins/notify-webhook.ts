// Generic webhook channel (FR-NOTI-02). POSTs {title, body, url} as JSON, optionally HMAC-signed.
import { createHmac } from 'node:crypto';
import { safeFetch, type Registry } from '../apps/web/src/services/plugins.ts';

export default {
  register(r: Registry) {
    r.channels.set('webhook', {
      kind: 'webhook',
      name: 'Webhook (HTTPS)',
      fields: [{ key: 'url', label: 'URL', placeholder: 'https://example.com/hook' }, { key: 'secret', label: 'Signing secret (optional)', secret: true }],
      async send(cfg, msg) {
        const body = JSON.stringify({ ...msg, sent_at: new Date().toISOString() });
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (cfg.secret) headers['x-hearth-signature'] = `sha256=${createHmac('sha256', cfg.secret).update(body).digest('hex')}`;
        const res = await safeFetch(cfg.url, { method: 'POST', headers, body });
        if (!res.ok) throw new Error(`webhook responded ${res.status}`);
      },
    });
  },
};
