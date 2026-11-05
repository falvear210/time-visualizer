// =============================================================================
// ilab.js -- all the behavior for ilab/index.html, the small classroom screen
// in the iLab. It has to be readable from across the room, so it shows only:
//   - clock, date and weather (header)
//   - the class meeting NOW, with a countdown and a progress bar
//   - the class coming up NEXT
//   - today's list of periods
//
// Where the data comes from:
//   - ../data.js (SCHOOL_YEAR_DATA) gives each day's period letters + times,
//     the same source every other display uses.
//   - ilab-classes.csv (this folder) says which class meets in the iLab in
//     each period letter. Edit that file when the room schedule changes; a
//     blank course means the room is open that period.
//
// Standalone like math-office.js: it keeps its own small copies of the date
// and lunch-wave helpers instead of sharing code with app.js.
//
// Big picture, top to bottom:
//   1. Config + version watcher (reloads the page after a deploy)
//   2. Time helpers (Chicago time, with a #debug override)
//   3. Schedule helpers (lunch waves, finding today / the next school day)
//   4. Formatting helpers
//   5. CSV loading
//   6. Weather (Open-Meteo, no API key)
//   7. render() -- rebuilds every panel once a second
// =============================================================================

const TIME_ZONE = "America/Chicago";
const REFRESH_MS = 1000;
const CLASSES_URL = "ilab-classes.csv";
// Between two periods, a gap this long or longer is called "Break" (lunch,
// activity period); anything shorter is just "Passing".
const LONG_GAP_MINUTES = 15;

// ---- 1. remote reload (kiosk support) ----
// Nobody is around to hit refresh on a wall screen, so poll version.txt
// (bumped by deploy.sh) and reload when it changes. Same as math/ and mcl/.
const VERSION_URL = "../version.txt";
const VERSION_CHECK_MS = 60 * 1000;

async function fetchVersion() {
  const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`version.txt fetch failed: ${res.status}`);
  return (await res.text()).trim();
}

async function watchForNewVersion() {
  let initialVersion;
  try {
    initialVersion = await fetchVersion();
  } catch (e) {
    return; // no version.txt (e.g. local preview) -- nothing to watch
  }
  setInterval(async () => {
    try {
      if ((await fetchVersion()) !== initialVersion) location.reload();
    } catch (e) {
      // transient failure -- just try again next interval
    }
  }, VERSION_CHECK_MS);
}

// ---- 2. time ----

// When set (via the #debug bar), the display pretends it's this moment.
// Stored as the same {dateStr, minutes, seconds} shape nowInChicago() returns.
let debugNow = null;

// The current wall-clock time at SLUH, regardless of the device's timezone.
// Returns { dateStr: "YYYYMMDD", minutes: since midnight, seconds: 0-59 }.
function nowInChicago() {
  if (debugNow) return debugNow;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  let hour = +get("hour");
  if (hour === 24) hour = 0; // some engines report midnight as 24
  return {
    dateStr: `${get("year")}${get("month")}${get("day")}`,
    minutes: hour * 60 + +get("minute"),
    seconds: +get("second"),
  };
}

function setupDebugBar() {
  if (location.hash.indexOf("debug") === -1) return;
  const bar = document.getElementById("il-debug-bar");
  const input = document.getElementById("il-debug-time");
  bar.hidden = false;

  // The debug clock keeps ticking from the moment you pick, so countdowns
  // can be watched moving.
  let pickedAt = 0, base = null;
  input.addEventListener("change", () => {
    if (!input.value) return;
    const [date, time] = input.value.split("T");
    const [h, m] = time.split(":").map(Number);
    base = { dateStr: date.replace(/-/g, ""), totalSeconds: h * 3600 + m * 60 };
    pickedAt = Date.now();
  });
  document.getElementById("il-debug-live").addEventListener("click", () => {
    base = null;
    debugNow = null;
    input.value = "";
  });
  setInterval(() => {
    if (!base) return;
    const t = base.totalSeconds + Math.floor((Date.now() - pickedAt) / 1000);
    debugNow = { dateStr: base.dateStr, minutes: Math.floor(t / 60), seconds: t % 60 };
  }, 200);
}

// ---- 3. schedule helpers ----

