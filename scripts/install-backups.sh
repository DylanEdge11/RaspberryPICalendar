#!/usr/bin/env bash
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then
  echo 'Run: sudo bash scripts/install-backups.sh' >&2
  exit 1
fi
cd /opt/family-calendar
test -x /usr/bin/python3
test -d /var/lib/family-calendar
install -d -m 0755 -o root -g root /usr/local/libexec /var/lib/family-calendar-backup
install -d -m 0700 -o root -g root /var/backups/family-calendar
install -m 0755 -o root -g root scripts/nightly-backup.py /usr/local/libexec/family-calendar-backup.py
install -m 0644 -o root -g root systemd/family-calendar-backup.service /etc/systemd/system/family-calendar-backup.service
install -m 0644 -o root -g root systemd/family-calendar-backup.timer /etc/systemd/system/family-calendar-backup.timer
systemctl daemon-reload
systemctl enable --now family-calendar-backup.timer
echo 'Running the first backup now...'
systemctl start family-calendar-backup.service
journalctl -u family-calendar-backup.service -n 3 --no-pager
echo 'Nightly backups enabled (about 3:15 AM). The phone controls show the last backup under Application.'
