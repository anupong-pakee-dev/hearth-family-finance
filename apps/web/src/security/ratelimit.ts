/**
 * Brute-force protection (NFR-SEC-07): sliding-window rate limit + exponential delay.
 * In-memory (single instance). Multi-instance deployments can swap in a Redis-backed store.
 */
interface Bucket { hits: number[]; failures: number }
const store = new Map<string, Bucket>();

export function hit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const b = store.get(key) ?? { hits: [], failures: 0 };
  b.hits = b.hits.filter((t) => now - t < windowMs);
  b.hits.push(now);
  store.set(key, b);
  return b.hits.length <= limit;
}

export function recordFailure(key: string): number {
  const b = store.get(key) ?? { hits: [], failures: 0 };
  b.failures += 1;
  store.set(key, b);
  return b.failures;
}

export function clearFailures(key: string) {
  const b = store.get(key);
  if (b) b.failures = 0;
}

/** Exponential delay: 0, 0, 0, 250ms, 500ms, 1s, 2s … capped at 8 s. */
export function delayFor(key: string): number {
  const f = store.get(key)?.failures ?? 0;
  if (f < 3) return 0;
  return Math.min(8_000, 250 * 2 ** (f - 3));
}

export function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of store) if (b.failures === 0 && b.hits.every((t) => now - t > 3_600_000)) store.delete(k);
}, 600_000).unref();
