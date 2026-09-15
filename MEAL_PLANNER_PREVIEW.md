# Meal planner: safe preview and branch guide

This work is on `codex/meal-planner`. `main` and the running Pi release are unchanged.
No Google credentials or existing household data were used in development tests.

## What a branch means here

A branch is a named line of commits in the same repository. A commit is a saved
checkpoint. Changes become part of the normal Pi release only after an explicit
merge into `main` and a Pi update. The phone updater still follows `main` only.

Do not use the phone's Update application button to test this branch, and do not
switch the production Pi checkout onto this branch. Keep the preview separate.

## Preview on this computer

From the project folder:

```sh
git branch --show-current
npm run preview:meals
```

The branch should be `codex/meal-planner`. Open http://127.0.0.1:8081/meals
(PIN `1234`) and http://127.0.0.1:8081/ for the preview display. Stop with Ctrl+C.
If port 8081 is already in use, an existing preview may still be running: use that
preview rather than starting another. Demo data persists in `.meal-preview-data/`,
which is excluded from Git. Sample meals created during browser testing are demo
data only. The launcher forces demo mode, separate storage, and no Google client
credentials. It binds only to this computer, not the LAN.

The feature is **off by default**. Normal `npm start` does not create meal tables
unless `MEALS_ENABLED=1` is explicitly configured. Disabling the flag hides the
planner without deleting its saved data.

## What was built

- Separate `/meals` phone/tablet editor, using the existing household pairing.
- Defaults: two adults, one child, three adjustable recipe servings; no mushrooms.
- Favourites with ingredients, optional quantities/units, recipe links, time,
  tags, and a required toddler-friendly adaptation before planning.
- Monday-based weeks, cooking/leftovers/takeout/unplanned nights, locks and
  tap-based moves/swaps within the week; rules suggest unused eligible favourites.
- Draft save versus explicit approval for the display; favourite snapshots keep
  subsequent recipe changes from silently changing groceries. Use “Use latest
  favourite recipe” to deliberately refresh a planned snapshot.
- Selected cooking nights generate combined groceries. g/kg and ml/L combine;
  different package sizes or incompatible units do not. Missing amounts remain
  explicit. A linked leftovers night contributes no ingredients.
- Batch-specific “Already have” and “Already on Keep” decisions; saved review;
  manual copy text and user-confirmed transfer history. Later transfers show only
  new rows and explain quantity changes/removals separately. The app never reads
  or writes Keep. Native copy/paste and checkbox conversion must still be checked
  on the physical phones. Existing Keep groceries and checked history stay there.
- Ten-minute transfer reservation and revision checks protect shared edits. A
  restart requires re-pairing; abandoned reservations expire automatically.
- Approved tonight/weekly dinner strip with a tap-through week and recipe links.
- AI, custom voice capture, remote access, and Google Calendar writes are not in
  this release. Use Keep's existing speaker capture separately.

Ingredient matching uses normalized exact names. Rename an ingredient to match
another explicitly; there is no automatic synonym guessing or pantry inventory.
Mushroom detection is a name check, not a food-safety classifier. Parents review
the recipe and toddler adaptation. Child portions are adjustable, not inferred.

## Preview on the Pi — a later, separate step

First publish this branch (not `main`) from the computer, when ready:

```sh
git push -u origin codex/meal-planner
```

No push was performed as part of implementation. On the Pi, clone it into a **new
folder under your normal login user's home**, never `/opt/family-calendar`:

```sh
git clone --branch codex/meal-planner --single-branch https://github.com/DylanEdge11/RaspberryPICalendar.git ~/family-calendar-meal-preview
cd ~/family-calendar-meal-preview
npm ci --omit=dev
env -u GOOGLE_CLIENT_SECRETS -u GOOGLE_REDIRECT_URI APP_MODE=demo MEALS_ENABLED=1 APP_HOST=0.0.0.0 APP_PORT=8081 APP_DATA_DIR="$HOME/family-calendar-meal-preview/.meal-preview-data" node server.mjs
```

This runs in the terminal until Ctrl+C. On home Wi-Fi, use
`http://<Pi-LAN-address>:8081/meals`. Your regular calendar remains on port 8080.
Temporarily point Fully Kiosk at `http://<Pi-LAN-address>:8081/` to test the display,
then restore its current port-8080 URL. Keep this demo port on the private LAN.
No new systemd service or production updater change is needed for the first test.

For a later preview revision, stop this preview, run `git pull --ff-only` **in the
preview folder**, rerun `npm ci --omit=dev` if dependencies changed, and start the
same command. Never share live SQLite, photos, or token directories with preview.

## Data and release safeguards

The opt-in migration adds four `family_*` tables to the configured SQLite database
and raises `settings.schema_version` to 2 transactionally. Existing integration
tables are not changed. Meals, plans, grocery reviews, and household defaults use
revisioned JSON records, avoiding unnecessary ingredient tables for this small
household app. Snapshots and transfer comparisons live within those records.

The existing updater will not automatically roll back across a schema version
change. Before enabling meals in the real installation, rehearse backup/restore
on a separate data copy and retain the matching previous code/configuration.
Switching Git commits alone does not reverse a database migration. Merely merging
this branch does not enable meals; deployment must deliberately set the flag.

## Verification and next checkpoint

Run `npm run check` and `npm test`. The meal tests cover migration/reopen,
snapshot persistence, conflict rejection, drafts versus approval, aggregation,
leftovers validation, locks, transfer reservations/history, authentication,
cross-origin rejection, and input constraints. Existing Calendar/Photos tests
remain part of the suite. Python updater tests are unchanged.

Browser verification used a local demo: favourite creation, suggestion, linked
leftovers, six cooked portions producing 1000 g from a 500 g / three-serving
recipe, approval, manual-transfer preview and simulated confirmation, repeat
transfer producing no duplicate copy rows, and dinner-details display. No real
Keep list was modified. Calendar display fit was checked at 1280×800. Phone-width
form checks used 390 px. Native browser confirmations were replaced by in-page
dialogs; serving values are read on save for older WebView compatibility.

Remaining before production release: physical Android/iPhone/Fully Kiosk testing,
tablet portrait/month fit, two actual phone sessions, Pi resource measurements,
reboot/network recovery, and backup/restore rehearsal. Live Google integrations
were not exercised or changed. Calendar cache hardening is a separately scoped
follow-up, not bundled into this feature.

Next session: inspect this branch and run the local preview first. Publish the
branch and set up the isolated Pi preview only when ready. Do not merge to main
or enable meals on production until these acceptance checks are reviewed.
