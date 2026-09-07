# Raspberry Pi family calendar

A private, Pi-friendly household display: a readable seven-day calendar beside a rotating family-photo area, with a full-month view and phone controls on the same home Wi-Fi.

The first release is intentionally small. It uses one Node.js service, the built-in SQLite driver, plain browser assets, and `sharp` only for safe server-side photo processing. There is no frontend build step, container, paid cloud service, custom voice assistant, or Spotify player.

## What is here

- A landscape-oriented weekly display at `/`, with a six-week month view.
- Responsive typography and layout designed around a 1080p monitor; the actual monitor should be measured before choosing a larger target.
- Demo mode with clearly labelled local sample content and no account access.
- Phone controls at `/control`, including previous/next/today, week/month switching, week-start preference, slideshow timing, quiet hours, display title, upload, and removal.
- Server-sent updates so a phone view change appears on the display without a manual reload. Browsers without `EventSource` fall back to polling.
- SQLite-backed display settings and photo metadata.
- Protected control mutations using a pairing PIN and an HttpOnly session cookie.
- Photo upload validation, duplicate detection, EXIF orientation correction, resize-to-display, and a 20 MB request limit when `sharp` is installed.
- Read-only Google Calendar OAuth scaffolding for multiple Google accounts and selected calendars. Events are cached in SQLite, recurring instances are requested with `singleEvents=true`, and temporary failures leave the last cache visible.
- Health endpoint: `/api/health`.
- Systemd templates and backup/restore notes for a Pi deployment.

## Architecture and data boundaries

```text
Browser display (/)  ─┐
                      ├── one Node service ── SQLite state/event cache
Phone controls        ─┘                    └─ data/photos + data/secrets
```

The replaceable code tree is separate from household data. Set `APP_DATA_DIR` to a directory outside the checkout in production, normally `/var/lib/family-calendar`. Uploaded originals, resized display JPEGs, SQLite, and Google refresh tokens stay there. Google client credentials live separately, for example `/etc/family-calendar/client_secret.json`.

The display is read-only with respect to Google Calendar. Continue editing events in the Google Calendar apps. The Nest speaker continues to handle Spotify, timers, questions, smart-home actions, and any calendar/list commands it supports; nothing in this app makes the Pi a speaker or causes Nest voice commands to switch this screen. Phone controls are the required fallback.

## Local development

Node.js **22.13 or newer** is required because the app uses the built-in `node:sqlite` module without an experimental flag. Run the version check before installing dependencies:

```sh
node --version
npm --version
npm install
npm run check
npm test
```

The repository includes `package-lock.json`. Run `npm ci` on the development machine for repeatable installs, review dependency changes, and use `npm ci --omit=dev` for locked Pi releases.

Start the labelled demo mode:

```sh
# macOS/Linux
APP_MODE=demo APP_HOST=127.0.0.1 APP_PORT=8080 node server.mjs

# PowerShell
$env:APP_MODE = "demo"
$env:APP_HOST = "127.0.0.1"
$env:APP_PORT = "8080"
node server.mjs
```

Open `http://127.0.0.1:8080/` for the display and `http://127.0.0.1:8080/control` for phone controls. The demo pairing PIN is `1234`; it is deliberately visible in the demo control page and must not be used for production.

To preview from another device on the same network, bind to `0.0.0.0` and open the computer's LAN address. Keep the firewall/private-network boundary in place.

## Production configuration

Copy `.env.example` to a private location or turn it into a systemd environment file. Do not commit it.

```ini
APP_MODE=production
APP_HOST=0.0.0.0
APP_PORT=8080
APP_DATA_DIR=/var/lib/family-calendar
TIMEZONE=America/Regina
ADMIN_PIN=use-a-long-private-pin
CALENDAR_SYNC_INTERVAL_MIN=15
MAX_PHOTOS=500
MAX_PHOTO_STORAGE_BYTES=2147483648
GOOGLE_CLIENT_SECRETS=/etc/family-calendar/client_secret.json
GOOGLE_REDIRECT_URI=http://localhost:8080/api/google/callback
```

