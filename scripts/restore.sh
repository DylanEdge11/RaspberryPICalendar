#!/usr/bin/env bash
set -euo pipefail
umask 077

backup_dir="${1:-}"
data_dir="${APP_DATA_DIR:-/var/lib/family-calendar}"

if [[ -z "${backup_dir}" || ! -d "${backup_dir}" ]]; then
  echo "Usage: APP_DATA_DIR=/var/lib/family-calendar $0 /path/to/backup" >&2
  exit 2
fi
if [[ ! -f "${backup_dir}/calendar.sqlite" ]]; then
  echo "Backup does not contain calendar.sqlite" >&2
  exit 1
fi

echo "Restore is destructive for the selected APP_DATA_DIR: ${data_dir}"
echo "Stop the service and make a safety copy before continuing."
read -r -p "Type RESTORE to continue: " confirmation
[[ "${confirmation}" == "RESTORE" ]] || { echo "Restore cancelled"; exit 1; }

if [[ -f "${backup_dir}/SHA256SUMS" ]]; then
  (cd "${backup_dir}" && sha256sum -c SHA256SUMS)
fi

mkdir -p "${data_dir}"
cp -f "${backup_dir}/calendar.sqlite" "${data_dir}/calendar.sqlite"
rm -f -- "${data_dir}/calendar.sqlite-wal" "${data_dir}/calendar.sqlite-shm"
if [[ -f "${backup_dir}/photos.tgz" ]]; then
  tar -C "${data_dir}" -xzf "${backup_dir}/photos.tgz"
fi
if [[ -f "${backup_dir}/secrets.tgz" ]]; then
  tar -C "${data_dir}" -xzf "${backup_dir}/secrets.tgz"
fi
echo "Restore completed. Fix ownership and start the service using the matching application commit."
