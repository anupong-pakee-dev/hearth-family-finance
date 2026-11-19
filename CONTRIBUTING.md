# Contributing

Thanks for helping families manage money better! / ขอบคุณที่ช่วยพัฒนา Hearth

## Development
1. Install Node.js ≥ 24.7. Then `npm install`, `npm run seed:demo` and `npm run dev`.
2. `npm run typecheck && npm test` must pass. Every PR runs the `ci` workflow (typecheck, tests, coverage, gitleaks).
   CodeQL, Semgrep, OSV, licences, Trivy, Postgres migrations and Lighthouse CI run in the `weekly` workflow
   (every Monday, on demand from the Actions tab, and on PRs that change dependencies or the Dockerfile).
3. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).

## Ground rules
- **Money is never a float.** Use `bigint` satang and the helpers in `packages/engine/src/money.ts`.
- **Every route declares `access`.** New financial tables need `owner_id`, `household_id`, RLS policies and reference-guard triggers.
- **Never call `db.system/asUser` inside another transaction.** The DB layer throws if you do.
- **No inline scripts or styles, no third-party assets.** CSP and Trusted Types will block them.
- **Translations:** add keys to both `apps/web/src/i18n/th.json` and `en.json`.
- **Finance formulas** need unit tests with a real-world reference example (NFR-ACC-03).
- **New modules** need a STRIDE entry in `docs/threat-model.md`.

## Bigger changes
Open an RFC issue first for new modules, schema changes or anything that affects security or privacy.

By contributing you agree your work is licensed under the project licence and you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
