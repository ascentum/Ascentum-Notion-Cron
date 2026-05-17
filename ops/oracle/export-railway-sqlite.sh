#!/usr/bin/env bash
set -euo pipefail

backup_dir="${1:-ops/oracle/backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
local_file="${backup_dir}/automation-${timestamp}.sqlite"
remote_file="/tmp/notion-cron-automation-${timestamp}.sqlite"

mkdir -p "$backup_dir"

node_script='const { DatabaseSync } = require("node:sqlite"); const fs = require("fs"); const source = process.env.SQLITE_DB_PATH || "/app/data/automation.sqlite"; const output = process.argv[1]; fs.rmSync(output, { force: true }); const quote = String.fromCharCode(39); const escapedOutput = output.split(quote).join(quote + quote); const db = new DatabaseSync(source); db.exec("PRAGMA wal_checkpoint(FULL)"); db.exec("VACUUM INTO " + quote + escapedOutput + quote); db.close();'

railway ssh -- "node -e '$node_script' '$remote_file'"

railway ssh -- base64 "$remote_file" | base64 --decode > "$local_file"
railway ssh -- rm -f "$remote_file"

chmod 600 "$local_file"
echo "Wrote $local_file"
