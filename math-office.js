// =============================================================================
// math-office.js -- all the behavior for math-office.html, the wall display
// that runs full-screen and unattended on a TV in the math office.
//
// Standalone: it reads the same data.js the main site uses, but shares no
// code with app.js. It keeps its own trimmed-down copies of just the
// date/schedule helpers it needs, because it has no tabs, no settings, and
// no personal period filtering -- it's a shared display, not a personalized
// one. (Those copies are deliberate duplication; each is annotated with a
// pointer to its app.js counterpart.)
//
// Big picture, top to bottom:
//   1. Config constants (refresh cadences, the 7:30am cutoff for showing
//      "teaching next", etc.).
//   2. watchForNewVersion() -- polls version.txt (bumped by deploy.sh) and
//      reloads the page when it changes, so a deploy reaches the TV on its
//      own with nobody there to hit refresh.
//   3. Date / schedule / lunch-wave / break-detection helpers -- mirrors of
//      the app.js versions.
//   4. CSV parsers for the office-editable data: teachers, birthdays, food,
//      break-name overrides.
//   5. Weather (Open-Meteo, no API key), hardcoded to SLUH's location.
//   6. main() -- grabs the DOM, kicks off all the fetch-on-a-timer loops,
//      then re-renders everything once a second. Every panel rebuilds from
//      scratch each tick (there's nothing interactive to lose), except a
//      few spots that patch in place so a running CSS animation or fade
//      isn't restarted. Nothing runs until main() is called at the bottom.
// =============================================================================

const TIME_ZONE = "America/Chicago";
const REFRESH_MS = 1000; // no interactive elements here, so a full rebuild every tick is cheap and safe
const COUNTDOWN_START_MINUTES = 7 * 60 + 30; // countdowns/"teaching next" don't show before 7:30am

// ---- remote reload (kiosk support) ----
// This runs unattended on a wall display with no one to hit refresh, so it
// watches version.txt (bumped by deploy.sh on every deploy) and reloads
// itself within one polling interval of a new deploy landing -- no SSH
// into the kiosk needed for routine updates.
const VERSION_URL = "version.txt";
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
    return; // no version.txt (or unreachable) -- nothing to watch against
  }
  setInterval(async () => {
    try {
      const current = await fetchVersion();
      if (current !== initialVersion) location.reload();
    } catch (e) {
      // a transient fetch failure shouldn't reload or crash the watcher --
      // just try again next interval.
    }
  }, VERSION_CHECK_MS);
}

// ---- date helpers (see app.js for the fuller version these mirror) ----

function parseDate(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  return { y, m, d };
}