Production refuses to start without `ADMIN_PIN`. Port 8080 is plain HTTP on the local network, and display/event/photo reads are intentionally unauthenticated so the kiosk can operate without a login. Never add a router port-forward for it; if the Pi firewall is enabled, restrict the port to the home subnet. This first deployment is intended to stay private to the home network; the app has no TLS termination or public-hosting configuration.

### Google Calendar setup

1. In Google Cloud, create/select a project and enable Google Calendar API.
2. Configure the OAuth consent screen and create a Web application OAuth client. Add the exact `GOOGLE_REDIRECT_URI` to its authorized redirect URIs. Google permits an `http://localhost` callback for a flow started in the Pi's own browser. A phone-initiated flow requires an exact HTTPS callback on a domain you control; a `.local` hostname over HTTP is not a valid general web-app redirect.
3. Put the downloaded client JSON outside the repository and set `GOOGLE_CLIENT_SECRETS` to its path.
4. Start the production service and pair `/control` with the admin PIN. For the private localhost callback, open `http://localhost:8080/control` in the Pi's own Chromium session, pair there, and choose **Connect Google Calendar**; the phone cannot receive a localhost redirect for a service running on the Pi. If you intentionally operate an HTTPS reverse proxy on a domain you control, the connection can instead be initiated from the phone.
5. Complete Google consent in the same browser that started pairing. Repeat the connection for the additional household Google account if needed.
6. Select the calendars to display. The app requests the narrow read-only scope `https://www.googleapis.com/auth/calendar.readonly` and stores refresh tokens under `APP_DATA_DIR/secrets`.
7. Confirm the display shows a real event and that the status pill reports a successful sync.

The implementation uses Google's supported OAuth authorization-code flow and Calendar REST endpoints. It requests `singleEvents=true` and `showDeleted=true`; this expands recurring events and makes cancelled recurring instances available to the sync code. All-day Google events use their date/end-date semantics, while timed events are normalized to `America/Regina` for display. The cache is retained when a sync fails.

Google's OAuth documentation recommends well-tested client libraries for production implementations. This app keeps the dependency footprint small by calling the documented OAuth token and Calendar REST endpoints directly; review the flow before exposing the app beyond a private LAN.

## Raspberry Pi deployment

Do not assume the Pi OS architecture or Node version. On the Pi, run this inspection first:

```sh
uname -m
getconf LONG_BIT
cat /etc/os-release
node --version
command -v node
command -v chromium || command -v chromium-browser
```

Install a distribution-supported Node.js **22.13+** build that matches the reported ARM architecture if the check is too old. Install dependencies on the Pi itself so `sharp` can select/compile a compatible ARM binary; never copy a Windows or x64 `node_modules` directory to the Pi. Install the `sqlite3` command too if you want to use the supplied backup script. A 2 GB Pi 4 should run the service and one Chromium kiosk window, but the memory/latency numbers must be measured on the actual unit.

The current `sharp` installation guidance lists prebuilt Linux ARM binaries when the system's glibc is new enough (Linux ARM: glibc 2.36+, Linux ARM64: glibc 2.28+). Check the Pi's OS/glibc before relying on a prebuilt package; otherwise allow the install to build from source and measure the result. Keep `npm` optional-dependencies enabled because they carry the platform-specific image binaries.

The intended layout is:

```text
/opt/family-calendar/                 replaceable Git checkout
/var/lib/family-calendar/             SQLite, photos, Google tokens
/etc/family-calendar/calendar.env     private configuration
/etc/family-calendar/client_secret.json  private Google OAuth client
```

Example preparation after the version/architecture check:

