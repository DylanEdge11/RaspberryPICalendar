(() => {
  "use strict";

  const dom = {
    displayTitle: document.getElementById("displayTitle"),
    modeLabel: document.getElementById("modeLabel"),
    syncStatus: document.getElementById("syncStatus"),
    clock: document.getElementById("clock"),
    viewKicker: document.getElementById("viewKicker"),
    periodTitle: document.getElementById("periodTitle"),
    periodSubtitle: document.getElementById("periodSubtitle"),
    calendarLegend: document.getElementById("calendarLegend"),
    calendarMount: document.getElementById("calendarMount"),
    photoHeading: document.getElementById("photoHeading"),
    photoCount: document.getElementById("photoCount"),
    photoFrame: document.getElementById("photoFrame"),
    photoImage: document.getElementById("photoImage"),
    photoEmpty: document.getElementById("photoEmpty"),
    photoCaption: document.getElementById("photoCaption"),
    photoCaptionBar: document.getElementById("photoCaptionBar"),
    photoIndex: document.getElementById("photoIndex"),
    photoNote: document.getElementById("photoNote"),
    footerMessage: document.getElementById("footerMessage"),
    connectionMessage: document.getElementById("connectionMessage")
  };

  const app = {
    state: null,
    events: [],
    photos: [],
    photoIndex: 0,
    photoTimer: null,
    lastPeriodKey: "",
    stream: null
  };

  const TIME_START = 6 * 60;
  const TIME_END = 22 * 60;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  }

  function safeColor(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#6d7bea";
  }

  function dateFromKey(key) {
    return new Date(`${key}T12:00:00Z`);
  }

  function addDays(key, amount) {
    const date = dateFromKey(key);
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  }

  function formatDate(key, options = {}) {
    if (!key) return "";
    return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...options }).format(dateFromKey(key));
  }

  function formatPeriod(state) {
    const settings = state.settings;
    if (settings.view === "month") {
      return formatDate(`${settings.anchor_date.slice(0, 7)}-01`, { month: "long", year: "numeric" });
    }
    const start = state.period.start;
    const end = addDays(state.period.end, -1);
    const startDate = dateFromKey(start);
    const endDate = dateFromKey(end);
    const sameYear = startDate.getUTCFullYear() === endDate.getUTCFullYear();
    const sameMonth = sameYear && startDate.getUTCMonth() === endDate.getUTCMonth();
    if (sameMonth) return `${formatDate(start, { month: "short", day: "numeric" })} – ${formatDate(end, { day: "numeric" })}, ${startDate.getUTCFullYear()}`;
    if (sameYear) return `${formatDate(start, { month: "short", day: "numeric" })} – ${formatDate(end, { month: "short", day: "numeric" })}, ${startDate.getUTCFullYear()}`;
    return `${formatDate(start, { month: "short", day: "numeric", year: "numeric" })} – ${formatDate(end, { month: "short", day: "numeric", year: "numeric" })}`;
  }

  function formatTime(time) {
    if (!time) return "";
    const [hourText, minute] = time.split(":");
    const hour = Number(hourText);
    if (!Number.isInteger(hour)) return time;
    const suffix = hour >= 12 ? "PM" : "AM";
    const twelveHour = hour % 12 || 12;
    return `${twelveHour}:${minute} ${suffix}`;
  }

  function timeToMinutes(value) {
    if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function periodKey(state) {
    return `${state.settings.view}:${state.settings.anchor_date}:${state.settings.week_start}`;
  }

  function syncKey(state) {
    const calendar = state?.calendar || {};
    return `${calendar.revision || 0}:${calendar.last_success_at || ""}:${calendar.error || ""}:${calendar.stale ? "stale" : "fresh"}`;
  }

  async function requestJson(url, options) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  async function loadState() {
    const next = await requestJson("/api/state");
    const changedPeriod = !app.state || periodKey(app.state) !== periodKey(next);
    const changedCalendar = !app.state || syncKey(app.state) !== syncKey(next);
    const changedPhotos = !app.state || app.state.photo_count !== next.photo_count;
    app.state = next;
    renderChrome();
    if (changedPeriod || changedCalendar) await loadEvents();
    if (changedPhotos) await loadPhotos();
  }

  async function loadEvents() {
    if (!app.state?.period) return;
    try {
      const params = new URLSearchParams({ start: app.state.period.start, end: app.state.period.end });
      const payload = await requestJson(`/api/events?${params}`);
      app.events = Array.isArray(payload.events) ? payload.events : [];
      renderCalendar();
    } catch (error) {
      dom.calendarMount.innerHTML = `<div class="empty-calendar"><strong>Calendar temporarily unavailable</strong><span>${escapeHtml(error.message)}</span></div>`;
    }
  }

  async function loadPhotos() {
    try {
      const payload = await requestJson("/api/photos");
      app.photos = Array.isArray(payload.photos) ? payload.photos : [];
      if (app.photoIndex >= app.photos.length) app.photoIndex = 0;
      renderPhoto();
      schedulePhotoTimer();
    } catch {
      app.photos = [];
      renderPhoto();
    }
  }

  function renderChrome() {
    if (!app.state) return;
    const { settings, calendar } = app.state;
    const isDemo = app.state.mode === "demo";
    dom.displayTitle.textContent = settings.display_title;
    dom.modeLabel.textContent = isDemo ? "Family calendar · demo" : "Family calendar";
    dom.viewKicker.textContent = settings.view === "month" ? "THIS MONTH" : "THIS WEEK";
    dom.periodTitle.textContent = formatPeriod(app.state);
    dom.periodSubtitle.textContent = settings.view === "month" ? "A full-month view for the room’s big picture." : "The family’s next seven days, at a glance.";
    dom.footerMessage.textContent = isDemo ? "Demo mode · no account data connected" : `Private home display · ${app.state.timezone}`;
    dom.syncStatus.classList.toggle("stale", Boolean(calendar?.stale));
    dom.syncStatus.innerHTML = `<span class="status-dot"></span>${escapeHtml(calendar?.label || "Calendar status unknown")}`;
    updateClock();
    updateNightMode();
    updatePhotoCaptionVisibility();
    renderLegend();
    renderCalendar();
  }

  function renderLegend() {
    const seen = new Map();
    for (const event of app.events) {
      const name = event.calendar || "Calendar";
      if (!seen.has(name)) seen.set(name, safeColor(event.calendar_color));
    }
    const items = [...seen.entries()].slice(0, 5);
    dom.calendarLegend.innerHTML = items.map(([name, color]) => `<span class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${escapeHtml(name)}</span>`).join("");
  }

  function renderCalendar() {
    if (!app.state?.period) return;
    dom.calendarMount.innerHTML = app.state.settings.view === "month" ? renderMonth() : renderWeek();
  }

  function renderWeek() {
    const dates = [];
    for (let date = app.state.period.start; date < app.state.period.end; date = addDays(date, 1)) dates.push(date);
    const dayHeadings = dates.map((date) => {
      const today = date === app.state.today;
      return `<div class="day-heading ${today ? "today" : ""}"><span>${formatDate(date, { weekday: "short" })}</span><span class="day-number">${formatDate(date, { day: "numeric" })}</span></div>`;
    }).join("");
    const allDay = dates.map((date) => {
      const events = app.events.filter((event) => event.all_day && date >= event.start_date && date < event.end_date);
      const visible = events.slice(0, 2).map((event) => `<span class="allday-chip" style="--event-color:${safeColor(event.calendar_color)}" title="${escapeHtml(event.title)}">${escapeHtml(event.title)}</span>`).join("");
      const more = events.length > 2 ? `<div class="allday-more">+${events.length - 2} more</div>` : "";
      return `<div class="allday-cell">${visible}${more}</div>`;
    }).join("");
    const dayCanvases = dates.map((date) => renderDayCanvas(date)).join("");
    const timeLabels = Array.from({ length: 16 }, (_, index) => `<div class="time-label">${formatHour(TIME_START / 60 + index)}</div>`).join("");
    return `<div class="week-view">
      <div class="week-header"><div></div><div class="week-head-days">${dayHeadings}</div></div>
      <div class="week-allday"><div class="time-gutter-label">ALL<br>DAY</div><div class="allday-days">${allDay}</div></div>
      <div class="week-time-row"><div class="time-axis">${timeLabels}</div><div class="day-canvases">${dayCanvases}</div></div>
    </div>`;
  }

  function formatHour(hour) {
    const suffix = hour >= 12 ? "PM" : "AM";
    const twelveHour = hour % 12 || 12;
    return `${twelveHour} ${suffix}`;
  }

  function renderDayCanvas(date) {
    const events = app.events.filter((event) => !event.all_day && eventOverlapsDate(event, date));
    const positioned = positionEvents(events, date);
    const html = positioned.map(({ event, lane, laneCount, top, height }) => {
      const color = safeColor(event.calendar_color);
      const left = (lane * 100) / laneCount;
      const width = 100 / laneCount;
      const time = event.start_time ? `${formatTime(event.start_time)}${event.end_time ? ` – ${formatTime(event.end_time)}` : ""}` : "";
      return `<div class="timed-event" style="--event-color:${color};top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 5px)" title="${escapeHtml(`${event.title}${time ? ` · ${time}` : ""}`)}"><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(time)}</span></div>`;
    }).join("");
    return `<div class="day-canvas ${date === app.state.today ? "today" : ""}">${html}</div>`;
  }

  function positionEvents(events, date) {
    const rowHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-height")) || 43;
    const sorted = events.map((event) => {
      const start = event.start_date === date ? timeToMinutes(event.start_time) ?? TIME_START : TIME_START;
      const end = event.end_date === date ? timeToMinutes(event.end_time) ?? TIME_END : TIME_END;
      return { event, start, end };
    }).filter((item) => item.end > item.start).map((item) => {
      let { start, end } = item;
      start = Math.max(TIME_START, Math.min(TIME_END, start));
      end = Math.max(start + 20, Math.min(TIME_END, end));
      return { ...item, start, end };
    }).filter((item) => item.end > TIME_START && item.start < TIME_END).sort((a, b) => a.start - b.start || a.end - b.end);
    const laneEnds = [];
    const positioned = [];
    for (const item of sorted) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = item.end;
      positioned.push({ ...item, lane, top: ((item.start - TIME_START) / 60) * rowHeight + 2, height: Math.max(22, ((item.end - item.start) / 60) * rowHeight - 4) });
    }
    return positioned.map((item) => ({ ...item, laneCount: laneEnds.length }));
  }

  function renderMonth() {
    const dates = [];
    for (let date = app.state.period.start; date < app.state.period.end; date = addDays(date, 1)) dates.push(date);
    const monthKey = app.state.settings.anchor_date.slice(0, 7);
    const weekdays = dates.slice(0, 7).map((date) => `<div class="month-weekday">${escapeHtml(formatDate(date, { weekday: "short" }))}</div>`).join("");
    const cells = dates.map((date) => {
      const events = app.events.filter((event) => eventOverlapsDate(event, date)).sort((a, b) => Number(b.all_day) - Number(a.all_day) || (a.start_time || "").localeCompare(b.start_time || ""));
      const visible = events.slice(0, 4).map((event) => {
        const color = safeColor(event.calendar_color);
        const time = event.all_day ? "All day" : formatTime(event.start_time);
        return `<div class="month-event" style="--event-color:${color}" title="${escapeHtml(event.title)}"><span class="event-dot"></span><span class="event-time">${escapeHtml(time)}</span><span class="event-title">${escapeHtml(event.title)}</span></div>`;
      }).join("");
      const more = events.length > 4 ? `<div class="month-more">+${events.length - 4} more</div>` : "";
      const outside = date.slice(0, 7) !== monthKey;
      return `<div class="month-cell ${outside ? "outside" : ""} ${date === app.state.today ? "today" : ""}"><div class="month-date">${formatDate(date, { day: "numeric" })}</div>${visible}${more}</div>`;
    }).join("");
    return `<div class="month-view"><div class="month-weekdays">${weekdays}</div><div class="month-grid">${cells}</div></div>`;
  }

  function eventOverlapsDate(event, date) {
    if (event.all_day) return date >= event.start_date && date < event.end_date;
    if (date < event.start_date || date > event.end_date) return false;
    const start = date === event.start_date ? (timeToMinutes(event.start_time) ?? 0) : 0;
    const end = date === event.end_date ? (timeToMinutes(event.end_time) ?? 1440) : 1440;
    return end > start;
  }

  function updatePhotoCaptionVisibility() {
    const photo = app.photos[app.photoIndex % app.photos.length];
    // Sample images remain explicitly labelled even when real-photo labels are hidden.
    dom.photoCaptionBar.classList.toggle("hidden", !photo?.demo && !app.state?.settings?.show_photo_captions);
  }

  function renderPhoto() {
    updatePhotoCaptionVisibility();
    const count = app.photos.length;
    dom.photoCount.textContent = count ? `${String(count).padStart(2, "0")}` : "—";
    dom.photoEmpty.classList.toggle("hidden", Boolean(count));
    if (!count) {
      dom.photoImage.removeAttribute("src");
      dom.photoImage.classList.remove("loaded");
      dom.photoCaption.textContent = "No photos yet";
      dom.photoIndex.textContent = "—";
      dom.photoNote.textContent = "Add family photos from the phone controls; uploaded photos stay on this Pi.";
      return;
    }
    const photo = app.photos[app.photoIndex % count];
    const next = app.photos[(app.photoIndex + 1) % count];
    dom.photoImage.classList.remove("loaded");
    dom.photoImage.alt = photo.original_name || "Family photo";
    dom.photoImage.onload = () => dom.photoImage.classList.add("loaded");
    dom.photoImage.src = `${photo.url}${photo.demo ? "" : `?v=${encodeURIComponent(photo.created_at || "")}`}`;
    dom.photoCaption.textContent = photo.demo ? "Sample image · demo" : (photo.original_name || "Family photo");
    dom.photoIndex.textContent = `${String(app.photoIndex + 1).padStart(2, "0")} / ${String(count).padStart(2, "0")}`;
    dom.photoNote.textContent = app.state?.mode === "demo" ? "Demo images are labelled; uploaded photos can be added from the phone controls." : "Photos stay on this Pi and keep cycling if the internet goes away.";
    const preload = new Image();
    preload.src = next.url;
  }

  function schedulePhotoTimer() {
    window.clearInterval(app.photoTimer);
    const seconds = app.state?.settings?.slideshow_seconds || 12;
    app.photoTimer = window.setInterval(() => {
      if (app.photos.length > 1) {
        app.photoIndex = (app.photoIndex + 1) % app.photos.length;
        renderPhoto();
      }
    }, seconds * 1000);
  }

  function updateClock() {
    if (!app.state) return;
    dom.clock.textContent = new Intl.DateTimeFormat(undefined, { timeZone: app.state.timezone, hour: "numeric", minute: "2-digit" }).format(new Date());
  }

  function updateNightMode() {
    if (!app.state) return;
    const { settings } = app.state;
    const now = new Intl.DateTimeFormat("en-GB", { timeZone: app.state.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    const current = timeToMinutes(now);
    const start = timeToMinutes(settings.overnight_start);
    const end = timeToMinutes(settings.overnight_end);
    const overnight = Boolean(settings.overnight_enabled) && start !== null && end !== null && (start > end ? current >= start || current < end : current >= start && current < end);
    document.body.classList.toggle("night-mode", overnight);
  }

  function connectUpdates() {
    if (!window.EventSource) {
      window.setInterval(() => loadState().catch(() => {}), 3000);
      return;
    }
    app.stream = new EventSource("/api/updates");
    app.stream.addEventListener("state", async (message) => {
      try {
        const next = JSON.parse(message.data);
        const changedPeriod = !app.state || periodKey(app.state) !== periodKey(next);
        const changedSlideshow = !app.state || app.state.settings.slideshow_seconds !== next.settings.slideshow_seconds;
        const changedCalendar = !app.state || syncKey(app.state) !== syncKey(next);
        const changedPhotos = !app.state || app.state.photo_count !== next.photo_count;
        app.state = next;
        renderChrome();
        if (changedPeriod || changedCalendar) await loadEvents();
        if (changedPhotos) await loadPhotos();
        if (changedSlideshow) schedulePhotoTimer();
      } catch {
        // A malformed event is ignored; the next heartbeat or reconnect will recover.
      }
    });
    app.stream.onopen = () => {
      dom.connectionMessage.textContent = "Connected";
    };
    app.stream.onerror = () => {
      dom.connectionMessage.textContent = "Reconnecting…";
    };
  }

  async function init() {
    try {
      await loadState();
    } catch (error) {
      dom.periodTitle.textContent = "Display is waiting for the service";
      dom.periodSubtitle.textContent = error.message;
      dom.connectionMessage.textContent = "Offline";
    }
    connectUpdates();
    window.setInterval(updateClock, 30_000);
    window.setInterval(updateNightMode, 30_000);
  }

  init();
})();