function dateFromUTC(dt) {
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function addDays(dateStr, n) {
  const { y, m, d } = parseDate(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dateFromUTC(dt);
}

// Monday (YYYYMMDD) of the calendar week containing this date.
function mondayOf(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return dateFromUTC(dt);
}

// 0=Mon .. 6=Sun
function weekdayIndex(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 6 : dow - 1;
}

function nowInChicago() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  const dateStr = `${get("year")}${get("month")}${get("day")}`;
  let hour = +get("hour");
  if (hour === 24) hour = 0;
  const minutes = hour * 60 + +get("minute");
  return { dateStr, minutes, seconds: +get("second") };
}

function formatFullDate(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

// "8/27" -- the rotator's day-count rows lead with this so it's clear
// exactly which date the countdown is counting down to.
function formatShortDate(dateStr) {
  const { m, d } = parseDate(dateStr);
  return `${m}/${d}`;
}

function formatClock12h(now) {
  let h = Math.floor(now.minutes / 60);
  const m = now.minutes % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")}:${String(now.seconds).padStart(2, "0")} ${ampm}`;
}

// "1:23:45" / "23:45" -- meant to be read from across a room
function formatCountdownClock(totalMs) {
  const totalSec = Math.max(0, Math.round(totalMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : m;
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}

function cleanBreakLabel(summary) {
  return summary.replace(/^No (School|Classes)-/, "").replace(/\s*\([^)]*\)\s*$/, "");
}

// ---- lunch-wave resolution (see app.js's resolvePeriodTimes/liveWaveOf) ----
// no personal settings here, so "frso" is just the blanket default; the
// natural-detection fallback still keeps a still-running Jr/Sr half from
// looking "done" the moment Fr/So's window closes.

function resolvePeriodTimes(period, wave) {
  if (wave === "jrsr" && period.jrsrStartMinutes != null) {
    return { startMinutes: period.jrsrStartMinutes, endMinutes: period.jrsrEndMinutes };
  }
  return { startMinutes: period.startMinutes, endMinutes: period.endMinutes };
}

function periodProgress(day, period, now, wave) {
  const { startMinutes, endMinutes } = resolvePeriodTimes(period, wave);
  if (day.date < now.dateStr) return 1;
  if (day.date > now.dateStr) return 0;
  if (now.minutes < startMinutes) return 0;
  if (now.minutes >= endMinutes) return 1;
  return (now.minutes - startMinutes) / (endMinutes - startMinutes);
}

// whether this period is actually in progress right now (see app.js's
// isPeriodLive) -- periodProgress() truncates to whole minutes, so it reads
// exactly 0 for the entire first minute of a period, indistinguishable from
// "hasn't started yet". This checks the minute range directly instead, so a
// period counts as live from the moment it starts rather than one minute in.
function isPeriodLive(day, period, now, wave) {
  if (day.date !== now.dateStr) return false;
  const { startMinutes, endMinutes } = resolvePeriodTimes(period, wave);
  return now.minutes >= startMinutes && now.minutes < endMinutes;
}

function liveWaveOf(day, period, now) {
  if (isPeriodLive(day, period, now, "frso")) return "frso";
  if (period.jrsrStartMinutes != null) {
    if (isPeriodLive(day, period, now, "jrsr")) return "jrsr";
  }
  return null;
}

function effectiveWave(day, period, now) {
  return liveWaveOf(day, period, now) || "frso";
}

// ---- break detection (see app.js's classifyCalendarDays/findQualifyingBreaks) ----

function classifyCalendarDays(days, daysByDate) {
  const first = days[0].date, last = days[days.length - 1].date;
  const seq = [];
  for (let cursor = first; cursor <= last; cursor = addDays(cursor, 1)) {
    const entry = daysByDate.get(cursor);
    let type;
    if (entry && entry.periods.length) type = "school";
    else if (entry && /professional development|\bpd\b|parent-teacher conference/i.test(entry.summary)) type = "pd";
    else type = "off";
    seq.push({ date: cursor, type });
  }
  return seq;
}

function findQualifyingBreaks(seq, minLen) {
  const breaks = [];
  let runStart = null, runLen = 0;
  for (let i = 0; i <= seq.length; i++) {
    const isOff = i < seq.length && seq[i].type === "off";
    if (isOff) {
      if (runLen === 0) runStart = seq[i].date;
      runLen += 1;
    } else {
      if (runLen >= minLen) breaks.push({ start: runStart, end: seq[i - 1].date, length: runLen });
      runLen = 0;
    }
  }
  return breaks;
}

function breakName(startDate, endDate, daysByDate, nameOverrides) {
  if (nameOverrides.has(startDate)) return nameOverrides.get(startDate);
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    const entry = daysByDate.get(d);
    if (entry && entry.summary) return cleanBreakLabel(entry.summary);
  }
  return "Break";
}

// Whole school days from tomorrow through targetDate (inclusive of
// targetDate itself even when it isn't a school day, e.g. a break's first
// day off) -- pure date comparison, no fractional day-progress involved.
// That means it only ever changes at midnight, never partway through a
// day, and a targetDate of tomorrow always reads as 1, never 0 -- 0 is
// reserved for "targetDate is today", which callers handle separately.
function schoolDaysUntil(days, now, targetDate) {
  const between = days.filter((d) => d.periods.length && d.date > now.dateStr && d.date < targetDate).length;
  return between + 1;
}

// Plain calendar days from today through targetDate -- for events (like
// birthdays) that aren't about school days in session, just the date.
function calendarDaysUntil(now, targetDate) {
  const a = parseDate(now.dateStr), b = parseDate(targetDate);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

// ---- teachers (loaded from teachers.csv -- one row per teacher/period,
// since the same teacher can be in a different room for different
// periods) ----

const TEACHERS_CSV_URL = "teachers.csv";
const TEACHERS_REFRESH_MS = 30 * 60 * 1000;

// naive comma-split -- fine as long as names/rooms in the CSV don't
// contain commas, which keeps this dependency-free.
function parseTeachersCsv(text) {
  const lines = text.trim().split("\n").slice(1); // drop the header row
  const byName = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const [name, period, room] = line.split(",").map((s) => s.trim());
    if (!name || !period) continue;
    if (!byName.has(name)) byName.set(name, { name, periods: [], rooms: {} });
    const t = byName.get(name);
    t.periods.push(period);
    t.rooms[period] = room;
  }
  return [...byName.values()];
}

// ---- rotator data (breaks.csv / birthdays.csv / food.csv -- lets the
// office edit/add birthdays, free-food days, and break-name overrides
// without touching code or the school-year calendar; three separate files
// so each is a simple, single-purpose list to hand-edit) ----

const BREAKS_CSV_URL = "breaks.csv";
const BIRTHDAYS_CSV_URL = "birthdays.csv";
const FOOD_CSV_URL = "food.csv";
const ROTATOR_REFRESH_MS = 30 * 60 * 1000;
const ROTATOR_LIST_LIMIT = 14; // the box body scrolls if a page runs longer than this fits

// naive comma-split, same tradeoff as parseTeachersCsv -- fine as long as
// names in the CSV don't contain commas.

// break-name overrides: date is the break's start date, name is what to
// display instead of the auto-detected label from the school calendar.
function parseBreaksCsv(text) {
  const lines = text.trim().split("\n").slice(1);
  const overrides = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const [date, name] = line.split(",").map((s) => s.trim());
    if (!date || !name) continue;
    overrides.set(date, name);
  }
  return overrides;
}

// birthdays: an optional third column of "math" marks a math-department
// birthday so it can be rendered in bold on the shared office display.
function parseBirthdaysCsv(text) {
  const lines = text.trim().split("\n").slice(1);
  const birthdays = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const [date, name, dept] = line.split(",").map((s) => (s || "").trim());
    if (!date || !name) continue;
    birthdays.push({ date, name, isMath: dept === "math" });
  }
  birthdays.sort((a, b) => a.date.localeCompare(b.date));
  return birthdays;
}

