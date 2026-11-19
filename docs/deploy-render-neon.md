# Deploy on Render + Neon (free tier)

A zero-cost setup for a single household: the app runs as a Docker web service on Render, the data lives in a
Neon PostgreSQL database. Uses [`render.yaml`](../render.yaml) and the existing `Dockerfile` — no code changes.

> Free-tier limits change; check the current Render and Neon pricing pages before relying on them.

## 1. Neon database
1. Create a project at neon.tech. Pick region **AWS Asia Pacific (Singapore)** (or the one nearest to you —
   use the same region on Render).
2. Dashboard → **Connect** → copy the connection string with **Connection pooling turned OFF**
   (the host must *not* contain `-pooler`). It looks like
   `postgresql://neondb_owner:…@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.
   If the app fails to connect, remove `&channel_binding=require` from the end.

The default `neondb_owner` role can create roles, so the migrations (which create the RLS role `hearth_app`)
run automatically on first start. Nothing to do in the SQL editor.

## 2. Master key
Generate once on your own machine and **store a copy offline** (password manager). Without it the encrypted data
cannot be read — not even from a database backup.

```bash
node -e "console.log('k' + new Date().getFullYear() + 'a:' + require('crypto').randomBytes(32).toString('base64'))"
```

## 3. Render web service
1. Push this repository to GitHub/GitLab.
2. render.com → **New → Blueprint** → select the repository. Render reads `render.yaml`.
3. Fill in the three secret values when prompted:
   - `DATABASE_URL` — the Neon string from step 1
   - `HEARTH_MASTER_KEYS` — the key from step 2
   - `HEARTH_BASE_URL` — `https://<service-name>.onrender.com` (update it if you add a custom domain later)
4. Deploy. The first build takes a few minutes; open the URL and register — the first account becomes admin.

## How it behaves on free plans
| Topic | What happens | Mitigation |
|---|---|---|
| Render sleeps after ~15 min without traffic | First request after a pause takes ~30–60 s | Acceptable for family use |
| Background jobs (recurring items, alerts, snapshots) | Run only while awake: 5 s after wake-up, then every 15 min | Jobs catch up on the next wake. To keep them on schedule, point a free uptime pinger at `/healthz` every 10–14 min (keeps Neon awake too, so it uses more Neon compute hours) |
| Neon suspends the database when idle | Adds a second or two to the first query | — |
| Container disk is ephemeral | File backups and the mail outbox would vanish on restart, so scheduled backups are off (`HEARTH_BACKUP_INTERVAL_HOURS=0`) | Use Neon's point-in-time restore, plus **Settings → Export** (JSON) regularly |
| E-mail | Only the `outbox` transport exists, so no e-mail is actually sent | Use in-app / Web Push notifications |

## Updating
Push to the connected branch — Render rebuilds and redeploys; pending migrations run on start.
