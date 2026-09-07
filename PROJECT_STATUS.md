# Project status

Updated: 2026-09-06

## Architecture

- Single Node.js service in `server.mjs`.
- Built-in `node:sqlite`; one SQLite database under `APP_DATA_DIR`.
- Plain static HTML/CSS/JS under `static/`; no frontend build step.
- `sharp` is the only runtime package and is loaded optionally so the demo display can run without it. Photo-processing tests and uploads require `npm ci` first.
- Persistent data is outside replaceable code: SQLite, original photos, resized display JPEGs, and Google token files.
- Default timezone is `America/Regina`; production is intended to remain private to the home network.

## Completed

- Per-calendar local colour pickers in paired phone controls, automatic save, reset to Google colour, authenticated/validated API and immediate cached-event/legend updates. Overrides use `settings` keys `calendar_color:<source-id>`; no schema migration. Google source refresh does not replace overrides; disconnect removes them. No writes to Google calendars.
- Colour verification: 18 Node tests pass, including API authentication/validation, independent choices, persisted/reopened database values, reset, cached-event colour precedence and source colour changes. Browser visual check was blocked by the local browser runtime sandbox initialization error; actual iPhone/Android picker and Pi display need owner verification. No live Google or Pi tests claimed for this release.
- Configurable weekly start/end hours in paired phone settings: integer hours 0–24, end after start, existing 6–22 default, persisted SQLite settings, immediate live display updates, dynamic hourly grid and corrected boundary clipping. Full-day and 11 PM–midnight supported; month/all-day unchanged. No schema or updater-helper changes.
- Weekly-hours verification: 17 Node tests pass (validation, persisted database values, unchanged month period included). Headless Edge inspected at 1920×1080 and phone width 390: full 24-hour grid, live switch to a one-hour range, and a mocked 11 PM event visible through midnight. Phone midnight option fits after layout correction. Actual phone updater and Pi rendering still require owner verification.
- Phone application updates: authenticated request/status API, mobile confirmation/progress, root-owned fixed-purpose systemd updater, clean-origin/ancestry checks, stopped-service private backup including configuration, dependency/syntax/health checks, and schema-aware rollback attempt. Display reloads on backend instance changes. One-time Pi installer required; helper upgrades remain manual. No schema migration.
- Current verification: 16 Node tests and 6 mocked Python updater tests pass. Mobile update request/progress/completion inspected in headless Edge at 390×844 with no page errors or horizontal overflow. Actual Pi update/backup/recovery and reboot are not tested here. See README phone-update setup and recovery instructions.
- Photo filename/counter overlays are hidden by default for real photos. Phone setting **Show photo labels** persists in SQLite and updates the display live. Demo image labels remain visible. Owner reports Google Photos Picker is now working on the Pi.

- Google Photos Picker manual import: separate Photos OAuth using existing callback/client, phone selection/search, explicit import, progress, expiry/cancel/disconnect, pagination and persistent-ID duplicate skips. One connection and import at a time; 100-item batch, sequential bounded downloads through shared image pipeline. Local saved photos; no automatic album subscription. No database migration.
- Photos verification: 15 tests pass with mocked Google responses plus real PNG upload/resize/duplicate/delete. Phone-sized rendering and selection/import flow checked with Playwright/headless Edge at 390×844, 412×915, and 1920×1080 (no horizontal overflow or JS errors). Live Google Photos consent/downloads on Pi, actual Safari/Android Chrome, and Pi memory under import remain untested.
- Photos next setup: enable Google Photos Picker API and its selected-items scope; connect once on Pi at localhost/control, then select/import from phone. See README. Sessions/jobs are in memory; after restart select unfinished photos again. Completed files and duplicate IDs persist. Local Photos disconnect keeps imported files.

- Calendar maintenance update: authenticated disconnect with local token/cache removal; reconnect reuses the primary calendar identity including legacy accounts; unchecked calendars are filtered from cached display results immediately. Existing duplicates require explicit removal. No schema migration.
- Regression verification: syntax checks and 8 tests pass, including mocked reconnect/legacy identity, retained refresh token and selection, hidden-event filtering, disconnect isolation/cascade/token deletion, and unauthenticated DELETE rejection. New maintenance behaviour needs owner verification on the Pi with live Google.
- Owner confirms Pi service, phone controls and live Google syncing work. GitHub origin is configured at DylanEdge11/RaspberryPICalendar. Reboot/kiosk and backup/restore remain pending.

