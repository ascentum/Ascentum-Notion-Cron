# Oracle Cloud Migration Runbook

This runbook moves the Railway `notion-cron` service to an Oracle Cloud VM running Docker Compose.

## Target Architecture

- Oracle Cloud Always Free Compute VM, preferably `VM.Standard.A1.Flex`.
- Docker Compose runs the Node 24 app and Caddy.
- Caddy terminates HTTPS and proxies to the app on port 3000.
- SQLite is stored on the VM at `/opt/notion-cron/data/automation.sqlite`.
- `ENABLE_SCHEDULER=true` on Oracle, then Railway scheduler is disabled after cutover.

Oracle documents Always Free Ampere A1 as 3,000 OCPU hours and 18,000 GB hours per month, equivalent to 4 OCPUs and 24 GB memory for Always Free tenancies. A 1 OCPU / 6 GB VM is enough for this service and leaves room for other workloads.

## 1. Create Or Choose The VM

Use the Oracle home region for Always Free resources. For this account, the configured OCI profile points to `ap-chuncheon-1`.

Recommended VM:

- Image: Ubuntu 24.04 or Oracle Linux 9.
- Shape: `VM.Standard.A1.Flex`, 1 OCPU, 6 GB RAM.
- Public IPv4: enabled. Prefer a reserved public IP before final cutover.
- Ingress: TCP 22 from your IP, TCP 80 and 443 from `0.0.0.0/0`.
- Boot volume: default is enough; this app's Railway volume is currently under 5 GB.

## 2. Bootstrap The VM

On the VM:

```bash
git clone https://github.com/ascentum/Ascentum-Notion-Cron.git
cd Ascentum-Notion-Cron
bash ops/oracle/bootstrap-ubuntu.sh
newgrp docker
```

## 3. Generate Oracle Env File From Railway

Pick the public host first.

If you do not have a custom domain yet, use `sslip.io`:

```bash
bash ops/oracle/export-railway-env.sh notion-cron.<ORACLE_PUBLIC_IP>.sslip.io
```

This creates `ops/oracle/notion-cron.env`, filters out `RAILWAY_*`, and pins:

- `ENABLE_SCHEDULER=true`
- `NODE_ENV=production`
- `SQLITE_DB_PATH=/app/data/automation.sqlite`
- `APP_BASE_URL=https://<APP_HOST>`

Copy `ops/oracle/notion-cron.env` to the same path on the VM.

## 4. Export Railway SQLite

From this local repository:

```bash
bash ops/oracle/export-railway-sqlite.sh
```

Copy the generated `ops/oracle/backups/automation-*.sqlite` file to the VM, then restore it on the VM:

```bash
bash ops/oracle/restore-sqlite.sh ops/oracle/backups/automation-YYYYMMDDTHHMMSSZ.sqlite
```

The script creates a consistent SQLite copy using Railway SSH, `PRAGMA wal_checkpoint(FULL)`, and `VACUUM INTO`, so WAL files do not need to be copied separately.

## 5. Start Oracle Service

On the VM:

```bash
docker compose --env-file ops/oracle/notion-cron.env -f ops/oracle/docker-compose.yml up -d --build
docker compose --env-file ops/oracle/notion-cron.env -f ops/oracle/docker-compose.yml ps
curl -fsS https://$(grep '^APP_HOST=' ops/oracle/notion-cron.env | cut -d= -f2)/healthz
```

For a no-duplicate staging deployment before Discord cutover, set `ENABLE_SCHEDULER=false` in `ops/oracle/notion-cron.env`, start the stack, and verify `/healthz`. Change it back to `true` only during the final cutover window.

For local Compose validation with the sample environment file:

```bash
APP_ENV_FILE=./notion-cron.env.example \
  docker compose --env-file ops/oracle/notion-cron.env.example -f ops/oracle/docker-compose.yml config
```

## 6. Cut Over Discord

In the Discord Developer Portal, update Interactions Endpoint URL:

```text
https://<APP_HOST>/discord-interact
```

Then verify:

- `GET /healthz` returns `ok: true` and `schedulerEnabled: true`.
- `/snippet` responds in Discord.
- Button interactions work.
- One manual internal run works with `INTERNAL_ADMIN_TOKEN`.

## 7. Stop Railway After Verification

Do this only after Oracle has served the endpoint successfully:

```bash
railway variable set ENABLE_SCHEDULER=false
```

Keep Railway deployed but scheduler-disabled for one day if possible. After the Discord endpoint and scheduled jobs are stable on Oracle, remove the Railway service/subscription from the Railway dashboard.
