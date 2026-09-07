#!/usr/bin/env bash
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then
  echo 'Run: sudo bash scripts/install-phone-updates.sh' >&2
  exit 1
fi
cd /opt/family-calendar
for executable in /usr/bin/python3 /usr/bin/git /usr/bin/npm /usr/bin/node /usr/sbin/runuser; do
  test -x "${executable}"
done
test -f /etc/family-calendar/calendar.env
test -d /var/lib/family-calendar
install -d -m 0755 -o root -g root /usr/local/libexec /var/lib/family-calendar-updater
install -d -m 0700 -o root -g root /var/backups/family-calendar
install -m 0755 -o root -g root scripts/phone-update.py /usr/local/libexec/family-calendar-update.py
install -m 0644 -o root -g root systemd/family-calendar-update.service /etc/systemd/system/family-calendar-update.service
install -m 0644 -o root -g root systemd/family-calendar-update.path /etc/systemd/system/family-calendar-update.path
/usr/bin/python3 -c "import runpy; runpy.run_path('/usr/local/libexec/family-calendar-update.py')['verify_layout']()"
systemctl daemon-reload
systemctl enable --now family-calendar-update.path
install -m 0644 -o root -g root /dev/null /var/lib/family-calendar-updater/enabled
echo 'Phone updates enabled. Refresh the phone controls.'
