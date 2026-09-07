import { createHash } from "node:crypto";

const API = "https://photospicker.googleapis.com/v1/";
const LIMIT = 100;
const MAX_BYTES = 20 * 1024 * 1024;

function problem(status, message) { return Object.assign(new Error(message), { status }); }

export function photoDownloadUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".googleusercontent.com") || url.username || url.password || url.port || url.search || url.hash) {
    throw problem(502, "Google returned an unsupported photo download address.");
  }
  return `${url.href}=w1920-h1080`;
}

export async function readLimitedPhoto(response) {
  if ([401, 403].includes(response.status)) {
    await response.body?.cancel();
    throw problem(response.status, "Google Photos access expired or was denied. Reconnect Google Photos and select again.");
  }
  if (!response.ok || !response.body) throw problem(502, "Photo download failed. Select it again to retry.");
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body.cancel();
    throw problem(413, "Photo exceeds the 20 MB download limit.");
  }
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > MAX_BYTES) throw problem(413, "Photo exceeds the 20 MB download limit.");
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts, size);
}

function seconds(value, fallback) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value || "");
  return match ? Number(match[1]) * 1000 : fallback;
}

// One household Photos connection and one bounded import at a time. Only local
// paired administrators can call these methods; URLs/tokens are not in display state.
export function createPhotosPicker({ api, accessToken, savePhoto, hasPhoto, withSlot, connected, fetchPhoto = fetch, now = Date.now }) {
  let job = null;
  let busy = false;
  let running = Promise.resolve();

  function status() {
    const current = job && { phase: job.phase, picker_url: job.phase === "selecting" ? job.pickerUrl : null,
      imported: job.imported, skipped: job.skipped, failed: job.failed, processed: job.processed,
      messages: [...job.messages], poll_after_ms: Math.max(1000, job.nextPoll - now()) };
    return { connected: connected(), busy, job: current };
  }

  function ensureIdle() {
    if (busy || job?.phase === "importing") throw problem(409, "A Google Photos operation is running. Wait for it to finish.");
  }

  async function cleanUp(current) {
    if (!current?.id) return;
    try { await api(`${API}sessions/${encodeURIComponent(current.id)}`, { method: "DELETE" }); }
    catch { current.messages.push("Google session cleanup failed; it will expire automatically."); }
    current.id = null;
    current.pickerUrl = null;
  }

  async function cancel() {
    ensureIdle();
    busy = true;
    try { await cleanUp(job); job = null; } finally { busy = false; }
    return status();
  }

  async function start() {
    ensureIdle();
    if (!connected()) throw problem(409, "Connect Google Photos on the Pi first.");
    if (job && ["selecting", "ready"].includes(job.phase)) return status();
    busy = true;
    try {
      await cleanUp(job);
      const session = await api(`${API}sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pickingConfig: { maxItemCount: String(LIMIT) } }) });
      const pickerUrl = new URL(session.pickerUri);
      if (!session.id || pickerUrl.origin !== "https://photos.google.com" || pickerUrl.username || pickerUrl.password) throw problem(502, "Google returned an invalid selection session.");
      const expires = Date.parse(session.expireTime);
      job = { id: session.id, pickerUrl: pickerUrl.href, phase: "selecting", imported: 0, skipped: 0, failed: 0, processed: 0, messages: [],
        expires: Number.isFinite(expires) ? expires : now() + 600000,
        deadline: now() + seconds(session.pollingConfig?.timeoutIn, 600000),
        nextPoll: now() + Math.max(1000, seconds(session.pollingConfig?.pollInterval, 5000)) };
      return status();
    } finally { busy = false; }
  }

  async function check() {
    if (busy || !job || job.phase !== "selecting") return status();
    if (now() >= Math.min(job.deadline, job.expires)) {
      job.phase = "expired";
      job.messages.push("Selection expired. Start a new selection.");
      busy = true;
      try { await cleanUp(job); } finally { busy = false; }
      return status();
    }
    if (now() < job.nextPoll) return status();
    busy = true;
    try {
      job.nextPoll = now() + 30000;
      const session = await api(`${API}sessions/${encodeURIComponent(job.id)}`);
      job.nextPoll = now() + Math.max(1000, seconds(session.pollingConfig?.pollInterval, 5000));
      if (session.mediaItemsSet) job.phase = "ready";
      else if (session.pollingConfig?.timeoutIn) job.deadline = Math.min(job.deadline, now() + seconds(session.pollingConfig.timeoutIn, 600000));
      return status();
    } catch (error) {
      if (error.status !== 410) throw error;
      job.phase = "expired";
      job.messages.push("Selection expired. Start a new selection.");
      await cleanUp(job);
      return status();
    } finally { busy = false; }
  }

  async function runImport(current) {
    const seenPages = new Set();
    let pageToken = "";
    try {
      do {
        if (now() >= current.expires) throw problem(410, "Selection expired. Select the remaining photos again.");
        if (seenPages.has(pageToken) || seenPages.size >= 10) throw problem(502, "Google returned too many result pages.");
        seenPages.add(pageToken);
        const query = new URLSearchParams({ sessionId: current.id, pageSize: "100" });
        if (pageToken) query.set("pageToken", pageToken);
        const page = await api(`${API}mediaItems?${query}`);
        for (const item of page.mediaItems || []) {
          if (current.processed >= LIMIT) throw problem(413, "Import limited to 100 selections. Start another import for more.");
          current.processed += 1;
          if (item.type !== "PHOTO") { current.skipped += 1; continue; }
          try {
            if (!item.id) throw problem(502, "A selected photo has no identifier.");
            const id = `photo_google_${createHash("sha256").update(item.id).digest("hex")}`;
            await withSlot(async () => {
              if (hasPhoto(id)) throw problem(409, "Already imported");
              const url = photoDownloadUrl(item.mediaFile?.baseUrl);
              const response = await fetchPhoto(url, { headers: { Authorization: `Bearer ${await accessToken()}` }, redirect: "error", signal: AbortSignal.timeout(60000) });
              const data = await readLimitedPhoto(response);
              await savePhoto(data, item.mediaFile?.filename || "Google photo.jpg", id);
            });
            current.imported += 1;
          } catch (error) {
            if (error.status === 409) current.skipped += 1;
            else {
              current.failed += 1;
              if (current.messages.length < 5) current.messages.push(`Photo ${current.processed}: ${error.status ? error.message : "Download failed; select it again to retry."}`);
              if ([401, 403, 507].includes(error.status)) throw error;
            }
          }
        }
        pageToken = page.nextPageToken || "";
      } while (pageToken);
      current.phase = "complete";
    } catch (error) {
      current.phase = "error";
      current.messages.push(error.status ? error.message : "Google Photos import failed. Imported photos are saved; select the rest again.");
    } finally { await cleanUp(current); busy = false; }
  }

  function importSelected() {
    ensureIdle();
    if (!job || job.phase !== "ready") throw problem(409, "Finish selecting in Google Photos first, then check your selection.");
    if (now() >= job.expires) throw problem(410, "Selection expired. Cancel and start again.");
    job.phase = "importing";
    busy = true;
    running = runImport(job);
    return status();
  }

  return { status, start, check, cancel, importSelected, ensureIdle, settled: () => running };
}
