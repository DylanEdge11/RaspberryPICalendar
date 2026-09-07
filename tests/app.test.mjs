import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";

const testDataDir = await mkdtemp(path.join(os.tmpdir(), "family-calendar-unit-"));
process.env.APP_DATA_DIR = testDataDir;
process.env.APP_MODE = "demo";
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
  const unauthenticated = await fetch(`${baseUrl}/api/state`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: "month" }) });
  assert.equal(unauthenticated.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "1234" }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";", 1)[0];

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
  assert.equal((await previousMonth.json()).state.settings.anchor_date, "2026-02-28");
});

test("event API returns the requested range and no live account claim in demo mode", async () => {
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const events = await (await fetch(`${baseUrl}/api/events?start=${state.period.start}&end=${state.period.end}`)).json();
  assert.equal(events.mode, "demo");
  assert.equal(events.range.start, state.period.start);
  assert.ok(Array.isArray(events.events));
  assert.ok(events.events.every((event) => event.calendar_color.startsWith("#")));
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