- Milestone 1 visual prototype: polished landscape week view, six-week month view, calendar color legend, today marker, overlapping event lanes, all-day/multi-day handling in the display model, rotating local demo images, clear demo-mode labeling, and responsive control page.
- Phone-to-display state changes through SSE with polling fallback; state persists in SQLite.
- Settings for week start, view, anchor period, slideshow seconds, title, and overnight dimming. Overnight dimming intentionally does not power off the monitor.
- Protected control mutations with demo PIN `1234`; production requires `ADMIN_PIN`.
- Photo upload/removal API and control UI with signature validation, duplicate detection, file/pixel limits, orientation correction, and resize pipeline when `sharp` is installed.
- Google Calendar OAuth/read-only cache scaffold supporting multiple accounts and selected calendars. Real credentials are not present in this workspace.
- Health endpoint, structured stdout logging, systemd templates, update workflow, and backup/restore/migration documentation.
- Google Photos option researched; core does not depend on it because current supported APIs do not provide a dependable silent sync of an existing personal daily album.

## Verification

Automated checks are in `tests/app.test.mjs` and are intended to run with `npm test`. Browser, live-account, and Pi verification must be recorded here only after they are actually performed.

Current environment facts: the workspace began empty and has no configured GitHub remote. Node 24 and npm are available on the development computer. The service was launched in demo mode and inspected in the Codex in-app browser at its available 1146×856 content viewport. The browser showed the weekly and month layouts, and the controls page was inspected at the available desktop-width viewport; a true device-emulated iPhone/Android viewport was not available in that browser surface.

Observed browser verification on 2026-09-06:

- `/` rendered the labelled demo week, color legend, today marker, timed events, all-day/multi-day chips, and rotating local SVG images.
- `/control` accepted the demo pairing PIN, exposed the protected controls, and showed the photo/calendar sections.
- Switching to month, navigating to the previous week, returning to today, and changing week start from the phone page updated the display without a manual reload.
- Restarting the Node service preserved the selected settings in SQLite.

The valid-image upload path was exercised with a PNG after installing the locked runtime dependencies; upload and removal succeeded, and the temporary test photo was removed afterward. HEIC was not tested on the development computer or Pi.

## Next exact steps

1. Publish the reviewed phone-update release to the existing public GitHub repository.
2. On the Pi, follow README's one-time phone-update setup (backup, pull, install helper, restart). Refresh phone controls.
3. Verify the no-change update check, then a subsequent published release; verify protected backup contents and recovery on a separate data copy.
4. Finish actual-monitor 1080p, kiosk startup/reboot, iPhone/Android browser and HEIC checks. Measure memory with Chromium during uploads.
5. Owner reports live Calendar and Photos working; verify recurring/all-day/multi-day edge cases and Calendar outage/recovery on the Pi. Do not repeat account setup unnecessarily.
6. Keep routine development/testing on the computer, publish reviewed commits, then request installation from the phone. No automatic album sync or voice bridge is planned for this release.

## Known limitations

- No real Google credentials, Pi hardware, monitor resolution, or Nest speaker is available in this workspace, so those paths are documented but not claimed tested.
- Pi information verified by the owner: `aarch64` architecture, 64-bit userspace, Linux/Debian 13 (Trixie), Chromium 152.9.7977.75, Node.js `v22.23.2`, npm `10.9.3`, approximately 1.4 GiB available memory, 1.8 GiB zram swap, and approximately 105 GB available storage. Desktop/session configuration and application performance remain unverified.
- The kiosk service, Pi architecture-specific install, and real monitor sizing remain unverified; use the documented user-session/autostart fallback if the system service starts before the desktop session.
- Screenshot attachments are excluded from future commits; previously committed attachments can remain in Git history.
- `sharp` support for HEIC depends on the ARM/libvips build installed on the Pi; the app reports a clear failure rather than silently treating HEIC as JPEG.
- Google OAuth currently stores refresh tokens as permission-protected JSON under the Pi data directory; protect the OS account and backups. The service is not intended for public exposure.
- There is no voice-controlled screen switching in this release; the phone controls are the fallback. Research found no direct arbitrary-HTTP action in the current Google Home automation action list. Home Assistant is a possible future bridge but adds a service, Google account-linking/SSL or a paid cloud option, and Pi resource risk.
- There is no monitor power-off automation, touch interaction, Spotify playback, meal planning, chores, freezer inventory, or shopping list feature.

## Tablet stage — 2026-09-07

Implemented touch event details and full-day event lists, separate-tab Controls link, tablet layout/readability changes, hidden-tab slideshow pause, foreground/online state refresh and debounced resizing. No backend or schema changes. README contains Pi hub/browser setup, remaining enhancement options and physical-tablet acceptance checks. The earlier statement that touch interaction is absent is superseded by this release.

Validation: syntax checks and all 18 existing Node tests pass. In-app Chromium checked at 1280×800, 800×1280 and 1024×768; event popup, location/time fields, outside/Close/Escape dismissal, day-list selection and month-event selection passed. Physical Samsung touchscreen, power management and sustained resource consumption remain unverified. Changes are local, not published or installed on the Pi.
