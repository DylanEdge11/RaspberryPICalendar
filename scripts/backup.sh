#!/usr/bin/env bash
set -euo pipefail
umask 077

data_dir="${APP_DATA_DIR:-/var/lib/family-calendar}"
backup_root="${BACKUP_ROOT:-/var/backups/family-calendar}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${backup_root}/${stamp}"

if [[ ! -f "${data_dir}/calendar.sqlite" ]]; then
  echo "No SQLite database found at ${data_dir}/calendar.sqlite" >&2
  exit 1
fi

mkdir -p "${backup_dir}"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${data_dir}/calendar.sqlite" ".backup '${backup_dir}/calendar.sqlite'"
else
  echo "sqlite3 is required for a consistent database backup" >&2
  exit 1
fi

if [[ -d "${data_dir}/photos" ]]; then
  tar -C "${data_dir}" -czf "${backup_dir}/photos.tgz" photos
fi
if [[ -d "${data_dir}/secrets" ]]; then
  tar -C "${data_dir}" -czf "${backup_dir}/secrets.tgz" secrets
fi
(cd "${backup_dir}" && sha256sum -- * > SHA256SUMS)
chmod -R go-rwx "${backup_dir}"
echo "Backup written to ${backup_dir}"