// A period that falls in the lunch slot has two sets of times in data.js:
// startMinutes/endMinutes (Fr/So wave) and jrsrStartMinutes/jrsrEndMinutes.
// Each iLab class says in the CSV which wave its students are on.
function timesFor(period, cls) {
  if (cls && cls.lunch === "jrsr" && period.jrsrStartMinutes != null) {
    return { start: period.jrsrStartMinutes, end: period.jrsrEndMinutes };
  }
  return { start: period.startMinutes, end: period.endMinutes };
}

// Today's periods as a simple list the renderer can use:
// [{ label, start, end, cls }] in time order. cls is null for open periods.
function buildDay(day, classes) {
  if (!day) return [];
  return day.periods
    .map((p) => {
      const cls = classes[p.label] || null;
      const { start, end } = timesFor(p, cls);
      return { label: p.label, start, end, cls };
    })
    .sort((a, b) => a.start - b.start);
}

// The first school day (one with periods) strictly after dateStr.
function nextSchoolDay(dateStr) {
  return SCHOOL_YEAR_DATA.find((d) => d.date > dateStr && d.periods.length > 0) || null;
}

// ---- 4. formatting ----

function parseDate(yyyymmdd) {
  return { y: +yyyymmdd.slice(0, 4), m: +yyyymmdd.slice(4, 6), d: +yyyymmdd.slice(6, 8) };
}

function formatFullDate(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US",
    { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

function formatWeekday(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US",
    { weekday: "long", timeZone: "UTC" });
}

// minutes-since-midnight -> "9:35" (no AM/PM: short enough to read far away)
function hm(minutes) {
  const h = Math.floor(minutes / 60) % 12 || 12;
  return `${h}:${String(minutes % 60).padStart(2, "0")}`;
}

// minutes-since-midnight -> "9:35 AM"
function hmAmPm(minutes) {
  return `${hm(minutes)} ${minutes >= 720 ? "PM" : "AM"}`;
}

// seconds -> "23:05" or "1:02:05"
function formatCountdown(totalSec) {
  totalSec = Math.max(0, totalSec);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}

// Progress bar width as a percent, FLOORED and capped at 99 while the
// period is still running -- the bar must never read "done" early.
function floorPercent(fraction) {
  return Math.max(0, Math.min(99, Math.floor(fraction * 100)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- 5. CSV loading ----

// Minimal CSV reader: no quoted fields needed for this file.
// Returns { A: {teacher, course, section, lunch}, ... }; open periods are omitted.
function parseClassesCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(",").map((h) => h.trim());
  const classes = {};
  for (const line of lines) {
    const cells = line.split(",").map((c) => c.trim());
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i] || ""]));
    if (row.period && row.course) classes[row.period.toUpperCase()] = row;
  }
  return classes;
}

// ---- 6. weather (Open-Meteo -- free, no API key; same setup as math/) ----

const WEATHER_URL = "https://api.open-meteo.com/v1/forecast?latitude=38.6274&longitude=-90.2688" +
  "&current=temperature_2m,weather_code,is_day" +
  "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
  "&temperature_unit=fahrenheit&timezone=America%2FChicago&forecast_days=1";
const WEATHER_REFRESH_MS = 30 * 60 * 1000;
const WEATHER_RETRY_MS = 2 * 60 * 1000; // failures are usually brief -- retry soon