```sh
sudo useradd --system --user-group --home /var/lib/family-calendar --shell /usr/sbin/nologin family-calendar
sudo install -d -o family-calendar -g family-calendar /var/lib/family-calendar
sudo install -d -m 0750 -o root -g family-calendar /etc/family-calendar
sudo git clone <your-private-github-url> /opt/family-calendar
cd /opt/family-calendar
sudo npm ci --omit=dev
sudo install -m 0640 -o root -g family-calendar .env.example /etc/family-calendar/calendar.env
sudoedit /etc/family-calendar/calendar.env
# After downloading the Google OAuth client JSON:
sudo install -m 0640 -o root -g family-calendar client_secret.json /etc/family-calendar/client_secret.json
sudo -u family-calendar test -r /etc/family-calendar/client_secret.json
```

Edit the service template if `node` or the checkout path differs, then install it:

```sh
sudo install -m 0644 systemd/family-calendar.service /etc/systemd/system/family-calendar.service
sudo systemctl daemon-reload
sudo systemctl enable --now family-calendar.service
curl http://127.0.0.1:8080/api/health
sudo journalctl -u family-calendar.service -f
```

The kiosk template assumes the Pi desktop user is `pi`, the X display is `:0`, and Chromium is `/usr/bin/chromium`; edit those values after checking the commands above. The kiosk is a separate user-session concern from the application service:

```sh
sudo install -m 0644 systemd/family-calendar-kiosk.service /etc/systemd/system/family-calendar-kiosk.service
sudo systemctl daemon-reload
sudo systemctl enable --now family-calendar-kiosk.service
```

If the Pi desktop uses a user systemd session instead of a system service, copy the `ExecStart` line into that user's autostart mechanism instead. Keep the browser to one kiosk window. This template does not power the monitor off; overnight mode only dims the page. Monitor power scheduling belongs to the monitor/desktop layer and is intentionally not claimed as implemented here.

## GitHub-to-Pi update workflow

1. Develop on the computer in demo mode.
2. Run `npm run check` and `npm test`; inspect the display at 1080p and the control page at phone width.
3. Commit and push a reviewed release. Record the commit hash.
4. On the Pi, make a data backup before replacing code.
5. Fetch and fast-forward only; install dependencies on the Pi; restart one service; verify `/api/health` and the display.

```sh
cd /opt/family-calendar
sudo bash scripts/backup.sh
sudo git fetch origin
sudo git pull --ff-only origin main
sudo npm ci --omit=dev
sudo systemctl restart family-calendar.service
curl http://127.0.0.1:8080/api/health
```

`APP_DATA_DIR` is outside the checkout, so normal code updates do not remove photos, settings, event cache, or Google tokens. Never run a checkout/reset command against the data directory.

### Rollback and migrations

Keep the previous good commit hash and the backup directory. If the new code fails:

```sh
sudo systemctl stop family-calendar.service
cd /opt/family-calendar
sudo git checkout <known-good-commit>
sudo npm ci --omit=dev
sudo systemctl start family-calendar.service
curl http://127.0.0.1:8080/api/health
```

The schema has a `schema_version` setting and is currently version 1. Future migrations must be additive, transactional, and tested before release. A migration that changes or removes data is not safely reversible by changing Git commits alone: stop the service, restore the pre-update SQLite backup (and any corresponding photos/secrets backup), then start the known-good code. Do not delete the only backup until the new release has been observed in normal use.

## Backups and restore

Calendar connection maintenance: use **Disconnect account** in phone controls to remove an extra connection. This deletes only that connection's local token and cached calendars/events, never Google events or other connections. Unchecking hides cached events immediately, even during an internet outage. Reconnecting reuses the primary calendar identity and preserves selections, using the existing read-only scope ([Google endpoint](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/get)). Existing duplicates require explicit removal. If an unidentified legacy connection has expired, disconnect it before reconnecting. Disconnect during active sync asks you to retry shortly.

This update makes no schema changes. Reload the display and controls once after updating. Normal rollback uses the previous commit; restoring a removed connection requires the protected data backup.

