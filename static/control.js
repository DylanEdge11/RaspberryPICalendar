(() => {
  "use strict";

  const dom = {
    loginView: document.getElementById("loginView"),
    controlsView: document.getElementById("controlsView"),
    loginForm: document.getElementById("loginForm"),
    pinInput: document.getElementById("pinInput"),
    loginHint: document.getElementById("loginHint"),
    loginError: document.getElementById("loginError"),
    demoHint: document.getElementById("demoHint"),
    logoutButton: document.getElementById("logoutButton"),
    controlModeLabel: document.getElementById("controlModeLabel"),
    controlStatusCard: document.getElementById("controlStatusCard"),
    controlStatusText: document.getElementById("controlStatusText"),
    controlPeriod: document.getElementById("controlPeriod"),
    previousButton: document.getElementById("previousButton"),
    todayButton: document.getElementById("todayButton"),
    nextButton: document.getElementById("nextButton"),
    weekStart: document.getElementById("weekStart"),
    slideshowSeconds: document.getElementById("slideshowSeconds"),
    showPhotoCaptions: document.getElementById("showPhotoCaptions"),
    displayTitleInput: document.getElementById("displayTitleInput"),
    overnightEnabled: document.getElementById("overnightEnabled"),
    overnightStart: document.getElementById("overnightStart"),
    overnightEnd: document.getElementById("overnightEnd"),
    settingsForm: document.getElementById("settingsForm"),
    settingsMessage: document.getElementById("settingsMessage"),
    uploadForm: document.getElementById("uploadForm"),
    photoInput: document.getElementById("photoInput"),
    uploadMessage: document.getElementById("uploadMessage"),
    photoList: document.getElementById("photoList"),
    googleAccountList: document.getElementById("googleAccountList"),
    googleConnectButton: document.getElementById("googleConnectButton"),
    googleSyncButton: document.getElementById("googleSyncButton")
  };

  const app = { state: null, photos: [], google: { accounts: [], sources: [] } };
  const photosUi = Object.fromEntries(["Connect", "Start", "Open", "Import", "Cancel", "Disconnect", "Status"].map((name) => [name, document.getElementById(`photos${name}`)]));
  let photosTimer;
  let photosProgress = "";

  function renderPicker(state) {
    const job = state.job;
    const phase = job?.phase;
    const active = ["selecting", "ready", "importing"].includes(phase);
    photosUi.Connect.classList.toggle("hidden", state.demo || state.busy || active);
    photosUi.Connect.textContent = state.connected ? "Reconnect Google Photos" : "Connect Google Photos";
    photosUi.Start.classList.toggle("hidden", state.demo || !state.connected || active);
    photosUi.Open.classList.toggle("hidden", phase !== "selecting");
    if (job?.picker_url) photosUi.Open.href = job.picker_url;
    else photosUi.Open.removeAttribute("href");
    photosUi.Import.classList.toggle("hidden", phase !== "ready");
    photosUi.Cancel.classList.toggle("hidden", !job || phase === "importing");
    photosUi.Cancel.textContent = active ? "Cancel selection" : "Clear import status";
    photosUi.Disconnect.classList.toggle("hidden", state.demo || !state.connected || active);
    for (const name of ["Start", "Import", "Cancel", "Disconnect"]) photosUi[name].disabled = Boolean(state.busy);
    let message = state.connected ? "Google Photos connected. You can choose photos from your phone." : "Google Photos is not connected yet.";
    if (state.demo) message = "Google Photos is unavailable in demo mode. File uploads above still work.";
    if (phase === "selecting") message = "Open Google Photos, search your album title, select photos and tap Done. Then return here.";
    if (phase === "ready") message = "Selection ready. Tap Import selected photos to save copies on the Pi.";
    if (job && !["selecting", "ready"].includes(phase)) message = `${phase === "importing" ? "Importing…" : phase === "complete" ? "Import finished." : "Import stopped."} ${job.imported} added, ${job.skipped} duplicates/videos skipped, ${job.failed} failed.`;
    photosUi.Status.textContent = [message, ...(job?.messages || [])].join("\n");
    const progress = `${job?.imported || 0}:${phase || ""}`;
    if (progress !== photosProgress && job?.imported) loadPhotos().catch(() => {});
    photosProgress = progress;
    clearTimeout(photosTimer);
    if ((active || state.busy) && !dom.controlsView.classList.contains("hidden")) photosTimer = setTimeout(() => pickerRequest(phase === "selecting" ? "check" : "status"), Math.max(2000, job?.poll_after_ms || 3000));
  }

  async function pickerRequest(action = "status") {
    clearTimeout(photosTimer);
    try {
      const result = action === "status" ? await requestJson("/api/google-photos/status")
        : action === "disconnect" ? await requestJson("/api/google-photos/connection", { method: "DELETE" })
        : await postJson(`/api/google-photos/${action}`, {});
      renderPicker(result);
    } catch (error) {
      photosUi.Status.textContent = error.message;
      if (!dom.controlsView.classList.contains("hidden")) photosTimer = setTimeout(() => pickerRequest("status"), 30000);
    }
  }

  for (const [name, action] of [["Start", "start"], ["Import", "import"], ["Cancel", "cancel"], ["Disconnect", "disconnect"]]) {
    photosUi[name].addEventListener("click", async () => {
      if (action === "disconnect" && !window.confirm("Disconnect Google Photos? Imported photos stay on the Pi. You can remove them using the photo list.")) return;
      photosUi[name].disabled = true;
      await pickerRequest(action);
      photosUi[name].disabled = false;
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  }

  function dateFromKey(key) { return new Date(`${key}T12:00:00Z`); }

  function addDays(key, amount) {
    const date = dateFromKey(key);
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  }

  function formatDate(key, options = {}) {
    return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...options }).format(dateFromKey(key));
  }

  function periodText(state) {
    if (!state) return "Loading…";
    if (state.settings.view === "month") return formatDate(`${state.settings.anchor_date.slice(0, 7)}-01`, { month: "long", year: "numeric" });
    const start = state.period.start;
    const end = addDays(state.period.end, -1);
    return `${formatDate(start, { month: "short", day: "numeric" })} – ${formatDate(end, { month: "short", day: "numeric", year: "numeric" })}`;
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  async function postJson(url, body) {
    return requestJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  function showLogin() {
    clearTimeout(photosTimer);
    dom.loginView.classList.remove("hidden");
    dom.controlsView.classList.add("hidden");
    dom.logoutButton.classList.add("hidden");
    if (app.state?.mode === "demo") {
      dom.demoHint.classList.remove("hidden");
      dom.loginHint.textContent = "Demo mode has no account connection. The pairing PIN still protects control actions.";
    }
    window.setTimeout(() => dom.pinInput.focus(), 50);
  }

  function showControls() {
    dom.loginView.classList.add("hidden");
    dom.controlsView.classList.remove("hidden");
    dom.logoutButton.classList.remove("hidden");
  }

  function renderState() {
    if (!app.state) return;
    const { settings, calendar } = app.state;
    dom.controlModeLabel.textContent = app.state.mode === "demo" ? "DISPLAY CONTROLS · DEMO" : "DISPLAY CONTROLS";
    dom.controlPeriod.textContent = `${settings.view === "month" ? "Month" : "Week"} · ${periodText(app.state)}`;
    document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === settings.view));
    dom.weekStart.value = settings.week_start;
    dom.slideshowSeconds.value = settings.slideshow_seconds;
    dom.showPhotoCaptions.checked = Boolean(settings.show_photo_captions);
    dom.displayTitleInput.value = settings.display_title;
    dom.overnightEnabled.checked = settings.overnight_enabled;
    dom.overnightStart.value = settings.overnight_start;
    dom.overnightEnd.value = settings.overnight_end;
    dom.controlStatusCard.classList.toggle("stale", Boolean(calendar?.stale));
    dom.controlStatusText.textContent = calendar?.label || "Connected";
    dom.googleConnectButton.classList.toggle("hidden", app.state.mode === "demo");
    dom.googleSyncButton.classList.toggle("hidden", app.state.mode === "demo");
    if (app.state.mode === "demo") dom.googleAccountList.innerHTML = `<div class="google-account"><strong>Demo calendar content</strong><small>No Google account is contacted in demo mode. Switch to production when the Pi is ready for household data.</small></div>`;
  }

  async function loadState() {
    app.state = await requestJson("/api/state");
    renderState();
  }

  async function loadPhotos() {
    const payload = await requestJson("/api/photos");
    app.photos = Array.isArray(payload.photos) ? payload.photos : [];
    renderPhotos();
  }

  function renderPhotos() {
    if (!app.photos.length) {
      dom.photoList.innerHTML = `<p class="muted-copy">No photos uploaded yet.</p>`;
      return;
    }
    dom.photoList.innerHTML = app.photos.map((photo) => `<div class="photo-list-item"><img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.original_name)}" loading="lazy"><small>${escapeHtml(photo.original_name)}</small>${photo.demo ? "" : `<button type="button" data-remove-photo="${escapeHtml(photo.id)}" aria-label="Remove ${escapeHtml(photo.original_name)}">×</button>`}</div>`).join("");
    dom.photoList.querySelectorAll("[data-remove-photo]").forEach((button) => button.addEventListener("click", () => removePhoto(button.dataset.removePhoto)));
  }

  async function removePhoto(id) {
    const photo = app.photos.find((item) => item.id === id);
    if (!photo || !window.confirm(`Remove “${photo.original_name}” from this display?`)) return;
    try {
      await requestJson(`/api/photos/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadPhotos();
      setMessage(dom.uploadMessage, "Photo removed.");
    } catch (error) {
      setMessage(dom.uploadMessage, error.message, true);
    }
  }

  function setMessage(element, message, error = false) {
    element.textContent = message;
    element.classList.toggle("error", error);
    window.clearTimeout(element._clearTimer);
    element._clearTimer = window.setTimeout(() => { element.textContent = ""; }, 5000);
  }

  async function loadGoogle() {
    if (app.state?.mode === "demo") return;
    try {
      app.google = await requestJson("/api/google/accounts");
      renderGoogle();
    } catch (error) {
      dom.googleAccountList.innerHTML = `<p class="muted-copy">${escapeHtml(error.message)}</p>`;
    }
  }

  function renderGoogle() {
    if (!app.google.accounts.length) {
      dom.googleAccountList.innerHTML = `<p class="muted-copy">No Google account connected yet. Use the button below after setting the OAuth client path in .env.</p>`;
      return;
    }
    dom.googleAccountList.innerHTML = app.google.accounts.map((account) => {
      const sources = app.google.sources.filter((source) => source.account_id === account.id);
      const sourceHtml = sources.length ? `<div class="calendar-source-list">${sources.map((source) => `<label class="calendar-source"><input type="checkbox" data-source-id="${escapeHtml(source.id)}" ${source.enabled ? "checked" : ""}><span class="calendar-source-dot" style="--source-color:${/^#[0-9a-f]{6}$/i.test(source.color || "") ? source.color : "#6d7bea"}"></span><span>${escapeHtml(source.summary)}</span></label>`).join("")}</div>` : `<small>No readable calendars returned yet.</small>`;
      return `<div class="google-account"><strong>${escapeHtml(account.label)}</strong><small>Connected ${escapeHtml(new Date(account.created_at).toLocaleString())}</small>${account.last_error ? `<small class="form-error">${escapeHtml(account.last_error)}</small>` : ""}${sourceHtml}<button type="button" class="secondary-button" data-disconnect-id="${escapeHtml(account.id)}">Disconnect account</button></div>`;
    }).join("");
    dom.googleAccountList.querySelectorAll("[data-source-id]").forEach((input) => input.addEventListener("change", saveGoogleSources));
    dom.googleAccountList.querySelectorAll("[data-disconnect-id]").forEach((button) => button.addEventListener("click", async () => {
      if (!window.confirm("Remove this connection and its events from this display? Your Google calendars will not be deleted. Other connections remain connected.")) return;
      button.disabled = true;
      try {
        await requestJson(`/api/google/accounts/${encodeURIComponent(button.dataset.disconnectId)}`, { method: "DELETE" });
        await loadGoogle();
        await loadState();
      } catch (error) {
        setMessage(dom.settingsMessage, error.message, true);
        button.disabled = false;
      }
    }));
  }

  async function saveGoogleSources() {
    const sources = [...dom.googleAccountList.querySelectorAll("[data-source-id]")].map((input) => ({ id: input.dataset.sourceId, enabled: input.checked }));
    dom.googleAccountList.querySelectorAll("input, button").forEach((input) => { input.disabled = true; });
    try {
      dom.googleSyncButton.disabled = true;
      await postJson("/api/google/sources", { sources });
      await loadState();
      await loadGoogle();
    } catch (error) {
      setMessage(dom.settingsMessage, error.message, true);
    } finally {
      dom.googleSyncButton.disabled = false;
      dom.googleAccountList.querySelectorAll("input, button").forEach((input) => { input.disabled = false; });
    }
  }

  dom.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    dom.loginError.textContent = "";
    try {
      await postJson("/api/auth/login", { pin: dom.pinInput.value });
      dom.pinInput.value = "";
      showControls();
      await loadState();
      await loadPhotos();
      await loadGoogle();
      await pickerRequest();
    } catch (error) {
      dom.loginError.textContent = error.message;
    }
  });

  dom.logoutButton.addEventListener("click", async () => {
    await postJson("/api/auth/logout", {}).catch(() => {});
    showLogin();
  });

  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", async () => {
    try { app.state = (await postJson("/api/state", { view: button.dataset.view })).state; renderState(); } catch (error) { setMessage(dom.settingsMessage, error.message, true); }
  }));

  dom.previousButton.addEventListener("click", () => navigate("previous"));
  dom.nextButton.addEventListener("click", () => navigate("next"));
  dom.todayButton.addEventListener("click", async () => {
    try { app.state = (await postJson("/api/state", { action: "today" })).state; renderState(); } catch (error) { setMessage(dom.settingsMessage, error.message, true); }
  });

  async function navigate(direction) {
    try { app.state = (await postJson("/api/state", { action: "navigate", direction })).state; renderState(); } catch (error) { setMessage(dom.settingsMessage, error.message, true); }
  }

  dom.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      app.state = (await postJson("/api/state", {
        week_start: dom.weekStart.value,
        slideshow_seconds: Number(dom.slideshowSeconds.value),
        show_photo_captions: dom.showPhotoCaptions.checked,
        display_title: dom.displayTitleInput.value,
        overnight_enabled: dom.overnightEnabled.checked,
        overnight_start: dom.overnightStart.value,
        overnight_end: dom.overnightEnd.value
      })).state;
      renderState();
      setMessage(dom.settingsMessage, "Saved on the Pi.");
    } catch (error) {
      setMessage(dom.settingsMessage, error.message, true);
    }
  });

  dom.uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const files = [...dom.photoInput.files];
    if (!files.length) { setMessage(dom.uploadMessage, "Choose at least one photo first.", true); return; }
    dom.uploadMessage.textContent = `Uploading ${files.length} photo${files.length === 1 ? "" : "s"}…`;
    let uploaded = 0;
    for (const file of files) {
      const form = new FormData();
      form.append("photo", file, file.name);
      try {
        await requestJson("/api/photos", { method: "POST", body: form });
        uploaded += 1;
      } catch (error) {
        setMessage(dom.uploadMessage, `${file.name}: ${error.message}`, true);
      }
    }
    dom.photoInput.value = "";
    await loadPhotos();
    if (uploaded) setMessage(dom.uploadMessage, `${uploaded} photo${uploaded === 1 ? "" : "s"} added.`);
  });

  dom.googleSyncButton.addEventListener("click", async () => {
    try {
      dom.googleSyncButton.disabled = true;
      dom.googleSyncButton.textContent = "Syncing…";
      await postJson("/api/google/sync", {});
      await loadState();
      await loadGoogle();
    } catch (error) {
      setMessage(dom.settingsMessage, error.message, true);
    } finally {
      dom.googleSyncButton.disabled = false;
      dom.googleSyncButton.textContent = "Sync now";
    }
  });

  async function init() {
    try {
      app.state = await requestJson("/api/state");
      const auth = await requestJson("/api/auth/me");
      if (!auth.authenticated) { showLogin(); return; }
      showControls();
      renderState();
      await loadPhotos();
      await loadGoogle();
      await pickerRequest();
    } catch (error) {
      dom.loginError.textContent = error.message;
      showLogin();
    }
  }

  init();
})();
