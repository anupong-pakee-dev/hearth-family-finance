# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/) and [SemVer](https://semver.org/).

## [0.2.0] — 2026-11-18
### Added
- Analytics page: range picker, drill-down, Sankey, category trends, net worth over time, calendar heatmap
- Transaction splits, multi-currency with FX rates, encrypted receipts with metadata stripping, slip/PromptPay QR pre-fill,
  offline entry with background sync, "recorded by" filter, Thai bank / YNAB / Money Lover / Firefly III import presets
- Passkeys (WebAuthn), OpenID Connect sign-in and linking, consented support access
- Web Push, plugin system (LINE, Telegram, Discord, webhook, CoinGecko prices, Frankfurter FX), weekly/monthly summaries,
  subscription price-increase detection
- Per-person and household debt-free dates, net family lending, shared-bucket opt-in, automatic payment roll-over on payoff
- Savings challenges, pending DCA confirmation, FX breakdown, configurable tax-fund limits, dependent portfolios
- Master keys from HashiCorp Vault or AWS Secrets Manager, k6 load test, local Lighthouse runner
### Fixed
- Avalanche now ranks flat-rate loans by their effective rate; line charts support negative values; form labels
  are always tied to their controls; API errors are JSON

## [0.1.0] — 2026-11-17
### Added
- MIT licence (requirements §11 decision #1)
- First release built from requirements v0.4: accounts, transactions, optional buckets, debts with payoff
  strategies, households, savings goals, emergency fund, optional investments, budgets, recurring items,
  notifications, reports, CSV import/export, encrypted backups, Thai/English UI
- Security baseline: Argon2id, TOTP, RLS, IDOR guard, envelope encryption, strict CSP + Trusted Types, audit chain
- Docker Compose deployment, CI security gates, Lighthouse CI configuration
