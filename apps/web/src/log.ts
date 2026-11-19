/**
 * Structured JSON logging with redaction (NFR-OPS-03, NFR-SEC-17).
 * Never log passwords, tokens, amounts or account numbers: any key matching SENSITIVE is replaced.
 */
const SENSITIVE = /pass|token|secret|otp|code|cookie|authorization|amount|balance|account_?no|iban|card|salary|income|key|csrf|note|creditor|email/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'bigint') return '[redacted]';
  return value;
}

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const min = levels[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (levels[level] < min || process.env.HEARTH_SILENT === '1') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(fields ? (redact(fields) as object) : {}) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
};
