import { createHash } from "node:crypto";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_NEW_PER_SYNC = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function problem(status, message) { return Object.assign(new Error(message), { status }); }

// Immich's localDateTime is when the photo was taken, in the place it was taken.
function takenAt(asset) {
  return asset.localDateTime || asset.exifInfo?.dateTimeOriginal || asset.fileCreatedAt || null;
}

export function immichPhotoId(assetId) {
  return `photo_immich_${createHash("sha256").update(String(assetId)).digest("hex").slice(0, 32)}`;
}

// Mirrors one or more Immich albums onto the display. An Immich API key does not
// expire, so this runs unattended: album additions appear and removals disappear.
export function createImmichSync({ baseUrl, apiKey, albums, savePhoto, removePhoto, listPhotoIds, withSlot, setTakenAt = () => {}, fetchImpl = fetch, now = Date.now }) {
  const root = String(baseUrl || "").replace(/\/+$/, "");
  const configured = Boolean(root && apiKey && albums.length);
  const skipped = new Map();
  let busy = false;
  let last = { synced_at: null, error: null, album_names: [], photos: 0, imported: 0, removed: 0 };

  async function api(pathname, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${root}/api/${pathname}`, {
        ...options,
        headers: { "x-api-key": apiKey, Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
        signal: AbortSignal.timeout(20_000)
      });
    } catch {
      throw problem(502, `Immich could not be reached at ${root}. Check IMMICH_URL and that the Immich computer is on.`);
    }
    if (response.status === 401 || response.status === 403) throw problem(401, "Immich rejected the API key. Create a new key with album.read, asset.read and asset.view permissions.");
    if (!response.ok) throw problem(502, `Immich request failed (${response.status})`);
    return response;
  }

  async function resolveAlbums() {
    const wanted = albums.filter((album) => !UUID.test(album));
    const byName = new Map();
    if (wanted.length) {
      for (const album of await (await api("albums")).json()) byName.set(String(album.albumName).toLowerCase(), album.id);
      const shared = await (await api("albums?shared=true")).json().catch(() => []);
      for (const album of shared) if (!byName.has(String(album.albumName).toLowerCase())) byName.set(String(album.albumName).toLowerCase(), album.id);
    }
    return albums.map((album) => {
      if (UUID.test(album)) return album;
      const id = byName.get(album.toLowerCase());
      if (!id) throw problem(404, `No Immich album named "${album}" is visible to this API key`);
      return id;
    });
  }

  async function albumAssets(albumId) {
    const album = await (await api(`albums/${encodeURIComponent(albumId)}`)).json();
    let assets = Array.isArray(album.assets) ? album.assets : [];
    if (!assets.length && Number(album.assetCount) > 0) {
      // Newer servers may omit assets from the album response; page through search instead.
      assets = [];
      for (let page = 1; page && page <= 50;) {
        const result = await (await api("search/metadata", { method: "POST", body: JSON.stringify({ albumIds: [albumId], page, size: 1000 }) })).json();
        assets.push(...(result.assets?.items || []));
        page = result.assets?.nextPage ? Number(result.assets.nextPage) : 0;
      }
    }
    return { name: album.albumName || albumId, assets };
  }

  async function download(asset) {
    const response = await api(`assets/${encodeURIComponent(asset.id)}/thumbnail?size=preview`);
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      throw problem(413, "Preview exceeds the 20 MB limit");
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_BYTES) throw problem(413, "Preview exceeds the 20 MB limit");
    return data;
  }

  async function sync() {
    if (!configured) return { skipped: true };
    if (busy) return { skipped: true, busy: true };
    busy = true;
    try {
      const albumIds = await resolveAlbums();
      const wanted = new Map();
      const names = [];
      for (const albumId of albumIds) {
        const album = await albumAssets(albumId);
        names.push(album.name);
        for (const asset of album.assets) {
          if (asset.type && asset.type !== "IMAGE") continue;
          if (asset.isTrashed) continue;
          wanted.set(immichPhotoId(asset.id), asset);
        }
      }
      const existing = new Set(listPhotoIds());
      let removed = 0;
      for (const id of existing) {
        if (wanted.has(id)) continue;
        await removePhoto(id);
        removed += 1;
      }
      let imported = 0;
      let limitError = null;
      for (const [id, asset] of wanted) {
        if (existing.has(id)) {
          // Fills in the date for photos imported before dates were recorded.
          setTakenAt(id, takenAt(asset));
          continue;
        }
        if (skipped.has(id)) continue;
        if (imported >= MAX_NEW_PER_SYNC) break;
        try {
          const data = await download(asset);
          await withSlot(() => savePhoto(data, asset.originalFileName || "Immich photo.jpg", id, takenAt(asset)));
          imported += 1;
        } catch (error) {
          if (error.status === 507) { limitError = error.message; break; }
          if (error.status === 401 || error.status === 502) throw error;
          // Duplicates and undecodable images would fail the same way every sync.
          skipped.set(id, error.message);
        }
      }
      last = { synced_at: new Date(now()).toISOString(), error: limitError, album_names: names, photos: wanted.size, imported, removed };
      return last;
    } catch (error) {
      last = { ...last, synced_at: new Date(now()).toISOString(), error: error.message };
      throw error;
    } finally {
      busy = false;
    }
  }

  function status() {
    return { configured, busy, url: configured ? root : null, skipped: skipped.size, ...last };
  }

  return { sync, status, busy: () => busy, configured };
}
