// Crypto prices from CoinGecko's public API (FR-INV-11). Asset symbol = CoinGecko coin id, e.g. BITCOIN.
import { safeFetch, type Registry } from '../apps/web/src/services/plugins.ts';

export default {
  register(r: Registry) {
    r.prices.set('coingecko', {
      id: 'coingecko',
      name: 'CoinGecko (crypto)',
      async fetchPrices(assets) {
        const out = new Map<string, number>();
        const byCur = new Map<string, string[]>();
        for (const a of assets) byCur.set(a.currency.toLowerCase(), [...(byCur.get(a.currency.toLowerCase()) ?? []), a.symbol.toLowerCase()]);
        for (const [cur, ids] of byCur) {
          const res = await safeFetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=${encodeURIComponent(cur)}`);
          if (!res.ok) throw new Error(`coingecko ${res.status}`);
          const data = (await res.json()) as Record<string, Record<string, number>>;
          for (const id of ids) if (data[id]?.[cur]) out.set(id.toUpperCase(), data[id][cur]);
        }
        return out;
      },
    });
  },
};
