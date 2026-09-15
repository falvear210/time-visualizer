// =============================================================================
// mcl-office.js -- all the behavior for mcl-office.html, the Modern & Classical
// Languages office wall display. Runs full-screen and unattended on a TV.
//
// It's a deliberate sibling of math-office.js: the same standalone approach
// (reads data.js for the school calendar, shares no code with app.js, keeps
// its own trimmed-down copies of the date/schedule helpers), and several
// panels are byte-for-byte the same idea. The header comment on each helper
// block points back to its math-office.js / app.js counterpart.
//
// What's genuinely different here, and where to look for it:
//   - HEADER GREETING -- a rotating "hello" in the taught languages.
//   - WORLD MAP panel (renderMap / mapTick) -- replaces math-office's "Year
//     at a Glance". Rotates between: shading the countries where a language
//     is spoken (one page per mcl-map-languages.csv row), the department's
//     exchange partners, and where SLUH travels -- the last two showing one
//     place at a time as a pulsing dot + name (mcl-map-places.csv).
//   - "Languages Teaching Now" -- the teacher list, but each row carries the
//     language + level (mcl-teachers.csv has a 4th column).
//   - the rotating box carries a "Cultural Calendar" of upcoming festivities
//     and national days for the countries behind the taught languages
//     (mcl-culture.csv) and the next meeting of each cultural / affinity
//     club (mcl-clubs.csv).
//   - weather shows St. Louis plus a few world cities (mcl-cities.csv).
//
// Every panel rebuilds from scratch each tick (nothing interactive to lose),
// except a few spots that patch in place so a running CSS animation/fade
// isn't restarted. Nothing runs until main() is called at the bottom.
// =============================================================================

const TIME_ZONE = "America/Chicago";
const REFRESH_MS = 1000; // no interactive elements, so a full rebuild every tick is cheap and safe
const COUNTDOWN_START_MINUTES = 7 * 60 + 30; // countdowns/"teaching next" don't show before 7:30am

// ---- remote reload (kiosk support) ----
// Same as math-office: this runs unattended with no one to hit refresh, so
// it watches version.txt (bumped by deploy.sh on every deploy) and reloads
// itself within one polling interval of a new deploy landing.
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
      // a transient fetch failure shouldn't reload or crash the watcher.
    }
  }, VERSION_CHECK_MS);
}

// ---- date helpers (mirrors of math-office.js / see app.js for the fuller version) ----

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

// "8/27" -- the countdown rows lead with this so it's clear which date the
// countdown is counting down to.
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

// ---- lunch-wave resolution (see math-office.js / app.js's resolvePeriodTimes) ----
// No personal settings here, so "frso" is the blanket default; the
// natural-detection fallback keeps a still-running Jr/Sr half from looking
// "done" the moment Fr/So's window closes.

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

// whether this period is in progress right now (see math-office.js's note --
// periodProgress() truncates to whole minutes, so it reads exactly 0 for the
// whole first minute; this checks the minute range directly instead).
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

// ---- break detection (see math-office.js / app.js's classifyCalendarDays) ----

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

// Whole school days from tomorrow through targetDate (inclusive of targetDate
// even when it isn't a school day). Pure date comparison -- only ever changes
// at midnight, and a targetDate of tomorrow always reads as 1, never 0.
function schoolDaysUntil(days, now, targetDate) {
  const between = days.filter((d) => d.periods.length && d.date > now.dateStr && d.date < targetDate).length;
  return between + 1;
}

// Plain calendar days from today through targetDate -- for events (birthdays,
// cultural dates) that aren't about school days in session, just the date.
function calendarDaysUntil(now, targetDate) {
  const a = parseDate(now.dateStr), b = parseDate(targetDate);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

// A cultural date in mcl-culture.csv is usually a month/day ("07-14") -- a
// fixed festival like Bastille Day that lands on the same date every year --
// which we resolve to its next occurrence on or after today so it can be
// counted down to. A movable feast (Lunar New Year, Orthodox Easter) instead
// gets a full "YYYY-MM-DD", which is used as-is.
function resolveCultureDate(spec, now) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec.replace(/-/g, "");
  const [mm, dd] = spec.split("-");
  const thisYear = `${now.dateStr.slice(0, 4)}${mm}${dd}`;
  if (thisYear >= now.dateStr) return thisYear;
  return `${+now.dateStr.slice(0, 4) + 1}${mm}${dd}`;
}

// 0=Sun..6=Sat for a YYYYMMDD date, and the same for a weekday name/abbrev
// ("Monday", "mon", "M"). Used by the clubs list.
function dowOfDate(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dowOfName(name) {
  const n = (name || "").trim().toLowerCase();
  const i = DOW_NAMES.findIndex((d) => d.toLowerCase().startsWith(n.slice(0, 3)));
  return i; // -1 if unrecognized
}

// "15:15" -> 915 (minutes past midnight); null if not HH:MM.
function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || "").trim());
  return m ? +m[1] * 60 + +m[2] : null;
}

// "15:15" -> "3:15 PM"; passes anything unparseable straight through.
function formatHHMM12h(hhmm) {
  const mins = hhmmToMinutes(hhmm);
  if (mins == null) return hhmm || "";
  let h = Math.floor(mins / 60);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(mins % 60).padStart(2, "0")} ${ampm}`;
}

// ---- CSV loading ----
// All the department-editable data is plain CSV fetched every 30 minutes,
// each fetch cache-busted (same reasoning as math-office: these are static
// files the office edits directly on disk, and without ?t= a browser or file
// server can keep serving a stale copy well past the refresh interval).
// Naive comma-split throughout -- fine as long as the cells don't contain
// commas, which keeps this dependency-free.

const CSV_REFRESH_MS = 30 * 60 * 1000;
const LIST_LIMIT = 12; // a rotator box page scrolls if it runs longer than this

function csvRows(text) {
  return text.trim().split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
}

async function fetchCsv(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} fetch failed: ${res.status}`);
  return await res.text();
}