`scripts/backup.sh` makes a SQLite-consistent copy, writes a portable checksum file, and archives `photos/` and `secrets/` under `/var/backups/family-calendar` by default. It requires the `sqlite3` command. Protect the backup because it contains family photos and Google refresh tokens:

```sh
sudo BACKUP_ROOT=/var/backups/family-calendar bash scripts/backup.sh
```

Also back up `/etc/family-calendar/calendar.env` and the Google client JSON through a separately protected method. The app does not upload backups anywhere.

To restore, stop the service, preserve the current data directory as a safety copy, verify the backup checksum, restore `calendar.sqlite` and the `photos/` and `secrets/` archives into `APP_DATA_DIR`, remove any stale `calendar.sqlite-wal` and `calendar.sqlite-shm` files, fix ownership, and start the matching application commit. Verify the health endpoint, photo list, settings, and calendar connection before removing the safety copy. The restore operation is intentionally manual because overwriting household data is a destructive action.

## Photo handling

Photo labels (the filename/counter overlay) are hidden by default for family photos. In phone controls → Display settings, enable **Show photo labels** and save to restore them. The preference is stored on the Pi and updates the display immediately; demo images always keep their sample label.

Supported inputs are JPEG, PNG, GIF, WebP, AVIF, and HEIC/HEIF only when the Pi's installed `sharp`/libvips build can decode them. The server checks file signatures, rejects unsupported formats, rejects duplicates by SHA-256, limits requests to 20 MB, rejects decoded images over 40 million pixels, corrects EXIF orientation, and writes a display JPEG no larger than 1920×1080. Server-side processing is serialized, and the default collection limit is 500 photos or 2 GiB of original files; adjust the limits only after measuring storage and memory.

iPhone users should try HEIC first after installing the Pi dependencies. If the installed ARM image stack cannot decode it, the control page returns a clear error; export/share as JPEG or PNG rather than assuming every iPhone photo is JPEG. Existing uploaded photos are local and continue cycling without internet access.

## Google Photos import (optional)

Google changed the Photos APIs in 2025. The Library API now focuses on content created by the app, and the old broad `photoslibrary.readonly`/sharing scopes are no longer the dependable way to enumerate a user's existing daily album. The supported Picker API lets a user explicitly select photos from their library, but it is an interactive selection flow with a session, not a silent “watch this album forever” feed. Google also says picked media URLs are temporary and should not be cached as a permanent source.

**Import from Google Photos** is implemented in phone controls using the Picker API. It imports selected photos rather than subscribing to an album. Search by album title in Google's picker, then select photos; one-click whole-album selection is not promised. Google's Ambient API requires partner acceptance and is not used here.

One-time setup:

1. In the same Google Cloud project as Calendar, enable **Google Photos Picker API**.
2. In **Google Auth Platform → Data Access**, add `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`. Keep the Calendar permission. If the project is in Testing, add the Photos account as a test user.
3. Keep the existing web client JSON and `GOOGLE_REDIRECT_URI=http://localhost:8080/api/google/callback`; no new redirect or environment variable is needed.
4. On the Pi, open `http://localhost:8080/control` in Chromium, enter the PIN, and click **Connect Google Photos**. Grant the selected-photos permission. This separate connection does not add a Calendar account.

Regular phone imports:

1. Open the Pi controls on home Wi-Fi and click **Choose from Google Photos**, then **Open Google Photos selection**.
2. Sign in with the same Photos account authorized on the Pi. Search the album title, select photos, and tap **Done**.
3. Return to the controls tab and click **Import selected photos** when ready. The Pi downloads and saves the photos; the phone can sleep after import starts.

Limits and privacy: one shared household Photos connection and import at a time, up to 100 selections per batch; videos skipped. Photos are requested at up to 1920×1080 with a 20 MB download limit, existing decoded-pixel/storage quotas, and serialized image processing. Imported files are display-sized copies rather than an archive of camera originals. Repeated Google media IDs are skipped even after restart; exact byte duplicates are also rejected. Photos remain on the Pi and cycle offline. Temporary Google URLs are not used as permanent slideshow URLs. Copies are visible on the private LAN like ordinary uploads; never expose this service publicly.

