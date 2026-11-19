// Discord webhook channel (FR-NOTI-02).
import { safeFetch, type Registry } from '../apps/web/src/services/plugins.ts';

export default {
  register(r: Registry) {
    r.channels.set('discord', {
      kind: 'discord',
      name: 'Discord',
      fields: [{ key: 'url', label: 'Webhook URL', secret: true, placeholder: 'https://discord.com/api/webhooks/...' }],
      async send(cfg, msg) {
        if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(cfg.url ?? '')) throw new Error('not a Discord webhook URL');
        const res = await safeFetch(cfg.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: `**${msg.title}**\n${msg.body}\n<${msg.url}>`, allowed_mentions: { parse: [] } }),
        });
        if (!res.ok) throw new Error(`discord responded ${res.status}`);
      },
    });
  },
};
