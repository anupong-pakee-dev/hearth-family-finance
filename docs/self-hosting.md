# Self-hosting

## Requirements
- Docker + Docker Compose v2, 2 vCPU / 4 GB RAM is plenty for a household or a small organisation
- A domain name and a TLS reverse proxy (Caddy, nginx, Traefik)

## Install
```bash
git clone https://github.com/hearth-family-finance/hearth-family-finance.git
```

```bash
cd hearth-family-finance && node deploy/setup.mjs
```

`setup.mjs` generates a random database password and a master encryption key in `deploy/secrets/`
(there are no default passwords). **Copy `deploy/secrets/master_keys` to a safe place outside the server.**
Without it, encrypted fields and backups cannot be read.

Edit `.env` (at least `HEARTH_BASE_URL`), then:
```bash
docker compose up -d
```

The first account you register becomes the instance administrator. You can then switch registration to
invite-only and require 2FA for everyone under **Admin**.

## Reverse proxy (Caddy example)
```
finance.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```
Caddy obtains certificates automatically. The app itself sends HSTS (with preload), CSP and the other security headers.

## Updates
```bash
docker compose pull && docker compose up -d
```
Migrations run automatically at start-up and are reversible (`node apps/web/src/db/migrate.ts down`).

## Backups
Encrypted backups are written to the `backups` volume every `HEARTH_BACKUP_INTERVAL_HOURS` (default 24); the
latest 14 are kept. Admins can also create one from the Admin page. Restore (replaces all data):
```bash
docker compose run --rm app apps/web/scripts/restore.ts /backups/hearth-….hbk --yes
```

## Key rotation
Prepend a new key to `deploy/secrets/master_keys` (`k2:<new>,k1:<old>`) and restart. Then run
`docker compose run --rm app apps/web/scripts/rotate-keys.ts`, and finally remove the old key.

## Plugins
Plugins live in `plugins/` and are off by default (NFR-PRV-03). Enable the ones you want:
```
HEARTH_PLUGINS=notify-telegram,notify-line,notify-discord,notify-webhook,price-coingecko,fx-frankfurter
```
Notification plugins only send for users who add a channel in Settings. Price/FX plugins run once a day and only
for assets whose price source is that plugin. Webhook URLs must be public HTTPS addresses (private IPs are refused).

## Sign-in providers (OIDC)
Admin → *Sign-in providers*: add the issuer URL, client ID and secret; register the redirect URI
`https://<your domain>/auth/oidc/callback` at the provider. Existing users link their account from
*Settings → Security*; new accounts via OIDC are only created when *Allow new sign-ups* is on.

## Master keys from Vault / AWS
Set `HEARTH_KEY_PROVIDER=vault` (`VAULT_ADDR`, `VAULT_TOKEN_FILE`, `VAULT_KV_PATH`, field `master_keys`) or
`HEARTH_KEY_PROVIDER=aws` (`AWS_REGION`, credentials, `HEARTH_AWS_SECRET_ID`). The secret uses the same
`id:base64,old:base64` format, so rotation works the same way.

## E-mail
By default mail is written as `.eml` files to the data directory (`HEARTH_MAIL_TRANSPORT=outbox`); point your
MTA/relay at that directory, or contribute an SMTP transport adapter.
