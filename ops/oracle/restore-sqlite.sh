#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <automation.sqlite-backup-file>" >&2
  exit 64
fi

backup_file="$1"
data_dir="${DATA_DIR:-/opt/notion-cron/data}"

if [[ ! -f "$backup_file" ]]; then
  echo "Backup file not found: $backup_file" >&2
  exit 66
fi

sudo mkdir -p "$data_dir"
sudo install -m 664 "$backup_file" "${data_dir}/automation.sqlite"
sudo rm -f "${data_dir}/automation.sqlite-wal" "${data_dir}/automation.sqlite-shm"
sudo chown -R 1000:1000 "$data_dir"

echo "Restored SQLite backup to ${data_dir}/automation.sqlite"
