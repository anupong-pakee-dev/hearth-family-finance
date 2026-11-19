// Telegram Bot API channel (FR-NOTI-02).
import { safeFetch, type Registry } from '../apps/web/src/services/plugins.ts';

export default {
  register(r: Registry) {
    r.channels.set('telegram', {
      kind: 'telegram',
      name: 'Telegram',
      fields: [{ key: 'token', label: 'Bot token', secret: true }, { key: 'chat_id', label: 'Chat ID' }],
      async send(cfg, msg) {
        if (!/^\d+:[\w-]+$/.test(cfg.token ?? '')) throw new Error('invalid bot token');
        const res = await safeFetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: cfg.chat_id, text: `${msg.title}\n${msg.body}\n${msg.url}`, disable_web_page_preview: true }),
        });
        if (!res.ok) throw new Error(`telegram responded ${res.status}`);
      },
    });
  },
};
