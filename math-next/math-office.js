// =============================================================================
// math-next/math-office.js -- the "Desmos" redesign of the math-office wall
// display (design I from math-next/designs/). The live TV still runs /math/.
//
// What's on screen:
//   Left, an expression list: a slider for t = now, f(t) (how far through
//   the current block) and g(t) (how far through the whole day), the
//   countdown, today's blocks as a table, who's in which room, and weather.
//   Right, graph paper: every block today is a ramp from 0 to 1 (so the day
//   is a sawtooth), the whole day is one animated SLUH Navy line, and under
//   it the next 18 days are a number line with school events above and math
//   birthdays below.
//
// Standalone: it reads the same data.js the main site uses but shares no
// code with app.js. The date/schedule/CSV helpers in sections 2-4 are carried
// over unchanged from the previous math-next version (kept in
// designs/v1-columns/), which mirror app.js.
//
// Big picture, top to bottom:
//   1. Config + the version.txt watcher (reloads the TV after a deploy).
//   2. Date and time helpers, including the ?at= preview override.
//   3. Schedule helpers: lunch waves, today's "segments" (periods + blocks).
//   4. CSV parsers (teachers, birthdays, school events) and weather config.
//   5. Colors and the stage scaler.
//   6. main(): fetch loops, then render() once a second. The graph's
//      static layer (axes, finished/upcoming ramps, number line) is rebuilt
//      only when something about it changes; the moving parts (now line,
//      points, the live ramp) are updated every tick, and the animated day
//      line is updated in place so its CSS animation never restarts.
// =============================================================================

const TIME_ZONE = "America/Chicago";
const REFRESH_MS = 1000;
const COUNTDOWN_START_MINUTES = 7 * 60 + 30; // no "next" countdown before 7:30am

// ---- 1. remote reload (kiosk support) ----
// Runs unattended on a wall display, so it watches version.txt (bumped by
// deploy.sh) and reloads itself within a minute of a new deploy.
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
    return; // no version.txt (or unreachable) -- nothing to watch against
  }
  setInterval(async () => {
    try {
      if ((await fetchVersion()) !== initialVersion) location.reload();
    } catch (e) {
      // transient failure: just try again next interval
    }
  }, VERSION_CHECK_MS);
}

// ---- 2. date helpers ----

function parseDate(yyyymmdd) {
  return { y: +yyyymmdd.slice(0, 4), m: +yyyymmdd.slice(4, 6), d: +yyyymmdd.slice(6, 8) };
}

// "20261110" plus n calendar days -> "20261112"
function addDays(yyyymmdd, n) {
  const { y, m, d } = parseDate(yyyymmdd);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10).replace(/-/g, "");
}

function weekdayIndex(yyyymmdd) {          // 0 = Sunday
  const { y, m, d } = parseDate(yyyymmdd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Preview override: ?at=20261110T1040 (YYYYMMDDTHHMM, Chicago time) shows the
// display as it would look at that moment, with the clock running on from there.
const PREVIEW_OFFSET_MS = (() => {
  const m = /[?&]at=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(location.search);
  if (!m) return 0;
  const [, y, mo, d, h, mi] = m.map(Number);
  // Chicago wall-clock -> a real instant: guess UTC, then correct by the
  // zone offset Chicago had at that guess (DST-safe for any normal time).
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const asChicago = new Date(new Date(guess).toLocaleString("en-US", { timeZone: TIME_ZONE }));
  const asUTC = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" }));
  return guess + (asUTC - asChicago) - Date.now();
})();

function nowInChicago() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(Date.now() + PREVIEW_OFFSET_MS));
  const get = (t) => parts.find((p) => p.type === t).value;
  let hour = +get("hour");
  if (hour === 24) hour = 0;
  return {
    dateStr: `${get("year")}${get("month")}${get("day")}`,
    minutes: hour * 60 + +get("minute"),
    seconds: +get("second"),
  };
}

// AP-style month abbreviations ("Nov. 10", but "May 4", "June 2")
const AP_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

// "Tuesday, Nov. 10"
function formatHeaderDate(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  const weekday = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return `${weekday}, ${AP_MONTHS[m - 1]} ${d}`;
}