// mcl-teachers.csv: name,period,room,language -- one row per teacher per
// period (a teacher can be in a different room, or teach a different
// language, in different periods).
function parseTeachersCsv(text) {
  const byName = new Map();
  for (const line of csvRows(text)) {
    const [name, period, room, language] = line.split(",").map((s) => (s || "").trim());
    if (!name || !period) continue;
    if (!byName.has(name)) byName.set(name, { name, periods: [], rooms: {}, langs: {} });
    const t = byName.get(name);
    t.periods.push(period);
    t.rooms[period] = room || "";
    t.langs[period] = language || "";
  }
  return [...byName.values()];
}

// mcl-clubs.csv: name,weekday,time,location -- the cultural & affinity clubs.
//   weekday   "Monday" / "Tue" / ... (the day the club meets)
//   time      "HH:MM" 24-hour (e.g. 15:15 for a 3:15pm meeting)
//   location  room or space
// The list shows each club's *next* meeting; a club with no recognizable
// weekday still lists (without a date) so it isn't silently dropped.
function parseClubsCsv(text) {
  return csvRows(text).map((line) => {
    const [name, weekday, time, location] = line.split(",").map((s) => (s || "").trim());
    return { name, dow: dowOfName(weekday), weekdayRaw: weekday, time: time || "", location: location || "" };
  }).filter((c) => c.name);
}

// mcl-culture.csv: date,name,language
//   date      "MM-DD" for a fixed festival, or "YYYY-MM-DD" for a movable one
//   name      what to show
//   language  a dim tag (the related language / country / region)
// e.g.  07-14,Bastille Day,France   |   2027-02-06,Lunar New Year,China
function parseCultureCsv(text) {
  return csvRows(text).map((line) => {
    const [date, name, language] = line.split(",").map((s) => (s || "").trim());
    return { date, name, language };
  }).filter((c) => (/^\d{2}-\d{2}$/.test(c.date) || /^\d{4}-\d{2}-\d{2}$/.test(c.date)) && c.name);
}

// mcl-birthdays.csv: date,name,dept -- a dept of "language" renders bold.
function parseBirthdaysCsv(text) {
  const birthdays = csvRows(text).map((line) => {
    const [date, name, dept] = line.split(",").map((s) => (s || "").trim());
    return { date, name, isDept: dept === "language" };
  }).filter((b) => b.date && b.name);
  birthdays.sort((a, b) => a.date.localeCompare(b.date));
  return birthdays;
}

// mcl-breaks.csv: date,name -- override a break's auto-detected label.
function parseBreaksCsv(text) {
  const overrides = new Map();
  for (const line of csvRows(text)) {
    const [date, name] = line.split(",").map((s) => (s || "").trim());
    if (date && name) overrides.set(date, name);
  }
  return overrides;
}

// mcl-map-languages.csv: language,flag,color,countries
//   countries is a SPACE-separated list of ISO 3166-1 alpha-2 codes
//   (lowercase) matching path ids in world-map.svg. For classical languages
//   this is "where the language left its mark", not a native-speaker map --
//   edit the list to whatever the department wants to show.
function parseMapLanguagesCsv(text) {
  return csvRows(text).map((line) => {
    const [language, flag, color, countries] = line.split(",").map((s) => (s || "").trim());
    return {
      language,
      flag: flag || "",
      color: color || "",
      countries: (countries || "").split(/\s+/).filter(Boolean).map((c) => c.toLowerCase()),
    };
  }).filter((l) => l.language && l.countries.length);
}

// mcl-map-places.csv: label,kind,country,dx,dy,detail
//   kind    "partner" (exchange school) or "trip" (SLUH travels there)
//   country ISO 3166-1 alpha-2 -- the pin drops on that country's center
//   dx,dy   optional nudge, in percent of the map's width/height, to move
//           the pin off the country center toward an actual city
//   detail  short caption under the label (a city, or trip dates)
function parseMapPlacesCsv(text) {
  return csvRows(text).map((line) => {
    const [label, kind, country, dx, dy, detail] = line.split(",").map((s) => (s || "").trim());
    return {
      label,
      kind: (kind || "").toLowerCase(),
      country: (country || "").toLowerCase(),
      dx: parseFloat(dx) || 0,
      dy: parseFloat(dy) || 0,
      detail: detail || "",
    };
  }).filter((p) => p.label && p.country);
}

// mcl-cities.csv: label,lat,lon -- the extra cities in the weather panel.
function parseCitiesCsv(text) {
  return csvRows(text).map((line) => {
    const [label, lat, lon] = line.split(",").map((s) => (s || "").trim());
    return { label, lat: parseFloat(lat), lon: parseFloat(lon) };
  }).filter((c) => c.label && isFinite(c.lat) && isFinite(c.lon));
}

// ---- weather (Open-Meteo -- free, no API key, CORS-enabled) ----
// The office TV is in St. Louis, so that's the primary reading. The extra
// cities (mcl-cities.csv) get a small current-temp card each -- a nod to the
// department's reach, and genuinely handy the week before a trip.
const STL_LAT = 38.6274;   // SLUH, 4970 Oakland Ave, St. Louis, MO
const STL_LON = -90.2688;
const WEATHER_REFRESH_MS = 30 * 60 * 1000;
const WEATHER_RETRY_MS = 2 * 60 * 1000; // most failures are transient; don't wait the full interval
const STL_WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${STL_LAT}&longitude=${STL_LON}` +
  "&current=temperature_2m,weather_code,is_day" +
  "&hourly=temperature_2m,weather_code,is_day" +
  "&daily=weather_code,temperature_2m_max,temperature_2m_min" +
  "&temperature_unit=fahrenheit&timezone=America%2FChicago&forecast_days=2";

// WMO weather codes (what Open-Meteo returns) -> a plain emoji. Same table
// as math-office; no icon assets/library, consistent with the rest of the
// project.
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

// finds the hourly-array index for a specific local hour on `dateStr`.
function findHourlyIndex(hourlyTimes, dateStr, hour) {
  const target = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T${String(hour).padStart(2, "0")}:00`;
  return hourlyTimes.indexOf(target);
}

// ---- main ----

