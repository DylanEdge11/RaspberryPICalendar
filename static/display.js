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
    weatherDialog.classList.toggle("hourly-weather", !weekly);
    document.getElementById("weatherTitle").textContent = (data?.location.name || city) + " · " + (weekly ? "Next 7 days" : "Hourly today");
    if (!data) {
      weatherButton.textContent = "☁ " + city + (weatherError ? " · Unavailable" : " · Loading…");
      document.getElementById("weatherBody").textContent = weatherError || "Loading forecast…";
      return;
    }
    const [icon, label] = conditions(data.current.display_weather_code ?? data.current.weather_code);
    const stale = data.stale || Boolean(weatherError);
    const theme = ({ Clear: 'sunny', 'Partly cloudy': 'partly', Overcast: 'cloudy', Fog: 'fog', Rain: 'rain', Snow: 'snow', Thunderstorms: 'storm' })[label] || 'cloudy';
    weatherButton.dataset.weather = theme;
    weatherDialog.dataset.weather = theme;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: data.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const dayIndex = data.daily.time.indexOf(today);
    const dailyValue = key => data.daily[key]?.[dayIndex];
    const todayHigh = degrees(dailyValue('temperature_2m_max'));
    const todayLow = degrees(dailyValue('temperature_2m_min'));
    const amount = (value, unit) => Number.isFinite(value) ? (value > 0 && value < 0.1 ? '<0.1' : String(Math.round(value * 10) / 10)) + ' ' + unit : '—';
    const precipitation = dailyValue('precipitation_sum');
    const snow = dailyValue('snowfall_sum');
    const chance = dailyValue('precipitation_probability_max');
    const precipText = amount(precipitation, 'mm') + (Number.isFinite(chance) ? ' · ' + Math.round(chance) + '%' : ' · —%');
    const precipTitle = 'Today’s total precipitation in water equivalent and maximum chance.' + (Number.isFinite(snow) && snow > 0 ? ' Includes ' + amount(snow, 'cm') + ' snowfall.' : '');
    weatherButton.innerHTML = '<span class="weather-scene" aria-hidden="true"><i class="scene-sun"></i><i class="scene-cloud cloud-one"></i><i class="scene-cloud cloud-two"></i><i class="scene-precip"></i></span><span class="weather-compact"><span class="weather-compact-left"><span class="weather-compact-temp">' + degrees(data.current.temperature_2m) + '<small>C</small></span><span class="weather-compact-feels">Feels ' + degrees(data.current.apparent_temperature) + '</span></span><span class="weather-compact-place"><strong>' + escapeHtml(city) + '</strong><span>' + label + '</span><span class="weather-compact-range">H ' + todayHigh + ' · L ' + todayLow + '</span></span><span class="weather-compact-precip" title="' + escapeHtml(precipTitle) + '"><span>☂ Today' + (stale ? ' · Saved' : '') + '</span><strong>' + escapeHtml(amount(precipitation, 'mm')) + '</strong><span>' + (Number.isFinite(chance) ? Math.round(chance) + '% chance' : 'Chance —') + '</span></span></span>';
    weatherButton.setAttribute("aria-label", city + ": " + degrees(data.current.temperature_2m) + " Celsius, " + label + ". Feels like " + degrees(data.current.apparent_temperature) + ". Today: precipitation " + precipText + ". " + precipTitle + (stale ? " Last saved forecast." : "") + ". Open " + (weekly ? "7-day forecast" : "today's hourly forecast"));
    const source = weekly ? data.daily : data.hourly;
    const rows = source.time.map((time, i) => {
      if (!weekly && time.slice(0, 10) !== today) return "";
      const [symbol, description] = conditions(source.weather_code[i]);
      const when = weekly ? formatDate(time, { weekday: "short", month: "short", day: "numeric" }) : formatTime(time.slice(11, 16));
      const temp = weekly ? degrees(source.temperature_2m_max[i]) + " / " + degrees(source.temperature_2m_min[i]) : degrees(source.temperature_2m[i]);
      const rain = (weekly ? source.precipitation_probability_max : source.precipitation_probability)?.[i];
      return '<article class="forecast-card"><h4>' + escapeHtml(when) + '</h4><span class="forecast-icon" aria-hidden="true">' + symbol + '</span><span class="forecast-condition">' + description + '</span><strong class="forecast-temp">' + temp + '</strong><span class="rain-track" aria-hidden="true"><span style="width:' + (Number.isFinite(rain) ? Math.max(0, Math.min(100, rain)) : 0) + '%"></span></span><span class="forecast-rain">' + (Number.isFinite(rain) ? rain + '%' : '—') + '<small> precip.</small></span></article>';
    }).join("");
    document.getElementById("weatherBody").innerHTML = '<section class="weather-hero"><div><p class="weather-eyebrow">CURRENT CONDITIONS' + (stale ? ' · LAST SAVED' : '') + '</p><div class="weather-temperature">' + degrees(data.current.temperature_2m) + '<span>C</span></div><p class="weather-condition">' + label + '</p></div><div class="weather-hero-art" aria-hidden="true">' + icon + '</div><div class="weather-metrics"><div><span>Feels like</span><strong>' + degrees(data.current.apparent_temperature) + 'C</strong></div><div><span>Wind</span><strong>' + (Number.isFinite(data.current.wind_speed_10m) ? Math.round(data.current.wind_speed_10m) + '<small> km/h</small>' : '—') + '</strong></div></div></section><section class="weather-forecast"><h3>' + (weekly ? 'The week ahead <small>High / low · °C</small>' : 'Today, hour by hour <small>Temperature · °C</small>') + '</h3>' + (rows ? '<div class="forecast-grid">' + rows + '</div>' : '<p>Today’s forecast is unavailable. Waiting for updated weather.</p>') + '</section><p class="weather-updated">' + (stale ? 'Weather may be out of date. Last successful update: ' : 'Updated: ') + escapeHtml(new Date(data.updated_at).toLocaleString()) + ' · Forecast times: ' + escapeHtml(data.timezone) + '</p>';
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
    if (settings.view === "today") return formatDate(settings.anchor_date, { weekday: "long", month: "long", day: "numeric" });
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
    return `${state.today}:${state.settings.view}:${state.settings.anchor_date}:${state.settings.week_start}`;
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
    document.getElementById("albumDialog").classList.toggle("no-motion", settings.photo_motion === false);
    dom.modeLabel.textContent = isDemo ? "Family calendar · demo" : "Family calendar";
    dom.viewKicker.textContent = settings.view === "today" ? (settings.anchor_date === app.state.today ? "TODAY" : "DAY VIEW") : settings.view === "month" ? "THIS MONTH" : "THIS WEEK";
    dom.periodTitle.textContent = formatPeriod(app.state);
    dom.periodSubtitle.textContent = settings.view === "today" ? "The day ahead, easy to read from across the room." : settings.view === "month" ? "A full-month view for the room’s big picture." : "The family’s next seven days, at a glance.";
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
    const ends = event.all_day ? `${event.end_date}T00:00` : `${event.end_date}T${event.end_time || "23:59"}`;
    return `type="button" data-event="${app.events.indexOf(event)}" data-ends="${escapeHtml(ends)}" aria-label="${escapeHtml(`Show details: ${event.title}`)}"`;
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
    dom.calendarMount.innerHTML = app.state.settings.view === "month" ? renderMonth() : app.state.settings.view === "today" ? renderToday() : renderWeek();
    if (app.state.settings.view === "today") {
      // Keep what's next in view: scroll past finished events, leaving the last one visible for context.
      const now = dom.calendarMount.querySelector(".agenda-now");
      const list = now?.closest(".agenda-list");
      if (now && list) {
        const anchor = now.previousElementSibling || now;
        list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - 4;
      }
    }
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
    updateTimeMarkers();
  }

  // Finished events fade and a line marks the current time in today's column,
  // so the screen answers "what's next?" at a glance.
  function updateTimeMarkers() {
    if (!app.state) return;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: app.state.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const nowKey = `${today}T${parts.hour}:${parts.minute}`;
    dom.calendarMount.querySelectorAll("[data-ends]").forEach((element) => element.classList.toggle("past", element.dataset.ends <= nowKey));
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    dom.calendarMount.querySelectorAll(".day-canvas").forEach((canvas) => {
      let line = canvas.querySelector(".now-line");
      const show = canvas.dataset.date === today && minutes >= TIME_START && minutes <= TIME_END;
      if (!show) { line?.remove(); return; }
      if (!line) { line = document.createElement("div"); line.className = "now-line"; line.setAttribute("aria-hidden", "true"); canvas.append(line); }
      line.style.top = `${((minutes - TIME_START) / 60) * weeklyRowHeight}px`;
    });
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
    const { positioned, early, late } = positionEvents(events, date);
    const html = positioned.map(({ event, lane, laneCount, top, height }) => {
      const color = safeColor(event.calendar_color);
      const left = (lane * 100) / laneCount;
      const width = 100 / laneCount;
      const time = event.start_time ? `${formatTime(event.start_time)}${event.end_time ? ` – ${formatTime(event.end_time)}` : ""}` : "";
      return `<button ${eventButton(event)} class="timed-event ${height < 34 ? 'compact-event' : ''}" style="--event-color:${color};--event-tint:${eventTint(color)};top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 5px)" title="${escapeHtml(`${event.title}${time ? ` · ${time}` : ""}`)}"><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(time)}</span></button>`;
    }).join("");
    return `<div data-date="${date}" class="day-canvas ${date === app.state.today ? "today" : ""}">${html}${offHoursChip(early, date, "early")}${offHoursChip(late, date, "late")}</div>`;
  }

  // Events entirely before or after the week view's visible hours get a small marker
  // at the top or bottom of the day instead of silently disappearing.
  function offHoursChip(items, date, edge) {
    if (!items.length) return "";
    const arrow = edge === "early" ? "▲" : "▼";
    const first = items[0].event;
    const when = first.start_date === date ? formatTime(first.start_time) : `Until ${formatTime(first.end_time)}`;
    const label = `${when} · ${first.title}`;
    const color = safeColor(first.calendar_color);
    if (items.length === 1) {
      return `<button ${eventButton(first)} class="offhours-chip ${edge}" style="--event-color:${color}" title="${escapeHtml(label)}">${arrow} ${escapeHtml(label)}</button>`;
    }
    const more = `${items.length} ${edge === "early" ? "earlier" : "later"}`;
    return `<button type="button" data-day="${date}" class="offhours-chip ${edge}" style="--event-color:${color}" title="${escapeHtml(`${more}: ${items.map((item) => item.event.title).join(", ")}`)}">${arrow} ${escapeHtml(more)} · ${escapeHtml(label)}</button>`;
  }

  function positionEvents(events, date) {
    const rowHeight = weeklyRowHeight;
    const early = [];
    const late = [];
    const visible = [];
    for (const event of events) {
      const start = event.start_date === date ? timeToMinutes(event.start_time) ?? 0 : 0;
      const end = event.end_date === date ? timeToMinutes(event.end_time) ?? 1440 : 1440;
      if (end <= start) continue;
      if (end <= TIME_START) early.push({ event, start, end });
      else if (start >= TIME_END) late.push({ event, start, end });
      else visible.push({ event, start: Math.max(TIME_START, start), end: Math.min(TIME_END, Math.max(start + 20, end)) });
    }
    early.sort((a, b) => a.start - b.start);
    late.sort((a, b) => a.start - b.start);
    visible.sort((a, b) => a.start - b.start || a.end - b.end);

    // Lanes are shared only within a cluster of overlapping events, so one clash
    // does not squeeze every other event that day into half the width.
    const positioned = [];
    let cluster = [];
    let laneEnds = [];
    let clusterEnd = -1;
    const closeCluster = () => {
      for (const item of cluster) positioned.push({ ...item, laneCount: laneEnds.length });
      cluster = [];
      laneEnds = [];
    };
    for (const item of visible) {
      if (item.start >= clusterEnd) closeCluster();
      let lane = laneEnds.findIndex((laneEnd) => laneEnd <= item.start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = item.end;
      clusterEnd = Math.max(clusterEnd, item.end);
      const top = ((item.start - TIME_START) / 60) * rowHeight;
      const available = ((TIME_END - item.start) / 60) * rowHeight;
      cluster.push({ ...item, lane, top, height: Math.min(available, Math.max(22, ((item.end - item.start) / 60) * rowHeight - 2)) });
    }
    closeCluster();
    return { positioned, early, late };
  }

  // Today view: a large agenda for the chosen day, with a smaller "Tomorrow" column.
  function agendaFor(date) {
    const events = app.events.filter((event) => eventOverlapsDate(event, date));
    const allDay = events.filter((event) => event.all_day);
    const timed = events.filter((event) => !event.all_day).sort((a, b) => {
      const startA = a.start_date === date ? a.start_time || "00:00" : "00:00";
      const startB = b.start_date === date ? b.start_time || "00:00" : "00:00";
      return startA.localeCompare(startB) || a.title.localeCompare(b.title);
    });
    return { allDay, timed };
  }

  function agendaRow(event, date) {
    const color = safeColor(event.calendar_color);
    const starts = event.start_date === date ? formatTime(event.start_time) : "Earlier";
    const ends = event.end_date === date && event.end_time ? formatTime(event.end_time) : "";
    const place = event.location ? `<span class="agenda-place">${escapeHtml(event.location)}</span>` : "";
    return `<button ${eventButton(event)} class="agenda-row" style="--event-color:${color};--event-tint:${eventTint(color)}"><span class="agenda-time"><strong>${escapeHtml(starts)}</strong>${ends ? `<span>${escapeHtml(ends)}</span>` : ""}</span><span class="agenda-body"><strong>${escapeHtml(event.title)}</strong><span class="agenda-calendar">${escapeHtml(event.calendar || "")}</span>${place}</span></button>`;
  }

  function renderAgendaColumn(date, heading, { showNow }) {
    const { allDay, timed } = agendaFor(date);
    const chips = allDay.map((event) => `<button ${eventButton(event)} class="agenda-allday" style="--event-color:${safeColor(event.calendar_color)};--event-tint:${eventTint(event.calendar_color)}">${escapeHtml(event.title)}</button>`).join("");
    let rows = "";
    let nowPlaced = !showNow;
    const now = showNow ? new Intl.DateTimeFormat("en-GB", { timeZone: app.state.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()) : "";
    for (const event of timed) {
      const start = event.start_date === date ? event.start_time || "00:00" : "00:00";
      if (!nowPlaced && start > now) {
        rows += `<div class="agenda-now" aria-hidden="true"><span>Now · ${escapeHtml(formatTime(now))}</span></div>`;
        nowPlaced = true;
      }
      rows += agendaRow(event, date);
    }
    if (!nowPlaced && timed.length) rows += `<div class="agenda-now" aria-hidden="true"><span>Now · ${escapeHtml(formatTime(now))}</span></div>`;
    const empty = !allDay.length && !timed.length ? `<p class="agenda-empty">Nothing scheduled.</p>` : "";
    return `<section class="agenda-column"><h3 class="agenda-heading"><button type="button" data-day="${date}">${heading}</button></h3>${chips ? `<div class="agenda-allday-row">${chips}</div>` : ""}<div class="agenda-list">${rows}${empty}</div></section>`;
  }

  function renderToday() {
    const day = app.state.settings.anchor_date;
    const next = addDays(day, 1);
    const isToday = day === app.state.today;
    const dayHeading = isToday ? "Today" : escapeHtml(formatDate(day, { weekday: "long", month: "short", day: "numeric" }));
    const nextHeading = day === addDays(app.state.today, -1) ? "Today" : next === addDays(app.state.today, 1) ? "Tomorrow" : escapeHtml(formatDate(next, { weekday: "long", month: "short", day: "numeric" }));
    return `<div class="today-view">${renderAgendaColumn(day, dayHeading, { showNow: isToday })}${renderAgendaColumn(next, `${nextHeading} <span>${escapeHtml(formatDate(next, { weekday: "short", month: "short", day: "numeric" }))}</span>`, { showNow: false })}</div>`;
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

  // Photo frame: fills the screen like a smart-display ambient mode. Each "scene"
  // shows one photo, a pair of portraits, or a three-photo collage chosen from
  // the photos' shapes, so portrait photos are not stranded in black bars.
  const albumDialog = document.getElementById("albumDialog");
  const albumTrigger = document.getElementById("openAlbum");
  const frame = {
    stage: document.getElementById("frameStage"),
    order: [],
    cursor: 0,
    history: [],
    timer: null,
    hideTimer: null,
    sceneCount: 0,
    aspects: new Map(),
    token: 0
  };

  function photoSrc(photo) {
    return photo.url + (photo.demo ? "" : "?v=" + encodeURIComponent(photo.created_at || ""));
  }

  function measure(photo) {
    const src = photoSrc(photo);
    if (frame.aspects.has(src)) return Promise.resolve(frame.aspects.get(src));
    return new Promise((resolve) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        const aspect = image.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 1.5;
        frame.aspects.set(src, aspect);
        resolve(aspect);
      };
      image.onerror = () => resolve(null);
      image.src = src;
    });
  }

  function shuffle(items) {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  // "On this day": a photo taken within three days of today's date in an earlier year.
  function memoryLabel(photo) {
    const today = app.state?.today;
    if (!app.state?.settings?.photo_memories || !today || !/^\d{4}-\d{2}-\d{2}/.test(photo.taken_at || "")) return "";
    const year = Number(photo.taken_at.slice(0, 4));
    const thisYear = Number(today.slice(0, 4));
    if (year >= thisYear) return "";
    const monthDay = photo.taken_at.slice(5, 10);
    const todayMs = Date.parse(`${today}T12:00:00Z`);
    const distance = Math.min(...[thisYear - 1, thisYear, thisYear + 1].map((candidate) => {
      const ms = Date.parse(`${candidate}-${monthDay}T12:00:00Z`);
      return Number.isFinite(ms) ? Math.abs(ms - todayMs) / 86_400_000 : Infinity;
    }));
    if (distance > 3) return "";
    const ago = thisYear - year;
    return `${distance === 0 ? "On this day" : "This week"} · ${year} · ${ago} year${ago === 1 ? "" : "s"} ago`;
  }

  function shuffledOrder() {
    // Memories lead each pass through the album; everything else follows in random order.
    const indexes = app.photos.map((_, index) => index);
    const memories = indexes.filter((index) => memoryLabel(app.photos[index]));
    const others = indexes.filter((index) => !memoryLabel(app.photos[index]));
    return [...shuffle(memories), ...shuffle(others)];
  }

  function nextPhotos(count) {
    if (frame.order.length !== app.photos.length) { frame.order = shuffledOrder(); frame.cursor = 0; }
    const picked = [];
    for (let i = 0; i < Math.min(count, frame.order.length); i += 1) {
      picked.push(app.photos[frame.order[(frame.cursor + i) % frame.order.length]]);
    }
    return picked;
  }

  async function planScene() {
    const screen = window.innerWidth / Math.max(1, window.innerHeight);
    const candidates = nextPhotos(3);
    const aspects = await Promise.all(candidates.map(measure));
    const shape = (aspect) => aspect === null ? "broken" : aspect < 0.9 ? "portrait" : "landscape";
    const shapes = aspects.map(shape);
    const wide = screen > 1.2;
    frame.sceneCount += 1;
    let layout = "single";
    let used = 1;
    if (shapes[0] === "broken") {
      layout = "skip";
    } else if (wide && candidates.length >= 3 && shapes[0] === "portrait" && shapes[1] === "landscape" && shapes[2] === "landscape") {
      layout = "trio";
      used = 3;
    } else if (wide && candidates.length >= 2 && shapes[0] === "portrait" && shapes[1] === "portrait") {
      layout = "pair";
      used = 2;
    } else if (!wide && candidates.length >= 2 && shapes[0] === "landscape" && shapes[1] === "landscape") {
      layout = "stack";
      used = 2;
    } else if (wide && candidates.length >= 3 && shapes.every((item) => item === "landscape") && frame.sceneCount % 3 === 0) {
      // Every third scene of landscapes becomes a collage for variety.
      layout = "trio";
      used = 3;
    }
    const photos = candidates.slice(0, used);
    const fill = layout === "single" && Math.abs(Math.log(aspects[0] / screen)) < 0.22;
    return { layout, photos, fill, used };
  }

  function tileHtml(photo, { contain = false, drift = 0 } = {}) {
    const src = escapeHtml(photoSrc(photo));
    const alt = escapeHtml(photo.original_name || "Family photo");
    const backdrop = contain ? `<img class="frame-backdrop" src="${src}" alt="" aria-hidden="true">` : "";
    const memory = memoryLabel(photo);
    const caption = memory ? `<figcaption class="frame-memory">${escapeHtml(memory)}</figcaption>` : "";
    return `<figure class="frame-tile${contain ? " contain" : ""}">${backdrop}<img class="frame-photo drift-${drift}" src="${src}" alt="${alt}">${caption}</figure>`;
  }

  function sceneDuration() {
    return Math.max(8, Number(app.state?.settings?.slideshow_seconds) || 12) * 1000;
  }

  async function showScene(direction = 1) {
    if (!albumDialog.open) return;
    const token = ++frame.token;
    window.clearTimeout(frame.timer);
    const empty = !app.photos.length;
    document.getElementById("albumEmpty").hidden = !empty;
    if (empty) { frame.stage.innerHTML = ""; return; }
    if (direction < 0 && frame.history.length > 1) {
      frame.history.pop();
      frame.cursor = frame.history.pop();
    }
    const startCursor = frame.cursor;
    const scene = await planScene();
    if (token !== frame.token || !albumDialog.open) return;
    frame.cursor = (frame.cursor + scene.used) % Math.max(1, frame.order.length);
    if (scene.layout === "skip") { showScene(1); return; }
    frame.history.push(startCursor);
    if (frame.history.length > 50) frame.history.shift();

    const duration = sceneDuration();
    const drift = frame.sceneCount % 4;
    const tiles = scene.photos.map((photo, index) => tileHtml(photo, { contain: scene.layout === "single" && !scene.fill, drift: (drift + index) % 4 })).join("");
    const layer = document.createElement("div");
    layer.className = `frame-layer layout-${scene.layout}`;
    layer.style.setProperty("--scene-ms", `${duration + 2000}ms`);
    layer.innerHTML = tiles;
    await Promise.all([...layer.querySelectorAll(".frame-photo")].map((image) => image.decode?.().catch(() => {})));
    if (token !== frame.token || !albumDialog.open) return;
    frame.stage.append(layer);
    requestAnimationFrame(() => layer.classList.add("visible"));
    const previous = [...frame.stage.children].filter((child) => child !== layer);
    window.setTimeout(() => previous.forEach((child) => child.remove()), 1600);
    document.getElementById("albumDemoLabel").hidden = !scene.photos.some((photo) => photo.demo);
    frame.timer = window.setTimeout(() => showScene(1), duration);
  }

  function nextEventText() {
    const today = app.state?.today;
    if (!today) return "";
    const now = new Intl.DateTimeFormat("en-GB", { timeZone: app.state.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    const todays = app.events.filter((event) => eventOverlapsDate(event, today));
    const upcoming = todays.filter((event) => !event.all_day && event.start_date === today && (event.start_time || "") > now).sort((a, b) => a.start_time.localeCompare(b.start_time))[0];
    if (upcoming) return `Next · ${upcoming.title} · ${formatTime(upcoming.start_time)}`;
    const allDay = todays.find((event) => event.all_day);
    return allDay ? `Today · ${allDay.title}` : "";
  }

  function updateFrameInfo() {
    if (!albumDialog.open || !app.state) return;
    const now = new Date();
    document.getElementById("frameTime").textContent = new Intl.DateTimeFormat(undefined, { timeZone: app.state.timezone, hour: "numeric", minute: "2-digit" }).format(now);
    document.getElementById("frameDate").textContent = new Intl.DateTimeFormat(undefined, { timeZone: app.state.timezone, weekday: "long", month: "long", day: "numeric" }).format(now);
    const weather = document.getElementById("frameWeather");
    if (weatherData?.current) {
      const [icon, label] = conditions(weatherData.current.display_weather_code ?? weatherData.current.weather_code);
      weather.textContent = `${icon} ${degrees(weatherData.current.temperature_2m)} · ${label}`;
    }
    weather.hidden = !weatherData?.current;
    const next = document.getElementById("frameNext");
    next.textContent = nextEventText();
    next.hidden = !next.textContent;
  }

  function showFrameControls() {
    albumDialog.classList.add("controls-visible");
    window.clearTimeout(frame.hideTimer);
    frame.hideTimer = window.setTimeout(() => albumDialog.classList.remove("controls-visible"), 4000);
  }

  function openAlbum() {
    if (albumDialog.open) return;
    albumDialog.showModal();
    frame.order = shuffledOrder();
    frame.cursor = 0;
    frame.history = [];
    frame.stage.innerHTML = "";
    updateFrameInfo();
    showFrameControls();
    showScene(1);
  }

  albumTrigger.addEventListener("click", openAlbum);
  albumTrigger.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openAlbum(); }
  });
  document.getElementById("closeAlbum").addEventListener("click", (event) => { event.stopPropagation(); albumDialog.close(); });
  document.getElementById("framePrevious").addEventListener("click", (event) => { event.stopPropagation(); showFrameControls(); showScene(-1); });
  document.getElementById("frameNextButton").addEventListener("click", (event) => { event.stopPropagation(); showFrameControls(); showScene(1); });
  albumDialog.addEventListener("click", (event) => {
    // Tap the left or right edge to step through photos; tap elsewhere to show the buttons.
    const x = event.clientX / window.innerWidth;
    showFrameControls();
    if (x < 0.2) showScene(-1);
    else if (x > 0.8) showScene(1);
  });
  albumDialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") { showFrameControls(); showScene(-1); }
    if (event.key === "ArrowRight") { showFrameControls(); showScene(1); }
  });
  albumDialog.addEventListener("close", () => {
    frame.token += 1;
    window.clearTimeout(frame.timer);
    window.clearTimeout(frame.hideTimer);
    frame.stage.innerHTML = "";
    // Only move focus back when someone closed it; an idle timeout should not leave a focus ring.
    if (Date.now() - lastInteraction < 5000) albumTrigger.focus();
  });
  window.setInterval(updateFrameInfo, 15_000);

  // A wall display should never be left covered: pop-ups close after two minutes
  // without a touch, and Photo Mode after the time chosen on the phone.
  const DIALOG_IDLE_MS = 2 * 60_000;
  let lastInteraction = Date.now();
  for (const type of ["pointerdown", "keydown", "wheel"]) {
    document.addEventListener(type, () => { lastInteraction = Date.now(); }, { capture: true, passive: true });
  }
  window.setInterval(() => {
    const idle = Date.now() - lastInteraction;
    for (const dialog of [weatherDialog, detailDialog]) {
      if (dialog.open && idle > DIALOG_IDLE_MS) dialog.close();
    }
    const minutes = Number(app.state?.settings?.photo_mode_minutes ?? 30);
    if (albumDialog.open && minutes > 0 && idle > minutes * 60_000) albumDialog.close();
  }, 15_000);

  function renderAlbum() {
    // New or removed photos are picked up at the next scene; only an empty album needs an immediate redraw.
    if (albumDialog.open && (!app.photos.length || !frame.stage.children.length)) showScene(1);
  }

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
    const preload = new Image();
    preload.src = next.url;
  }

  function schedulePhotoTimer() {
    window.clearInterval(app.photoTimer);
    const seconds = app.state?.settings?.slideshow_seconds || 12;
    app.photoTimer = window.setInterval(() => {
      // The small album card is hidden behind Photo Mode, so it rests while the frame is open.
      if (!document.hidden && !document.getElementById("albumDialog").open && app.photos.length > 1) {
        app.photoIndex = (app.photoIndex + 1) % app.photos.length;
        renderPhoto();
      }
    }, seconds * 1000);
  }

  function updateClock() {
    if (!app.state) return;
    dom.clock.textContent = new Intl.DateTimeFormat(undefined, { timeZone: app.state.timezone, hour: "numeric", minute: "2-digit" }).format(new Date());
  }

  function localTodayKey() {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: app.state.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function checkDateRollover() {
    // Backup for a missed server push: refetch once the wall-clock date no longer matches the shown "today".
    if (app.state && localTodayKey() !== app.state.today) loadState().catch(() => {});
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
    window.setInterval(updateTimeMarkers, 30_000);
    // The Today view's "Now" line sits between events, so it is redrawn each minute.
    window.setInterval(() => { if (app.state?.settings.view === "today" && !document.hidden) renderCalendar(); }, 60_000);
    window.setInterval(updateNightMode, 30_000);
    window.setInterval(checkDateRollover, 60_000);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadState().catch(() => { dom.connectionMessage.textContent = "Reconnecting…"; });
  });
  window.addEventListener("online", () => loadState().catch(() => {}));
  init();
})();
