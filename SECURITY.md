# Security policy

## Reporting a vulnerability

**Please do not open public issues for security problems.** Use GitHub's
[Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository ("Security" tab → "Report a vulnerability").

| Step | Target |
|---|---|
| Acknowledgement | within **72 hours** |
| Triage + severity (CVSS) | within 7 days |
| Fix for **Critical** | within **7 days** |
| Fix for High | within 30 days |
| Disclosure | GitHub Security Advisory + CVE once a fix is released |

We credit reporters in the advisory unless you prefer otherwise. Good-faith research that respects user
privacy, avoids data destruction and gives us reasonable time to fix is welcome and will not be pursued legally.

## Supported versions

Only the latest minor release receives security fixes until v1.0.

## Security design (summary)

- OWASP ASVS 5.0 Level 2 target (Level 3 for authentication, sessions, authorization and cryptography)
- Argon2id passwords (19 MiB, t=2), NIST 800-63B policy, offline breached-password list
- TOTP 2FA + recovery codes, step-up re-authentication for sensitive actions
- `__Host-` session cookies (HttpOnly, Secure, SameSite=Strict), 30 min idle / 7 day max, rotation on login & privilege change
- Deny-by-default routing + PostgreSQL Row-Level Security + FK reference guard (IDOR)
- Field-level AES-256-GCM envelope encryption with per-user data keys and crypto-shredding
- Strict nonce-based CSP with `strict-dynamic`, Trusted Types, no third-party assets
- Hash-chained, append-only audit log

See [docs/threat-model.md](docs/threat-model.md) and [docs/hardening.md](docs/hardening.md).