function main() {
  const days = SCHOOL_YEAR_DATA;
  const daysByDate = new Map(days.map((d) => [d.date, d]));
  const qualifyingBreaks = findQualifyingBreaks(classifyCalendarDays(days, daysByDate), 3);

  const el = (id) => document.getElementById(id);
  const clockEl = el("mcl-clock");
  const dateEl = el("mcl-date");
  const greetingEl = el("mcl-greeting");
  const dailyBarsEl = el("mcl-daily-bars");
  const dailyStatusEl = el("mcl-daily-status");
  const rotatorTitleEl = el("mcl-rotator-title");
  const rotatorBodyEl = el("mcl-rotator-body");
  const peopleEl = el("mcl-people-list");
  const teachersPeriodEl = el("mcl-teachers-period");
  const weatherEl = el("mcl-weather");
  const mapTitleEl = el("mcl-map-title");
  const mapSubEl = el("mcl-map-sub");
  const mapSvgEl = el("mcl-map-svg");
  const mapPinsEl = el("mcl-map-pins");
  const mapLegendEl = el("mcl-map-legend");
  const mapWrapEl = el("mcl-map-wrap");
  const mapStageEl = el("mcl-map-stage");

  // ---- header greeting rotator ----
  // cycles a "hello" through the taught languages, on its own slow timer
  // with a cross-fade. Purely decorative -- sets the tone the moment
  // someone glances at the screen.
  const GREETINGS = [
    "Hola", "Bonjour", "مرحبًا", "你好",
    "Привет", "Salvē", "Χαῖρε",
  ];
  let greetingIndex = 0;
  function rotateGreeting() {
    greetingEl.classList.add("is-fading");
    setTimeout(() => {
      greetingIndex = (greetingIndex + 1) % GREETINGS.length;
      greetingEl.textContent = GREETINGS[greetingIndex];
      greetingEl.classList.remove("is-fading");
    }, 250);
  }
  greetingEl.textContent = GREETINGS[0];

  // ---- confetti (a period/lunch-wave bar just finished) ----
  const CONFETTI_COLORS = ["#005588", "#88ccec", "#f59e0b", "#34d399", "#fb7185", "#a78bfa"];

  function fireConfetti() {
    const container = document.createElement("div");
    container.className = "mcl-confetti-burst";
    for (let i = 0; i < 60; i++) {
      const piece = document.createElement("div");
      piece.className = "mcl-confetti-piece";
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

  let lastLiveBarKeys = new Set();
  function checkPeriodCompletion(now) {
    const newKeys = liveBarKeys(now);
    for (const key of lastLiveBarKeys) {
      if (!newKeys.has(key)) fireConfetti();
    }
    lastLiveBarKeys = newKeys;
  }

  // shared by the daily countdown and the teachers list: what's happening
  // right now for today's (real) periods -- live, or the next upcoming one,
  // or nothing left today.
  function currentOrNextPeriod(today, now) {
    if (!today || !today.periods.length) return { state: "no-school" };
    const live = today.periods.find((p) => isPeriodLive(today, p, now, effectiveWave(today, p, now)));
    if (live) return { state: "current", period: live };
    if (now.minutes < COUNTDOWN_START_MINUTES) return { state: "too-early" };
    const upcoming = today.periods.find((p) => resolvePeriodTimes(p, effectiveWave(today, p, now)).startMinutes > now.minutes);
    if (upcoming) return { state: "next", period: upcoming };
    return { state: "done" };
  }

  // ---- "Languages Teaching Now" ----

  let teachersData = [];

  function renderTeachers(now) {
    const today = daysByDate.get(now.dateStr);
    const info = currentOrNextPeriod(today, now);

    if (info.state === "no-school") {
      teachersPeriodEl.textContent = "";
      peopleEl.innerHTML = `<li class="mcl-status">No school today</li>`;
      return;
    }
    if (info.state === "too-early") {
      teachersPeriodEl.textContent = "";
      peopleEl.innerHTML = "";
      return;
    }
    if (info.state === "done") {
      teachersPeriodEl.textContent = "";
      peopleEl.innerHTML = `<li class="mcl-status">School's out for today 🎉🙌</li>`;
      return;
    }

    const letter = info.period.label;
    teachersPeriodEl.textContent = info.state === "current" ? `Period ${letter} — Now` : `Period ${letter} — Next`;
    const teaching = teachersData.filter((t) => t.periods.includes(letter));
    peopleEl.innerHTML = teaching.length
      ? teaching.map((t) => {
          const lang = t.langs[letter];
          return `
        <li class="mcl-person">
          <span class="mcl-person-name">${t.name}</span>
          ${lang ? `<span class="mcl-person-lang">${lang}</span>` : ""}
          <span class="mcl-person-room">${t.rooms[letter]}</span>
        </li>`;
        }).join("")
      : `<li class="mcl-status">No one scheduled this period</li>`;
  }

  // ---- Today's Schedule (countdown + one bar per period) ----

  let lastBarsKey = null;

  function renderDaily(now) {
    const today = daysByDate.get(now.dateStr);
    const periods = today ? today.periods : [];

    if (!periods.length) {
      dailyStatusEl.innerHTML = `<div class="mcl-status">No school today</div>`;
      dailyBarsEl.innerHTML = "";
      return;
    }

    const info = currentOrNextPeriod(today, now);
    if (info.state === "too-early") {
      dailyStatusEl.innerHTML = "";
    } else if (info.state === "done") {
      dailyStatusEl.innerHTML = `<div class="mcl-status">School's out for today 🎉🙌</div>`;
    } else if (info.state === "current") {
      const live = info.period;
      const wave = effectiveWave(today, live, now);
      const { startMinutes, endMinutes } = resolvePeriodTimes(live, wave);
      const totalMs = (endMinutes - startMinutes) * 60000;
      const elapsedMs = Math.min(totalMs, Math.max(0, (now.minutes - startMinutes) * 60000 + now.seconds * 1000));
      const remainingMs = totalMs - elapsedMs;
      dailyStatusEl.innerHTML = `
        <div class="mcl-countdown">
          <div class="mcl-countdown-label">Period ${live.label} — Now</div>
          <div class="mcl-countdown-clock">${formatCountdownClock(remainingMs)}</div>
          <div class="mcl-countdown-sub">${formatCountdownClock(elapsedMs)} elapsed</div>
        </div>`;
    } else {
      const upcoming = info.period;
      const { startMinutes } = resolvePeriodTimes(upcoming, effectiveWave(today, upcoming, now));
      const msToStart = (startMinutes - now.minutes) * 60000 - now.seconds * 1000;
      dailyStatusEl.innerHTML = `
        <div class="mcl-countdown">
          <div class="mcl-countdown-label">Next: Period ${upcoming.label}</div>
          <div class="mcl-countdown-clock">${formatCountdownClock(msToStart)}</div>
        </div>`;
    }

    const barSpecs = periods.flatMap((p) => {
      if (p.jrsrStartMinutes != null) {
        return [{ p, wave: "frso", waveLabel: "Fr/So" }, { p, wave: "jrsr", waveLabel: "Jr/Sr" }];
      }
      return [{ p, wave: "frso", waveLabel: null }];
    });

    // the set of bars only changes at the date rollover; every other tick
    // patches width/live state in place so a live bar's animated gradient
    // keeps playing instead of restarting from a new DOM node each second.
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
      const pct = Math.round(periodProgress(today, s.p, now, s.wave) * 100);
      row.classList.toggle("is-live", isPeriodLive(today, s.p, now, s.wave));
      row.querySelector(".mcl-bar-top span:last-child").textContent = pct + "%";
      row.querySelector(".mcl-bar-fill").style.width = pct + "%";
    });
  }

  function periodBarHtml(day, p, now, wave, waveLabel) {
    const pct = Math.round(periodProgress(day, p, now, wave) * 100);
    const isLive = isPeriodLive(day, p, now, wave);
    const label = waveLabel ? `Period ${p.label} (${waveLabel})` : `Period ${p.label}`;
    return `
      <div class="mcl-bar-row${isLive ? " is-live" : ""}">
        <div class="mcl-bar-top"><span>${label}</span><span>${pct}%</span></div>
        <div class="mcl-bar-track"><div class="mcl-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
  }

  // ---- weather ----

  let stlWeather = null;
  let cityWeather = []; // [{ label, temp, code }]
  let citiesData = [];

  let weatherTimer = null;
  async function fetchWeather() {
    let ok = false;
    try {
      const res = await fetch(STL_WEATHER_URL);
      if (!res.ok) throw new Error(`STL weather fetch failed: ${res.status}`);
      stlWeather = await res.json();
      ok = true;
    } catch (e) {
      console.warn("STL weather fetch failed, retrying soon:", e);
      stlWeather = null;
    }

    // the extra cities in one call -- Open-Meteo takes comma-separated
    // coordinates and returns an array in the same order.
    if (citiesData.length) {
      try {
        const lat = citiesData.map((c) => c.lat).join(",");
        const lon = citiesData.map((c) => c.lon).join(",");
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
          "&current=temperature_2m,weather_code,is_day&temperature_unit=fahrenheit");
        if (res.ok) {
          const data = await res.json();
          const arr = Array.isArray(data) ? data : [data];
          cityWeather = arr.map((d, i) => ({
            label: citiesData[i] ? citiesData[i].label : "",
            temp: d.current ? Math.round(d.current.temperature_2m) : null,
            code: d.current ? d.current.weather_code : null,
            isDay: d.current ? d.current.is_day : 1,
          }));
        }
      } catch (e) {
        console.warn("city weather fetch failed:", e);
        cityWeather = [];
      }
    }

    renderWeather();
    clearTimeout(weatherTimer);
    weatherTimer = setTimeout(fetchWeather, ok ? WEATHER_REFRESH_MS : WEATHER_RETRY_MS);
  }

  function cityCardHtml(label, temp, code, isDay) {
    return `
      <div class="mcl-weather-card">
        <div class="mcl-weather-card-label">${label}</div>
        <div class="mcl-weather-card-icon">${weatherEmoji(code, isDay)}</div>
        <div class="mcl-weather-card-temp">${temp == null ? "—" : temp + "°"}</div>
      </div>`;
  }

  function renderWeather() {
    if (!stlWeather && !cityWeather.length) {
      weatherEl.innerHTML = `<div class="mcl-weather-error">Weather unavailable</div>`;
      return;
    }

    let currentHtml = "";
    if (stlWeather) {
      const cur = stlWeather.current;
      currentHtml = `
        <div class="mcl-weather-current">
          <div class="mcl-weather-current-icon">${weatherEmoji(cur.weather_code, cur.is_day)}</div>
          <div class="mcl-weather-current-temp">${Math.round(cur.temperature_2m)}°F</div>
          <div class="mcl-weather-current-label">St. Louis · ${weatherLabel(cur.weather_code)}</div>
        </div>`;
    }

    const cards = cityWeather.map((c) => cityCardHtml(c.label, c.temp, c.code, c.isDay)).join("");

    weatherEl.innerHTML = currentHtml + `<div class="mcl-weather-forecast">${cards}</div>`;
  }

  // ---- rotating box: Cultural Calendar / Breaks / Birthdays / Clubs ----

  let breakNameOverrides = new Map();
  let cultureData = [];
  let birthdaysData = [];
  let clubsData = [];

  function nextWeekendRowHtml(now) {
    const mon = mondayOf(now.dateStr);
    const weekDays = days.filter((d) => d.periods.length && mondayOf(d.date) === mon);
    if (!weekDays.length) return "";
    if (weekdayIndex(now.dateStr) > 4) {
      return `
        <div class="mcl-row is-active">
          <span class="mcl-row-name">Weekend</span>
          <span class="mcl-row-meta">🎉 enjoy!</span>
        </div>`;
    }
    const isLastDayOfWeek = now.dateStr === weekDays[weekDays.length - 1].date;
    const weekendStart = addDays(weekDays[weekDays.length - 1].date, 1);
    const daysLeft = schoolDaysUntil(days, now, weekendStart);
    return `
      <div class="mcl-row">
        <span class="mcl-row-name">Next Weekend</span>
        <span class="mcl-row-meta">${daysLeft} school day${daysLeft === 1 ? "" : "s"}${isLastDayOfWeek ? " 🎉" : ""}</span>
      </div>`;
  }

  function breaksListHtml(now) {
    const weekendRow = nextWeekendRowHtml(now);
    const upcoming = qualifyingBreaks.filter((b) => b.end >= now.dateStr);
    if (!upcoming.length) {
      return weekendRow + `<div class="mcl-status">No more qualifying breaks left this year</div>`;
    }
    return weekendRow + upcoming.map((b) => {
      const name = breakName(b.start, b.end, daysByDate, breakNameOverrides);
      const onBreak = b.start <= now.dateStr && now.dateStr <= b.end;
      if (onBreak) {
        return `
          <div class="mcl-row is-active">
            <span class="mcl-row-name">${name}</span>
            <span class="mcl-row-meta">🎉 now</span>
          </div>`;
      }
      const daysLeft = schoolDaysUntil(days, now, b.start);
      return `
        <div class="mcl-row">
          <span class="mcl-row-name">${name}</span>
          <span class="mcl-row-meta">${daysLeft} school day${daysLeft === 1 ? "" : "s"}</span>
        </div>`;
    }).join("");
  }

  // Upcoming festivities / national days for the countries behind the taught
  // languages -- the department's replacement for "phrase of the day".
  function cultureListHtml(now) {
    const dated = cultureData
      .map((c) => ({ ...c, date: resolveCultureDate(c.date, now) }))
      .filter((c) => c.date >= now.dateStr)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, LIST_LIMIT);
    if (!dated.length) return `<div class="mcl-status">Add dates in mcl-culture.csv</div>`;
    const thisYear = now.dateStr.slice(0, 4);
    return dated.map((c) => {
      const name = c.language ? `${c.name} <span class="mcl-dim">· ${c.language}</span>` : c.name;
      if (c.date === now.dateStr) {
        return `
          <div class="mcl-row is-active">
            <span class="mcl-row-name">${name}</span>
            <span class="mcl-row-meta">🎉 Today!</span>
          </div>`;
      }
      const daysLeft = calendarDaysUntil(now, c.date);
      const when = c.date.slice(0, 4) === thisYear
        ? formatShortDate(c.date)
        : `${formatShortDate(c.date)}/${c.date.slice(2, 4)}`;
      return `
        <div class="mcl-row">
          <span class="mcl-row-name">${name}</span>
          <span class="mcl-row-meta">${when} — ${daysLeft} day${daysLeft === 1 ? "" : "s"}</span>
        </div>`;
    }).join("");
  }

  function birthdaysListHtml(now) {
    const upcoming = birthdaysData.filter((e) => e.date >= now.dateStr).slice(0, LIST_LIMIT);
    if (!upcoming.length) return `<div class="mcl-status">No more birthdays left this year</div>`;
    return upcoming.map((e) => {
      const nameHtml = e.isDept ? `<strong>${e.name}</strong>` : e.name;
      if (e.date === now.dateStr) {
        return `
          <div class="mcl-row is-active">
            <span class="mcl-row-name">${nameHtml}</span>
            <span class="mcl-row-meta">🎉🎂 Today!</span>
          </div>`;
      }
      const daysLeft = calendarDaysUntil(now, e.date);
      return `
        <div class="mcl-row">
          <span class="mcl-row-name">${nameHtml}</span>
          <span class="mcl-row-meta">${formatShortDate(e.date)} — ${daysLeft} day${daysLeft === 1 ? "" : "s"}</span>
        </div>`;
    }).join("");
  }

  // The next meeting of each cultural / affinity club. Clubs meet on a fixed
  // weekday, so "next meeting" is the next occurrence of that weekday (today
  // still counts until its start time passes).
  function nextClubMeeting(club, now) {
    if (club.dow < 0) return null;
    const todayDow = dowOfDate(now.dateStr);
    let delta = (club.dow - todayDow + 7) % 7;
    const startMin = hhmmToMinutes(club.time);
    if (delta === 0 && startMin != null && startMin <= now.minutes) delta = 7;
    return addDays(now.dateStr, delta);
  }

  function clubsListHtml(now) {
    if (!clubsData.length) return `<div class="mcl-status">Add clubs in mcl-clubs.csv</div>`;
    const rows = clubsData
      .map((c) => ({ ...c, next: nextClubMeeting(c, now) }))
      .sort((a, b) => {
        if (!a.next) return 1;
        if (!b.next) return -1;
        return a.next.localeCompare(b.next) || (hhmmToMinutes(a.time) - hhmmToMinutes(b.time));
      })
      .slice(0, 16); // clubs all recur weekly, so show the full roster
    return rows.map((c) => {
      const time = c.time ? formatHHMM12h(c.time) : "";
      const loc = c.location ? ` · ${c.location}` : "";
      if (!c.next) {
        return `
          <div class="mcl-row">
            <span class="mcl-row-name">${c.name}</span>
            <span class="mcl-row-meta">${c.weekdayRaw || "TBD"}${time ? " " + time : ""}${loc}</span>
          </div>`;
      }
      const daysOut = calendarDaysUntil(now, c.next);
      const dayLabel = daysOut === 0 ? "Today" : daysOut === 1 ? "Tomorrow" : DOW_ABBR[dowOfDate(c.next)];
      return `
        <div class="mcl-row${daysOut === 0 ? " is-active" : ""}">
          <span class="mcl-row-name">${c.name}</span>
          <span class="mcl-row-meta">${dayLabel}${time ? " " + time : ""}${loc}</span>
        </div>`;
    }).join("");
  }

  const ROTATE_MS = 8000;
  const FADE_MS = 250;
  let rotatorPages = [];
  let rotatorIndex = 0;
  let lastRotatorHtml = null;

  function computeRotatorPages(now) {
    const pages = [];
    if (cultureData.length) pages.push({ title: "Cultural Calendar", html: cultureListHtml(now) });
    pages.push({ title: "Upcoming Breaks", html: breaksListHtml(now) });
    if (birthdaysData.some((e) => e.date >= now.dateStr)) {
      pages.push({ title: "Upcoming Birthdays", html: birthdaysListHtml(now) });
    }
    if (clubsData.length) {
      pages.push({ title: "Cultural & Affinity Clubs", html: clubsListHtml(now) });
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
    if (rotatorPages.length <= 1) return;
    rotatorBodyEl.classList.add("is-fading");
    rotatorTitleEl.classList.add("is-fading");
    setTimeout(() => {
      rotatorIndex = (rotatorIndex + 1) % rotatorPages.length;
      lastRotatorHtml = null;
      renderRotator(nowInChicago());
      rotatorBodyEl.classList.remove("is-fading");
      rotatorTitleEl.classList.remove("is-fading");
    }, FADE_MS);
  }

  // ---- world map ----
  // The SVG (world-map.svg, vendored -- "Simple World Map" by Al MacDonald,
  // ed. Fritz Lekschas, CC BY-SA 3.0) has one <path id="xx"> per country,
  // xx = ISO 3166-1 alpha-2. We fetch it once and inject it inline so its
  // paths can be styled (shaded) and measured (for pin placement).
  //
  // The map rotates on its own self-scheduling timer between:
  //   - one "where <language> is spoken" page per row of mcl-map-languages.csv
  //     (countries shaded; held for MAP_SHADE_MS)
  //   - "Our exchange partners"  (mcl-map-places.csv rows with kind=partner)
  //   - "Where SLUH travels"     (mcl-map-places.csv rows with kind=trip)
  // The two pin pages show ONE place at a time -- a pulsing dot + its name --
  // stepping through up to PINS_PER_PASS of them, MAP_PIN_MS each.

  const MAP_SHADE_MS = 8000;
  const MAP_PIN_MS = 4200;
  const PINS_PER_PASS = 6;
  const MAP_ZOOM_SCALE = 3.6;    // how far in a featured pin zooms
  let mapSvg = null;             // the injected <svg> element
  let mapViewBox = null;         // { x, y, w, h } from the SVG
  let mapLanguages = [];
  let mapPlaces = [];
  let mapPages = [];
  let mapIndex = 0;
  let pinCursor = 0;             // which place within a pin page is showing
  let mapTimer = null;
  let shadedPaths = [];          // paths touched by a "spoken" page, to reset next time
  let featuredPaths = [];        // the featured pin's country, to reset next time
  let mapZoom = { scale: 1, dx: 0, dy: 0 }; // current zoomToPoint transform, for projecting other pins

  async function loadMapSvg() {
    try {
      // cache-bust, same reasoning as fetchCsv -- this is a plain static
      // file that gets replaced on disk from time to time (e.g. rebuilt by
      // scripts/build_world_map.py), and a stale cached copy would silently
      // linger past a version-poll reload since world-map.svg isn't part of
      // the ?v= cache-busted CSS/JS.
      const res = await fetch(`world-map.svg?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`world-map.svg fetch failed: ${res.status}`);
      mapSvgEl.innerHTML = await res.text();
      mapSvg = mapSvgEl.querySelector("svg");
      if (mapSvg) {
        mapSvg.removeAttribute("width");
        mapSvg.removeAttribute("height");
        const vb = (mapSvg.getAttribute("viewBox") || "0 0 1000 1000").split(/\s+/).map(Number);
        mapViewBox = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
      }
    } catch (e) {
      console.warn("map svg load failed:", e);
      mapSvgEl.innerHTML = `<div class="mcl-status">Map unavailable</div>`;
    }
    renderMap();
  }

  function computeMapPages() {
    const pages = mapLanguages.map((lang) => ({ type: "shade", lang }));
    const partners = mapPlaces.filter((p) => p.kind === "partner");
    const trips = mapPlaces.filter((p) => p.kind === "trip");
    if (partners.length) pages.push({ type: "pins", title: "Our exchange partners", places: partners });
    if (trips.length) pages.push({ type: "pins", title: "Where SLUH travels", places: trips });
    return pages;
  }

  // The SVG is rendered with preserveAspectRatio "meet", so it's letterboxed
  // inside the wrapper. This works out where the map actually sits so the pin
  // overlay (which fills the whole wrapper) can be lined up with it.
  function mapRenderRect() {
    const wrap = mapWrapEl.getBoundingClientRect();
    const vbAR = mapViewBox.w / mapViewBox.h;
    let w, h;
    if (wrap.width / wrap.height > vbAR) { h = wrap.height; w = h * vbAR; }
    else { w = wrap.width; h = w / vbAR; }
    return { offX: (wrap.width - w) / 2, offY: (wrap.height - h) / 2, w, h, wrapW: wrap.width, wrapH: wrap.height };
  }

  // viewBox coords -> percentage offsets within the map wrapper.
  function pctFromViewBox(x, y) {
    const r = mapRenderRect();
    const px = r.offX + ((x - mapViewBox.x) / mapViewBox.w) * r.w;
    const py = r.offY + ((y - mapViewBox.y) / mapViewBox.h) * r.h;
    return { left: (px / r.wrapW) * 100, top: (py / r.wrapH) * 100 };
  }

  // In world-map.svg a single-part country is a <path id="xx">; a multi-part
  // one is a <g id="xx"> of <path> pieces, with the main landmass marked
  // <path class="mainland">. Return the leaf <path> elements for a country
  // (for shading), and separately the "main" one (for placing a pin).
  function countryPaths(iso) {
    if (!mapSvg) return [];
    const el = mapSvg.querySelector(`[id="${iso}"]`);
    if (!el) return [];
    return el.tagName.toLowerCase() === "path" ? [el] : [...el.querySelectorAll("path")];
  }

  function mainPathOf(iso) {
    const parts = countryPaths(iso);
    if (parts.length <= 1) return parts[0] || null;
    const mainland = parts.find((p) => p.classList.contains("mainland"));
    if (mainland) return mainland;
    let best = parts[0], bestArea = -1;
    for (const p of parts) {
      let b; try { b = p.getBBox(); } catch (e) { continue; }
      const area = b.width * b.height;
      if (area > bestArea) { bestArea = area; best = p; }
    }
    return best;
  }

  // world-map.svg's build script (scripts/build_world_map.py) stamps every
  // country with data-lx/data-ly -- Natural Earth's own hand-curated "best
  // point for this country's label", projected the same way as the outline.
  // That's a real cartographic choice (the populated heartland), not a
  // geometric artifact, so it's used directly whenever present.
  function countryCenter(iso) {
    const el = mapSvg && mapSvg.querySelector(`[id="${iso}"]`);
    if (el) {
      const lx = el.getAttribute("data-lx"), ly = el.getAttribute("data-ly");
      if (lx != null && ly != null) return { x: parseFloat(lx), y: parseFloat(ly) };
    }
    // Fallback for a map without label points: sample points along the main
    // path's outline and take the median x and median y, which is at least
    // robust to a handful of far-flung-territory outliers (unlike a plain
    // bounding-box center, which those pull out into the ocean).
    const path = mainPathOf(iso);
    if (!path) return null;
    let len;
    try { len = path.getTotalLength(); } catch (e) { len = 0; }
    if (!len) {
      try { const b = path.getBBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
      catch (e) { return null; }
    }
    const N = 96, xs = [], ys = [];
    for (let i = 0; i < N; i++) {
      const pt = path.getPointAtLength((len * i) / N);
      xs.push(pt.x); ys.push(pt.y);
    }
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const median = (a) => (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2;
    return { x: median(xs), y: median(ys) };
  }

  function clearShading() {
    for (const p of shadedPaths) {
      p.classList.remove("is-shaded");
      p.style.fill = "";
    }
    shadedPaths = [];
  }

  function clearFeatured() {
    for (const p of featuredPaths) p.classList.remove("is-featured");
    featuredPaths = [];
  }

  // A country's outline-median center (see countryCenter), as a percentage
  // of the map panel -- this is what the zoom targets, so the zoomed-in view
  // is always centered on the actual highlighted shape.
  function countryCentroidPct(iso) {
    const center = countryCenter(iso);
    const vx = center ? center.x : mapViewBox.x + mapViewBox.w / 2;
    const vy = center ? center.y : mapViewBox.y + mapViewBox.h / 2;
    return pctFromViewBox(vx, vy);
  }

  // Where a place's pin actually sits -- the country's centroid, nudged by
  // the CSV's dx,dy toward the specific city. Deliberately a *separate*
  // point from the zoom target above: the zoom keeps the country itself
  // framed regardless of a place's nudge, and the dot/card render at this
  // point (via projectToScreenPct) wherever that lands within that view.
  function placePosition(place) {
    const pos = countryCentroidPct(place.country);
    return { left: pos.left + place.dx, top: pos.top + place.dy };
  }

  // Scales and re-centers the map layer (mapStageEl -- the SVG only, not the
  // pin overlay) on one point, given as a percentage of the (unscaled) map
  // panel -- so a featured pin reads clearly instead of being one speck on a
  // whole-world view. transform-origin stays at the top-left (0 0) so this is
  // a plain "solve for where point (px,py) lands at the panel's center":
  // new_point = scale*point + translate, set equal to (width/2, height/2).
  // mapZoom is kept around so projectToScreenPct can place the *other* pins
  // (which live in the separate, unscaled pin overlay) consistently with it.
  function zoomToPoint(leftPct, topPct, scale) {
    const wrap = mapWrapEl.getBoundingClientRect();
    if (!wrap.width || !wrap.height) return;
    const px = (leftPct / 100) * wrap.width;
    const py = (topPct / 100) * wrap.height;
    mapZoom = { scale, dx: wrap.width / 2 - scale * px, dy: wrap.height / 2 - scale * py };
    mapStageEl.style.transform = `translate(${mapZoom.dx}px, ${mapZoom.dy}px) scale(${scale})`;
  }

  function resetZoom() {
    mapZoom = { scale: 1, dx: 0, dy: 0 };
    mapStageEl.style.transform = "";
  }

  // Where a percentage-of-panel point ends up on screen once zoomToPoint has
  // scaled/panned the map -- used to place the dimmed "other places" dots (in
  // the unscaled pin overlay) so they track the zoomed map underneath it.
  function projectToScreenPct(leftPct, topPct) {
    const wrap = mapWrapEl.getBoundingClientRect();
    if (!wrap.width || !wrap.height) return { left: leftPct, top: topPct };
    const px = (leftPct / 100) * wrap.width;
    const py = (topPct / 100) * wrap.height;
    const sx = mapZoom.scale * px + mapZoom.dx;
    const sy = mapZoom.scale * py + mapZoom.dy;
    return { left: (sx / wrap.width) * 100, top: (sy / wrap.height) * 100 };
  }

  function renderMap() {
    if (!mapPages.length) mapPages = computeMapPages();
    if (!mapPages.length) return;
    if (mapIndex >= mapPages.length) mapIndex = 0;
    const page = mapPages[mapIndex];

    // the heading updates whether or not the SVG is ready
    mapTitleEl.textContent = page.type === "shade" ? `Where ${page.lang.language} is spoken` : page.title;
    mapSubEl.textContent = page.type === "shade" ? "" : page.sub;
    if (!mapSvg || !mapViewBox) return; // SVG not loaded yet (or failed to)

    if (page.type === "shade") {
      clearFeatured();
      resetZoom();
      mapPinsEl.innerHTML = "";
      clearShading();
      const lang = page.lang;
      let hit = 0;
      for (const iso of lang.countries) {
        const paths = countryPaths(iso);
        if (paths.length) hit += 1;
        for (const p of paths) {
          p.classList.add("is-shaded");
          if (lang.color) p.style.fill = lang.color;
          shadedPaths.push(p);
        }
      }
      mapSubEl.textContent = `${lang.flag ? lang.flag + " " : ""}${hit} countr${hit === 1 ? "y" : "ies"}/regions`;
      mapLegendEl.innerHTML = hit
        ? `<span class="mcl-legend-swatch" style="background:${lang.color || "var(--accent)"}"></span> ${lang.flag ? lang.flag + " " : ""}${lang.language}`
        : "";
    } else {
      clearShading();
      renderMapPin(page);
    }
  }

  // one place at a time: the map zooms in on it, its country gets a light
  // highlight, and a pulsing dot carries its name. The rest of the current
  // page's places (and the other kind's) still show as plain dots, dimmed,
  // so the department's fuller reach is visible even while one is featured.
  // The map page steps through up to PINS_PER_PASS of page.places on the map
  // timer; pinCursor says which one is currently featured.
  function renderMapPin(page) {
    const shown = Math.min(page.places.length, PINS_PER_PASS);
    if (pinCursor >= shown) pinCursor = 0;
    const place = page.places[pinCursor];
    mapSubEl.textContent = `${pinCursor + 1} / ${shown}`;

    // zoom onto the country's own centroid -- not the nudged pin position --
    // so the highlighted shape is always what ends up framed/centered, even
    // for a place whose dx,dy nudges its dot off toward a particular city.
    const zoomTarget = countryCentroidPct(place.country);
    zoomToPoint(zoomTarget.left, zoomTarget.top, MAP_ZOOM_SCALE);

    clearFeatured();
    for (const p of countryPaths(place.country)) {
      p.classList.add("is-featured");
      featuredPaths.push(p);
    }

    // every place's dot (including the featured one) is placed the same
    // way: its own position, projected through the zoom just set above --
    // so the featured dot and the highlighted country always agree.
    mapPinsEl.innerHTML = "";
    for (const other of mapPlaces) {
      if (other === place) continue;
      const proj = projectToScreenPct(placePosition(other).left, placePosition(other).top);
      if (proj.left < -8 || proj.left > 108 || proj.top < -8 || proj.top > 108) continue; // off-screen once zoomed
      const dot = document.createElement("div");
      dot.className = "mcl-dot-context";
      dot.style.left = proj.left + "%";
      dot.style.top = proj.top + "%";
      mapPinsEl.appendChild(dot);
    }

    const featuredProj = projectToScreenPct(placePosition(place).left, placePosition(place).top);
    const pin = document.createElement("div");
    pin.className = `mcl-pin-pulse mcl-pin-${place.kind}`;
    pin.style.left = featuredProj.left + "%";
    pin.style.top = featuredProj.top + "%";
    pin.innerHTML = `
      <span class="mcl-pulse-ring"></span>
      <span class="mcl-pulse-dot"></span>
      <span class="mcl-pin-card">${place.label}${place.detail ? `<span class="mcl-pin-card-sub">${place.detail}</span>` : ""}</span>`;
    mapPinsEl.appendChild(pin);

    // small pager dots below the map
    mapLegendEl.innerHTML = Array.from({ length: shown }, (_, i) =>
      `<span class="mcl-pager-dot${i === pinCursor ? " is-on" : ""}"></span>`).join("");
  }

  // ---- map self-scheduling rotation ----

  function scheduleMapTick() {
    clearTimeout(mapTimer);
    if (!mapPages.length) return;
    const dwell = mapPages[mapIndex].type === "pins" ? MAP_PIN_MS : MAP_SHADE_MS;
    mapTimer = setTimeout(mapTick, dwell);
  }

  function mapTick() {
    const page = mapPages[mapIndex];
    const shown = page.type === "pins" ? Math.min(page.places.length, PINS_PER_PASS) : 0;

    if (page.type === "pins" && pinCursor + 1 < shown) {
      // step to the next place on this page -- fade the whole map (not just
      // the pin overlay) out first, so the zoom/pan snap and the country
      // highlight change happen while hidden. Nothing should ever be seen
      // moving; the fade is the only visible transition.
      pinCursor += 1;
      mapWrapEl.classList.add("is-fading");
      mapSubEl.classList.add("is-fading");
      mapLegendEl.classList.add("is-fading");
      setTimeout(() => {
        renderMapPin(page);
        mapWrapEl.classList.remove("is-fading");
        mapSubEl.classList.remove("is-fading");
        mapLegendEl.classList.remove("is-fading");
        scheduleMapTick();
      }, FADE_MS);
    } else {
      // move to the next page -- same idea, plus the title (which doesn't
      // change on a same-page pin step, so it's left alone there)
      if (mapPages.length > 1) {
        mapWrapEl.classList.add("is-fading");
        mapTitleEl.classList.add("is-fading");
        mapSubEl.classList.add("is-fading");
      }
      setTimeout(() => {
        mapIndex = (mapIndex + 1) % mapPages.length;
        pinCursor = 0;
        renderMap();
        mapWrapEl.classList.remove("is-fading");
        mapTitleEl.classList.remove("is-fading");
        mapSubEl.classList.remove("is-fading");
        scheduleMapTick();
      }, FADE_MS);
    }
  }

  // ---- fetch loops ----

  async function refreshTeachers() {
    try { teachersData = parseTeachersCsv(await fetchCsv("mcl-teachers.csv")); }
    catch (e) { teachersData = []; }
  }
  async function refreshBreaks() {
    try { breakNameOverrides = parseBreaksCsv(await fetchCsv("mcl-breaks.csv")); }
    catch (e) { breakNameOverrides = new Map(); }
  }
  async function refreshCultureData() {
    try { cultureData = parseCultureCsv(await fetchCsv("mcl-culture.csv")); }
    catch (e) { cultureData = []; }
  }
  async function refreshBirthdays() {
    try { birthdaysData = parseBirthdaysCsv(await fetchCsv("mcl-birthdays.csv")); }
    catch (e) { birthdaysData = []; }
  }
  async function refreshClubs() {
    try { clubsData = parseClubsCsv(await fetchCsv("mcl-clubs.csv")); }
    catch (e) { clubsData = []; }
  }
  async function refreshCities() {
    try { citiesData = parseCitiesCsv(await fetchCsv("mcl-cities.csv")); }
    catch (e) { citiesData = []; }
  }
  async function refreshMapData() {
    try { mapLanguages = parseMapLanguagesCsv(await fetchCsv("mcl-map-languages.csv")); }
    catch (e) { mapLanguages = []; }
    try { mapPlaces = parseMapPlacesCsv(await fetchCsv("mcl-map-places.csv")); }
    catch (e) { mapPlaces = []; }
    mapPages = computeMapPages();
    if (mapIndex >= mapPages.length) { mapIndex = 0; pinCursor = 0; }
    renderMap();
  }

  function everyThirtyMin(fn) {
    fn();
    setInterval(fn, CSV_REFRESH_MS);
  }

  // ---- render tick ----

  function render() {
    const now = nowInChicago();
    clockEl.textContent = formatClock12h(now);
    dateEl.textContent = formatFullDate(now.dateStr);
    checkPeriodCompletion(now);
    renderDaily(now);
    renderTeachers(now);
    renderRotator(now);
  }

  everyThirtyMin(refreshTeachers);
  everyThirtyMin(refreshBreaks);
  everyThirtyMin(refreshCultureData);
  everyThirtyMin(refreshBirthdays);
  everyThirtyMin(refreshClubs);

  // cities must load before the first weather fetch builds its city list
  refreshCities().then(fetchWeather);
  setInterval(refreshCities, CSV_REFRESH_MS);

  // map: load its data, then the SVG (which calls renderMap), then start the
  // map's own self-scheduling rotation.
  refreshMapData().then(loadMapSvg).then(scheduleMapTick);
  setInterval(refreshMapData, CSV_REFRESH_MS);

  watchForNewVersion();
  render();
  setInterval(render, REFRESH_MS);
  setInterval(rotateToNextPage, ROTATE_MS);
  setInterval(rotateGreeting, 3500);
}

main();
