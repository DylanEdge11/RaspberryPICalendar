import assert from "node:assert/strict";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";

const testDataDir = await mkdtemp(path.join(os.tmpdir(), "family-calendar-unit-"));
process.env.APP_DATA_DIR = testDataDir;
process.env.APP_MODE = "demo";
process.env.BACKUP_STATUS = path.join(testDataDir, "backup-status.json");
const app = await import("../server.mjs");

test("week starts on the configured day", () => {
  assert.equal(app.startOfWeek("2026-09-09", "monday"), "2026-09-07");
  assert.equal(app.startOfWeek("2026-09-09", "sunday"), "2026-09-06");
  assert.equal(app.addDays("2026-09-07", 7), "2026-09-14");
  assert.equal(app.isDateKey("2026-02-28"), true);
  assert.equal(app.isDateKey("2026-02-31"), false);
});

test("month navigation preserves a valid day at month boundaries", () => {
  assert.equal(app.addMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(app.addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(app.addMonths("2028-02-29", 12), "2029-02-28");
});

test("month ranges cover complete six-week display grids", () => {
  const info = app.getPeriodInfo({ view: "month", anchor_date: "2026-09-09", week_start: "monday" });
  assert.equal(info.start, "2026-08-31");
  assert.equal(info.end, "2026-10-12");
  assert.equal(Date.parse(`${info.end}T00:00:00Z`) - Date.parse(`${info.start}T00:00:00Z`), 42 * 86400000);
});

test("period containment drives whether the display follows today", () => {
  const settings = { view: "week", anchor_date: "2026-09-09", week_start: "monday" };
  assert.equal(app.periodContains(settings, "2026-09-13"), true);
  assert.equal(app.periodContains(settings, "2026-09-14"), false);
  assert.equal(app.periodContains({ ...settings, view: "month" }, "2026-10-11"), true);
});

test("a fresh install follows today instead of a fixed date", () => {
  const settings = app.readSettings();
  assert.equal(settings.follow_today, true);
  assert.equal(settings.manual_until, "");
});

test("demo events are explicit sample data with timed and all-day cases", () => {
  const events = app.makeDemoEvents("2026-09-07", "2026-09-14");
  assert.ok(events.length >= 8);
  assert.ok(events.some((event) => event.all_day));
  assert.ok(events.some((event) => !event.all_day && event.start_time === "08:30"));
  assert.ok(events.every((event) => event.id.includes("-2026-09-")));
});

let child;
let childDataDir;
let baseUrl;
let cookie;

before(async () => {
  const port = 18080 + (process.pid % 500);
  baseUrl = `http://127.0.0.1:${port}`;
  childDataDir = await mkdtemp(path.join(os.tmpdir(), "family-calendar-http-"));
  child = spawn(process.execPath, [path.resolve("server.mjs")], {
    cwd: path.resolve("."),
    env: { ...process.env, APP_MODE: "demo", APP_PORT: String(port), APP_HOST: "127.0.0.1", APP_DATA_DIR: childDataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Test server did not start");
});

after(async () => {
  if (child && !child.killed) {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  await rm(childDataDir, { recursive: true, force: true }).catch(() => {});
  await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
});

test("management state is protected and phone view changes are persisted", async () => {
  assert.equal((await fetch(`${baseUrl}/api/google/color`, { method: 'POST' })).status, 401);
  for (const method of ['GET', 'POST']) assert.equal((await fetch(`${baseUrl}/api/system/update`, { method })).status, 401);
  for (const [method, route] of [["GET", "status"], ["GET", "connect"], ["POST", "start"], ["POST", "check"], ["POST", "import"], ["POST", "cancel"], ["DELETE", "connection"]]) {
    assert.equal((await fetch(`${baseUrl}/api/google-photos/${route}`, { method, redirect: "manual" })).status, 401);
  }
  const deniedDelete = await fetch(`${baseUrl}/api/google/accounts/anything`, { method: "DELETE" });
  assert.equal(deniedDelete.status, 401);
  const unauthenticated = await fetch(`${baseUrl}/api/state`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: "month" }) });
  assert.equal(unauthenticated.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "1234" }) });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /SameSite=Lax/);
  cookie = login.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await fetch(`${baseUrl}/api/system/update`, { method: 'POST', headers: { Cookie: cookie } })).status, 409);
  assert.equal((await fetch(`${baseUrl}/api/google-photos/start`, { method: "POST", headers: { Cookie: cookie } })).status, 409, "demo never calls Google");

  const changed = await fetch(`${baseUrl}/api/state`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ view: "month" }) });
  assert.equal(changed.status, 200);
  const changedPayload = await changed.json();
  assert.equal(changedPayload.state.settings.view, "month");

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.settings.view, "month");
  assert.equal(state.mode, "demo");

  const seeded = await fetch(`${baseUrl}/api/state`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ view: "month", anchor_date: "2026-03-31" }) });
  assert.equal(seeded.status, 200);
  const previousMonth = await fetch(`${baseUrl}/api/state`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ action: "navigate", direction: "previous" }) });
  const previousPayload = (await previousMonth.json()).state.settings;
  assert.equal(previousPayload.anchor_date, "2026-02-28");
  assert.equal(previousPayload.follow_today, false);
  assert.ok(Date.parse(previousPayload.manual_until) > Date.now());

  const today = await fetch(`${baseUrl}/api/state`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ action: "today" }) });
  const todayPayload = (await today.json()).state;
  assert.equal(todayPayload.settings.follow_today, true);
  assert.equal(todayPayload.settings.anchor_date, todayPayload.today);
});

