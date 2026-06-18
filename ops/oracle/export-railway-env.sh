#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <app-host-without-scheme>" >&2
  echo "Example: $0 notion-cron.203.0.113.10.sslip.io" >&2
  exit 64
fi

app_host="$1"
output_file="ops/oracle/notion-cron.env"
tmp_file="$(mktemp)"

cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

railway variable list --kv > "$tmp_file"

{
  echo "# Generated from Railway production variables."
  echo "# Do not commit this file."
  echo "APP_HOST=${app_host}"
  echo "APP_BASE_URL=https://${app_host}"
  echo "NODE_ENV=production"
  echo "PORT=3000"
  echo "ENABLE_SCHEDULER=true"
  echo "ENABLE_MEETING_PAGE_AUTO_CREATE=false"
  echo "SQLITE_DB_PATH=/app/data/automation.sqlite"
  echo "DATA_DIR=/opt/notion-cron/data"
  grep -E -v '^(APP_BASE_URL|NODE_ENV|PORT|ENABLE_SCHEDULER|ENABLE_MEETING_PAGE_AUTO_CREATE|SQLITE_DB_PATH|DATA_DIR|APP_HOST|RAILWAY_.*)=' "$tmp_file" || true
} > "$output_file"

chmod 600 "$output_file"
echo "Wrote $output_file"
