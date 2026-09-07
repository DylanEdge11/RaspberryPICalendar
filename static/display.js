(() => {
  "use strict";

  // Preserve keyboard focus cues without leaving rings behind after a tap.
  document.addEventListener("pointerdown", () => document.body.classList.add("pointer-navigation"), true);
  document.addEventListener("keydown", event => {
    if (["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) document.body.classList.remove("pointer-navigation");
  }, true);
  // Allow scrolling inside days, but stop edge gestures from moving the page.
  let calendarTouchY = 0;
  document.querySelector(".display-app").addEventListener("touchstart", event => {
    calendarTouchY = event.touches[0]?.clientY || 0;
  }, { passive: true });
  document.querySelector(".display-app").addEventListener("touchmove", event => {
    if (event.touches.length !== 1) return;
    const day = event.target.closest(".month-cell");
    const delta = event.touches[0].clientY - calendarTouchY;
    calendarTouchY = event.touches[0].clientY;
    if (day && day.scrollHeight > day.clientHeight) {
      const atTop = day.scrollTop <= 0;
      const atBottom = day.scrollTop + day.clientHeight >= day.scrollHeight - 1;
      if (!(atTop && delta > 0) && !(atBottom && delta < 0)) return;
    }
    event.preventDefault();
  }, { passive: false });

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


  const weatherButton = document.getElementById("weatherWidget");
  const weatherDialog = document.getElementById("weatherDialog");
  let weatherData = null;
  let weatherError = "";
  let weatherRequest = 0;
  const degrees = value => Number.isFinite(value) ? Math.round(value) + "°" : "—";
  function conditions(code) {
    if (code === 0) return ["☀️", "Clear"];
    if ([1, 2].includes(code)) return ["🌤️", "Partly cloudy"];
    if (code === 3) return ["☁️", "Overcast"];
    if ([45, 48].includes(code)) return ["🌫️", "Fog"];
    if ([71, 73, 75, 77, 85, 86].includes(code)) return ["🌨️", "Snow"];
    if ([95, 96, 99].includes(code)) return ["⛈️", "Thunderstorms"];
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return ["🌧️", "Rain"];
    return ["☁️", "Conditions unavailable"];
  }
  async function loadWeather() {
    if (!app.state) return;
    const request = ++weatherRequest;
    const city = app.state.settings.weather_city;
    if (weatherData?.city !== city) weatherData = null;
    weatherError = "";
    renderWeather();
    try {
      const data = await requestJson("/api/weather");
      if (request !== weatherRequest) return;
      weatherData = { ...data, city };
    } catch (error) {
      if (request !== weatherRequest) return;
      weatherError = error.message;
    }
    renderWeather();
  }
  function renderWeather() {
    if (!app.state) return;
    const city = app.state.settings.weather_city;
    const data = weatherData;
    const weekly = app.state.settings.weather_duration === "weekly";
    document.getElementById("weatherTitle").textContent = (data?.location.name || city) + " · " + (weekly ? "Next 7 days" : "Hourly today");
    if (!data) {
      weatherButton.textContent = "☁ " + city + (weatherError ? " · Unavailable" : " · Loading…");
      document.getElementById("weatherBody").textContent = weatherError || "Loading forecast…";
      return;
    }
    const [icon, label] = conditions(data.current.weather_code);
    const stale = data.stale || Boolean(weatherError);
    weatherButton.textContent = icon + " " + degrees(data.current.temperature_2m) + "C · " + city + (stale ? " · Last saved" : "");
    weatherButton.setAttribute("aria-label", city + ": " + degrees(data.current.temperature_2m) + " Celsius, " + label + ". Open " + (weekly ? "7-day forecast" : "today's hourly forecast"));
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: data.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const source = weekly ? data.daily : data.hourly;
    const rows = source.time.map((time, i) => {
      if (!weekly && time.slice(0, 10) !== today) return "";
      const [symbol, description] = conditions(source.weather_code[i]);
      const when = weekly ? formatDate(time, { weekday: "short", month: "short", day: "numeric" }) : formatTime(time.slice(11, 16));
      const temp = weekly ? degrees(source.temperature_2m_max[i]) + " / " + degrees(source.temperature_2m_min[i]) : degrees(source.temperature_2m[i]);
      const rain = (weekly ? source.precipitation_probability_max : source.precipitation_probability)?.[i];
      return '<tr><th scope="row">' + escapeHtml(when) + '</th><td>' + symbol + ' ' + description + '</td><td>' + temp + '</td><td>' + (Number.isFinite(rain) ? rain + "%" : "—") + '</td></tr>';
    }).join("");
    document.getElementById("weatherBody").innerHTML = '<p>' + icon + ' ' + label + ' · Feels like ' + degrees(data.current.apparent_temperature) + 'C · Wind ' + (Number.isFinite(data.current.wind_speed_10m) ? Math.round(data.current.wind_speed_10m) + ' km/h' : '—') + '</p><p class="muted-copy">' + (stale ? 'Weather may be out of date. Last successful update: ' : 'Updated: ') + escapeHtml(new Date(data.updated_at).toLocaleString()) + ' · Forecast times: ' + escapeHtml(data.timezone) + '</p>' + (rows ? '<div class="weather-table-wrap"><table class="weather-table"><thead><tr><th>' + (weekly ? 'Day' : 'Time') + '</th><th>Conditions</th><th>' + (weekly ? 'High / Low' : 'Temp') + '</th><th>Precip.</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p>Today’s forecast is unavailable. Waiting for updated weather.</p>');
  }
  weatherButton.addEventListener("click", () => { renderWeather(); weatherDialog.showModal(); loadWeather(); });
  document.getElementById("closeWeather").addEventListener("click", () => weatherDialog.close());
  setInterval(loadWeather, 5 * 60 * 1000);

  let TIME_START = 6 * 60;
  let TIME_END = 22 * 60;
  let weeklyRowHeight = 43;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  }

  function safeColor(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#6d7bea";
  }

  function eventTint(color) {
    const hex = safeColor(color).slice(1);
    const channels = [0, 2, 4].map(offset => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * 0.18 + 255 * 0.82));
    return `rgb(${channels.join(',')})`;
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
    if (app.state?.instance_id && next.instance_id && app.state.instance_id !== next.instance_id) {
      window.location.reload();
      return;
    }
    const changedPeriod = !app.state || periodKey(app.state) !== periodKey(next);
    const changedCalendar = !app.state || syncKey(app.state) !== syncKey(next);
    const changedPhotos = !app.state || app.state.photo_count !== next.photo_count;
    const weatherChanged = app.state?.settings.weather_city !== next.settings.weather_city;
    app.state = next;
    if (weatherChanged) loadWeather();
    else renderWeather();
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
      const color = safeColor(event.calendar_color);
      seen.set(`${name}:${color}`, [name, color]);
    }
    const items = [...seen.values()].slice(0, 5);
    dom.calendarLegend.innerHTML = items.map(([name, color]) => `<span class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${escapeHtml(name)}</span>`).join("");
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCalendar, 150);
  });

  const detailDialog = document.getElementById("eventDialog");
  const detailBody = document.getElementById("detailBody");
  let detailEvents = [];
  function eventButton(event) {
    return `type="button" data-event="${app.events.indexOf(event)}" aria-label="${escapeHtml(`Show details: ${event.title}`)}"`;
  }
  function eventWhen(event) {
    const options = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
    const start = formatDate(event.start_date, options);
    if (event.all_day) {
      const last = addDays(event.end_date, -1);
      return `${start}${last > event.start_date ? ` – ${formatDate(last, options)}` : ""} · All day`;
    }
    return `${start}, ${formatTime(event.start_time)} – ${event.end_date !== event.start_date ? `${formatDate(event.end_date, options)}, ` : ""}${formatTime(event.end_time)} · ${app.state.timezone}`;
  }
  function openDetails(title, content) {
    document.getElementById("detailTitle").textContent = title;
    detailBody.innerHTML = content;
    if (!detailDialog.open) detailDialog.showModal();
    detailDialog.scrollTop = 0;
    document.getElementById("closeDetails").focus();
  }
  function handleCalendarTap(event) {
    const button = event.target.closest("[data-event], [data-day]");
    if (!button) return;
    if (button.dataset.day) {
      detailEvents = app.events.slice();
      const date = button.dataset.day;
      const events = app.events.filter(item => eventOverlapsDate(item, date)).sort((a, b) => Number(b.all_day) - Number(a.all_day) || (a.start_time || "").localeCompare(b.start_time || ""));
      openDetails(formatDate(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" }), events.length ? events.map(item => `<button ${eventButton(item)} class="day-list-event"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(eventWhen(item))}</span><span>${escapeHtml(item.calendar || "Calendar")}</span></button>`).join("") : "<p>No events for this day.</p>");
    } else {
      const item = (detailBody.contains(button) ? detailEvents : app.events)[Number(button.dataset.event)];
      if (!item) return;
      openDetails(item.title || "Untitled event", `<p>${escapeHtml(eventWhen(item))}</p><p><strong>Calendar</strong><br>${escapeHtml(item.calendar || "Calendar")}</p>${item.location ? `<p><strong>Location</strong><br>${escapeHtml(item.location)}</p>` : ""}<p class="event-description">${escapeHtml(item.description || "No additional details.")}</p>`);
    }
  }
  dom.calendarMount.addEventListener("click", handleCalendarTap);
  detailBody.addEventListener("click", handleCalendarTap);
  document.getElementById("closeDetails").addEventListener("click", () => detailDialog.close());
  let backdropPress = false;
  detailDialog.addEventListener("pointerdown", event => { backdropPress = event.target === detailDialog; });
  detailDialog.addEventListener("click", event => {
    if (backdropPress && event.target === detailDialog) {
      const rect = detailDialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) detailDialog.close();
    }
    backdropPress = false;
  });

  function renderCalendar() {
    if (!app.state?.period) return;
    const dayScrolls = new Map([...dom.calendarMount.querySelectorAll(".month-cell")].map(cell => [cell.querySelector("[data-day]").dataset.day, cell.scrollTop]));
    renderLegend();
    dom.calendarMount.innerHTML = app.state.settings.view === "month" ? renderMonth() : renderWeek();
    if (app.state.settings.view === "week") {
      const row = dom.calendarMount.querySelector(".week-time-row");
      weeklyRowHeight = Math.max(1, row.clientHeight / (TIME_END - TIME_START) * 60);
      dom.calendarMount.querySelector(".week-view").style.setProperty("--row-height", `${weeklyRowHeight}px`);
      row.querySelectorAll(".day-canvas").forEach(canvas => {
        canvas.outerHTML = renderDayCanvas(canvas.dataset.date);
      });
      row.querySelectorAll(".time-label").forEach((label, index) => {
        label.style.visibility = weeklyRowHeight < 20 && index % 2 ? "hidden" : "visible";
      });
    } else {
      dom.calendarMount.querySelectorAll(".month-cell").forEach(cell => {
        cell.scrollTop = dayScrolls.get(cell.querySelector("[data-day]").dataset.day) || 0;
      });
    }
  }

  function renderWeek() {
    TIME_START = (app.state.settings.weekly_start_hour ?? 6) * 60;
    TIME_END = (app.state.settings.weekly_end_hour ?? 22) * 60;
    const hours = (TIME_END - TIME_START) / 60;
    weeklyRowHeight = Math.max(1, (dom.calendarMount.clientHeight - 125) / hours);
    const dates = [];
    for (let date = app.state.period.start; date < app.state.period.end; date = addDays(date, 1)) dates.push(date);
    const dayHeadings = dates.map((date) => {
      const today = date === app.state.today;
      return `<button type="button" data-day="${date}" aria-label="Show all events for ${date}" class="day-heading ${today ? "today" : ""}"><span>${formatDate(date, { weekday: "short" })}</span><span class="day-number">${formatDate(date, { day: "numeric" })}</span></button>`;
    }).join("");
    const allDay = dates.map((date) => {
      const events = app.events.filter((event) => event.all_day && date >= event.start_date && date < event.end_date);
      const visible = events.slice(0, 2).map((event) => `<button ${eventButton(event)} class="allday-chip" style="--event-color:${safeColor(event.calendar_color)};--event-tint:${eventTint(event.calendar_color)}" title="${escapeHtml(event.title)}">${escapeHtml(event.title)}</button>`).join("");
      const more = events.length > 2 ? `<button type="button" data-day="${date}" class="allday-more">+${events.length - 2} more</button>` : "";
      return `<div class="allday-cell">${visible}${more}</div>`;
    }).join("");
    const dayCanvases = dates.map((date) => renderDayCanvas(date)).join("");
    const timeLabels = Array.from({ length: hours }, (_, index) => `<div class="time-label">${formatHour(TIME_START / 60 + index)}</div>`).join("");
    return `<div class="week-view" style="--visible-hours:${hours};--row-height:${weeklyRowHeight}px">
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
      return `<button ${eventButton(event)} class="timed-event ${height < 34 ? 'compact-event' : ''}" style="--event-color:${color};--event-tint:${eventTint(color)};top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 5px)" title="${escapeHtml(`${event.title}${time ? ` · ${time}` : ""}`)}"><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(time)}</span></button>`;
    }).join("");
    return `<div data-date="${date}" class="day-canvas ${date === app.state.today ? "today" : ""}">${html}</div>`;
  }

  function positionEvents(events, date) {
    const rowHeight = weeklyRowHeight;
    const sorted = events.map((event) => {
      const start = event.start_date === date ? timeToMinutes(event.start_time) ?? TIME_START : TIME_START;
      const end = event.end_date === date ? timeToMinutes(event.end_time) ?? TIME_END : TIME_END;
      return { event, start, end };
    }).filter((item) => item.end > item.start && item.end > TIME_START && item.start < TIME_END).map((item) => {
      let { start, end } = item;
      start = Math.max(TIME_START, Math.min(TIME_END, start));
      end = Math.min(TIME_END, Math.max(start + 20, end));
      return { ...item, start, end };
    }).filter((item) => item.end > TIME_START && item.start < TIME_END).sort((a, b) => a.start - b.start || a.end - b.end);
    const laneEnds = [];
    const positioned = [];
    for (const item of sorted) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = item.end;
      const top = ((item.start - TIME_START) / 60) * rowHeight;
      const available = ((TIME_END - item.start) / 60) * rowHeight;
      positioned.push({ ...item, lane, top, height: Math.min(available, Math.max(22, ((item.end - item.start) / 60) * rowHeight - 2)) });
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
      const visible = events.map((event) => {
        const color = safeColor(event.calendar_color);
        const time = event.all_day ? "All day" : formatTime(event.start_time);
        return `<button ${eventButton(event)} class="month-event" style="--event-color:${color};--event-tint:${eventTint(color)}" title="${escapeHtml(event.title)}"><span class="event-dot"></span><span class="event-time">${escapeHtml(time)}</span><span class="event-title">${escapeHtml(event.title)}</span></button>`;
      }).join("");
      const more = "";
      const outside = date.slice(0, 7) !== monthKey;
      return `<div class="month-cell ${outside ? "outside" : ""} ${date === app.state.today ? "today" : ""}"><button type="button" data-day="${date}" aria-label="Show all events for ${date}" class="month-date">${formatDate(date, { day: "numeric" })}</button>${visible}${more}</div>`;
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

  const albumDialog = document.getElementById("albumDialog");
  const albumImage = document.getElementById("albumImage");
  const albumTrigger = document.getElementById("openAlbum");
  function renderAlbum() {
    if (!albumDialog.open) return;
    const photo = app.photos[app.photoIndex % app.photos.length];
    document.getElementById("albumEmpty").hidden = Boolean(photo);
    document.getElementById("albumDemoLabel").hidden = !photo?.demo;
    albumImage.hidden = !photo;
    if (!photo) { albumImage.removeAttribute("src"); return; }
    albumImage.alt = photo.original_name || "Family photo";
    albumImage.src = photo.url + (photo.demo ? "" : "?v=" + encodeURIComponent(photo.created_at || ""));
  }
  function openAlbum() {
    if (!albumDialog.open) albumDialog.showModal();
    renderAlbum();
  }
  albumTrigger.addEventListener("click", openAlbum);
  albumTrigger.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openAlbum(); }
  });
  for (const id of ["closeAlbum", "backToCalendar"]) {
    document.getElementById(id).addEventListener("click", () => albumDialog.close());
  }
  albumDialog.addEventListener("close", () => albumTrigger.focus());

  function renderPhoto() {
    renderAlbum();
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
      if (!document.hidden && app.photos.length > 1) {
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
        if (app.state?.instance_id && next.instance_id && app.state.instance_id !== next.instance_id) {
          window.location.reload();
          return;
        }
        const changedPeriod = !app.state || periodKey(app.state) !== periodKey(next);
        const changedSlideshow = !app.state || app.state.settings.slideshow_seconds !== next.settings.slideshow_seconds;
        const changedCalendar = !app.state || syncKey(app.state) !== syncKey(next);
        const changedPhotos = !app.state || app.state.photo_count !== next.photo_count;
        const changedWeather = app.state?.settings.weather_city !== next.settings.weather_city;
        app.state = next;
        if (changedWeather) loadWeather();
        else renderWeather();
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

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadState().catch(() => { dom.connectionMessage.textContent = "Reconnecting…"; });
  });
  window.addEventListener("online", () => loadState().catch(() => {}));
  init();
})();
