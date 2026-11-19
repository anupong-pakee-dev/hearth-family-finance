// LINE Messaging API push message (the replacement for the discontinued LINE Notify) — FR-NOTI-02.
import { safeFetch, type Registry } from '../apps/web/src/services/plugins.ts';

export default {
  register(r: Registry) {
    r.channels.set('line', {
      kind: 'line',
      name: 'LINE (Messaging API)',
      fields: [{ key: 'token', label: 'Channel access token', secret: true }, { key: 'to', label: 'User / group ID' }],
      async send(cfg, msg) {
        const res = await safeFetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
          body: JSON.stringify({ to: cfg.to, messages: [{ type: 'text', text: `${msg.title}\n${msg.body}\n${msg.url}`.slice(0, 4900) }] }),
        });
        if (!res.ok) throw new Error(`LINE responded ${res.status}`);
      },
    });
  },
};