function parseFoodCsv(text) {
  const lines = text.trim().split("\n").slice(1);
  const food = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const [date, name] = line.split(",").map((s) => s.trim());
    if (!date || !name) continue;
    food.push({ date, name });
  }
  food.sort((a, b) => a.date.localeCompare(b.date));
  return food;
}

// ---- weather (Open-Meteo -- free, no API key, CORS-enabled) ----
// SLUH, 4970 Oakland Ave, St. Louis, MO -- hardcoded since this dashboard
// only ever runs at one physical location.
const WEATHER_LAT = 38.6274;
const WEATHER_LON = -90.2688;
const WEATHER_REFRESH_MS = 30 * 60 * 1000;
const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}` +
  "&current=temperature_2m,weather_code,is_day" +
  "&hourly=temperature_2m,weather_code,is_day" +
  "&daily=weather_code,temperature_2m_max,temperature_2m_min" +
  "&temperature_unit=fahrenheit&timezone=America%2FChicago&forecast_days=2";

// WMO weather codes (what Open-Meteo returns) mapped to a plain emoji --
// no icon assets/library needed, consistent with the rest of this project.
function weatherEmoji(code, isDay) {
  if (code === 0) return isDay ? "☀️" : "🌙";
  if (code === 1) return isDay ? "🌤️" : "🌙";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
  if ([61, 63, 65, 66, 67].includes(code)) return "🌧️";
  if ([71, 73, 75, 77].includes(code)) return "❄️";
  if (code === 80 || code === 81 || code === 82) return "🌦️";
  if (code === 85 || code === 86) return "🌨️";
  if (code === 95 || code === 96 || code === 99) return "⛈️";
  return "🌡️";
}

function weatherLabel(code) {
  const labels = {
    0: "Clear", 1: "Mostly Clear", 2: "Partly Cloudy", 3: "Overcast",
    45: "Fog", 48: "Fog",
    51: "Light Drizzle", 53: "Drizzle", 55: "Heavy Drizzle",
    56: "Freezing Drizzle", 57: "Freezing Drizzle",
    61: "Light Rain", 63: "Rain", 65: "Heavy Rain",
    66: "Freezing Rain", 67: "Freezing Rain",
    71: "Light Snow", 73: "Snow", 75: "Heavy Snow", 77: "Snow Grains",
    80: "Rain Showers", 81: "Rain Showers", 82: "Heavy Showers",
    85: "Snow Showers", 86: "Snow Showers",
    95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm",
  };
  return labels[code] || "—";
}

// finds the hourly-array index for a specific local hour on `dateStr`,
// since Open-Meteo returns one flat chronological array rather than
// something already bucketed by day.
function findHourlyIndex(hourlyTimes, dateStr, hour) {
  const target = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T${String(hour).padStart(2, "0")}:00`;
  return hourlyTimes.indexOf(target);
}

// ---- main ----

