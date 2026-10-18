import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";

async function startServer(dataDir, port) {
  const child = spawn(process.execPath, [path.resolve("server.mjs")], {
    cwd: path.resolve("."),
    env: { ...process.env, APP_MODE: "production", ADMIN_PIN: "test-pin", APP_PORT: String(port), APP_HOST: "127.0.0.1", APP_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return child; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  child.kill();
  throw new Error("Server did not start");
}

async function stopServer(child) {
  child.kill();
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
}

test("a paired phone stays signed in across restarts until it signs out", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "family-calendar-sessions-"));
  const port = 19080 + (process.pid % 500);
  const base = `http://127.0.0.1:${port}`;
  const protectedCall = (cookie) => fetch(`${base}/api/state`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ view: "week" }) });
  let child = await startServer(dataDir, port);
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "test-pin" }) });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie");
    assert.match(setCookie, /Max-Age=31536000/);
    const cookie = setCookie.split(";", 1)[0];
    assert.equal((await protectedCall(cookie)).status, 200);

    await stopServer(child);
    child = await startServer(dataDir, port);
    assert.equal((await protectedCall(cookie)).status, 200, "still signed in after a restart");
    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal((await me.json()).authenticated, true);
    assert.match(me.headers.get("set-cookie") || "", /Max-Age=31536000/, "visiting renews the cookie");

    assert.equal((await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } })).status, 200);
    assert.equal((await protectedCall(cookie)).status, 401, "signed out");
  } finally {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