// "8:25" -- 12-hour, no a.m./p.m. (it's always a school day on this screen)
function clock12(minutes) {
  const h = Math.floor(minutes / 60) % 12 || 12;
  return `${h}:${String(Math.floor(minutes % 60)).padStart(2, "0")}`;
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

// A percent meant for human eyes, NEVER rounded up: Math.round() would turn
// 99.7% into "100%" and announce a block is over while it's still running.
// Genuinely finished work arrives as exactly 100 (progress returns exactly 1).
function displayPct(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  if (clamped >= 100 - 1e-9) return 100;
  return Math.floor(clamped);
}

// The same rule for a 0..1 value shown with two decimals ("0.10").
function displayFraction(v) {
  return (displayPct(v * 100) / 100).toFixed(2);
}

// ---- 3. schedule helpers ----

function resolvePeriodTimes(period, wave) {
  if (wave === "jrsr" && period.jrsrStartMinutes != null) {
    return { startMinutes: period.jrsrStartMinutes, endMinutes: period.jrsrEndMinutes };
  }
  return { startMinutes: period.startMinutes, endMinutes: period.endMinutes };
}

function isPeriodLive(day, period, now, wave) {
  if (day.date !== now.dateStr) return false;
  const { startMinutes, endMinutes } = resolvePeriodTimes(period, wave);
  return now.minutes >= startMinutes && now.minutes < endMinutes;
}

// which lunch wave of a split period is live right now (Fr/So first)
function liveWaveOf(day, period, now) {
  if (isPeriodLive(day, period, now, "frso")) return "frso";
  if (period.jrsrStartMinutes != null && isPeriodLive(day, period, now, "jrsr")) return "jrsr";
  return null;
}

function effectiveWave(day, period, now) {
  return liveWaveOf(day, period, now) || "frso";
}

// Today's schedule as one time-ordered list of "segments":
//   { key, kind: "period" | "block", label, title, short, start, end }
// (minutes after midnight). A period split by lunch wave becomes two
// segments, Fr/So and Jr/Sr, since their windows overlap. Blocks (Studium,
// Advisory, Activity Period...) come from data.js's per-day "blocks".
function daySegments(day) {
  if (!day) return [];
  const segments = [];
  for (const p of day.periods) {
    if (p.jrsrStartMinutes != null) {
      segments.push({ key: `${p.label}:frso`, kind: "period", label: p.label, title: `Period ${p.label} (Fr/So)`, short: `${p.label} Fr/So`, start: p.startMinutes, end: p.endMinutes });
      segments.push({ key: `${p.label}:jrsr`, kind: "period", label: p.label, title: `Period ${p.label} (Jr/Sr)`, short: `${p.label} Jr/Sr`, start: p.jrsrStartMinutes, end: p.jrsrEndMinutes });
    } else {
      segments.push({ key: p.label, kind: "period", label: p.label, title: `Period ${p.label}`, short: p.label, start: p.startMinutes, end: p.endMinutes });
    }
  }
  for (const b of day.blocks || []) {
    // "Advisory Period" reads better on the wall as just "Advisory"
    const title = b.name.replace(/^Advisory Period$/, "Advisory");
    segments.push({ key: `block:${b.name}:${b.startMinutes}`, kind: "block", label: b.name, title, short: title, start: b.startMinutes, end: b.endMinutes });
  }
  return segments.sort((a, b) => a.start - b.start);
}

function segmentIsLive(seg, now) {
  return now.minutes >= seg.start && now.minutes < seg.end;
}

// 0..1, by the second, so things move smoothly
function segmentProgress(seg, now) {
  const nowSec = now.minutes * 60 + now.seconds;
  if (nowSec <= seg.start * 60) return 0;
  if (nowSec >= seg.end * 60) return 1;
  return (nowSec - seg.start * 60) / ((seg.end - seg.start) * 60);
}

// ---- 4. CSV data ----

const TEACHERS_CSV_URL = "math-teachers.csv";
const BIRTHDAYS_CSV_URL = "../data/birthdays.csv";
const EVENTS_CSV_URL = "../data/school-events.csv";
const DATA_REFRESH_MS = 30 * 60 * 1000;

// Data rows of a hand-edited CSV: drops blank lines, "#" comments, and the header.
function csvRows(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines.slice(1);
}

// math-teachers.csv: name,period,room -- one row per teacher per period
function parseTeachersCsv(text) {
  const byName = new Map();
  for (const line of csvRows(text)) {
    const [name, period, room] = line.split(",").map((s) => s.trim());
    if (!name || !period) continue;
    if (!byName.has(name)) byName.set(name, { name, periods: [], rooms: {} });
    const t = byName.get(name);
    t.periods.push(period);
    t.rooms[period] = room;
  }
  return [...byName.values()];
}

// birthdays.csv (shared): date,name,dept -- this display only shows dept "math"
function parseBirthdaysCsv(text) {
  const birthdays = [];
  for (const line of csvRows(text)) {
    const [date, name, dept] = line.split(",").map((s) => (s || "").trim());
    if (date && name && dept === "math") birthdays.push({ date, name });
  }
  return birthdays.sort((a, b) => a.date.localeCompare(b.date));
}

// One CSV line into cells, honoring "double quotes" (event names contain commas).
function splitCsvLine(line) {
  const cells = [];
  let cell = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { cells.push(cell); cell = ""; }
    else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

// school-events.csv (generated by scripts/school_events.py): date,end_date,time,name
function parseEventsCsv(text) {
  const events = [];
  for (const line of csvRows(text)) {
    const [date, endDate, time, name] = splitCsvLine(line);
    if (date && name) events.push({ date, endDate: endDate || date, time: time || "", name });
  }
  return events.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// ---- weather (Open-Meteo: free, no API key), hardcoded to SLUH ----
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast?latitude=38.6274&longitude=-90.2688" +
  "&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min" +
  "&temperature_unit=fahrenheit&timezone=America%2FChicago&forecast_days=1";
const WEATHER_REFRESH_MS = 30 * 60 * 1000;
const WEATHER_RETRY_MS = 2 * 60 * 1000; // after a failure, try again sooner

function weatherLabel(code) {
  const labels = {
    0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "foggy",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "rain showers", 81: "rain showers", 82: "heavy showers", 85: "snow showers", 86: "snow showers",
    95: "thunderstorms", 96: "thunderstorms", 99: "thunderstorms",
  };
  return labels[code] || "";
}

// ---- 5. colors + stage ----

// One Desmos-style color per period letter, so a period looks the same every
// day and nothing is ever drawn gray. Blue is kept out of the letters on
// purpose: it belongs to the navy day line and the whole-school blocks
// (Studium, Advisory, Activity Period...), which share one lighter sky blue.
const PERIOD_COLORS = {
  A: "#c74440", B: "#fa7e19", C: "#388c46", D: "#6042a6",
  E: "#0f9d9a", F: "#d6336c", G: "#c99a06",
};
const BLOCK_COLOR = "#3a9ad9";
const NAVY = "#003366";
const EVENT_COLOR = "#005588";
const BIRTHDAY_COLOR = "#d6336c";

function segColor(seg) {
  return seg.kind === "block" ? BLOCK_COLOR : (PERIOD_COLORS[seg.label] || BLOCK_COLOR);
}

// The page is one 1920x1080 stage, scaled to fit the window and centered.
function fitStage() {
  const stage = document.getElementById("mo-stage");
  const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
  const left = (innerWidth - 1920 * scale) / 2, top = (innerHeight - 1080 * scale) / 2;
  stage.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
}

// ---- SVG helpers ----
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(parent, tag, attrs, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  parent.appendChild(e);
  return e;
}

// Desmos-style label: text on a white rounded pill. Returns {g, box}.
function pillLabel(parent, x, y, text, color, anchor = "middle") {
  const g = svgEl(parent, "g", {});
  const rect = svgEl(g, "rect", { class: "mo-plabel-box", rx: 8 });
  const t = svgEl(g, "text", { x, y, "text-anchor": anchor, "dominant-baseline": "central", class: "mo-plabel", fill: color }, text);
  const b = t.getBBox();
  rect.setAttribute("x", b.x - 10);
  rect.setAttribute("y", b.y - 5);
  rect.setAttribute("width", b.width + 20);
  rect.setAttribute("height", b.height + 10);
  return { g, box: { x: b.x - 10, w: b.width + 20 } };
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }

// ---- 6. main ----

function main() {
  fitStage();
  addEventListener("resize", fitStage);

  const daysByDate = new Map(SCHOOL_YEAR_DATA.map((d) => [d.date, d]));
  const $ = (id) => document.getElementById(id);
  const svg = $("mo-plot");

  // graph geometry, in the SVG's 1320x1080 units
  const X0 = 110, X1 = 1250;          // left/right edge of both plots
  const Y0 = 590, YTOP = 300;         // y for f = 0 and f = 1
  const LY = 900;                      // the number line
  const DAYS_AHEAD = 18;

  let teachersData = [], birthdaysData = [], eventsData = [], weatherData = null;
  let dataVersion = 0;                 // bumped when any CSV reloads

  // ---------- data fetching (cache-busted: static files edited on disk) ----------
  async function fetchCsv(url, parse, fallback) {
    try {
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`${url} fetch failed: ${res.status}`);
      return parse(await res.text());
    } catch (e) {
      console.warn(e);
      return fallback;
    }
  }
  async function reloadData() {
    [teachersData, birthdaysData, eventsData] = await Promise.all([
      fetchCsv(TEACHERS_CSV_URL, parseTeachersCsv, teachersData),
      fetchCsv(BIRTHDAYS_CSV_URL, parseBirthdaysCsv, birthdaysData),
      fetchCsv(EVENTS_CSV_URL, parseEventsCsv, eventsData),
    ]);
    dataVersion += 1;
  }

  let weatherTimer = null;
  async function fetchWeather() {
    let ok = false;
    try {
      const res = await fetch(WEATHER_URL);
      if (!res.ok) throw new Error(`weather fetch failed: ${res.status}`);
      weatherData = await res.json();
      ok = true;
    } catch (e) {
      console.warn("weather fetch failed, retrying soon:", e);
      weatherData = null;
    }
    renderWeather();
    clearTimeout(weatherTimer);
    weatherTimer = setTimeout(fetchWeather, ok ? WEATHER_REFRESH_MS : WEATHER_RETRY_MS);
  }

  function renderWeather() {
    const el = $("mo-weather");
    if (!weatherData) { el.textContent = "Weather unavailable"; return; }
    const cur = weatherData.current, daily = weatherData.daily;
    el.innerHTML = `<b>${Math.round(cur.temperature_2m)}°</b> and ${weatherLabel(cur.weather_code) || "—"} now · ` +
      `high <b>${Math.round(daily.temperature_2m_max[0])}°</b>, low ${Math.round(daily.temperature_2m_min[0])}°`;
  }

  // ---------- what the countdown follows ----------
  //   current -- something is live (the first live one in time order)
  //   next    -- nothing live: count down to the next thing to start
  //   too-early / done / no-school
  function currentOrNext(segments, now) {
    if (!segments.length) return { state: "no-school" };
    const live = segments.find((s) => segmentIsLive(s, now));
    if (live) return { state: "current", seg: live };
    if (now.minutes < COUNTDOWN_START_MINUTES) return { state: "too-early", seg: segments[0] };
    const upcoming = segments.find((s) => s.start > now.minutes);
    if (upcoming) return { state: "next", seg: upcoming };
    return { state: "done" };
  }

  // ---------- confetti, once per block, the moment it finishes ----------
  const CONFETTI_COLORS = ["#003366", "#88ccec", ...Object.values(PERIOD_COLORS)];
  function fireConfetti() {
    const box = document.createElement("div");
    box.className = "mo-confetti-burst";
    for (let i = 0; i < 60; i++) {
      const p = document.createElement("div");
      p.className = "mo-confetti-piece";
      p.style.left = Math.random() * 100 + "vw";
      p.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
      p.style.animationDelay = Math.random() * 0.4 + "s";
      p.style.animationDuration = 2 + Math.random() * 1.5 + "s";
      p.style.setProperty("--rot", Math.random() * 360 + "deg");
      p.style.setProperty("--drift", Math.random() * 200 - 100 + "px");
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 4000);
  }
  let lastLiveKeys = new Set();
  function checkCompletion(segments, now) {
    const liveKeys = new Set(segments.filter((s) => segmentIsLive(s, now)).map((s) => `${now.dateStr}|${s.key}`));
    for (const k of lastLiveKeys) if (!liveKeys.has(k)) fireConfetti();
    lastLiveKeys = liveKeys;
  }

  // ---------- left column ----------

  function renderExpressions(segments, info, now) {
    const nowSec = now.minutes * 60 + now.seconds;
    const hasDay = segments.length > 0;
    for (const id of ["mo-slider-row", "mo-f-row", "mo-g-row"]) $(id).hidden = !hasDay;
    if (!hasDay) { $("mo-count-row").hidden = true; return; }

    const dayStart = segments[0].start, dayEnd = Math.max(...segments.map((s) => s.end));
    const dayLen = dayEnd - dayStart;
    const g = Math.max(0, Math.min(1, (nowSec / 60 - dayStart) / dayLen));

    // 1: the slider
    const sliderPct = displayPct(g * 100);
    $("mo-t").textContent = clock12(now.minutes);
    $("mo-t-fill").style.width = sliderPct + "%";
    $("mo-t-dot").style.left = sliderPct + "%";
    $("mo-t-min").textContent = clock12(dayStart);
    $("mo-t-max").textContent = clock12(dayEnd);

    // 2: f(t), the live block's progress
    if (info.state === "current") {
      $("mo-f-label").textContent = `${info.seg.short} progress`;
      $("mo-f").textContent = displayFraction(segmentProgress(info.seg, now));
      $("mo-f-swatch").style.background = segColor(info.seg);
    } else {
      $("mo-f-label").textContent = "block progress";
      $("mo-f").textContent = "—";
      $("mo-f-swatch").style.background = "";
    }

    // 3: g(t), the whole day
    $("mo-g-expr").textContent = `(t − ${clock12(dayStart)}) / ${dayLen}`;
    $("mo-g").textContent = displayFraction(g);

    // 4: the countdown as an expression
    const row = $("mo-count-row");
    if (info.state === "current" || info.state === "next") {
      const target = info.state === "current" ? info.seg.end : info.seg.start;
      $("mo-count-expr").innerHTML = `${clock12(target)} − <i>t</i>`;
      $("mo-count-res").textContent = formatCountdownClock(target * 60000 - nowSec * 1000);
      row.hidden = false;
    } else {
      row.hidden = true;
    }
  }

  // today's blocks table (rebuilt only when a row's state changes)
  let lastBlocksKey = null;
  function renderBlocksTable(segments, now) {
    const states = segments.map((s) => (segmentIsLive(s, now) ? "live" : now.minutes >= s.end ? "done" : "todo"));
    const key = `${now.dateStr}|${segments.map((s) => s.key).join(",")}|${states.join(",")}`;
    if (key === lastBlocksKey) return;
    lastBlocksKey = key;
    const table = $("mo-blocks");
    if (!segments.length) {
      table.innerHTML = `<tr><td>No classes today</td></tr>`;
      return;
    }
    table.innerHTML = `<tr><th>block</th><th><i>a</i> (start)</th><th><i>b</i> (end)</th></tr>` +
      segments.map((s, i) => `
        <tr class="is-${states[i]}" style="color:${segColor(s)}">
          <td>${s.short}</td><td>${clock12(s.start)}</td><td>${clock12(s.end)}</td>
        </tr>`).join("");
  }

  // Who's where: today's class periods plus any block teachers have their
  // own locations for (Studium, from math-teachers.csv). Other blocks are
  // skipped, so during Advisory the list shows who teaches next.
  function teacherSlots(today, now) {
    if (!today) return [];
    const slots = today.periods.map((p) => {
      const { startMinutes, endMinutes } = resolvePeriodTimes(p, effectiveWave(today, p, now));
      return { key: p.label, title: `Period ${p.label}`, start: startMinutes, end: endMinutes };
    });
    for (const b of today.blocks || []) {
      if (teachersData.some((t) => t.periods.includes(b.name))) {
        slots.push({ key: b.name, title: b.name, start: b.startMinutes, end: b.endMinutes });
      }
    }
    return slots.sort((a, b) => a.start - b.start);
  }

  // Last names fit the narrow column; a shared last name gets a first initial.
  function shortNames(teachers) {
    const lastOf = (n) => n.split(" ").slice(-1)[0];
    const counts = {};
    teachers.forEach((t) => { counts[lastOf(t.name)] = (counts[lastOf(t.name)] || 0) + 1; });
    return teachers.map((t) => (counts[lastOf(t.name)] > 1 ? `${t.name[0]}. ${lastOf(t.name)}` : lastOf(t.name)));
  }

  let lastRoomsKey = null;
  function renderRooms(now) {
    const today = daysByDate.get(now.dateStr);
    const slots = teacherSlots(today, now);
    const info = currentOrNext(slots, now);
    const key = `${now.dateStr}|${info.state}|${info.seg ? info.seg.key : ""}|${dataVersion}`;
    if (key === lastRoomsKey) return;
    lastRoomsKey = key;

    const title = $("mo-rooms-title"), table = $("mo-rooms");
    const hide = !slots.length || info.state === "no-school";
    title.hidden = table.parentElement.hidden = hide;
    if (hide) return;
    if (info.state === "done") {
      title.textContent = "Rooms";
      table.innerHTML = `<tr><td class="mo-empty">All classes are done for today</td></tr>`;
      return;
    }
    const slot = info.seg;
    const when = info.state === "current" ? "now" : "next";
    title.textContent = slot.key === "Studium" ? `Studium locations · ${when}` : `${slot.title} rooms · ${when}`;
    const here = teachersData.filter((t) => t.periods.includes(slot.key));
    if (!here.length) {
      table.innerHTML = `<tr><td class="mo-empty">No one scheduled</td></tr>`;
      return;
    }
    const names = shortNames(here);
    let rows = "";
    for (let i = 0; i < here.length; i += 2) {
      const cell = (j) => (here[j] ? `<td>${names[j]}</td><td>${here[j].rooms[slot.key] || ""}</td>` : `<td></td><td></td>`);
      rows += `<tr>${cell(i)}${cell(i + 1)}</tr>`;
    }
    table.innerHTML = rows;
  }

  // ---------- the countdown, top-right of the paper ----------
  function renderCountdown(info, now) {
    const label = $("mo-countdown-label"), clock = $("mo-countdown-clock");
    const nowMs = (now.minutes * 60 + now.seconds) * 1000;
    clock.hidden = false;
    if (info.state === "current") {
      label.innerHTML = `left in <strong>${info.seg.title}</strong>`;
      clock.textContent = formatCountdownClock(info.seg.end * 60000 - nowMs);
    } else if (info.state === "next") {
      label.innerHTML = `until <strong>${info.seg.title}</strong>`;
      clock.textContent = formatCountdownClock(info.seg.start * 60000 - nowMs);
    } else {
      // nothing to count down: the graph area shows a short message instead
      label.innerHTML = "";
      clock.hidden = true;
    }
  }

  // ---------- the graph ----------
  // Layers, back to front: static (rebuilt on change), the animated day
  // line (built once per day, updated in place), dynamic (every tick).
  const staticLayer = svgEl(svg, "g", {});
  const lineLayer = svgEl(svg, "g", {});
  const dynLayer = svgEl(svg, "g", {});
  let line = null;                       // { done, comet, rest, pulse, dot } for the day line
  let lastStaticKey = null, lastLineKey = null;
  let xOf = null, yOf = (v) => Y0 - v * (Y0 - YTOP);

  function renderGraph(segments, now) {
    const states = segments.map((s) => (segmentIsLive(s, now) ? "live" : now.minutes >= s.end ? "done" : "todo"));
    const staticKey = `${now.dateStr}|${segments.map((s) => s.key).join(",")}|${states.join(",")}|${dataVersion}`;
    if (staticKey !== lastStaticKey) {
      lastStaticKey = staticKey;
      drawStatic(segments, states, now);
    }
    drawDayLine(segments, now);
    drawDynamic(segments, now);
  }

  function drawStatic(segments, states, now) {
    staticLayer.innerHTML = "";
    drawNumberLine(now);
    if (!segments.length) {
      xOf = null;
      svgEl(staticLayer, "text", { x: 660, y: 420, "text-anchor": "middle", class: "mo-big-message" }, "No classes today");
      return;
    }

    // x range: whole hours around the school day
    const T0 = Math.floor((segments[0].start - 10) / 60) * 60;
    const T1 = Math.ceil((Math.max(...segments.map((s) => s.end)) + 10) / 60) * 60;
    xOf = (min) => X0 + (min - T0) / (T1 - T0) * (X1 - X0);

    // axes
    svgEl(staticLayer, "line", { x1: X0, y1: Y0, x2: X1, y2: Y0, stroke: "#1e2a3a", "stroke-width": 2.5 });
    svgEl(staticLayer, "line", { x1: X0, y1: Y0, x2: X0, y2: YTOP - 30, stroke: "#1e2a3a", "stroke-width": 2.5 });
    [0, 0.5, 1].forEach((v) => svgEl(staticLayer, "text", { x: X0 - 14, y: yOf(v), "text-anchor": "end", "dominant-baseline": "central", class: "mo-axis-label" }, v));
    for (let m = T0; m <= T1; m += 60) {
      svgEl(staticLayer, "line", { x1: xOf(m), y1: Y0 - 6, x2: xOf(m), y2: Y0 + 6, stroke: "#1e2a3a", "stroke-width": 2 });
      svgEl(staticLayer, "text", { x: xOf(m), y: Y0 + 34, "text-anchor": "middle", class: "mo-axis-label" }, clock12(m));
    }
    svgEl(staticLayer, "text", { x: X1 + 10, y: Y0 + 8, class: "mo-axis-label", "font-style": "italic", "font-size": 30 }, "t");

    // ramps for finished and upcoming blocks (the live one is dynamic)
    let lastLabelEnd = -Infinity, raise = 0;
    segments.forEach((s, i) => {
      const color = segColor(s);
      if (states[i] === "done") {
        svgEl(staticLayer, "line", { x1: xOf(s.start), y1: yOf(0), x2: xOf(s.end), y2: yOf(1), stroke: color, "stroke-width": 5, "stroke-linecap": "round" });
      } else if (states[i] === "todo") {
        svgEl(staticLayer, "line", { x1: xOf(s.start), y1: yOf(0), x2: xOf(s.end), y2: yOf(1), stroke: color, "stroke-width": 4, opacity: 0.5 });
      }
      svgEl(staticLayer, "circle", { cx: xOf(s.start), cy: yOf(0), r: 7, fill: color });                            // closed start
      svgEl(staticLayer, "circle", { cx: xOf(s.end), cy: yOf(1), r: 7, fill: "#fff", stroke: color, "stroke-width": 3 }); // open end
      // label over the open end; raise it when it would collide with the previous one
      const lx = xOf(s.end);
      raise = lx - lastLabelEnd < 70 ? raise + 30 : 0;
      svgEl(staticLayer, "text", { x: lx, y: yOf(1) - 22 - raise, "text-anchor": "middle", class: "mo-seg-label", fill: color }, s.short);
      lastLabelEnd = lx;
    });
  }

  // The day line g(t): built once per day, then only its geometry changes,
  // so the CSS animations (comet, marching dashes, pulse) never restart.
  function drawDayLine(segments, now) {
    const lineKey = `${now.dateStr}|${segments.length}`;
    if (lineKey !== lastLineKey) {
      lastLineKey = lineKey;
      lineLayer.innerHTML = "";
      line = null;
      if (!segments.length) return;
      line = {
        rest: svgEl(lineLayer, "path", { class: "mo-gline-rest" }),
        done: svgEl(lineLayer, "path", { class: "mo-gline-done" }),
        comet: svgEl(lineLayer, "path", { class: "mo-gline-comet", pathLength: 1 }),
        pulse: svgEl(lineLayer, "circle", { class: "mo-now-pulse", r: 11 }),
        dot: svgEl(lineLayer, "circle", { r: 11, fill: NAVY }),
      };
    }
    if (!line || !xOf) return;
    const dayStart = segments[0].start, dayEnd = Math.max(...segments.map((s) => s.end));
    const t = Math.max(dayStart, Math.min(dayEnd, now.minutes + now.seconds / 60));
    const g = (t - dayStart) / (dayEnd - dayStart);
    const ax = xOf(dayStart), ay = yOf(0), nx = xOf(t), ny = yOf(g), bx = xOf(dayEnd), by = yOf(1);
    const doneD = g > 0 ? `M${ax},${ay} L${nx},${ny}` : "";
    line.done.setAttribute("d", doneD);
    line.comet.setAttribute("d", doneD);
    line.rest.setAttribute("d", g < 1 ? `M${nx},${ny} L${bx},${by}` : "");
    for (const c of [line.pulse, line.dot]) { c.setAttribute("cx", nx); c.setAttribute("cy", ny); }
  }

  function drawDynamic(segments, now) {
    dynLayer.innerHTML = "";
    if (!segments.length || !xOf) return;
    const tNow = now.minutes + now.seconds / 60;
    const dayStart = segments[0].start, dayEnd = Math.max(...segments.map((s) => s.end));
    const inDay = tNow >= dayStart && tNow <= dayEnd;

    // the live block's ramp: solid up to now, dashed for the rest
    segments.filter((s) => segmentIsLive(s, now)).forEach((s) => {
      const color = segColor(s), f = segmentProgress(s, now);
      svgEl(dynLayer, "line", { x1: xOf(s.end - (s.end - s.start) * (1 - f)), y1: yOf(f), x2: xOf(s.end), y2: yOf(1), stroke: color, "stroke-width": 4, "stroke-dasharray": "10 9", opacity: 0.7 });
      svgEl(dynLayer, "line", { x1: xOf(s.start), y1: yOf(0), x2: xOf(tNow), y2: yOf(f), stroke: color, "stroke-width": 8, "stroke-linecap": "round" });
    });

    if (!inDay) return;
    // t = now, as a vertical dashed line
    const nx = xOf(tNow);
    svgEl(dynLayer, "line", { x1: nx, y1: YTOP - 40, x2: nx, y2: Y0, stroke: NAVY, "stroke-width": 2, "stroke-dasharray": "6 6", opacity: 0.6 });

    // labels: the day point (navy) and the live block's point (its color)
    const g = (tNow - dayStart) / (dayEnd - dayStart);
    const anchor = nx > 1000 ? "end" : "start", off = anchor === "end" ? -24 : 24;
    pillLabel(dynLayer, nx + off, yOf(g) - 4, `day: ${displayPct(g * 100)}%`, NAVY, anchor);
    const live = segments.find((s) => segmentIsLive(s, now));
    if (live) {
      const f = segmentProgress(live, now);
      svgEl(dynLayer, "circle", { cx: nx, cy: yOf(f), r: 12, fill: segColor(live) });
      // keep the two labels apart when f and g are close
      const fy = Math.abs(yOf(f) - yOf(g)) < 40 ? yOf(g) + 44 : yOf(f) - 26;
      pillLabel(dynLayer, nx + off, fy, `(${clock12(now.minutes)}, ${displayFraction(f)})`, segColor(live), anchor);
    }
  }

  // ---------- the next 18 days as a number line ----------
  function drawNumberLine(now) {
    const L = staticLayer;
    const first = now.dateStr, last = addDays(first, DAYS_AHEAD);
    const dx = (i) => X0 + i / DAYS_AHEAD * (X1 - X0);            // i = days after today
    const idx = (dateStr) => {
      const a = parseDate(first), b = parseDate(dateStr);
      return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
    };

    // section title, with the legend folded into it
    const title = svgEl(L, "text", { x: X0, y: 690, class: "mo-section-label" }, `NEXT ${DAYS_AHEAD} DAYS · `);
    svgEl(title, "tspan", { fill: EVENT_COLOR }, "school events above");
    svgEl(title, "tspan", {}, " · ");
    svgEl(title, "tspan", { fill: BIRTHDAY_COLOR }, "math birthdays below");

    // weekends: a light navy band (an interval, not a point)
    for (let i = 0; i <= DAYS_AHEAD; i++) {
      if (weekdayIndex(addDays(first, i)) === 6) {
        const a = Math.max(0, i - 0.5), b = Math.min(DAYS_AHEAD, i + 1.5);
        svgEl(L, "rect", { x: dx(a), y: LY - 150, width: dx(b) - dx(a), height: 200, fill: NAVY, opacity: 0.05 });
      }
    }

    // multi-day events (breaks, exams): shaded intervals labeled on top
    const upcoming = eventsData.filter((e) => e.endDate >= first && e.date <= last);
    const ranges = upcoming.filter((e) => e.endDate !== e.date);
    const singles = upcoming.filter((e) => e.endDate === e.date && e.date >= first);
    ranges.forEach((e) => {
      const a = Math.max(-0.5, idx(e.date) - 0.5), b = Math.min(DAYS_AHEAD, idx(e.endDate) + 0.5);
      svgEl(L, "rect", { x: dx(a), y: LY - 150, width: dx(b) - dx(a), height: 200, fill: "#fa7e19", opacity: 0.16 });
    });

    // the axis with one tick per day; the 1st of a month shows its name
    svgEl(L, "line", { x1: X0, y1: LY, x2: X1, y2: LY, stroke: "#1e2a3a", "stroke-width": 2.5 });
    for (let i = 0; i <= DAYS_AHEAD; i++) {
      const ds = addDays(first, i), { m, d } = parseDate(ds);
      svgEl(L, "line", { x1: dx(i), y1: LY - 6, x2: dx(i), y2: LY + 6, stroke: "#1e2a3a", "stroke-width": 1.5 });
      svgEl(L, "text", { x: dx(i), y: LY + 32, "text-anchor": "middle", class: "mo-axis-label", "font-size": 21,
        fill: i === 0 ? NAVY : "#1e2a3a", "font-weight": i === 0 || d === 1 ? 600 : 400 }, d === 1 ? `${AP_MONTHS[m - 1].replace(".", "")} 1` : d);
    }
    svgEl(L, "circle", { cx: dx(0), cy: LY, r: 10, fill: NAVY });
    svgEl(L, "text", { x: dx(0), y: LY + 58, "text-anchor": "middle", class: "mo-section-label", "font-size": 16, fill: NAVY }, "TODAY");

    // Labels are packed into rows: each goes in the first row where it
    // doesn't overlap a label already there (3 rows above, 2 below --
    // there's less room under the line). A label with no room is skipped.
    function place(items, above, color, hollow) {
      const maxRows = above ? 3 : 2;
      const rows = [];                  // per row: right edge of the last label
      items.sort((a, b) => a.i - b.i).forEach((it) => {
        const x = Math.min(X1 - 20, Math.max(X0 + 20, dx(it.i)));
        // measure the label first, offscreen, to know its width
        const probe = pillLabel(L, -9999, -9999, it.text, color);
        const w = probe.box.w;
        probe.g.remove();
        let left = x - w / 2;
        left = Math.max(X0 - 40, Math.min(X1 + 40 - w, left));
        let r = rows.findIndex((right) => left > right + 12);
        if (r === -1) { if (rows.length >= maxRows) return; r = rows.length; rows.push(0); }
        rows[r] = left + w;
        const ly = above ? LY - 62 - r * 44 : LY + 94 + r * 44;
        svgEl(L, "line", { x1: dx(it.i), y1: LY, x2: dx(it.i), y2: ly + (above ? 16 : -16), stroke: color, "stroke-width": 2 });
        svgEl(L, "circle", hollow
          ? { cx: dx(it.i), cy: LY, r: 7, fill: "#fff", stroke: color, "stroke-width": 3 }
          : { cx: dx(it.i), cy: LY, r: 8, fill: color });
        pillLabel(L, left + w / 2, ly, it.text, color);
      });
    }
    place([
      ...singles.map((e) => ({ i: idx(e.date), text: truncate(e.name, 30) })),
      ...ranges.map((e) => ({ i: (Math.max(0, idx(e.date)) + Math.min(DAYS_AHEAD, idx(e.endDate))) / 2, text: truncate(e.name, 30) })),
    ], true, EVENT_COLOR, false);

    // math birthdays, below the line
    const bdays = birthdaysData.filter((b) => b.date >= first && b.date <= last);
    place(bdays.map((b) => ({ i: idx(b.date), text: (b.date === first ? "Happy birthday, " : "") + b.name })), false, BIRTHDAY_COLOR, true);

  }

  // ---------- the once-a-second loop ----------
  function render() {
    const now = nowInChicago();
    const segments = daySegments(daysByDate.get(now.dateStr));
    const info = currentOrNext(segments, now);

    $("mo-clock").textContent = clock12(now.minutes);
    $("mo-date").textContent = formatHeaderDate(now.dateStr);

    checkCompletion(segments, now);
    renderExpressions(segments, info, now);
    renderBlocksTable(segments, now);
    renderRooms(now);
    renderCountdown(info, now);
    renderGraph(segments, now);

    // before/after school: a message where the countdown would be
    if (segments.length && (info.state === "done" || info.state === "too-early")) {
      $("mo-countdown-label").innerHTML = info.state === "done"
        ? "<strong>School's out</strong> for today"
        : `First bell at <strong>${clock12(segments[0].start)}</strong>`;
    }
  }

  reloadData().then(() => { lastStaticKey = null; });
  setInterval(reloadData, DATA_REFRESH_MS);
  fetchWeather();
  watchForNewVersion();
  render();
  setInterval(render, REFRESH_MS);
}

main();
