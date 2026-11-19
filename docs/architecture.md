# Architecture

```
Browser (SSR HTML, ~1.6 KB JS, inline SVG charts, PWA shell)
   │  HTTPS (reverse proxy)
   ▼
Node.js 24 app (apps/web) ── no framework, 2 runtime deps (pg, @electric-sql/pglite)
   ├─ http/      deny-by-default router, body parsing, CSRF, CSP/Trusted Types, Brotli, hashed assets
   ├─ security/  Argon2id · TOTP · sessions · envelope encryption · audit chain · rate limit
   ├─ routes/    server-rendered pages + JSON API v1
   ├─ services/  aggregates (summary), write paths (finance), export/backup, mail
   ├─ jobs/      scheduler (15 min): recurring, reminders, alerts, snapshots, rollover, deletion, backups
   └─ uses ──▶ packages/engine (pure TypeScript, no I/O): money, debt, strategy, savings, emergency, invest, health
   ▼
PostgreSQL 17 (or embedded PGlite for dev/demo) — RLS on every financial table
```

## Key decisions
- **Server-rendered, JavaScript-optional.** Every feature works without JS; JS only adds auto-submit,
  confirm dialogs, double-submit protection and the service worker. This is how we target Lighthouse 100.
- **Finance engine as a pure library.** Money is `bigint` satang, rates are integers (percent × 10 000), and rounding
  is banker's rounding. Projections that need exponentials (XIRR, compound growth) use floats and are labelled as estimates.
- **Multi-tenancy.** A shared database with `owner_id` + `household_id` on every row. Each request runs in a
  transaction as role `hearth_app` with `app.user_id` set, and RLS policies call `hearth_can_read/write()`.
  FK reference-guard triggers stop cross-tenant references.
- **Buckets are optional.** `bucket_id` is nullable everywhere. Turning buckets off only archives them.
- **Balances are snapshots.** Account and bucket balances are maintained by triggers, and net worth is snapshotted daily.
- **Plugins (planned).** Interfaces exist for key providers (`KeyProvider`) and mail transports. Bank
  importers, notification channels, price feeds and OCR will register through the same pattern, so no provider
  is hard-coded in the core.

## Request lifecycle
1. Static asset? → serve pre-compressed, immutable.
2. Match route (unknown → 404). Every route declares `access`.
3. Load session (sha256(token) lookup, idle/absolute expiry), preferences, households, unread count.
4. Enforce access, optional-module gates, 2FA policy, onboarding.
5. Parse the body. Check CSRF + Origin on every POST.
6. Step-up check for sensitive routes.
7. Handler → HTML/JSON → security headers → Brotli.