function main() {
  const days = SCHOOL_YEAR_DATA;
  const daysByDate = new Map(days.map((d) => [d.date, d]));
  const boundary = days.reduce((acc, d) => (/First Semester Exams/i.test(d.summary) ? d.date : acc), null);
  const qualifyingBreaks = findQualifyingBreaks(classifyCalendarDays(days, daysByDate), 3);

  const clockEl = document.getElementById("mo-clock");
  const dateEl = document.getElementById("mo-date");
  const dailyBarsEl = document.getElementById("mo-daily-bars");
  const dailyStatusEl = document.getElementById("mo-daily-status");
  const squaresEl = document.getElementById("mo-squares");
  const rotatorTitleEl = document.getElementById("mo-rotator-title");
  const rotatorBodyEl = document.getElementById("mo-rotator-body");
  const peopleEl = document.getElementById("mo-people-list");
  const teachersPeriodEl = document.getElementById("mo-teachers-period");
  const weatherEl = document.getElementById("mo-weather");

  const CONFETTI_COLORS = ["#005588", "#88ccec", "#f59e0b", "#34d399", "#fb7185", "#a78bfa"];

  // a short burst of falling confetti pieces, for the moment a bar
  // finishes. Plain DOM/CSS, no canvas or library.
  function fireConfetti() {
    const container = document.createElement("div");
    container.className = "mo-confetti-burst";
    for (let i = 0; i < 60; i++) {
      const piece = document.createElement("div");
      piece.className = "mo-confetti-piece";
      piece.style.left = Math.random() * 100 + "vw";
      piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
      piece.style.animationDelay = (Math.random() * 0.4) + "s";
      piece.style.animationDuration = (2 + Math.random() * 1.5) + "s";
      piece.style.setProperty("--rot", (Math.random() * 360) + "deg");
      piece.style.setProperty("--drift", (Math.random() * 200 - 100) + "px");
      container.appendChild(piece);
    }
    document.body.appendChild(container);
    setTimeout(() => container.remove(), 4000);
  }

  // every currently-live bar, keyed by date|letter|wave -- a split period
  // has two independent bars (Fr/So and Jr/Sr) whose windows overlap, so
  // either or both can be live/finish at different moments.
  function liveBarKeys(now) {
    const today = daysByDate.get(now.dateStr);
    const keys = new Set();
    if (!today) return keys;
    for (const p of today.periods) {
      const waves = p.jrsrStartMinutes != null ? ["frso", "jrsr"] : ["frso"];
      for (const wave of waves) {
        if (isPeriodLive(today, p, now, wave)) keys.add(`${now.dateStr}|${p.label}|${wave}`);
      }
    }
    return keys;
  }

  // fires once per bar, right as it finishes -- no personal filtering
  // exists on this dashboard to cause a false positive here, unlike the
  // main app, so a plain "was live, now isn't" check is enough.
  let lastLiveBarKeys = new Set();
  function checkPeriodCompletion(now) {
    const newKeys = liveBarKeys(now);
    for (const key of lastLiveBarKeys) {
      if (!newKeys.has(key)) fireConfetti();
    }
    lastLiveBarKeys = newKeys;
  }

  // shared by the daily countdown and the teachers list: what's happening
  // right now for today's (real) periods -- live, or the next upcoming
  // one, or nothing left today. "next" is withheld before 7:30am (see
  // COUNTDOWN_START_MINUTES) since predicting hours ahead isn't useful
  // that early, but an already-live period always shows regardless.
  function currentOrNextPeriod(today, now) {
    if (!today || !today.periods.length) return { state: "no-school" };
    const live = today.periods.find((p) => isPeriodLive(today, p, now, effectiveWave(today, p, now)));
    if (live) return { state: "current", period: live };
    if (now.minutes < COUNTDOWN_START_MINUTES) return { state: "too-early" };
    const upcoming = today.periods.find((p) => resolvePeriodTimes(p, effectiveWave(today, p, now)).startMinutes > now.minutes);
    if (upcoming) return { state: "next", period: upcoming };
    return { state: "done" };
  }

  function renderTeachers(now) {
    const today = daysByDate.get(now.dateStr);
    const info = currentOrNextPeriod(today, now);

    if (info.state === "no-school") {
      teachersPeriodEl.textContent = "";
      peopleEl.innerHTML = `<li class="mo-status">No school today</li>`;
      return;
    }
    if (info.state === "too-early") {
      teachersPeriodEl.textContent = "";
      peopleEl.innerHTML = "";
      return;
    }
    if (info.state === "done") {
      teachersPeriodEl.textContent = "";
      peopleEl.innerHTML = `<li class="mo-status">School's out for today 🎉🙌</li>`;
      return;
    }

    const letter = info.period.label;
    teachersPeriodEl.textContent = info.state === "current" ? `Period ${letter} — Now` : `Period ${letter} — Next`;
    const teaching = teachersData.filter((t) => t.periods.includes(letter));
    peopleEl.innerHTML = teaching.length
      ? teaching.map((t) => `
        <li class="mo-person">
          <span class="mo-person-name">${t.name}</span>
          <span class="mo-person-room">${t.rooms[letter]}</span>
        </li>`).join("")
      : `<li class="mo-status">No one scheduled this period</li>`;
  }

  let teachersData = [];

  async function fetchTeachers() {
    try {
      // cache-bust every fetch -- teachers.csv is a plain static file, so
      // without this a browser (or the file server) can keep serving
      // whatever it first fetched even after the file's been updated on
      // disk, well past the 30-minute refresh interval.
      const res = await fetch(`${TEACHERS_CSV_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`teachers.csv fetch failed: ${res.status}`);
      teachersData = parseTeachersCsv(await res.text());
    } catch (e) {
      teachersData = [];
    }
  }

  let breakNameOverrides = new Map();
  let birthdaysData = [];
  let foodData = [];

  // cache-bust every fetch, same reasoning as fetchTeachers -- these are
  // plain static files the office edits directly on disk.
  async function fetchBreaks() {
    try {
      const res = await fetch(`${BREAKS_CSV_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`breaks.csv fetch failed: ${res.status}`);
      breakNameOverrides = parseBreaksCsv(await res.text());
    } catch (e) {
      breakNameOverrides = new Map();
    }
  }

  async function fetchBirthdays() {
    try {
      const res = await fetch(`${BIRTHDAYS_CSV_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`birthdays.csv fetch failed: ${res.status}`);
      birthdaysData = parseBirthdaysCsv(await res.text());
    } catch (e) {
      birthdaysData = [];
    }
  }

  async function fetchFood() {
    try {
      const res = await fetch(`${FOOD_CSV_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`food.csv fetch failed: ${res.status}`);
      foodData = parseFoodCsv(await res.text());
    } catch (e) {
      foodData = [];
    }
  }

  let weatherData = null;

  async function fetchWeather() {
    try {
      const res = await fetch(WEATHER_URL);
      if (!res.ok) throw new Error(`weather fetch failed: ${res.status}`);
      weatherData = await res.json();
    } catch (e) {
      weatherData = null;
    }
    renderWeather();
  }

  function weatherCardHtml(label, temp, code, isDay) {
    return `
      <div class="mo-weather-card">
        <div class="mo-weather-card-label">${label}</div>
        <div class="mo-weather-card-icon">${weatherEmoji(code, isDay)}</div>
        <div class="mo-weather-card-temp">${temp}</div>
      </div>`;
  }

  function renderWeather() {
    if (!weatherData) {
      weatherEl.innerHTML = `<div class="mo-weather-error">Weather unavailable</div>`;
      return;
    }
    const now = nowInChicago();
    const cur = weatherData.current;
    const { time: hourlyTimes, temperature_2m: hourlyTemp, weather_code: hourlyCode, is_day: hourlyIsDay } = weatherData.hourly;

    function hourCard(label, hour) {
      const idx = findHourlyIndex(hourlyTimes, now.dateStr, hour);
      if (idx === -1) return weatherCardHtml(label, "—", null, 1);
      return weatherCardHtml(label, `${Math.round(hourlyTemp[idx])}°`, hourlyCode[idx], hourlyIsDay[idx]);
    }

    const daily = weatherData.daily;
    const tomorrow = `${Math.round(daily.temperature_2m_max[1])}° / ${Math.round(daily.temperature_2m_min[1])}°`;

    weatherEl.innerHTML = `
      <div class="mo-weather-current">
        <div class="mo-weather-current-icon">${weatherEmoji(cur.weather_code, cur.is_day)}</div>
        <div class="mo-weather-current-temp">${Math.round(cur.temperature_2m)}°F</div>
        <div class="mo-weather-current-label">${weatherLabel(cur.weather_code)}</div>
      </div>
      <div class="mo-weather-forecast">
        ${hourCard("Noon", 12)}
        ${hourCard("3 PM", 15)}
        ${hourCard("8 PM", 20)}
        ${weatherCardHtml("Tomorrow", tomorrow, daily.weather_code[1], 1)}
      </div>`;
  }

  // one progress bar per period of the day, plus a countdown banner when
  // nothing is currently in session.
  let lastBarsKey = null;

  function renderDaily(now) {
    const today = daysByDate.get(now.dateStr);
    const periods = today ? today.periods : [];

    if (!periods.length) {
      dailyStatusEl.innerHTML = `<div class="mo-status">No school today</div>`;
      dailyBarsEl.innerHTML = "";
      return;
    }

    const info = currentOrNextPeriod(today, now);
    if (info.state === "too-early") {
      dailyStatusEl.innerHTML = "";
    } else if (info.state === "done") {
      dailyStatusEl.innerHTML = `<div class="mo-status">School's out for today 🎉🙌</div>`;
    } else if (info.state === "current") {
      // the main countdown is the live period's time remaining -- the
      // per-bar elapsed/remaining text would just be repeating this.
      const live = info.period;
      const wave = effectiveWave(today, live, now);
      const { startMinutes, endMinutes } = resolvePeriodTimes(live, wave);
      const totalMs = (endMinutes - startMinutes) * 60000;
      const elapsedMs = Math.min(totalMs, Math.max(0, (now.minutes - startMinutes) * 60000 + now.seconds * 1000));
      const remainingMs = totalMs - elapsedMs;
      dailyStatusEl.innerHTML = `
        <div class="mo-countdown">
          <div class="mo-countdown-label">Period ${live.label} — Now</div>
          <div class="mo-countdown-clock">${formatCountdownClock(remainingMs)}</div>
          <div class="mo-countdown-sub">${formatCountdownClock(elapsedMs)} elapsed</div>
        </div>`;
    } else {
      // "next" -- nothing live right now, so count down to what's next.
      const upcoming = info.period;
      const { startMinutes } = resolvePeriodTimes(upcoming, effectiveWave(today, upcoming, now));
      const msToStart = (startMinutes - now.minutes) * 60000 - now.seconds * 1000;
      dailyStatusEl.innerHTML = `
        <div class="mo-countdown">
          <div class="mo-countdown-label">Next: Period ${upcoming.label}</div>
          <div class="mo-countdown-clock">${formatCountdownClock(msToStart)}</div>
        </div>`;
    }

    // a period that splits by lunch wave gets two independent bars (Fr/So
    // and Jr/Sr), since their windows overlap rather than one replacing
    // the other -- the office wants to track both, not just whichever one
    // "effectiveWave" would otherwise pick as the default.
    const barSpecs = periods.flatMap((p) => {
      if (p.jrsrStartMinutes != null) {
        return [{ p, wave: "frso", waveLabel: "Fr/So" }, { p, wave: "jrsr", waveLabel: "Jr/Sr" }];
      }
      return [{ p, wave: "frso", waveLabel: null }];
    });

    // today's set of bars only ever changes once a day (at the date
    // rollover); every other tick just patches percentage/width/live
    // state in place, so a live bar's animated gradient (see
    // mo-live-shift) keeps playing instead of restarting from a brand
    // new DOM node every second.
    const barsKey = `${now.dateStr}|${barSpecs.map((s) => `${s.p.label}:${s.wave}`).join(",")}`;
    if (barsKey !== lastBarsKey) {
      lastBarsKey = barsKey;
      dailyBarsEl.innerHTML = barSpecs.map((s) => periodBarHtml(today, s.p, now, s.wave, s.waveLabel)).join("");
      return;
    }

    const rows = dailyBarsEl.children;
    barSpecs.forEach((s, i) => {
      const row = rows[i];
      if (!row) return;
      const progress = periodProgress(today, s.p, now, s.wave);
      const pct = Math.round(progress * 100);
      row.classList.toggle("is-live", isPeriodLive(today, s.p, now, s.wave));
      row.querySelector(".mo-bar-top span:last-child").textContent = pct + "%";
      row.querySelector(".mo-bar-fill").style.width = pct + "%";
    });
  }

  function periodBarHtml(day, p, now, wave, waveLabel) {
    const progress = periodProgress(day, p, now, wave);
    const pct = Math.round(progress * 100);
    const isLive = isPeriodLive(day, p, now, wave);
    const label = waveLabel ? `Period ${p.label} (${waveLabel})` : `Period ${p.label}`;

    // no elapsed/remaining text here -- that's now the main countdown's
    // job, right above the bars, so this would just repeat it.
    return `
      <div class="mo-bar-row${isLive ? " is-live" : ""}">
        <div class="mo-bar-top"><span>${label}</span><span>${pct}%</span></div>
        <div class="mo-bar-track"><div class="mo-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
  }

  // the whole year as small squares, same "year in pixels" idea as the
  // main site's Continuous view, sized down to fit a dashboard column.
  let totalSquareCount = 0;

  function renderSquares(now) {
    if (squaresEl.childElementCount) return; // static once built -- only the fill amounts change per tick
    const schoolDays = days.filter((d) => d.periods.length);
    let crossedBoundary = false;
    const frag = document.createDocumentFragment();
    for (const day of schoolDays) {
      if (!crossedBoundary && day.date > boundary) {
        crossedBoundary = true;
        const divider = document.createElement("div");
        divider.className = "mo-semester-divider";
        frag.appendChild(divider);
      }
      for (const p of day.periods) {
        const sq = document.createElement("div");
        sq.className = "mo-square";
        sq.dataset.date = day.date;
        sq.dataset.label = p.label;
        totalSquareCount += 1;
        const fill = document.createElement("div");
        fill.className = "mo-square-fill";
        sq.appendChild(fill);
        frag.appendChild(sq);
      }
    }
    squaresEl.appendChild(frag);
    updateSquares(now);
    fitSquareSize();
  }

  // picks the largest square size that still fits the whole year in the
  // column's actual available space, on whatever screen this happens to
  // be running on -- a fixed pixel size looked fine at one window size and
  // overflowed at another, so this searches instead of guessing.
  function fitSquareSize() {
    const container = squaresEl.parentElement;
    const availWidth = container.clientWidth;
    const availHeight = container.clientHeight;
    if (!availWidth || !availHeight || !totalSquareCount) return;

    const dividerHeight = 12; // approx height the semester-divider row itself adds
    let best = { size: 4, gap: 1 };
    for (let size = 22; size >= 4; size--) {
      const gap = Math.max(1, Math.round(size / 6));
      const perRow = Math.floor((availWidth + gap) / (size + gap));
      if (perRow < 1) continue;
      const rows = Math.ceil(totalSquareCount / perRow);
      const totalHeight = rows * (size + gap) + dividerHeight;
      if (totalHeight <= availHeight) { best = { size, gap }; break; }
    }
    squaresEl.style.setProperty("--mo-square-size", best.size + "px");
    squaresEl.style.gap = best.gap + "px";
  }

  function updateSquares(now) {
    squaresEl.querySelectorAll(".mo-square").forEach((sq) => {
      const day = daysByDate.get(sq.dataset.date);
      const period = day.periods.find((p) => p.label === sq.dataset.label);
      const wave = effectiveWave(day, period, now);
      const progress = periodProgress(day, period, now, wave);
      sq.querySelector(".mo-square-fill").style.height = (progress * 100) + "%";
      sq.classList.toggle("is-live", isPeriodLive(day, period, now, wave));
    });
  }

  // sits at the top of the breaks list -- weekends aren't "qualifying
  // breaks" (those need 3+ days), but they're what most people actually
  // count down to day to day. Gets an emoji specifically on the last
  // school day of the week, not just once it's fully over.
  function nextWeekendRowHtml(now) {
    const mon = mondayOf(now.dateStr);
    const weekDays = days.filter((d) => d.periods.length && mondayOf(d.date) === mon);
    if (!weekDays.length) return "";

    if (weekdayIndex(now.dateStr) > 4) {
      return `
        <div class="mo-break-row is-active">
          <span class="mo-break-name">Weekend</span>
          <span class="mo-break-days">🎉 enjoy!</span>
        </div>`;
    }
    const isLastDayOfWeek = now.dateStr === weekDays[weekDays.length - 1].date;
    const weekendStart = addDays(weekDays[weekDays.length - 1].date, 1);
    const daysLeft = schoolDaysUntil(days, now, weekendStart);
    return `
      <div class="mo-break-row">
        <span class="mo-break-name">Next Weekend</span>
        <span class="mo-break-days">${daysLeft} school day${daysLeft === 1 ? "" : "s"}${isLastDayOfWeek ? " 🎉" : ""}</span>
      </div>`;
  }

  function breaksListHtml(now) {
    const weekendRow = nextWeekendRowHtml(now);
    const upcoming = qualifyingBreaks.filter((b) => b.end >= now.dateStr);
    if (!upcoming.length) {
      return weekendRow + `<div class="mo-status">No more qualifying breaks left this year</div>`;
    }
    return weekendRow + upcoming.map((b) => {
      const name = breakName(b.start, b.end, daysByDate, breakNameOverrides);
      const onBreak = b.start <= now.dateStr && now.dateStr <= b.end;
      if (onBreak) {
        return `
          <div class="mo-break-row is-active">
            <span class="mo-break-name">${name}</span>
            <span class="mo-break-days">🎉 now</span>
          </div>`;
      }
      const daysLeft = schoolDaysUntil(days, now, b.start);
      return `
        <div class="mo-break-row">
          <span class="mo-break-name">${name}</span>
          <span class="mo-break-days">${daysLeft} school day${daysLeft === 1 ? "" : "s"}</span>
        </div>`;
    }).join("");
  }

  function birthdaysListHtml(now) {
    const upcoming = birthdaysData.filter((e) => e.date >= now.dateStr).slice(0, ROTATOR_LIST_LIMIT);
    if (!upcoming.length) return `<div class="mo-status">No more birthdays left this year</div>`;
    return upcoming.map((e) => {
      const nameHtml = e.isMath ? `<strong>${e.name}</strong>` : e.name;
      if (e.date === now.dateStr) {
        return `
          <div class="mo-break-row is-active">
            <span class="mo-break-name">${nameHtml}</span>
            <span class="mo-break-days">🎉🎂 Today!</span>
          </div>`;
      }
      // real calendar days, not school days -- a birthday isn't tied to
      // whether school's in session, and this shouldn't be rounded: it
      // only changes at midnight, and a birthday tomorrow always reads 1.
      const daysLeft = calendarDaysUntil(now, e.date);
      return `
        <div class="mo-break-row">
          <span class="mo-break-name">${nameHtml}</span>
          <span class="mo-break-days">${formatShortDate(e.date)} - ${daysLeft} day${daysLeft === 1 ? "" : "s"}</span>
        </div>`;
    }).join("");
  }

  function foodListHtml(now) {
    const upcoming = foodData.filter((e) => e.date >= now.dateStr).slice(0, ROTATOR_LIST_LIMIT);
    if (!upcoming.length) return `<div class="mo-status">Nothing planned right now</div>`;
    return upcoming.map((e) => {
      if (e.date === now.dateStr) {
        return `
          <div class="mo-break-row is-active">
            <span class="mo-break-name">${e.name}</span>
            <span class="mo-break-days">🎉🍕 Today!</span>
          </div>`;
      }
      const daysLeft = schoolDaysUntil(days, now, e.date);
      return `
        <div class="mo-break-row">
          <span class="mo-break-name">${e.name}</span>
          <span class="mo-break-days">${daysLeft} school day${daysLeft === 1 ? "" : "s"}</span>
        </div>`;
    }).join("");
  }

  // the "Upcoming Breaks" box rotates between a few lists rather than
  // showing just one -- breaks (always present, computed from the school
  // calendar) plus birthdays/free-food whenever their CSV has upcoming
  // entries. Rebuilt every render tick so the currently-visible page's
  // countdowns stay fresh, but only ever written to the DOM (and only ever
  // advanced/faded) on its own slower rotation timer, so the fade
  // transition never gets clobbered mid-flight by the 1s tick.
  const ROTATE_MS = 7000;
  const FADE_MS = 250;
  let rotatorPages = [];
  let rotatorIndex = 0;
  let lastRotatorHtml = null;

  function computeRotatorPages(now) {
    const pages = [{ title: "Upcoming Breaks", html: breaksListHtml(now) }];
    if (birthdaysData.some((e) => e.date >= now.dateStr)) {
      pages.push({ title: "Upcoming Birthdays", html: birthdaysListHtml(now) });
    }
    if (foodData.some((e) => e.date >= now.dateStr)) {
      pages.push({ title: "Free Food", html: foodListHtml(now) });
    }
    return pages;
  }

  function renderRotator(now) {
    rotatorPages = computeRotatorPages(now);
    if (rotatorIndex >= rotatorPages.length) rotatorIndex = 0;
    const page = rotatorPages[rotatorIndex];
    rotatorTitleEl.textContent = page.title;
    if (page.html !== lastRotatorHtml) {
      lastRotatorHtml = page.html;
      rotatorBodyEl.innerHTML = page.html;
    }
  }

  function rotateToNextPage() {
    if (rotatorPages.length <= 1) return; // nothing else to rotate to
    rotatorBodyEl.classList.add("is-fading");
    rotatorTitleEl.classList.add("is-fading");
    setTimeout(() => {
      rotatorIndex = (rotatorIndex + 1) % rotatorPages.length;
      lastRotatorHtml = null; // force the swap even if the new page's html happens to match
      renderRotator(nowInChicago());
      rotatorBodyEl.classList.remove("is-fading");
      rotatorTitleEl.classList.remove("is-fading");
    }, FADE_MS);
  }

  function render() {
    const now = nowInChicago();
    clockEl.textContent = formatClock12h(now);
    dateEl.textContent = formatFullDate(now.dateStr);
    checkPeriodCompletion(now);
    renderDaily(now);
    renderTeachers(now);
    renderSquares(now);
    updateSquares(now);
    renderRotator(now);
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitSquareSize, 150);
  });

  fetchTeachers();
  setInterval(fetchTeachers, TEACHERS_REFRESH_MS);
  fetchBreaks();
  setInterval(fetchBreaks, ROTATOR_REFRESH_MS);
  fetchBirthdays();
  setInterval(fetchBirthdays, ROTATOR_REFRESH_MS);
  fetchFood();
  setInterval(fetchFood, ROTATOR_REFRESH_MS);
  fetchWeather();
  setInterval(fetchWeather, WEATHER_REFRESH_MS);
  watchForNewVersion();
  render();
  setInterval(render, REFRESH_MS);
  setInterval(rotateToNextPage, ROTATE_MS);
}

main();