The separate refresh token is stored at `APP_DATA_DIR/secrets/google-photos-picker.json`, covered by existing private permissions/backups. Paired household controls can initiate imports. **Disconnect Google Photos** removes the local connection; imported copies stay until removed from the photo list. Google photos are never deleted. No extra subscription or automatic album watch. Testing-mode access can expire after seven days; reconnect on the Pi when required.

Selection sessions/progress are in memory. If the Pi restarts during a selection/import, saved photos remain; select the unfinished batch again and duplicates will be skipped. Expired selections can be cancelled/replaced. Failed Google session cleanup is reported and Google eventually expires it. No database migration; rollback to the prior commit preserves household data.

Verification: mocked Google session/import tests and real local image-processing tests pass. Controls and the simulated import flow were inspected in headless Edge at 390×844, 412×915 and 1920×1080 without page errors or horizontal overflow. Live Photos consent/import, actual mobile browsers and Pi import memory require owner verification.

Primary references: [Google Calendar Node.js quickstart](https://developers.google.com/workspace/calendar/api/quickstart/nodejs), [Calendar events.list](https://developers.google.com/calendar/api/v3/reference/events/list), [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Google Photos API updates](https://developers.google.com/photos/support/updates), [Photos Picker API](https://developers.google.com/photos/picker/guides/sessions), and [Photos Library listing guidance](https://developers.google.com/photos/library/guides/list).

## Optional voice-controlled view switching

The current Google Home automation action list includes Assistant starters and supported device/media/notification actions, but not an arbitrary authenticated HTTP request to a private LAN app. That means a simple “show the month” Google Home Routine cannot safely call this service directly. This was not added to the core build.

The supported-looking bridge is Home Assistant: expose an `input_select`, scene, or script through its Google Assistant integration, then have a Home Assistant automation call a narrowly scoped local endpoint on this app. The trade-offs are substantial for this hardware: Home Assistant becomes another service competing with Chromium and the calendar on a 2 GB Pi; the documented manual Google Assistant setup requires an externally reachable hostname and SSL; Home Assistant Cloud avoids that setup but becomes a paid subscription after its trial. A future bridge should use a dedicated random token/webhook, keep it local-only, and be load-tested before sharing the Pi with Home Assistant. Until then, use the paired phone controls. Do not treat the Nest speaker as able to control this screen automatically.

References: [Google Home supported automation actions](https://developers.home.google.com/automations/starters-conditions-and-actions), [Google Home scripted automations](https://support.google.com/googlehome/answer/13323253), [Home Assistant Google Assistant integration](https://www.home-assistant.io/integrations/google_assistant), and [Home Assistant local-only webhooks](https://www.home-assistant.io/docs/automation/trigger/).

## Verification status

What can be verified on a normal Node development machine:

- `npm run check` checks all JavaScript files.
- `npm test` covers week-start calculations, month boundary navigation, six-week month ranges, explicit demo events, unauthenticated mutation rejection, PIN login, persisted view changes, and event API ranges.
- Browser inspection completed here at the available 1146×856 Codex browser viewport; `/` and `/control` were visually inspected, and week/month, navigation, today, week-start, SSE updates, and persistence were exercised. A true 1920×1080 kiosk viewport and device-emulated iPhone/Android widths still need to be checked on the target hardware/browser.

Not claimed until performed on the actual hardware/accounts:

- Raspberry Pi OS architecture-specific install, `sharp` ARM decoding, memory use with Chromium, kiosk restart after reboot, monitor behavior, or performance at a resolution other than the initial 1080p target.
- Live Google OAuth, personal/shared/additional-account calendars, recurring exceptions from a real account, outage/recovery against Google, or real iPhone HEIC uploads.
- Nest speaker voice commands or any voice-controlled screen switching. No voice route is included in this release.
