# Hearth Family Finance

> **จัดการเงินทั้งบ้าน แบ่งก้อน ออม ลงทุน ปลดหนี้ไปด้วยกัน**
> *Open-source money manager for the whole family — budget, save, invest and get out of debt together.*

Hearth is a self-hosted, privacy-first personal & family finance app. It's built from the
[requirements document v0.4](../Requirements/hearth-family-finance-requirements.md).

- **Optional money buckets** (off / partial / full envelope budgeting). Every other feature works without them.
- **Debts**: reducing balance, flat-rate hire purchase, credit card (daily interest + minimum %), interest-free.
  Also debt-free date, amortization schedule, what-if extra or lump-sum payments, refinance comparison,
  rate changes over time, and a **Snowball / Avalanche / custom** payoff plan.
- **Family**: households, roles (owner / manager / member / viewer / dependent) and per-item sharing.
  Debts can have co-payers with a record of who paid what. Members can leave without losing their own data.
- **Savings goals** with required monthly saving, a forecast and on-track status.
  **Emergency fund** runway with 1/3/6-month tiers and refill plans.
- **Investments** (optional): portfolios, average-cost or FIFO cost basis, realised/unrealised P/L, XIRR,
  allocation and rebalance, DCA reminders, 3-scenario projection and a retirement calculator.
  It is a record-keeping tool only, never advice.
- **Dashboard & Analytics** with server-rendered SVG charts (no chart JavaScript): Sankey cash flow, category
  trends, net worth over time, calendar heatmap, range picker and drill-down. Budgets, recurring bills and
  subscription detection, 3-month cash-flow forecast, reports, Financial Health Score.
- **Transactions**: splits, multi-currency with FX rates, encrypted receipts (metadata stripped), PromptPay/slip QR
  pre-fill on the device, offline entry with background sync, CSV import with Thai bank / YNAB / Money Lover /
  Firefly III presets.
- **Sign-in**: password + TOTP, **passkeys**, **OpenID Connect** (admin-configured), consented support access.
- **Notifications**: in-app, e-mail, **Web Push**, plus LINE / Telegram / Discord / webhook plugins.
- **Lighthouse 100/100/100/100** on every key page (mobile, cold cache), ~20 KB per page.

## Quick start (development)

Requires **Node.js ≥ 24.7** (built-in TypeScript type stripping and `crypto.argon2`). No database is needed:
when `DATABASE_URL` is empty, an embedded PostgreSQL (PGlite) is stored in `./data`.

```bash
npm install
```

```bash
npm run seed:demo
```

```bash
npm run dev
```

Open http://localhost:3000. The first account registered becomes the instance admin.
The demo login (development only) is `family@hearth.test`, with the password defined in
`apps/web/scripts/seed-demo.ts`. Outgoing mail (verification, reset, invites) is written to `data/outbox/*.eml`.

## Production (one command)

```bash
node deploy/setup.mjs
```

```bash
docker compose up -d
```

Then put a TLS reverse proxy in front of `127.0.0.1:3000`. See [docs/self-hosting.md](docs/self-hosting.md)
and [docs/hardening.md](docs/hardening.md).

## Project layout

| Path | What |
|---|---|
| `packages/engine` | Pure, I/O-free finance engine (money in integer satang, banker's rounding): debt, payoff strategies, savings, emergency, investments, health score |
| `apps/web/src/db` | PostgreSQL schema, reversible migrations, **Row-Level Security**, IDOR reference guard |
| `apps/web/src/security` | Argon2id, TOTP + recovery codes, sessions, envelope encryption (AES-256-GCM), hash-chained audit log, rate limiting |
| `apps/web/src/http` | Tiny dependency-free HTTP layer: deny-by-default routing, CSRF, strict CSP + Trusted Types, Brotli |
| `apps/web/src/routes` | Server-rendered pages (dashboard, transactions, buckets, debts, goals, emergency, invest, budget, recurring, household, reports, settings, admin, API) |
| `apps/web/src/jobs` | Scheduler: recurring items, reminders, budget alerts, snapshots, rollover, deletion, backups |
| `apps/web/src/i18n` | `th.json` / `en.json` (Weblate/Crowdin friendly) |
| `plugins/` | Optional plugins (notification channels, price and FX feeds, import presets), enabled with `HEARTH_PLUGINS` |
| `docs/` | Architecture, threat model, self-hosting, hardening, API, requirements status |

## Scripts

| Command | |
|---|---|
| `npm test` | Engine + security + end-to-end tests (in-memory PostgreSQL) |
| `npm run test:coverage` | Engine coverage gate (≥ 80 %) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` / `node apps/web/src/db/migrate.ts down` | Apply / roll back migrations |
| `npm run seed:demo` (`DEMO_TXNS=50000` for the perf profile) | Demo family data |
| `npm run rotate-keys` | Re-wrap data keys after adding a new master key |
| `npm run restore -- file.hbk --yes` | Restore an encrypted backup |
| `npm run lighthouse:local` (`LH_URLS=/,/debts LH_RUNS=3`) | Lighthouse on the seeded demo, fails below 100 |
| `k6 run deploy/k6/load.js -e BASE=…` | Load test against staging (NFR-PERF-20) |

## Status

All functional requirements of v0.4 are implemented. See [docs/requirements-status.md](docs/requirements-status.md)
for the requirement-by-requirement list and the few items that need external people or infrastructure
(independent pen test, staging load test, public-domain header scans).

## License

MIT (requirements §11 decision #1). See [LICENSE](LICENSE).
