// Daily ECB reference exchange rates via frankfurter.app (FR-TXN-11, FR-INV-18).
import { safeFetch, type Registry } from '../apps/web/src/services/plugins.ts';

export default {
  register(r: Registry) {
    r.fx.set('frankfurter', {
      id: 'frankfurter',
      name: 'Frankfurter (ECB rates)',
      async fetchRates(base, quotes) {
        if (!quotes.length) return {};
        const res = await safeFetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(quotes.join(','))}`);
        if (!res.ok) throw new Error(`frankfurter ${res.status}`);
        return ((await res.json()) as { rates: Record<string, number> }).rates;
      },
    });
  },
};
