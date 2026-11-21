# Threat model (STRIDE) — NFR-SEC-35

Scope: a self-hosted instance (reverse proxy → Node app → PostgreSQL) used by a few families.
Assets: financial records, credentials, encryption keys, household relationships.

| Component / flow | Threat (STRIDE) | Mitigation | Where |
|---|---|---|---|
| Login | **S**poofing: credential stuffing, brute force | Argon2id, rate limits per IP + e-mail, exponential delay, 15-min lock after 10 failures, identical errors + dummy hash for unknown e-mails, TOTP | `routes/auth.ts`, `security/ratelimit.ts` |
| Session | **S**/**E**: session theft or fixation | Random 256-bit token, only sha256 stored, `__Host-` + HttpOnly + Secure + SameSite=Strict, new session on login/MFA/privilege change, idle + absolute expiry, revoke UI | `security/session.ts` |
| Forms | **T**ampering: CSRF | Synchronizer token per session / double-submit for guests, Origin check, SameSite=Strict | `server.ts` |
| Any resource by id | **I**nformation disclosure: IDOR | UUIDs, app-level checks, PostgreSQL RLS as hearth_app, FK reference-guard triggers, errors mapped to 404 | `db/migrations/*.sql`, tests |
| Household sharing | **E**levation: viewer writes, member escalates | Role checks in app + `hearth_can_write/manage` policies; role changes need step-up and are audited | `routes/household.ts` |
| Admin | **I**: admin reads user finances | No admin route touches financial tables; hearth_app has no rights on `users` | `routes/admin.ts` |
| Pages | **T**/**E**: XSS | Auto-escaping templates, nonce CSP + strict-dynamic, Trusted Types, no inline handlers or styles | `views/html.ts`, `http/headers.ts` |
| DB at rest / backups | **I**: stolen disk or backup | Field encryption (account no., notes, creditor, TOTP secret) with per-user keys wrapped by an external master key; backups always encrypted | `security/keys.ts`, `services/backup.ts` |
| Account deletion | **I**: data remnants | All owned rows hard-deleted in one transaction (cascade); shared households handed to a remaining member first; only the append-only audit_log keeps the event. The scheduler still purges legacy soft-deleted accounts | `services/users.ts`, `jobs/scheduler.ts` |
| Logs | **I**: secrets in logs | Key-based redaction (passwords, tokens, amounts, account numbers, e-mails), no request bodies logged | `log.ts` |
| Audit trail | **R**epudiation / **T**ampering | Append-only trigger + SHA-256 hash chain, verified on the admin page | `security/audit.ts` |
| Availability | **D**oS | Body size limits, rate limits, server-side pagination, bounded simulations (600 months) | `http/body.ts`, engine |
| Passkeys | **S**: cloned or phished authenticators | Origin + RP ID hash checks, user verification required, signature counter must increase, challenges single-use (10 min) | `security/webauthn.ts` |
| OIDC | **S**/**E**: login CSRF, code injection, token substitution, account takeover by e-mail | state cookie (SameSite=Lax) bound to a stored challenge, PKCE S256, nonce, JWKS signature + iss/aud/exp checks, no automatic linking by e-mail | `security/oidc.ts`, `routes/identity.ts` |
| Receipts | **T**/**I**: polyglot/HTML uploads, GPS in photos | Content sniffing, size cap, metadata stripping, encrypted at rest, `attachment` + sandbox CSP | `services/attachments.ts` |
| Webhook / plugin channels | **I**/**E**: SSRF to internal services, data leaving the server | https only, DNS-resolved private/loopback/link-local addresses refused, no redirects, user-enabled only, config encrypted | `services/plugins.ts` |
| Support access | **I**: admin snooping | Only with the user's time-limited grant to a named admin, read-only summary, every view audited | `routes/admin.ts` |
| Offline queue | **I**: data left on a shared device | Only the add-transaction form is cached; queue and cache wiped on sign-out | `public/sw.js` |
| Supply chain | **T** | 2 runtime dependencies, lockfile, OSV/Trivy/CodeQL/Semgrep/gitleaks in CI, SBOM, signed images | `.github/workflows` |

Residual risks / TODO: external pen test (NFR-SEC-36), Redis-backed rate limits for multi-instance deployments,
DNS-rebinding window between the SSRF check and the webhook request.