test("removing Google accounts requires pairing and protects the service account", async () => {
  const anonymous = await fetch(`${baseUrl}/api/google/accounts/acct_missing`, { method: "DELETE" });
  assert.equal(anonymous.status, 401);
  const missing = await fetch(`${baseUrl}/api/google/accounts/acct_missing`, { method: "DELETE", headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);
  const service = await fetch(`${baseUrl}/api/google/accounts/service-account`, { method: "DELETE", headers: { Cookie: cookie } });
  assert.equal(service.status, 400);
});

test('weekly hours validate and persist without changing month ranges', async () => {
  const save = (body) => fetch(`${baseUrl}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const initial = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(initial.settings.weekly_start_hour, 6);
  assert.equal(initial.settings.weekly_end_hour, 22);
  for (const body of [{ weekly_start_hour: -1 }, { weekly_end_hour: 25 }, { weekly_start_hour: 6.5 }, { weekly_end_hour: '24' }, { weekly_start_hour: 22 }, { weekly_end_hour: 5 }]) {
    assert.equal((await save(body)).status, 400);
  }
  const changed = await (await save({ weekly_start_hour: 0, weekly_end_hour: 24 })).json();
  assert.deepEqual(changed.state.period, initial.period);
  const disk = new DatabaseSync(path.join(childDataDir, 'calendar.sqlite'));
  assert.equal(disk.prepare("SELECT value FROM settings WHERE key='weekly_start_hour'").get().value, '0');
  assert.equal(disk.prepare("SELECT value FROM settings WHERE key='weekly_end_hour'").get().value, '24');
  disk.close();
  assert.equal((await save({ weekly_start_hour: 23, weekly_end_hour: 24 })).status, 200);
});

test("reconnecting preserves selection; hidden events stay cached; disconnect removes only its account", async () => {
  const database = new DatabaseSync(path.join(testDataDir, "calendar.sqlite"));
  const originalFetch = globalThis.fetch;
  let identity = "one@example.test";
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://www.googleapis.com/calendar/v3/calendars/primary");
    return new Response(JSON.stringify({ id: identity }), { status: 200 });
  };
  try {
    const token = { access_token: "test-access", refresh_token: "test-refresh", expires_at: Date.now() + 3600000 };
    const first = await app.saveGoogleConnection(token);
    database.prepare(`INSERT INTO calendar_sources(id, account_id, calendar_id, summary, enabled, updated_at)
      VALUES('source-one', ?, 'calendar-one', 'Test calendar', 1, '2026-09-01')`).run(first.id);
    database.prepare(`INSERT INTO calendar_events(account_id, calendar_id, event_id, title, all_day, start_date, end_date, updated_at)
      VALUES(?, 'calendar-one', 'event-one', 'Test event', 1, '2026-09-07', '2026-09-08', '2026-09-01')`).run(first.id);
    assert.equal(app.getCachedEvents("2026-09-07", "2026-09-14").length, 1);
    database.prepare("INSERT INTO settings(key,value) VALUES('calendar_color:source-one','#112233')").run();
    database.prepare("UPDATE calendar_sources SET color='#abcdef'").run();
    assert.equal(app.getCachedEvents('2026-09-07', '2026-09-14')[0].calendar_color, '#112233', 'Google source refresh cannot overwrite local colour');
    database.prepare("DELETE FROM settings WHERE key='calendar_color:source-one'").run();
    assert.equal(app.getCachedEvents('2026-09-07', '2026-09-14')[0].calendar_color, '#abcdef', 'reset uses current source colour');
    database.prepare("UPDATE calendar_sources SET enabled=0 WHERE account_id=?").run(first.id);
    assert.equal(app.getCachedEvents("2026-09-07", "2026-09-14").length, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM calendar_events").get().n, 1);
    const again = await app.saveGoogleConnection({ access_token: "renewed", expires_at: token.expires_at });
    assert.equal(again.id, first.id);
    assert.equal(database.prepare("SELECT enabled FROM calendar_sources").get().enabled, 0);
    assert.equal(JSON.parse(await readFile(path.join(testDataDir, first.token_path))).refresh_token, "test-refresh");
    database.prepare("UPDATE google_accounts SET email=NULL WHERE id=?").run(first.id);
    assert.equal((await app.saveGoogleConnection(token)).id, first.id, "legacy connection is reused");
    identity = "two@example.test";
    const second = await app.saveGoogleConnection(token);
    assert.notEqual(second.id, first.id);
    app.disconnectGoogleAccount(first.id);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM calendar_events").get().n, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM calendar_sources").get().n, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM google_accounts").get().n, 1);
    await assert.rejects(access(path.join(testDataDir, first.token_path)));
    await access(path.join(testDataDir, second.token_path));
    app.disconnectGoogleAccount(second.id);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('calendar colour API validates, persists, isolates and resets overrides', async () => {
  const disk = new DatabaseSync(path.join(childDataDir, 'calendar.sqlite'));
  disk.prepare("INSERT INTO google_accounts(id,label,token_path,created_at) VALUES('colour-test','Test','secrets/test.json','2026-09-01')").run();
  for (const id of ['colour-a', 'colour-b']) disk.prepare("INSERT INTO calendar_sources(id,account_id,calendar_id,summary,color,enabled,updated_at) VALUES(?,'colour-test',?,'Test','#aabbcc',1,'2026-09-01')").run(id,id);
  const save = (id, color) => fetch(`${baseUrl}/api/google/color`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ id, color }) });
  assert.equal((await save('missing','#123456')).status,404);
  for (const value of ['red','#fff','<script>',7]) assert.equal((await save('colour-a',value)).status,400);
  const payload = await (await save('colour-a','#123ABC')).json();
  assert.equal(payload.sources.find(s=>s.id==='colour-a').color,'#123abc');
  assert.equal(payload.sources.find(s=>s.id==='colour-b').color,'#aabbcc');
  assert.equal(disk.prepare("SELECT value FROM settings WHERE key='calendar_color:colour-a'").get().value,'#123abc');
  disk.close();
  const reopened = new DatabaseSync(path.join(childDataDir, 'calendar.sqlite'));
  assert.equal(reopened.prepare("SELECT value FROM settings WHERE key='calendar_color:colour-a'").get().value,'#123abc');
  const reset = await (await save('colour-a',null)).json();
  assert.equal(reset.sources.find(s=>s.id==='colour-a').color,'#aabbcc');
  reopened.prepare("DELETE FROM calendar_sources WHERE account_id='colour-test'").run();
  reopened.prepare("DELETE FROM google_accounts WHERE id='colour-test'").run();
  reopened.close();
});

test("Photo Mode zoom and return-to-calendar settings are validated and saved", async () => {
  const post = (body) => fetch(`${baseUrl}/api/state`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  const defaults = (await (await fetch(`${baseUrl}/api/state`)).json()).settings;
  assert.equal(defaults.photo_motion, true);
  assert.equal(defaults.photo_mode_minutes, 30);
  assert.equal(defaults.photo_memories, true);
  const saved = await post({ photo_motion: false, photo_mode_minutes: 0, photo_memories: false });
  assert.equal(saved.status, 200);
  const settings = (await saved.json()).state.settings;
  assert.equal(settings.photo_motion, false);
  assert.equal(settings.photo_mode_minutes, 0);
  assert.equal(settings.photo_memories, false);
  assert.equal((await post({ photo_mode_minutes: 7 })).status, 400);
  assert.equal((await post({ photo_motion: "no" })).status, 400);
});

test("uploads record the camera date and get a small thumbnail for the phone list", async () => {
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#7a9e7e" } })
    .withExif({ IFD2: { DateTimeOriginal: "2020:10:18 10:15:00" } }).jpeg().toBuffer();
  const form = new FormData();
  form.append("photo", new Blob([jpeg], { type: "image/jpeg" }), "camera.jpg");
  const upload = await fetch(`${baseUrl}/api/photos`, { method: "POST", headers: { Cookie: cookie }, body: form });
  assert.equal(upload.status, 201);
  const { photo } = await upload.json();
  assert.equal(photo.taken_at, "2020-10-18T10:15:00");
  assert.match(photo.thumb_url, /^\/media\/thumb\/photo_[a-z0-9_]+\.jpg$/);
  const thumb = await fetch(`${baseUrl}${photo.thumb_url}`);
  assert.equal(thumb.status, 200);
  const size = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
  assert.equal(size.width, 320);
  assert.equal(size.height, 320);
  const remove = await fetch(`${baseUrl}/api/photos/${photo.id}`, { method: "DELETE", headers: { Cookie: cookie } });
  assert.equal(remove.status, 200);
  assert.equal((await fetch(`${baseUrl}${photo.thumb_url}`)).status, 404);
});

test("the display can be added to an iPad home screen as a full-screen app", async () => {
  const page = await (await fetch(`${baseUrl}/`)).text();
  assert.match(page, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(page, /rel="apple-touch-icon" href="\/static\/icon-180.png"/);
  const manifest = await fetch(`${baseUrl}/static/manifest.webmanifest`);
  assert.equal(manifest.headers.get("content-type"), "application/manifest+json");
  const body = await manifest.json();
  assert.equal(body.start_url, "/");
  assert.equal(body.display, "fullscreen");
  for (const icon of ["/static/icon-180.png", ...body.icons.map((item) => item.src)]) {
    const response = await fetch(`${baseUrl}${icon}`);
    assert.equal(response.status, 200, icon);
    assert.equal(response.headers.get("content-type"), "image/png");
  }
});

test("the Today view covers the chosen day and the next, and steps one day at a time", async () => {
  const post = (body) => fetch(`${baseUrl}/api/state`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  const today = await (await post({ view: "today", anchor_date: "2026-03-10" })).json();
  assert.equal(today.state.settings.view, "today");
  assert.deepEqual([today.state.period.start, today.state.period.end], ["2026-03-10", "2026-03-12"]);
  const next = await (await post({ action: "navigate", direction: "next" })).json();
  assert.equal(next.state.settings.anchor_date, "2026-03-11");
  assert.equal((await post({ view: "agenda" })).status, 400);
  await post({ view: "week", action: "today" });
});

test("the phone can see whether nightly backups are running", async () => {
  const { writeFile } = await import("node:fs/promises");
  const check = async () => (await fetch(`${baseUrl}/api/system/backup`, { headers: { Cookie: cookie } })).json();
  assert.equal((await fetch(`${baseUrl}/api/system/backup`)).status, 401);
  assert.deepEqual(await check(), { installed: false });
  await writeFile(process.env.BACKUP_STATUS, JSON.stringify({ ok: true, folder: "/var/backups/family-calendar/nightly/2026-10-18", updated_at: "2026-10-18T09:16:00Z" }));
  const status = await check();
  assert.equal(status.installed, true);
  assert.equal(status.ok, true);
});

test("event API returns the requested range and no live account claim in demo mode", async () => {
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const events = await (await fetch(`${baseUrl}/api/events?start=${state.period.start}&end=${state.period.end}`)).json();
  assert.equal(events.mode, "demo");
  assert.equal(events.range.start, state.period.start);
  assert.ok(Array.isArray(events.events));
  assert.ok(events.events.every((event) => event.calendar_color.startsWith("#")));
});

test("shared photo processing accepts PNG, rejects duplicates, serves JPEG and removes the photo", async () => {
  const sharp = (await import("sharp")).default;
  const data = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#123456" } }).png().toBuffer();
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "1234" }) });
  const photoCookie = login.headers.get("set-cookie").split(";", 1)[0];
  const upload = async () => {
    const form = new FormData();
    form.append("photo", new Blob([data], { type: "image/png" }), "test-photo.png");
    return fetch(`${baseUrl}/api/photos`, { method: "POST", headers: { Cookie: photoCookie }, body: form });
  };
  const response = await upload();
  assert.equal(response.status, 201);
  const { photo } = await response.json();
  try {
    assert.equal((await upload()).status, 409);
    const displayed = await fetch(`${baseUrl}${photo.url}`);
    assert.equal(displayed.status, 200);
    assert.equal(displayed.headers.get("content-type"), "image/jpeg");
    const metadata = await sharp(Buffer.from(await displayed.arrayBuffer())).metadata();
    assert.equal(metadata.width, 8);
  } finally {
    assert.equal((await fetch(`${baseUrl}/api/photos/${photo.id}`, { method: "DELETE", headers: { Cookie: photoCookie } })).status, 200);
  }
});

test("production mode does not fall back to demo events without a Google account", async () => {
  const productionDataDir = await mkdtemp(path.join(os.tmpdir(), "family-calendar-production-"));
  const port = 18580 + (process.pid % 500);
  const production = spawn(process.execPath, [path.resolve("server.mjs")], {
    cwd: path.resolve("."),
    env: { ...process.env, APP_MODE: "production", ADMIN_PIN: "test-pin", APP_PORT: String(port), APP_HOST: "127.0.0.1", APP_DATA_DIR: productionDataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${url}/api/health`);
        if (response.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const state = await (await fetch(`${url}/api/state`)).json();
    const events = await (await fetch(`${url}/api/events?start=${state.period.start}&end=${state.period.end}`)).json();
    assert.equal(state.mode, "production");
    assert.equal(events.mode, "production");
    assert.deepEqual(events.events, []);
  } finally {
    production.kill();
    await Promise.race([once(production, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
    await rm(productionDataDir, { recursive: true, force: true }).catch(() => {});
  }
});
