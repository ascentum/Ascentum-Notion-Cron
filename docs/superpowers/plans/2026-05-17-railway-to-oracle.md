# Railway To Oracle Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `notion-cron` production service from Railway Hobby to Oracle Cloud while preserving scheduler state, Discord interactions, and SQLite data.

**Architecture:** Run the existing Node 24 Express scheduler inside Docker on an Oracle Always Free VM. Use Caddy for HTTPS and a host bind mount for `/app/data/automation.sqlite`.

**Tech Stack:** Node 24, TypeScript, Express, SQLite via `node:sqlite`, Docker Compose, Caddy, Railway CLI, OCI CLI.

---

### Task 1: Containerize The App

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [x] **Step 1: Add a Node 24 Dockerfile**

Build TypeScript in a full dependency stage, install production dependencies in runtime, expose port 3000, and run `node dist/src/server.js`.

- [x] **Step 2: Add Docker ignore rules**

Exclude local build output, local env files, data, `node_modules`, and Oracle backup artifacts.

- [x] **Step 3: Verify image build**

Run:

```bash
docker build -t notion-cron:oracle .
```

Expected: image builds successfully with `npm run build`.

### Task 2: Add Oracle Runtime Composition

**Files:**
- Create: `ops/oracle/docker-compose.yml`
- Create: `ops/oracle/Caddyfile`
- Create: `ops/oracle/notion-cron.env.example`

- [x] **Step 1: Add Docker Compose services**

Create `notion-cron` and `caddy` services. Mount SQLite at `/app/data`, expose only Caddy ports 80/443, and healthcheck `/healthz`.

- [x] **Step 2: Add Caddy HTTPS proxy**

Proxy `https://$APP_HOST` to `notion-cron:3000`.

- [x] **Step 3: Add an environment template**

Include app, Notion, Discord, OpenAI, and GCS variables without secret values.

### Task 3: Add Migration Scripts

**Files:**
- Create: `ops/oracle/export-railway-env.sh`
- Create: `ops/oracle/export-railway-sqlite.sh`
- Create: `ops/oracle/restore-sqlite.sh`
- Create: `ops/oracle/bootstrap-ubuntu.sh`

- [x] **Step 1: Export Railway variables**

Generate `ops/oracle/notion-cron.env`, filter `RAILWAY_*`, and pin Oracle runtime defaults.

- [x] **Step 2: Export a consistent SQLite backup**

Use Railway SSH with `PRAGMA wal_checkpoint(FULL)` and `VACUUM INTO`, then base64-transfer the backup locally.

- [x] **Step 3: Restore SQLite on the VM**

Install the backup to `/opt/notion-cron/data/automation.sqlite`, remove stale WAL/SHM files, and chown to UID 1000.

- [x] **Step 4: Bootstrap Docker on Ubuntu**

Install Docker Engine and the Compose plugin, then create `/opt/notion-cron/data`.

### Task 4: Provision Oracle

**Files:**
- Modify: `ops/oracle/docker-compose.yml`
- Modify: `ops/oracle/README.md`

- [x] **Step 1: Refresh OCI CLI auth**

The local `archy-oci` profile currently has an expired session. Refresh before provisioning.

- [x] **Step 2: Create or select an Always Free VM**

`VM.Standard.A1.Flex` failed with `Out of host capacity` in `ap-chuncheon-1`, so the zero-cost path selected the existing `archy-ops-cron` Always Free candidate VM. Attached the web NSG to that VM's VNIC and opened 80/443 in UFW.

- [x] **Step 3: Deploy and verify**

Run Docker Compose on the VM and verify:

```bash
curl -fsS https://<APP_HOST>/healthz
```

Expected: JSON includes `ok: true` and `schedulerEnabled: true`. Verified at `https://notion-cron.168.110.123.188.sslip.io/healthz`.

### Task 5: Cut Over And Retire Railway

**Files:**
- Modify: `README.md`

- [x] **Step 1: Update Discord Application Endpoint**

Set interactions endpoint through Discord's `PATCH /applications/@me` API to `https://notion-cron.168.110.123.188.sslip.io/discord-interact`.

- [x] **Step 2: Disable Railway scheduler**

Run:

```bash
railway variable set ENABLE_SCHEDULER=false --skip-deploys
railway down -y
```

- [x] **Step 3: Update README operations references**

Replace Railway production URL and deployment notes with Oracle Cloud operations after the new URL is known.
