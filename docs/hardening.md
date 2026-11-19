# Hardening guide (NFR-SEC-38)

1. **TLS only.** Terminate TLS 1.2+ (prefer 1.3) at the reverse proxy; redirect port 80 to 443. Set
   `HEARTH_BASE_URL=https://…` so cookies get `Secure` + `__Host-` and HSTS is sent. Submit the domain to the HSTS preload list.
2. **Firewall.** Expose only 443 (and 80 for ACME). The app listens on `127.0.0.1:3000`. PostgreSQL is on an
   internal Docker network with no published port.
3. **Secrets.** Keep `deploy/secrets/*` mode 600, owned by root. Store a copy of the master key offline. Never
   put secrets in `.env` committed to git.
4. **Database role.** The app logs in as a non-superuser `hearth` (no BYPASSRLS) and switches to `hearth_app`
   for every request, so Row-Level Security always applies.
5. **Containers.** Distroless, non-root (65532), read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`.
   Verify image signatures: `cosign verify ghcr.io/hearth-family-finance/hearth:<tag> --certificate-identity-regexp '.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.
6. **Accounts.** Turn on *Require 2FA for everyone* and *invite-only* in Admin once your family has joined.
7. **Updates.** Subscribe to GitHub security advisories for the repository; apply releases promptly.
8. **Backups.** Copy the encrypted `backups` volume off-site regularly. Test a restore on a spare machine.
9. **Monitoring.** Scrape `/healthz`. Logs are JSON on stdout and never contain amounts, tokens or passwords.
10. **Headers check.** After deployment, verify Mozilla Observatory and securityheaders.com both report A+.
