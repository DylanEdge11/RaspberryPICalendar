import test from "node:test";
import assert from "node:assert/strict";
import { createImmichSync, immichPhotoId } from "../immich.mjs";

const ALBUM_ID = "11111111-2222-3333-4444-555555555555";

function fixture({ albums = ["Family Calendar"], assets, albumResponse, stored = new Map(), status = 200 } = {}) {
  const calls = [];
  const removed = [];
  const dated = [];
  const sync = createImmichSync({
    baseUrl: "http://immich.local:2283/",
    apiKey: "secret-key",
    albums,
    withSlot: async (task) => task(),
    listPhotoIds: () => [...stored.keys()],
    savePhoto: async (data, name, id, takenAt) => {
      if (name === "duplicate.jpg") throw Object.assign(new Error("That photo is already in the family display"), { status: 409 });
      stored.set(id, { data, name, takenAt });
    },
    setTakenAt: (id, takenAt) => dated.push([id, takenAt]),
    removePhoto: async (id) => { removed.push(id); stored.delete(id); },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET", body: options.body });
      assert.equal(options.headers["x-api-key"], "secret-key");
      if (status !== 200) return new Response("{}", { status });
      if (url.endsWith("/api/albums")) return Response.json([{ id: ALBUM_ID, albumName: "Family Calendar" }]);
      if (url.endsWith("/api/albums?shared=true")) return Response.json([]);
      if (url.endsWith(`/api/albums/${ALBUM_ID}`)) return Response.json(albumResponse || { albumName: "Family Calendar", assetCount: assets.length, assets });
      if (url.endsWith("/api/search/metadata")) return Response.json({ assets: { items: assets, nextPage: null } });
      if (url.includes("/thumbnail?size=preview")) return new Response(new Uint8Array([1, 2, 3]));
      throw new Error(`Unexpected ${url}`);
    }
  });
  return { sync, calls, removed, stored, dated };
}

test("imports album photos by name, skips videos and trash, and records the album", async () => {
  const { sync, calls, stored } = fixture({ assets: [
    { id: "a", type: "IMAGE", originalFileName: "beach.jpg" },
    { id: "b", type: "VIDEO", originalFileName: "clip.mp4" },
    { id: "c", type: "IMAGE", isTrashed: true, originalFileName: "old.jpg" }
  ] });
  const result = await sync.sync();
  assert.equal(result.imported, 1);
  assert.deepEqual([...stored.keys()], [immichPhotoId("a")]);
  assert.equal(stored.get(immichPhotoId("a")).name, "beach.jpg");
  assert.deepEqual(sync.status().album_names, ["Family Calendar"]);
  assert.ok(calls.some((call) => call.url === "http://immich.local:2283/api/assets/a/thumbnail?size=preview"));
});

test("photos removed from the album are removed from the display; others are kept", async () => {
  const stored = new Map([[immichPhotoId("keep"), {}], [immichPhotoId("gone"), {}]]);
  const { sync, removed } = fixture({ albums: [ALBUM_ID], stored, assets: [{ id: "keep", type: "IMAGE" }] });
  const result = await sync.sync();
  assert.deepEqual(removed, [immichPhotoId("gone")]);
  assert.equal(result.imported, 0);
});

test("falls back to search when the album response omits its assets", async () => {
  const { sync, calls, stored } = fixture({ albums: [ALBUM_ID], albumResponse: { albumName: "Family Calendar", assetCount: 1 }, assets: [{ id: "s", type: "IMAGE" }] });
  await sync.sync();
  assert.ok(stored.has(immichPhotoId("s")));
  const search = calls.find((call) => call.url.endsWith("/api/search/metadata"));
  assert.deepEqual(JSON.parse(search.body).albumIds, [ALBUM_ID]);
});

test("a duplicate is skipped once instead of being downloaded every sync", async () => {
  const { sync, calls } = fixture({ albums: [ALBUM_ID], assets: [{ id: "d", type: "IMAGE", originalFileName: "duplicate.jpg" }] });
  await sync.sync();
  await sync.sync();
  assert.equal(calls.filter((call) => call.url.includes("/thumbnail")).length, 1);
  assert.equal(sync.status().skipped, 1);
});

test("a rejected key leaves existing photos alone and reports a clear error", async () => {
  const stored = new Map([[immichPhotoId("x"), {}]]);
  const { sync, removed } = fixture({ albums: [ALBUM_ID], stored, assets: [], status: 401 });
  await assert.rejects(sync.sync(), /API key/);
  assert.deepEqual(removed, []);
  assert.match(sync.status().error, /API key/);
});

test("an unknown album name is reported", async () => {
  const { sync } = fixture({ albums: ["Missing"], assets: [] });
  await assert.rejects(sync.sync(), /No Immich album named "Missing"/);
});

test("nothing runs until Immich is configured", async () => {
  const sync = createImmichSync({ baseUrl: "", apiKey: "", albums: [] });
  assert.equal(sync.configured, false);
  assert.deepEqual(await sync.sync(), { skipped: true });
});

test("records when each photo was taken, including photos imported earlier", async () => {
  const stored = new Map([[immichPhotoId("old"), {}]]);
  const { sync, dated } = fixture({ albums: [ALBUM_ID], stored, assets: [
    { id: "old", type: "IMAGE", localDateTime: "2018-10-17T09:00:00.000Z" },
    { id: "new", type: "IMAGE", localDateTime: "2021-10-18T15:30:00.000Z" }
  ] });
  await sync.sync();
  assert.equal(stored.get(immichPhotoId("new")).takenAt, "2021-10-18T15:30:00.000Z");
  assert.deepEqual(dated, [[immichPhotoId("old"), "2018-10-17T09:00:00.000Z"]]);
});
