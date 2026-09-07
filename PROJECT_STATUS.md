# Project status

Updated: 2026-09-06

## Architecture

- Single Node.js service in `server.mjs`.
- Built-in `node:sqlite`; one SQLite database under `APP_DATA_DIR`.
- Plain static HTML/CSS/JS under `static/`; no frontend build step.
- `sharp` is the only runtime package and is loaded optionally so demo display/testing can run without photo processing installed. Production photo uploads require it.
- Persistent data is outside replaceable code: SQLite, original photos, resized display JPEGs, and Google token files.
- Default timezone is `America/Regina`; production is intended to remain private to the home network.

## Completed

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

1. Run `npm run check` and `npm test` on a machine with Node/npm.
2. Start demo mode, inspect the display at an actual 1920×1080 kiosk viewport and the control page at iPhone/Android-sized widths, and record any layout fixes.
3. Create a private GitHub repository and add its remote; push a reviewed first commit.
4. On the Pi, record `uname -m`, `getconf LONG_BIT`, `/etc/os-release`, Node version, Chromium path, and available memory before installation.
5. Install Node 22.13+ and dependencies on the Pi; configure `/etc/family-calendar/calendar.env` with a strong PIN and data directory; enable the app and kiosk services.
6. Test backup/restore and one code update before adding household data.
7. Connect Google Calendar account(s), choose calendars, verify a real recurring/all-day/multi-day event, then test outage/recovery.
8. Upload representative iPhone/Android photos, including HEIC if supported by the Pi's `sharp` build, and measure memory during uploads/slideshow.
9. Consider an optional Google Photos Picker import or supported voice bridge only after the private core is reliable and its extra permissions/cost/limitations are accepted.

## Known limitations

- No real Google credentials, Pi hardware, monitor resolution, or Nest speaker is available in this workspace, so those paths are documented but not claimed tested.
- The kiosk service, Pi architecture-specific install, and real monitor sizing remain unverified; use the documented user-session/autostart fallback if the system service starts before the desktop session.
- The first private GitHub commit and remote still need to be created before rollback/update instructions can be used.
- `sharp` support for HEIC depends on the ARM/libvips build installed on the Pi; the app reports a clear failure rather than silently treating HEIC as JPEG.
- Google OAuth currently stores refresh tokens as permission-protected JSON under the Pi data directory; protect the OS account and backups. The service is not intended for public exposure.
- There is no voice-controlled screen switching in this release; the phone controls are the fallback. Research found no direct arbitrary-HTTP action in the current Google Home automation action list. Home Assistant is a possible future bridge but adds a service, Google account-linking/SSL or a paid cloud option, and Pi resource risk.
- There is no monitor power-off automation, touch interaction, Spotify playback, meal planning, chores, freezer inventory, or shopping list feature.