// WMO weather code -> emoji (no icon assets needed)
function weatherEmoji(code, isDay) {
  if (code === 0 || code === 1) return isDay ? "☀️" : "🌙";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if ([51, 53, 55, 56, 57, 80, 81, 82].includes(code)) return "🌦️";
  if ([61, 63, 65, 66, 67].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
}

function weatherLabel(code) {
  const labels = {
    0: "Clear", 1: "Mostly Clear", 2: "Partly Cloudy", 3: "Cloudy",
    45: "Fog", 48: "Fog",
    51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 56: "Freezing Drizzle", 57: "Freezing Drizzle",
    61: "Light Rain", 63: "Rain", 65: "Heavy Rain", 66: "Freezing Rain", 67: "Freezing Rain",
    71: "Light Snow", 73: "Snow", 75: "Heavy Snow", 77: "Snow",
    80: "Showers", 81: "Showers", 82: "Heavy Showers", 85: "Snow Showers", 86: "Snow Showers",
    95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm",
  };
  return labels[code] || "";
}

let weatherData = null;

async function fetchWeather() {
  let ok = false;
  try {
    const res = await fetch(WEATHER_URL);
    if (!res.ok) throw new Error(`weather fetch failed: ${res.status}`);
    weatherData = await res.json();
    ok = true;
  } catch (e) {
    console.warn("weather fetch failed, retrying soon:", e);
    // keep showing the last good reading rather than blanking the panel
  }
  setTimeout(fetchWeather, ok ? WEATHER_REFRESH_MS : WEATHER_RETRY_MS);
  renderWeather();
}

function renderWeather() {
  const el = document.getElementById("il-weather");
  if (!weatherData) {
    el.innerHTML = "";
    return;
  }
  const cur = weatherData.current;
  const daily = weatherData.daily;
  const hi = Math.round(daily.temperature_2m_max[0]);
  const lo = Math.round(daily.temperature_2m_min[0]);
  const rain = daily.precipitation_probability_max ? daily.precipitation_probability_max[0] : null;
  el.innerHTML = `
    <div class="il-weather-icon">${weatherEmoji(cur.weather_code, cur.is_day)}</div>
    <div class="il-weather-main">
      <div class="il-weather-temp">${Math.round(cur.temperature_2m)}°</div>
      <div class="il-weather-sub">
        <span>${weatherLabel(cur.weather_code)}</span>
        <span>H ${hi}° · L ${lo}°${rain != null && rain >= 20 ? ` · 💧${rain}%` : ""}</span>
      </div>
    </div>`;
}

// ---- 7. render ----

let classes = {};

const els = {};
["clock", "date", "now", "now-label", "now-course", "now-teacher", "now-countdown",
 "now-note", "now-track", "now-fill", "next", "next-label", "next-course",
 "next-teacher", "schedule-label", "schedule-list"].forEach((id) => {
  els[id] = document.getElementById(`il-${id}`);
});

// Set a course name and shrink its font until it fits on one line. The CSS
// font-size is the maximum, so a short name ("CAD") stays huge and a long one
// ("Foundations of Engineering") steps down just enough. Only re-measures when
// the text changes (or on resize), since this runs every second.
function setFittedText(el, text) {
  if (el.dataset.fitted === text) return;
  el.textContent = text;
  el.dataset.fitted = text;
  el.style.fontSize = "";
  const max = parseFloat(getComputedStyle(el).fontSize);
  let size = max;
  while (el.scrollWidth > el.clientWidth && size > max * 0.4) {
    size *= 0.95;
    el.style.fontSize = `${size}px`;
  }
}

window.addEventListener("resize", () => {
  document.querySelectorAll(".il-course").forEach((el) => { delete el.dataset.fitted; });
  render();
});

// Course + teacher lines for a period (or an open period).
function classLines(slot) {
  if (!slot.cls) return { course: "Open", teacher: "No class scheduled", open: true };
  return {
    course: slot.cls.course,
    teacher: `${slot.cls.teacher}${slot.cls.section ? ` · ${slot.cls.section}` : ""}`,
    open: false,
  };
}

function setNow({ label, course, teacher, countdown = "", note = "", fraction = null, muted = false }) {
  els["now-label"].textContent = label;
  setFittedText(els["now-course"], course);
  els["now-teacher"].textContent = teacher || " ";
  els["now-countdown"].textContent = countdown;
  els["now-note"].textContent = note;
  els["now"].classList.toggle("il-is-muted", muted);
  els["now-track"].hidden = fraction == null;
  if (fraction != null) els["now-fill"].style.width = `${floorPercent(fraction)}%`;
}

function setNext({ label, course, teacher, muted = false } = {}) {
  els["next"].hidden = !label;
  if (!label) return;
  els["next-label"].textContent = label;
  setFittedText(els["next-course"], course);
  els["next-teacher"].textContent = teacher || " ";
  els["next"].classList.toggle("il-is-muted", muted);
}

// The NEXT card when today's classes are done (or there's no school today):
// the first period of the next school day.
function setNextFromNextSchoolDay(dateStr) {
  const nd = nextSchoolDay(dateStr);
  if (!nd) return setNext();
  const first = buildDay(nd, classes)[0];
  const lines = classLines(first);
  setNext({
    label: `${formatWeekday(nd.date)} · ${first.label} Period · ${hmAmPm(first.start)}`,
    course: lines.course,
    teacher: lines.open ? "" : lines.teacher,
    muted: lines.open,
  });
}

function renderSchedule(slots, nowMin, summary) {
  els["schedule-label"].textContent = "Today";
  if (slots.length === 0) {
    els["schedule-list"].innerHTML =
      `<li class="il-schedule-empty">${escapeHtml(summary || "No classes today")}</li>`;
    return;
  }
  els["schedule-list"].innerHTML = slots.map((s) => {
    const state = nowMin >= s.end ? "il-is-past" : nowMin >= s.start ? "il-is-current" : "";
    const what = s.cls
      ? escapeHtml(s.cls.course) // teacher is on the NOW/NEXT cards; the list stays short
      : `<span class="il-row-open">Open</span>`;
    return `
      <li class="il-row ${state}">
        <span class="il-row-letter">${s.label}</span>
        <span class="il-row-time">${hm(s.start)}</span>
        <span class="il-row-what">${what}</span>
      </li>`;
  }).join("");
}

function render() {
  const now = nowInChicago();
  const nowMin = now.minutes;
  const nowSec = nowMin * 60 + now.seconds;

  // header clock: "9:41" with a small AM/PM
  const h12 = Math.floor(nowMin / 60) % 12 || 12;
  els["clock"].innerHTML = `${h12}:${String(nowMin % 60).padStart(2, "0")}` +
    `<span class="il-ampm">${nowMin >= 720 ? "PM" : "AM"}</span>`;
  els["date"].textContent = formatFullDate(now.dateStr);

  const day = SCHOOL_YEAR_DATA.find((d) => d.date === now.dateStr);
  const slots = buildDay(day, classes);
  renderSchedule(slots, nowMin, day ? day.summary.replace(/^No (School|Classes)-/, "") : "No school today");

  // --- no classes at all today (weekend, break, exam day) ---
  if (slots.length === 0) {
    setNow({
      label: "Today",
      course: day ? day.summary.replace(/^No (School|Classes)-/, "") : "No School",
      teacher: "No classes in the iLab today",
      muted: true,
    });
    setNextFromNextSchoolDay(now.dateStr);
    return;
  }

  const currentIdx = slots.findIndex((s) => nowMin >= s.start && nowMin < s.end);
  const nextIdx = slots.findIndex((s) => nowMin < s.start);

  // --- a period is in progress ---
  if (currentIdx !== -1) {
    const cur = slots[currentIdx];
    const lines = classLines(cur);
    setNow({
      label: `Now · ${cur.label} Period`,
      course: lines.course,
      teacher: lines.teacher,
      countdown: formatCountdown(cur.end * 60 - nowSec),
      note: `left · ends ${hmAmPm(cur.end)}`,
      fraction: (nowSec - cur.start * 60) / ((cur.end - cur.start) * 60),
      muted: lines.open,
    });
  } else if (nextIdx === -1) {
    // --- after the last period ---
    setNow({ label: "Today", course: "Classes are done", teacher: "No more classes in the iLab today", muted: true });
    setNextFromNextSchoolDay(now.dateStr);
    return;
  } else {
    // --- before school, or between two periods ---
    const nxt = slots[nextIdx];
    const before = nextIdx === 0;
    const gap = before ? Infinity : nxt.start - slots[nextIdx - 1].end;
    setNow({
      label: "Now",
      course: before ? "Before School" : gap >= LONG_GAP_MINUTES ? "Break" : "Passing",
      teacher: "",
      countdown: formatCountdown(nxt.start * 60 - nowSec),
      note: `until ${nxt.label} Period`,
      muted: true,
    });
  }

  // --- the NEXT card: the next period today ---
  const upcoming = slots[currentIdx !== -1 ? currentIdx + 1 : nextIdx];
  if (upcoming) {
    const lines = classLines(upcoming);
    setNext({
      label: `Next · ${upcoming.label} Period · ${hmAmPm(upcoming.start)}`,
      course: lines.course,
      teacher: lines.open ? "" : lines.teacher,
      muted: lines.open,
    });
  } else {
    setNext({ label: "Next", course: "Last period of the day", teacher: "", muted: true });
  }
}

// ---- start ----

async function main() {
  setupDebugBar();
  try {
    const res = await fetch(`${CLASSES_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${CLASSES_URL}: ${res.status}`);
    classes = parseClassesCsv(await res.text());
  } catch (e) {
    console.warn("couldn't load class list; showing periods without class names:", e);
  }
  render();
  setInterval(render, REFRESH_MS);
  fetchWeather();
  watchForNewVersion();
}

main();
