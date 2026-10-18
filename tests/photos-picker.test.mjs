import test from "node:test";
import assert from "node:assert/strict";
import { createPhotosPicker, photoDownloadUrl, readLimitedPhoto } from "../photos-picker.mjs";

function fixture(overrides = {}) {
  let clock = 100000;
  const calls = [];
  const stored = new Map();
  const item = (id, type = "PHOTO") => ({ id, type, mediaFile: { filename: `${id}.jpg`, baseUrl: `https://lh3.googleusercontent.com/${id}` } });
  const picker = createPhotosPicker({
    now: () => clock,
    connected: () => true,
    accessToken: async () => "fake-token",
    hasPhoto: (id) => stored.has(id),
    savePhoto: async (data, name, id) => stored.set(id, { data, name }),
    withSlot: async (task) => task(),
    fetchPhoto: async (url, options) => {
      calls.push({ download: url });
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer fake-token");
      return new Response(new Uint8Array([1, 2, 3]));
    },
    api: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET" });
      if (options.method === "POST") {
        assert.equal(JSON.parse(options.body).pickingConfig.maxItemCount, "100");
        return { id: "session", pickerUri: "https://photos.google.com/picker/session", expireTime: new Date(clock + 600000).toISOString(), pollingConfig: { pollInterval: "5s", timeoutIn: "120s" } };
      }
      if (options.method === "DELETE") return {};
      if (url.includes("mediaItems?")) return url.includes("pageToken=") ? { mediaItems: [item("two")] }
        : { mediaItems: [item("one"), item("video", "VIDEO")], nextPageToken: "second" };
      return { mediaItemsSet: true };
    },
    ...overrides
  });
  return { picker, calls, stored, advance: (ms) => { clock += ms; } };
}

test("phone selection respects polling, imports pages once, skips videos and survives a repeat selection", async () => {
  const f = fixture();
  assert.equal((await f.picker.start()).job.phase, "selecting");
  await f.picker.check();
  assert.equal(f.calls.length, 1, "does not poll before Google interval");
  f.advance(5000);
  assert.equal((await f.picker.check()).job.phase, "ready");
  assert.equal(f.picker.importSelected().job.phase, "importing");
  assert.throws(() => f.picker.importSelected(), /operation is running/);
  await assert.rejects(f.picker.cancel(), /operation is running/);
  await f.picker.settled();
  assert.equal(f.stored.size, 2);
  assert.equal(f.picker.status().job.imported, 2);
  assert.equal(f.picker.status().job.skipped, 1);
  assert.equal(f.calls.filter((row) => row.method === "DELETE").length, 1);
  assert.equal(f.picker.status().job.picker_url, null);
  assert.ok(!JSON.stringify(f.picker.status()).includes("fake-token"));
  await f.picker.start(); f.advance(5000); await f.picker.check();
  f.picker.importSelected(); await f.picker.settled();
  assert.equal(f.picker.status().job.imported, 0);
  assert.equal(f.picker.status().job.skipped, 3);
  assert.equal(f.calls.filter((row) => row.download).length, 2, "duplicates are skipped before downloading");
});

test("expired selection is cleaned up and cannot import", async () => {
  const f = fixture();
  await f.picker.start(); f.advance(120001);
  assert.equal((await f.picker.check()).job.phase, "expired");
  assert.throws(() => f.picker.importSelected(), /Finish selecting/);
  assert.equal(f.calls.filter((row) => row.method === "DELETE").length, 1);
});

test("network failure preserves successful imports and can be retried", async () => {
  const f = fixture({ fetchPhoto: async (url) => {
    if (url.includes("/two=")) throw new Error("private download URL must not appear");
    return new Response(new Uint8Array([1, 2, 3]));
  } });
  await f.picker.start(); f.advance(5000); await f.picker.check();
  f.picker.importSelected(); await f.picker.settled();
  assert.equal(f.picker.status().job.imported, 1);
  assert.equal(f.picker.status().job.failed, 1);
  assert.equal(f.stored.size, 1);
  assert.ok(!JSON.stringify(f.picker.status()).includes("private download URL"));
});

test("malicious download destinations and redirects cannot receive the Google bearer token", () => {
  for (const url of ["http://lh3.googleusercontent.com/x", "https://localhost/x", "https://googleusercontent.com.evil.test/x", "https://user:pass@lh3.googleusercontent.com/x", "https://lh3.googleusercontent.com:444/x", "https://lh3.googleusercontent.com/x?url=secret"]) {
    assert.throws(() => photoDownloadUrl(url));
  }
  assert.equal(photoDownloadUrl("https://lh3.googleusercontent.com/test"), "https://lh3.googleusercontent.com/test=w1920-h1080");
});

test("download byte limits apply to both announced and streamed bodies", async () => {
  const announced = new Response("tiny", { headers: { "Content-Length": String(21 * 1024 * 1024) } });
  await assert.rejects(readLimitedPhoto(announced), /20 MB/);
  const streamed = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(11 * 1024 * 1024));
    controller.enqueue(new Uint8Array(11 * 1024 * 1024));
    controller.close();
  } }));
  await assert.rejects(readLimitedPhoto(streamed), /20 MB/);
});

test("storage quota ends an import and cleans its Google session", async () => {
  const f = fixture({ savePhoto: async () => { throw Object.assign(new Error("Storage limit reached"), { status: 507 }); } });
  await f.picker.start(); f.advance(5000); await f.picker.check();
  f.picker.importSelected(); await f.picker.settled();
  assert.equal(f.picker.status().job.phase, "error");
  assert.equal(f.picker.status().job.failed, 1);
  assert.equal(f.calls.filter((row) => row.method === "DELETE").length, 1);
});
