// =============================================================================
// Config
// =============================================================================

const TIME_ZONE = "America/Chicago";
const REFRESH_MS = 30000; // full re-render cadence; live bars tick faster, see bottom

const MONTH_NAMES = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];
const ALL_LETTERS = ["A", "B", "C", "D", "E", "F", "G"];

const ACCENT_COLORS = [
  { name: "blue", hex: "#005588", rgb: "0, 85, 136" }, // SLUH Blue
  { name: "violet", hex: "#a78bfa", rgb: "167, 139, 250" },
  { name: "green", hex: "#34d399", rgb: "52, 211, 153" },
  { name: "amber", hex: "#f59e0b", rgb: "245, 158, 11" },
  { name: "rose", hex: "#fb7185", rgb: "251, 113, 133" },
];

// =============================================================================
// Theme + accent color -- applied to <html> as a data-attribute / CSS vars,
// persisted to localStorage. Dark/light theme is also set once, early, by an
// inline script in <head> (before this file loads) to avoid a flash of the
// wrong theme; this file re-applies accent color on load and handles both
// going forward as the settings panel is used.
// =============================================================================

function applyTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  localStorage.setItem("tv-theme", mode);
}

function applyAccent(name) {
  const c = ACCENT_COLORS.find((a) => a.name === name) || ACCENT_COLORS[0];
  document.documentElement.style.setProperty("--accent", c.hex);
  document.documentElement.style.setProperty("--accent-rgb", c.rgb);
  localStorage.setItem("tv-accent", c.name);
}

// =============================================================================
// "My periods" filter -- lets a teacher narrow the grid/progress bars down to
// just the letters they teach, optionally different in Semester 2. Persisted
// to localStorage under "tv-filter".
// =============================================================================

// starts off (shows everyone's periods); the letters pre-fill to A/B/D/G so
// flipping "Show only my periods" on in settings is immediately useful.
// `jrsrLetters`: periods that follow the Jr/Sr lunch-wave clock time (see
// resolvePeriodTimes) rather than the Fr/So default -- a teacher can teach
// one grade band one period and the other in a different period, so this
// is tracked per letter, not as one global setting. `seniorLetters`:
// periods marked as seniors-only sections, which don't meet in Semester 2
// outside the SENIOR_S2 window.
const DEFAULT_FILTER = {
  enabled: false, split: false,
  s1: ["A", "B", "D", "G"], s2: ["A", "B", "D", "G"],
  jrsrLetters: [], seniorLetters: [],
};

function loadFilter() {
  try {
    const raw = localStorage.getItem("tv-filter");
    if (!raw) return { ...DEFAULT_FILTER };
    return { ...DEFAULT_FILTER, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_FILTER };
  }
}

function saveFilter(f) {
  localStorage.setItem("tv-filter", JSON.stringify(f));
}

// =============================================================================
// Date helpers -- dates are passed around as plain "YYYYMMDD" strings
// throughout this file (matching the JSON schema), since that format sorts
// and compares correctly as a string with no parsing needed.
// =============================================================================

function parseDate(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  return { y, m, d };
}

function formatFullDate(yyyymmdd, weekday) {
  const { y, m, d } = parseDate(yyyymmdd);
  return `${weekday}, ${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

function formatClockTenths(totalMs) {
  totalMs = Math.max(0, Math.round(totalMs));
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const tenths = Math.floor((totalMs % 1000) / 100);
  return `${m}:${String(s).padStart(2, "0")}.${tenths}`;
}

// "1:23:45" or "23:45" -- whole seconds only, meant to be read from across
// a room (the Dashboard tab's next-period countdown), unlike the tenths
// precision used for up-close bars elsewhere.
function formatCountdownClock(totalMs) {
  const totalSec = Math.max(0, Math.round(totalMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : m;
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}

// Monday (YYYYMMDD) of the calendar week containing this date, for weekly grouping.
function mondayOf(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return dateFromUTC(dt);
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

// 0=Mon .. 6=Sun
function weekdayIndex(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 6 : dow - 1;
}

// Chicago wall-clock "now", independent of the visitor's own timezone.
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
  return { dateStr, minutes };
}

// =============================================================================
// Semester / quarter boundaries -- derived from the schedule data itself so
// nothing needs manual updating year to year (except the optional
// quarter_end CSV column, for when the real Q1/Q3 dates are known).
// =============================================================================

// last day of "First Semester Exams" marks the semester boundary
function findSemesterBoundary(days) {
  let boundary = null;
  for (const d of days) {
    if (/First Semester Exams/i.test(d.summary)) boundary = d.date;
  }
  return boundary;
}

// Q1 and Q3 end dates come from data.js's QUARTER_MARKS when the CSV has
// them (see csv_to_data.py); otherwise fall back to an even split of each
// semester's period-stream by count. Q2 always ends at the semester
// boundary and Q4 at the last day of the year, so neither needs a mark.
function computeQuarterBoundaries(days, boundary) {
  function midpoint(filterFn) {
    const scoped = days.filter((d) => d.periods.length && filterFn(d.date));
    const total = scoped.reduce((s, d) => s + d.periods.length, 0);
    const half = total / 2;
    let running = 0;
    for (const d of scoped) {
      running += d.periods.length;
      if (running >= half) return d.date;
    }
    return scoped.length ? scoped[scoped.length - 1].date : null;
  }
  const marks = typeof QUARTER_MARKS !== "undefined" ? QUARTER_MARKS : {};
  return {
    mid1: marks["1"] || midpoint((d) => d <= boundary),
    mid2: marks["3"] || midpoint((d) => d > boundary),
  };
}

function quarterOfDate(dateStr, boundary, qb) {
  if (dateStr <= boundary) return dateStr <= qb.mid1 ? 1 : 2;
  return dateStr <= qb.mid2 ? 3 : 4;
}

// =============================================================================
// Period progress -- the core "how far along is this period/day/range" math
// that drives every fill bar and progress bar in the app.
// =============================================================================

const PREVIEW_WINDOW_START = 6 * 60; // 6:00am
const PREVIEW_WINDOW_END = 15 * 60 + 45; // 3:45pm

// whether to show today's not-yet-started periods in a distinct "coming up"
// shade (continuous view) / underline today's column (weekly view) -- only
// during school hours, so it doesn't linger all evening.
function inTodayPreviewWindow(now) {
  return now.minutes >= PREVIEW_WINDOW_START && now.minutes < PREVIEW_WINDOW_END;
}

// On most days, one period runs twice at different clock times -- once for
// freshmen/sophomores (class, then lunch) and once for juniors/seniors
// (lunch, then class) -- same letter, different startMinutes/endMinutes.
// `wave` ("frso" | "jrsr") picks which one applies; a period with no
// jrsrStartMinutes/jrsrEndMinutes (i.e. it never splits) ignores wave.
function resolvePeriodTimes(period, wave) {
  if (wave === "jrsr" && period.jrsrStartMinutes != null) {
    return { startMinutes: period.jrsrStartMinutes, endMinutes: period.jrsrEndMinutes };
  }
  return { startMinutes: period.startMinutes, endMinutes: period.endMinutes };
}

// 0 (hasn't happened), 1 (fully done), or a fraction in between for the
// currently-live period. `wave` is either a plain "frso"/"jrsr" string, or
// a (period, day) => wave function for when it varies by period.
function periodProgress(day, period, now, wave) {
  const resolvedWave = typeof wave === "function" ? wave(period, day) : wave;
  const { startMinutes, endMinutes } = resolvePeriodTimes(period, resolvedWave);
  if (day.date < now.dateStr) return 1;
  if (day.date > now.dateStr) return 0;
  if (now.minutes < startMinutes) return 0;
  if (now.minutes >= endMinutes) return 1;
  return (now.minutes - startMinutes) / (endMinutes - startMinutes);
}

// sums periodProgress() across a list of days, for the Progress tab's bars.
function progressOf(dayList, now, wave) {
  let total = 0, done = 0;
  for (const day of dayList) {
    for (const p of day.periods) {
      total += 1;
      done += periodProgress(day, p, now, wave);
    }
  }
  return { total, done, pct: total ? (done / total) * 100 : 0 };
}

// like progressOf, but counts whole school days instead of periods -- for
// bars phrased as "N school days left" rather than "N periods left". A day
// in progress counts as the average of its own periods' progress.
function schoolDayProgress(dayList, now) {
  let total = 0, done = 0;
  for (const day of dayList) {
    if (!day.periods.length) continue;
    total += 1;
    if (day.date < now.dateStr) { done += 1; continue; }
    if (day.date > now.dateStr) continue;
    const sum = day.periods.reduce((s, p) => s + periodProgress(day, p, now), 0);
    done += sum / day.periods.length;
  }
  return { total, done, pct: total ? (done / total) * 100 : 0 };
}

// =============================================================================
// "Next Break" detection -- a break is 3+ *consecutive calendar days* off,
// including weekends (which never appear in `days` at all). PD days are
// deliberately treated like a school day here: still a workday, so one
// sitting next to a weekend can't masquerade as a break.
// =============================================================================

// every single calendar day (school days, weekends, everything) from the
// first to the last school day, classified so a real multi-day break can
// be found even though weekends never appear in `days` at all.
function classifyCalendarDays(days, daysByDate) {
  const first = days[0].date, last = days[days.length - 1].date;
  const seq = [];
  for (let cursor = first; cursor <= last; cursor = addDays(cursor, 1)) {
    const entry = daysByDate.get(cursor);
    let type;
    if (entry && entry.periods.length) type = "school";
    // parent-teacher conferences are still a work day for teachers, so they
    // act as a wall too, same as a PD day -- not a real break.
    else if (entry && /professional development|\bpd\b|parent-teacher conference/i.test(entry.summary)) type = "pd";
    else type = "off"; // break/holiday day, or a weekend (no entry at all)
    seq.push({ date: cursor, type });
  }
  return seq;
}

// consecutive runs of "off" days (PD days act as a wall, same as a school
// day -- they don't count toward or extend a break) of at least `minLen`
// calendar days.
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

// the first weekday within [startDate, endDate] that has a calendar summary
// (weekends never do), cleaned up for display.
function breakName(startDate, endDate, daysByDate) {
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    const entry = daysByDate.get(d);
    if (entry && entry.summary) return cleanBreakLabel(entry.summary);
  }
  return "Break";
}

// =============================================================================
// Per-period metadata -- annotates every period in `days` in place with its
// position in the rotation/semester/year, used by the hover info panel.
// =============================================================================

// Returns the totals needed to turn those positions into percentages.
function computeMeta(days, boundary) {
  let overall = 0;
  const semCounters = { s1: 0, s2: 0 };
  const letterCounters = {};
  const letterTotals = {};
  const semesterTotals = { s1: 0, s2: 0 };
  let yearTotal = 0;

  for (const day of days) {
    if (!day.periods.length) continue;
    const sem = day.date <= boundary ? "s1" : "s2";
    semesterTotals[sem] += day.periods.length;
    yearTotal += day.periods.length;
    for (const p of day.periods) letterTotals[p.label] = (letterTotals[p.label] || 0) + 1;
  }

  for (const day of days) {
    if (!day.periods.length) continue;
    const sem = day.date <= boundary ? "s1" : "s2";
    for (const p of day.periods) {
      overall += 1;
      semCounters[sem] += 1;
      letterCounters[p.label] = (letterCounters[p.label] || 0) + 1;
      p.meta = {
        overall,
        semester: sem,
        semesterIndex: semCounters[sem],
        cycle: letterCounters[p.label],
      };
    }
  }

  return { yearTotal, semesterTotals, letterTotals };
}

// =============================================================================
// Shared UI fragment builders
// =============================================================================

// `celebrate` lights the bar up in a festive color -- for the last school
// day before a weekend or a break, so it's obvious at a glance you're on
// the home stretch.
function bar(label, pct, sub, celebrate) {
  const clamped = Math.max(0, Math.min(100, pct));
  return `
    <div class="bar-row${celebrate ? " is-celebrating" : ""}">
      <div class="bar-top"><div class="bar-label">${label}</div><div class="bar-pct">${Math.round(clamped)}%</div></div>
      <div class="bar-track"><div class="bar-fill" style="width:${clamped}%"></div></div>
      <div class="bar-sub">${sub}</div>
    </div>`;
}

function cleanBreakLabel(summary) {
  return summary.replace(/^No (School|Classes)-/, "");
}

// =============================================================================
// main() -- everything below needs the DOM and SCHOOL_YEAR_DATA to exist,
// so it's wrapped up and run once at the bottom of this file.
// =============================================================================

function main() {
  // ---- data + one-time (non-time-dependent) derived values ----
  const days = SCHOOL_YEAR_DATA;
  const boundary = findSemesterBoundary(days);
  const qb = computeQuarterBoundaries(days, boundary);
  const { yearTotal, semesterTotals, letterTotals } = computeMeta(days, boundary);
  const daysByDate = new Map(days.map((d) => [d.date, d]));
  // when set (see csv_to_data.py's senior_s2 column), the date range seniors'
  // second-semester schedule actually runs -- outside it, periods marked as
  // seniors-only in Settings don't meet at all. On the start date itself,
  // seniors don't return until period A -- whatever ran earlier that day
  // (the rotation doesn't always begin on A) doesn't count for them.
  const seniorS2 = typeof SENIOR_S2 !== "undefined" && SENIOR_S2.start && SENIOR_S2.end ? SENIOR_S2 : null;
  const seniorS2StartCutoff = seniorS2
    ? (daysByDate.get(seniorS2.start)?.periods.find((p) => p.label === "A")?.startMinutes ?? null)
    : null;
  // 3+ consecutive calendar days off, PD days excluded from counting as
  // "off" -- computed once, since the school calendar itself doesn't change.
  const qualifyingBreaks = findQualifyingBreaks(classifyCalendarDays(days, daysByDate), 3);
  // the one qualifying break that actually covers Christmas -- the milestone
  // bar below counts down to this, then flips to counting down to the last
  // day of the year once it's over.
  const winterBreak = qualifyingBreaks.find((b) => {
    for (let d = b.start; d <= b.end; d = addDays(d, 1)) {
      const entry = daysByDate.get(d);
      if (entry && /christmas/i.test(entry.summary)) return true;
    }
    return false;
  });

  // ---- DOM references ----
  const progressEl = document.getElementById("tab-progress");
  const currentPeriodEl = document.getElementById("tab-current");
  const dashboardEl = document.getElementById("tab-dashboard");
  const gridContinuousEl = document.getElementById("grid-continuous");
  const gridWeeklyEl = document.getElementById("grid-weekly");
  const infoPanel = document.getElementById("info-panel");
  const debugInput = document.getElementById("debug-time");
  const debugLiveBtn = document.getElementById("debug-live");

  let override = null; // {dateStr, minutes} while debugging, else null
  let filterState = loadFilter();
  // lets anyone viewing a split period switch which lunch wave's clock time
  // the Current Period bar reflects, without changing their saved setting.
  // Resets to the Settings default on reload.
  let liveWaveOverride = null;
  // `${date}|${letter}` of whichever period was live as of the last tick,
  // so a confetti burst can fire exactly once when it finishes -- not on
  // page load, and not again every 100ms while nothing's live.
  let lastLiveKey = null;
  // `${date}|${letter}` last rendered into each Current Period bar, so a
  // tick only rebuilds the bar's DOM (destroying and recreating the wave
  // toggle buttons) when the live period actually changes -- otherwise it
  // just patches the numbers in place. Rebuilding every 100ms regardless
  // was silently dropping real clicks on the toggle: a mousedown/mouseup
  // pair could straddle a rebuild and land on an element that no longer
  // existed by mouseup.
  const lastPeriodKeyById = {};

  // ---- "my periods" filter ----

  // which lunch wave's clock time applies to a given period letter -- set
  // per period in Settings, since a teacher can have Fr/So students one
  // period and Jr/Sr students in another.
  function waveFor(letter) {
    return (filterState.jrsrLetters || []).includes(letter) ? "jrsr" : "frso";
  }

  function isLetterActive(day, period) {
    if (!filterState.enabled) return true;
    const letter = period.label;
    const sem = day.date <= boundary ? "s1" : "s2";
    const set = filterState.split && sem === "s2" ? filterState.s2 : filterState.s1;
    if (!set.includes(letter)) return false;
    // a period marked seniors-only doesn't meet in S2 outside the window
    // seniors actually attend (see csv_to_data.py's senior_s2 column) --
    // and on the return date, not until period A specifically.
    if (sem === "s2" && seniorS2 && (filterState.seniorLetters || []).includes(letter)) {
      if (day.date < seniorS2.start || day.date > seniorS2.end) return false;
      if (day.date === seniorS2.start && seniorS2StartCutoff != null && period.startMinutes < seniorS2StartCutoff) return false;
    }
    return true;
  }

  // same shape progressOf() expects, but with non-matching periods dropped
  // when the "my periods" filter is on, and always resolved to each
  // period's effective wave (see effectiveWave).
  function progressOfFiltered(dayList, now) {
    const wave = (period, day) => effectiveWave(day, period, now);
    if (!filterState.enabled) return progressOf(dayList, now, wave);
    const mapped = dayList.map((d) => ({
      date: d.date,
      periods: d.periods.filter((p) => isLetterActive(d, p)),
    }));
    return progressOf(mapped, now, wave);
  }

  // which wave counts a period as "done" for progress purposes -- for
  // today's currently-live period specifically, that should match
  // whatever the Current Period bar is actually showing (an explicit
  // toggle override if one's set, otherwise whichever wave is naturally
  // in progress), not just the configured default. A period whose default
  // wave (say Fr/So) already finished shouldn't count as complete in the
  // Progress tab's totals while its Jr/Sr half is still running. For any
  // other day this is moot -- periodProgress returns 0 or 1 either way.
  function effectiveWave(day, period, now) {
    if (day.date !== now.dateStr) return waveFor(period.label);
    const live = findLivePeriod(now);
    const natural = liveWaveOf(day, period, now);
    if (live && period.label === live.label) return liveWaveOverride || natural || waveFor(period.label);
    return natural || waveFor(period.label);
  }

  function countVisiblePeriods() {
    let count = 0;
    for (const day of days) {
      for (const p of day.periods) {
        if (isLetterActive(day, p)) count += 1;
      }
    }
    return count;
  }

  // ---- desktop grid sizing ----

  // On desktop, size the grid squares so the continuous view's rows fill
  // the available viewport height instead of leaving empty space below a
  // small fixed size. Measured off <main>/<tabs> rather than the grid
  // itself, since the grid's own container may be display:none on another
  // tab. Below the desktop breakpoint, defer back to the CSS media queries.
  // Column count is pinned to a multiple of 7, so every row holds a whole
  // number of rotation cycles at a glance.
  const DESKTOP_BREAKPOINT = 768;
  function fitGridCellSize(count) {
    if (window.innerWidth < DESKTOP_BREAKPOINT) {
      document.documentElement.style.removeProperty("--cell");
      document.documentElement.style.removeProperty("--gap");
      document.documentElement.style.removeProperty("--cols");
      return;
    }
    const mainEl = document.querySelector("main");
    const tabsEl = document.getElementById("tabs");
    const availWidth = mainEl.clientWidth;
    const contentTop = tabsEl.getBoundingClientRect().bottom;
    // leave room for the semester-divider's own margin, so the grid doesn't
    // slightly overflow the viewport once it's inserted.
    const availHeight = Math.max(200, window.innerHeight - contentTop - 24 - 50);

    const minSize = 8, maxSize = 40;
    let best = { size: minSize, cols: 7 };
    for (let s = maxSize; s >= minSize; s--) {
      const rawCols = Math.floor(availWidth / s);
      const cols = Math.max(7, Math.floor(rawCols / 7) * 7);
      const rows = Math.ceil(count / cols);
      if (rows * s <= availHeight) { best = { size: s, cols }; break; }
    }
    document.documentElement.style.setProperty("--cell", best.size + "px");
    document.documentElement.style.setProperty("--gap", Math.max(2, Math.round(best.size / 6)) + "px");
    document.documentElement.style.setProperty("--cols", String(best.cols));
  }

  function getNow() {
    // debug time is a frozen preview -- seconds/ms stay at 0 rather than
    // ticking off real wall-clock time from an arbitrary chosen minute.
    if (override) return { ...override, seconds: 0, ms: 0 };
    const d = new Date();
    return { ...nowInChicago(), seconds: d.getSeconds(), ms: d.getMilliseconds() };
  }

  // ---- hover info panel (shared by both grid views) ----

  function showInfo(day, p, evt) {
    const meta = p.meta;
    const semLabel = meta.semester === "s1" ? "Semester 1" : "Semester 2";
    const semTotal = semesterTotals[meta.semester];
    const semPct = Math.round((meta.semesterIndex / semTotal) * 100);
    const yearPct = Math.round((meta.overall / yearTotal) * 100);

    infoPanel.innerHTML = `
      <div class="info-date">${formatFullDate(day.date, day.weekday)}</div>
      <div class="info-period">Period ${p.label} <span class="info-cycle">— Cycle ${meta.cycle} out of ${letterTotals[p.label]}</span></div>
      <div class="info-row"><span>Absolute</span><span>#${meta.overall} of ${yearTotal}</span></div>
      <div class="info-row"><span>${semLabel}</span><span>${semPct}% done · ${semTotal - meta.semesterIndex} left</span></div>
      <div class="info-row"><span>Year</span><span>${yearPct}% done · ${yearTotal - meta.overall} left</span></div>
    `;
    infoPanel.hidden = false;
    positionInfo(evt);
  }

  function showBreakInfo(day, evt) {
    infoPanel.innerHTML = `
      <div class="info-date">${formatFullDate(day.date, day.weekday)}</div>
      <div class="info-period">No school — ${cleanBreakLabel(day.summary)}</div>
    `;
    infoPanel.hidden = false;
    positionInfo(evt);
  }

  function positionInfo(evt) {
    const pad = 16;
    const rect = infoPanel.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
    infoPanel.style.left = Math.max(8, x) + "px";
    infoPanel.style.top = Math.max(8, y) + "px";
  }

  function hideInfo() {
    infoPanel.hidden = true;
  }

  function setGroupHighlight(container, key, val, on) {
    container.querySelectorAll(`.period[data-${key}="${val}"]`).forEach((el) => {
      el.classList.toggle("is-group-hover", on);
    });
  }

  // ---- grid square builder (shared by continuous + weekly) ----

  // hovering a period highlights every period that shares its day, so you
  // can see at a glance which squares belong to the same school day.
  function makeSquare(container, day, p, now, showPreview) {
    const sq = document.createElement("div");
    sq.className = "period";
    sq.dataset.date = day.date;
    if (!isLetterActive(day, p)) sq.classList.add("is-filtered");

    const fill = document.createElement("div");
    fill.className = "period-fill";
    const progress = periodProgress(day, p, now, effectiveWave(day, p, now));
    fill.style.height = (progress * 100) + "%";
    if (progress > 0 && progress < 1) {
      sq.classList.add("is-live");
    } else if (progress === 0 && showPreview && day.date === now.dateStr) {
      sq.classList.add("is-today-upcoming");
    }
    sq.appendChild(fill);

    const letter = document.createElement("span");
    letter.className = "letter";
    letter.textContent = p.label;
    sq.appendChild(letter);

    sq.addEventListener("mouseenter", (e) => {
      showInfo(day, p, e);
      setGroupHighlight(container, "date", day.date, true);
    });
    sq.addEventListener("mousemove", positionInfo);
    sq.addEventListener("mouseleave", () => {
      hideInfo();
      setGroupHighlight(container, "date", day.date, false);
    });

    return sq;
  }

  // ---- continuous view: every period of the year, one flat grid ----

  function buildContinuous(container, now) {
    const schoolDays = days.filter((d) => d.periods.length);
    const showPreview = inTodayPreviewWindow(now);
    let liveEl = null, todaySq = null, crossedBoundary = false;

    for (const day of schoolDays) {
      if (!crossedBoundary && day.date > boundary) {
        crossedBoundary = true;
        const divider = document.createElement("div");
        divider.className = "semester-divider";
        container.appendChild(divider);
      }
      for (const p of day.periods) {
        const sq = makeSquare(container, day, p, now, showPreview);
        if (sq.classList.contains("is-live")) liveEl = sq;
        if (day.date === now.dateStr && !todaySq) todaySq = sq;
        container.appendChild(sq);
      }
    }

    return liveEl || todaySq; // scroll target for the tab switcher
  }

  // ---- weekly view: one row per calendar week, Mon-Fri columns ----

  function buildWeekly(container, now) {
    const schoolDays = days.filter((d) => d.periods.length);
    const weeksMap = new Map(); // monday -> [Mon..Fri] sparse array of days
    for (const day of schoolDays) {
      const idx = weekdayIndex(day.date);
      if (idx < 0 || idx > 4) continue;
      const mon = mondayOf(day.date);
      if (!weeksMap.has(mon)) weeksMap.set(mon, [null, null, null, null, null]);
      weeksMap.get(mon)[idx] = day;
    }

    // fill in weeks with zero school days (e.g. spring break) so they still
    // render as a genuine gap, instead of silently vanishing from the view.
    if (schoolDays.length) {
      const firstMon = mondayOf(schoolDays[0].date);
      const lastMon = mondayOf(schoolDays[schoolDays.length - 1].date);
      for (let cursor = firstMon; cursor <= lastMon; cursor = addDays(cursor, 7)) {
        if (!weeksMap.has(cursor)) weeksMap.set(cursor, [null, null, null, null, null]);
      }
    }

    const mondays = [...weeksMap.keys()].sort();

    let liveEl = null, todaySlot = null, crossedBoundary = false;

    for (const mon of mondays) {
      const weekDays = weeksMap.get(mon);
      // based on the calendar week's own date range, not on whether school
      // actually happened, so an empty week still lands on the right side.
      const weekHasPastBoundary = addDays(mon, 4) > boundary;
      if (!crossedBoundary && weekHasPastBoundary) {
        crossedBoundary = true;
        const divider = document.createElement("div");
        divider.className = "semester-divider";
        container.appendChild(divider);
      }

      const row = document.createElement("div");
      row.className = "week-row";
      container.appendChild(row);

      for (let i = 0; i < 5; i++) {
        const slotDate = addDays(mon, i);
        const slot = document.createElement("div");
        slot.className = "day-slot";
        const day = weekDays[i];
        let contentEl = null;

        if (day) {
          contentEl = document.createElement("div");
          contentEl.className = "day-content";
          for (const p of day.periods) {
            const sq = makeSquare(container, day, p, now);
            if (sq.classList.contains("is-live")) liveEl = sq;
            contentEl.appendChild(sq);
          }
          slot.appendChild(contentEl);
        } else {
          const info = daysByDate.get(slotDate);
          // Christmas break doesn't need an explanation on hover -- it's
          // the obvious, implied gap between semesters.
          if (info && !/christmas/i.test(info.summary)) {
            contentEl = document.createElement("div");
            contentEl.className = "no-school-slot";
            contentEl.addEventListener("mouseenter", (e) => {
              showBreakInfo(info, e);
              contentEl.classList.add("is-active");
            });
            contentEl.addEventListener("mousemove", positionInfo);
            contentEl.addEventListener("mouseleave", () => {
              hideInfo();
              contentEl.classList.remove("is-active");
            });
            slot.appendChild(contentEl);
          }
        }

        if (slotDate === now.dateStr) todaySlot = contentEl;
        row.appendChild(slot);
      }
    }

    // underline today's periods only during the school-hours window, so it
    // shows what's on tap for the day without lingering all evening.
    if (todaySlot && todaySlot.classList.contains("day-content") && inTodayPreviewWindow(now)) {
      todaySlot.classList.add("is-today-window");
    }

    return liveEl || todaySlot; // scroll target for the tab switcher
  }

  // ---- Progress tab: static bars + two live-ticking bars ----

  // `celebrate` lights the bar up and, once it hits 0 left, adds a couple
  // of emoji -- for the last school day before a weekend.
  // `prog.done` is a sum of fractional per-period progress (the live period
  // contributes e.g. 0.6, not 1), since that's what drives the smooth
  // percentage fill. The "X of Y periods" count is a different thing --
  // a period should only count as completed once it's actually done, so
  // it floors rather than rounds (rounding would count a live period as
  // "done" the moment it crossed the halfway mark).
  function barOrEmpty(label, prog, emptyText, celebrate) {
    if (prog.total === 0) return bar(label, 0, emptyText);
    const completed = Math.floor(prog.done);
    const left = prog.total - completed;
    const emoji = celebrate && left === 0 ? " 🎉🙌" : "";
    return bar(label, prog.pct, `${completed} of ${prog.total} periods · ${left} left${emoji}`, celebrate);
  }

  // like barOrEmpty, but swaps the periods-left count for a school-days-left
  // count -- for the big-picture bars (year/semester/quarter) where "how
  // many days" is more useful than "how many periods".
  function barWithSchoolDays(label, dayList, now, emptyText) {
    const periodProg = progressOfFiltered(dayList, now);
    if (periodProg.total === 0) return bar(label, 0, emptyText);
    const completed = Math.floor(periodProg.done);
    const dayProg = schoolDayProgress(dayList, now);
    const daysLeft = Math.max(0, Math.round(dayProg.total - dayProg.done));
    return bar(label, periodProg.pct,
      `${completed} of ${periodProg.total} periods · ${daysLeft} school day${daysLeft === 1 ? "" : "s"} left`);
  }

  // always uses each period's own configured wave -- this determines which
  // period counts as "live" at all, so it has to be accurate, not whatever
  // the Current Period bar's toggle happens to be showing right now.
  function findLivePeriod(now) {
    const today = days.find((d) => d.date === now.dateStr);
    if (!today) return null;
    for (const p of today.periods) {
      if (!isLetterActive(today, p)) continue;
      if (liveWaveOf(today, p, now)) return p;
    }
    return null;
  }

  // which wave is actually in progress for this period right now: the
  // configured default if that's the one currently running, otherwise --
  // for a period that splits -- whichever of the two currently is. The
  // Fr/So and Jr/Sr windows never overlap, so at most one is ever live at
  // once; without this, a period whose default wave already finished
  // would look "not live" even while its other wave is still running.
  function liveWaveOf(day, period, now) {
    const defaultWave = waveFor(period.label);
    const progDefault = periodProgress(day, period, now, defaultWave);
    if (progDefault > 0 && progDefault < 1) return defaultWave;
    if (period.jrsrStartMinutes != null) {
      const altWave = defaultWave === "jrsr" ? "frso" : "jrsr";
      const progAlt = periodProgress(day, period, now, altWave);
      if (progAlt > 0 && progAlt < 1) return altWave;
    }
    return null;
  }

  // `id` lets this render into two places at once (the Progress tab's bar
  // list, and the standalone Current Period tab) without a duplicate DOM id.
  function currentPeriodBarHtml(id = "current-period-bar") {
    const now = getNow();
    const live = findLivePeriod(now);
    // keeps updateCurrentPeriodBar's change-detection in sync with whatever
    // just got built here, however it got built -- otherwise the very next
    // 100ms tick after any full render() would see a stale key and force
    // one needless (and click-swallowing) rebuild of its own.
    lastPeriodKeyById[id] = live ? `${now.dateStr}|${live.label}` : null;

    if (!live) {
      return `
        <div class="bar-row" id="${id}">
          <div class="bar-top"><div class="bar-label">Current Period</div><div class="bar-pct">—</div></div>
          <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
          <div class="bar-sub">No period in progress</div>
        </div>`;
    }

    // the toggle only ever changes which of THIS period's two times is
    // displayed -- it never changes which period counts as live (above).
    const today = days.find((d) => d.date === now.dateStr);
    const wave = effectiveWave(today, live, now);
    const { startMinutes, endMinutes } = resolvePeriodTimes(live, wave);
    const totalMs = (endMinutes - startMinutes) * 60000;
    const elapsedMs = Math.min(totalMs, Math.max(0, (now.minutes - startMinutes) * 60000 + now.seconds * 1000 + now.ms));
    const remainingMs = totalMs - elapsedMs;
    const pct = (elapsedMs / totalMs) * 100;

    // only offer the wave toggle when this specific period actually splits
    // -- most periods don't, and the control would just be noise on them.
    const waveToggle = live.jrsrStartMinutes != null ? `
        <div class="bar-wave-toggle">
          <span class="bar-wave-label">Lunch wave</span>
          <button class="wave-pill${wave === "frso" ? " active" : ""}" data-wave="frso" type="button">Fr/So</button>
          <button class="wave-pill${wave === "jrsr" ? " active" : ""}" data-wave="jrsr" type="button">Jr/Sr</button>
        </div>` : "";

    return `
      <div class="bar-row" id="${id}">
        <div class="bar-top"><div class="bar-label">Current Period — ${live.label}</div><div class="bar-pct">${Math.round(pct)}%</div></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-sub">${formatClockTenths(elapsedMs)} elapsed · ${formatClockTenths(remainingMs)} remaining</div>
        ${waveToggle}
      </div>`;
  }

  // For tired teachers: how far through the current stretch we are until
  // the next break of 3+ calendar days (PD days don't count as part of a
  // break -- they're a workday, so they can't extend or create one).
  function nextBreakBarHtml(id = "next-break-bar") {
    const now = getNow();

    let nb = null;
    for (const b of qualifyingBreaks) {
      if (b.end >= now.dateStr) { nb = b; break; }
    }

    if (!nb) {
      return `
        <div class="bar-row" id="${id}">
          <div class="bar-top"><div class="bar-label">Next Break (3+ days)</div><div class="bar-pct">—</div></div>
          <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
          <div class="bar-sub">No more qualifying breaks left this year</div>
        </div>`;
    }

    const name = breakName(nb.start, nb.end, daysByDate);
    const onBreak = nb.start <= now.dateStr && now.dateStr <= nb.end;

    if (onBreak) {
      return `
        <div class="bar-row" id="${id}">
          <div class="bar-top"><div class="bar-label">${name}</div><div class="bar-pct">🎉</div></div>
          <div class="bar-track"><div class="bar-fill" style="width:100%"></div></div>
          <div class="bar-sub">You made it. Enjoy every last minute.</div>
        </div>`;
    }

    const idx = qualifyingBreaks.indexOf(nb);
    const prevBreak = idx > 0 ? qualifyingBreaks[idx - 1] : null;
    const stretchStart = prevBreak ? addDays(prevBreak.end, 1) : days[0].date;
    const stretchDays = days.filter((d) => d.date >= stretchStart && d.date < nb.start);
    const prog = progressOfFiltered(stretchDays, now);
    const pct = prog.total ? (prog.done / prog.total) * 100 : 100;

    const dayProg = schoolDayProgress(stretchDays, now);
    const daysLeft = Math.max(0, Math.round(dayProg.total - dayProg.done));
    const isLastDay = stretchDays.length > 0 && now.dateStr === stretchDays[stretchDays.length - 1].date;

    return `
      <div class="bar-row${isLastDay ? " is-celebrating" : ""}" id="${id}">
        <div class="bar-top"><div class="bar-label">Next Break (3+ days) — ${name}</div><div class="bar-pct">${Math.round(pct)}%</div></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-sub">${daysLeft} school day${daysLeft === 1 ? "" : "s"} left${isLastDay ? " 🎉🙌" : ""}</div>
      </div>`;
  }

  // The "big picture" milestone bar: school days left until Winter Break,
  // then -- once it's over -- school days left until the last day of the
  // year. Counted in whole school days rather than periods, since that's
  // the more natural unit for a milestone this far out.
  function milestoneBarHtml(now) {
    if (!winterBreak) {
      const prog = schoolDayProgress(days.filter((d) => d.periods.length), now);
      const left = Math.max(0, Math.round(prog.total - prog.done));
      return bar("Until End of Year", prog.pct, `${left} school day${left === 1 ? "" : "s"} left`);
    }

    if (now.dateStr < winterBreak.start) {
      const stretch = days.filter((d) => d.periods.length && d.date < winterBreak.start);
      const prog = schoolDayProgress(stretch, now);
      const left = Math.max(0, Math.round(prog.total - prog.done));
      const isLastDay = stretch.length > 0 && now.dateStr === stretch[stretch.length - 1].date;
      const sub = `${left} school day${left === 1 ? "" : "s"} left${isLastDay ? " 🎉🙌" : ""}`;
      return bar("Until Winter Break", prog.pct, sub, isLastDay);
    }

    if (now.dateStr <= winterBreak.end) {
      return bar("Winter Break", 100, "Enjoy the holidays — you earned it.");
    }

    const stretch = days.filter((d) => d.periods.length && d.date > winterBreak.end);
    const prog = schoolDayProgress(stretch, now);
    const left = Math.max(0, Math.round(prog.total - prog.done));
    return bar("Until End of Year", prog.pct, `${left} school day${left === 1 ? "" : "s"} left`);
  }

  // ---- Dashboard tab: a big-screen (16:9) view combining the day's whole
  // period layout with a live countdown and a few at-a-glance stats. ----

  // one segment per today's (filtered) period, sized proportionally to its
  // own duration, with the real gaps between periods (lunch, passing time,
  // activity period, etc.) rendered as blank space of the correct width --
  // so the bar's shape reflects the literal school day layout, not just an
  // evenly-spaced row of periods.
  function dailyBarHtml(now) {
    const today = days.find((d) => d.date === now.dateStr);
    const periods = today ? today.periods.filter((p) => isLetterActive(today, p)) : [];
    if (!periods.length) {
      return `<div class="daily-status">No school today</div>`;
    }

    const dayStart = periods[0].startMinutes;
    const dayEnd = periods[periods.length - 1].endMinutes;
    const cols = [];
    const segments = [];
    periods.forEach((p, i) => {
      if (i > 0) {
        const gapMin = p.startMinutes - periods[i - 1].endMinutes;
        if (gapMin > 0) {
          cols.push(`${gapMin}fr`);
          segments.push(`<div class="daily-gap"></div>`);
        }
      }
      // segment width always reflects the period's own (Fr/So-default)
      // duration, so the bar's layout doesn't jump around depending on
      // which lunch wave happens to be live -- only the fill amount does.
      cols.push(`${p.endMinutes - p.startMinutes}fr`);
      const progress = periodProgress(today, p, now, effectiveWave(today, p, now));
      const isLive = progress > 0 && progress < 1;
      segments.push(`
        <div class="daily-segment${isLive ? " is-live" : ""}">
          <div class="daily-segment-fill" style="height:${progress * 100}%"></div>
          <div class="daily-segment-label">${p.label}</div>
        </div>`);
    });

    const totalSpan = dayEnd - dayStart;
    const nowPct = ((now.minutes - dayStart) / totalSpan) * 100;
    const marker = nowPct >= 0 && nowPct <= 100
      ? `<div class="daily-now-marker" style="left:${nowPct}%"></div>` : "";

    return `
      <div class="daily-bar-wrap">
        <div class="daily-bar" style="grid-template-columns:${cols.join(" ")}">${segments.join("")}</div>
        ${marker}
      </div>`;
  }

  // below the daily bar: either a big readout of the live period's
  // progress, a countdown to whichever (filtered) period starts next
  // today, or a status message when there's nothing left to count down to.
  function dailyStatusHtml(now) {
    const today = days.find((d) => d.date === now.dateStr);
    const periods = today ? today.periods.filter((p) => isLetterActive(today, p)) : [];
    if (!periods.length) return "";

    const live = findLivePeriod(now);
    if (live) {
      const wave = effectiveWave(today, live, now);
      const { startMinutes, endMinutes } = resolvePeriodTimes(live, wave);
      const totalMs = (endMinutes - startMinutes) * 60000;
      const elapsedMs = Math.min(totalMs, Math.max(0, (now.minutes - startMinutes) * 60000 + now.seconds * 1000 + now.ms));
      const pct = Math.round((elapsedMs / totalMs) * 100);
      return `
        <div class="daily-countdown">
          <div class="daily-countdown-label">Period ${live.label} in progress</div>
          <div class="daily-countdown-clock">${formatCountdownClock(totalMs - elapsedMs)}</div>
          <div class="daily-countdown-sub">${pct}% done</div>
        </div>`;
    }

    const upcoming = periods.find((p) => resolvePeriodTimes(p, effectiveWave(today, p, now)).startMinutes > now.minutes);
    if (!upcoming) {
      return `<div class="daily-status">School's out for today 🎉</div>`;
    }
    const { startMinutes } = resolvePeriodTimes(upcoming, effectiveWave(today, upcoming, now));
    const msToStart = (startMinutes - now.minutes) * 60000 - now.seconds * 1000 - now.ms;
    return `
      <div class="daily-countdown">
        <div class="daily-countdown-label">Next: Period ${upcoming.label}</div>
        <div class="daily-countdown-clock">${formatCountdownClock(msToStart)}</div>
      </div>`;
  }

  function dashboardHtml(now) {
    return `
      <div class="dashboard">
        <div class="dashboard-daily">
          ${dailyBarHtml(now)}
          ${dailyStatusHtml(now)}
        </div>
        <div class="dashboard-stats">
          ${nextBreakBarHtml("next-break-bar-dash")}
          ${untilWeekendBarHtml(now)}
          ${barWithSchoolDays("Academic Year", days, now, "No school")}
        </div>
      </div>`;
  }

  const CONFETTI_COLORS = ["#005588", "#88ccec", "#f59e0b", "#34d399", "#fb7185", "#a78bfa"];

  // a short burst of falling confetti pieces, for the moment a tracked
  // period finishes. Plain DOM/CSS, no canvas or library, since it only
  // needs to run for a few seconds.
  function fireConfetti() {
    const container = document.createElement("div");
    container.className = "confetti-burst";
    for (let i = 0; i < 60; i++) {
      const piece = document.createElement("div");
      piece.className = "confetti-piece";
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

  // fires once, right as a tracked period finishes (not on page load, and
  // not for periods you never see go live in the first place).
  function checkPeriodCompletion(now) {
    const live = findLivePeriod(now);
    const key = live ? `${now.dateStr}|${live.label}` : null;
    if (!key && lastLiveKey) {
      // the tracked period is no longer "live" -- but that can also happen
      // because a filter setting just changed (e.g. it's not one of "my
      // periods" anymore), not because time actually passed its end. Only
      // celebrate if it genuinely finished.
      const [prevDate, prevLabel] = lastLiveKey.split("|");
      const day = daysByDate.get(prevDate);
      const period = day && day.periods.find((p) => p.label === prevLabel);
      if (period && periodProgress(day, period, now, waveFor(prevLabel)) >= 1) fireConfetti();
    }
    lastLiveKey = key;
  }

  // Updates one Current Period bar for the current tick. Rebuilds the
  // whole node (including the wave-toggle buttons) only when the live
  // period itself has changed since the last tick; otherwise patches just
  // the percentage/fill/elapsed-remaining text in place, leaving the
  // toggle buttons (and their listeners, and any in-flight click) alone.
  function updateCurrentPeriodBar(id, now) {
    const el = document.getElementById(id);
    if (!el) return;
    const live = findLivePeriod(now);
    const key = live ? `${now.dateStr}|${live.label}` : null;

    if (key !== lastPeriodKeyById[id]) {
      el.outerHTML = currentPeriodBarHtml(id); // also syncs lastPeriodKeyById[id]
      return;
    }
    if (!live) return;

    const today = days.find((d) => d.date === now.dateStr);
    const wave = effectiveWave(today, live, now);
    const { startMinutes, endMinutes } = resolvePeriodTimes(live, wave);
    const totalMs = (endMinutes - startMinutes) * 60000;
    const elapsedMs = Math.min(totalMs, Math.max(0, (now.minutes - startMinutes) * 60000 + now.seconds * 1000 + now.ms));
    const remainingMs = totalMs - elapsedMs;
    const pct = (elapsedMs / totalMs) * 100;

    el.querySelector(".bar-pct").textContent = `${Math.round(pct)}%`;
    el.querySelector(".bar-fill").style.width = `${pct}%`;
    el.querySelector(".bar-sub").textContent = `${formatClockTenths(elapsedMs)} elapsed · ${formatClockTenths(remainingMs)} remaining`;
    el.querySelectorAll(".wave-pill").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.wave === wave);
    });
  }

  // Current Period and Next Break tick fast enough for their tenths-of-a-
  // second digit to actually move (via the interval at the bottom of
  // main()); everything else only needs the 30s full render.
  function tickCurrentPeriodBar() {
    const now = getNow();
    checkPeriodCompletion(now);
    updateCurrentPeriodBar("current-period-bar", now);
    updateCurrentPeriodBar("current-period-bar-solo", now);
    const nb = document.getElementById("next-break-bar");
    if (nb) nb.outerHTML = nextBreakBarHtml();
    // no buttons live inside the dashboard, so a full rebuild every tick
    // is safe (nothing to click, nothing to lose) -- only bother while
    // it's actually the visible tab.
    if (!dashboardEl.hidden) dashboardEl.innerHTML = dashboardHtml(now);
  }

  function untilWeekendBarHtml(now) {
    const mon = mondayOf(now.dateStr);
    const weekDays = days.filter((d) => d.periods.length && mondayOf(d.date) === mon);
    const week = progressOfFiltered(weekDays, now);
    const isLastDayOfWeek = weekDays.length > 0 && now.dateStr === weekDays[weekDays.length - 1].date;
    return barOrEmpty("Until Weekend", week, "No school this week", isLastDayOfWeek);
  }

  function renderProgress(now) {
    const semester = now.dateStr <= boundary ? 1 : 2;
    const quarter = quarterOfDate(now.dateStr, boundary, qb);

    const semDays = days.filter((d) => semester === 1 ? d.date <= boundary : d.date > boundary);
    const qDays = days.filter((d) => d.periods.length && quarterOfDate(d.date, boundary, qb) === quarter);

    const today = days.find((d) => d.date === now.dateStr);
    const dayProg = progressOfFiltered(today ? [today] : [], now);

    progressEl.classList.add("progress-list");
    progressEl.innerHTML = [
      barWithSchoolDays("Academic Year", days, now, "No school"),
      barWithSchoolDays(`Semester ${semester}`, semDays, now, "No school"),
      barWithSchoolDays(`Quarter ${quarter}`, qDays, now, "No school"),
      nextBreakBarHtml(),
      milestoneBarHtml(now),
      untilWeekendBarHtml(now),
      barOrEmpty("Today", dayProg, "No school today"),
      currentPeriodBarHtml(),
    ].join("");
  }

  // ---- render orchestration ----

  let continuousTarget = null;
  let weeklyTarget = null;

  function render() {
    const now = getNow();
    fitGridCellSize(countVisiblePeriods());
    gridContinuousEl.innerHTML = "";
    gridWeeklyEl.innerHTML = "";
    continuousTarget = buildContinuous(gridContinuousEl, now);
    weeklyTarget = buildWeekly(gridWeeklyEl, now);
    renderProgress(now);
    currentPeriodEl.classList.add("current-solo");
    currentPeriodEl.innerHTML = currentPeriodBarHtml("current-period-bar-solo");
    dashboardEl.innerHTML = dashboardHtml(now);
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });

  // ---- tabs ----
  // each tab is bookmarkable/linkable via its own #hash (e.g. index.html#continuous
  // to land straight on that view), independent of the #debug hash below.
  const tabButtons = [...document.querySelectorAll(".tab")];
  const panels = {
    progress: document.getElementById("tab-progress"),
    continuous: document.getElementById("tab-continuous"),
    weekly: document.getElementById("tab-weekly"),
    current: document.getElementById("tab-current"),
    dashboard: document.getElementById("tab-dashboard"),
  };

  function setTab(tab, opts = {}) {
    tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    Object.entries(panels).forEach(([k, el]) => { el.hidden = k !== tab; });
    if (tab === "continuous" && continuousTarget) continuousTarget.scrollIntoView({ block: "center" });
    if (tab === "weekly" && weeklyTarget) weeklyTarget.scrollIntoView({ block: "center" });
    if (!opts.fromHash) history.replaceState(null, "", "#" + tab);
  }

  tabButtons.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  function tabFromHash() {
    const h = window.location.hash.slice(1);
    return panels[h] ? h : null;
  }

  // ---- debug time (hidden unless #debug is in the URL) ----
  debugInput.addEventListener("change", () => {
    const val = debugInput.value; // "YYYY-MM-DDTHH:MM"
    if (!val) { override = null; render(); return; }
    const [datePart, timePart] = val.split("T");
    const dateStr = datePart.replace(/-/g, "");
    const [hh, mm] = timePart.split(":").map(Number);
    override = { dateStr, minutes: hh * 60 + mm };
    render();
  });

  debugLiveBtn.addEventListener("click", () => {
    override = null;
    debugInput.value = "";
    render();
  });

  // debug controls are only for testing -- keep them out of the way unless
  // explicitly requested via #debug in the URL.
  const debugBar = document.getElementById("debug-bar");
  function updateDebugVisibility() {
    debugBar.hidden = window.location.hash.toLowerCase() !== "#debug";
  }
  updateDebugVisibility();
  window.addEventListener("hashchange", () => {
    updateDebugVisibility();
    const tab = tabFromHash();
    if (tab) setTab(tab, { fromHash: true });
  });

  // ---- settings and help overlay panels ----
  applyAccent(localStorage.getItem("tv-accent") || ACCENT_COLORS[0].name);

  const overlay = document.getElementById("overlay");
  const settingsPanel = document.getElementById("settings-panel");
  const helpPanel = document.getElementById("help-panel");
  const accentRow = document.getElementById("accent-row");
  const modeButtons = [...document.querySelectorAll(".mode-btn")];
  const filterEnabledCb = document.getElementById("filter-enabled");
  const filterSplitCb = document.getElementById("filter-split");
  const lettersS1El = document.getElementById("letters-s1");
  const lettersS2El = document.getElementById("letters-s2");
  const lettersJrsrEl = document.getElementById("letters-jrsr");
  const seniorSectionEl = document.getElementById("senior-section");
  const lettersSeniorEl = document.getElementById("letters-senior");

  ACCENT_COLORS.forEach((c) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "accent-dot";
    dot.style.background = c.hex;
    dot.title = c.name;
    dot.addEventListener("click", () => {
      applyAccent(c.name);
      refreshSettingsUI();
    });
    accentRow.appendChild(dot);
  });

  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.mode);
      refreshSettingsUI();
    });
  });

  function renderLetterRow(container, selected, onToggle) {
    container.innerHTML = "";
    ALL_LETTERS.forEach((letter) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "letter-chip" + (selected.includes(letter) ? " active" : "");
      chip.textContent = letter;
      chip.addEventListener("click", () => onToggle(letter));
      container.appendChild(chip);
    });
  }

  function toggleLetter(list, letter) {
    const i = list.indexOf(letter);
    if (i === -1) list.push(letter); else list.splice(i, 1);
  }

  function refreshSettingsUI() {
    const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
    modeButtons.forEach((b) => b.classList.toggle("active", b.dataset.mode === currentTheme));
    const currentAccent = localStorage.getItem("tv-accent") || ACCENT_COLORS[0].name;
    [...accentRow.children].forEach((dot, i) => dot.classList.toggle("active", ACCENT_COLORS[i].name === currentAccent));

    filterEnabledCb.checked = filterState.enabled;
    filterSplitCb.checked = filterState.split;
    lettersS2El.hidden = !filterState.split;
    // seniors-only marking only means anything once the grid is actually
    // filtered down to specific periods -- hide it otherwise.
    seniorSectionEl.hidden = !filterState.enabled;

    renderLetterRow(lettersS1El, filterState.s1, (letter) => {
      toggleLetter(filterState.s1, letter);
      saveFilter(filterState);
      refreshSettingsUI();
      render();
    });
    renderLetterRow(lettersS2El, filterState.s2, (letter) => {
      toggleLetter(filterState.s2, letter);
      saveFilter(filterState);
      refreshSettingsUI();
      render();
    });
    renderLetterRow(lettersJrsrEl, filterState.jrsrLetters || [], (letter) => {
      filterState.jrsrLetters = filterState.jrsrLetters || [];
      toggleLetter(filterState.jrsrLetters, letter);
      saveFilter(filterState);
      refreshSettingsUI();
      render();
    });
    renderLetterRow(lettersSeniorEl, filterState.seniorLetters || [], (letter) => {
      filterState.seniorLetters = filterState.seniorLetters || [];
      toggleLetter(filterState.seniorLetters, letter);
      saveFilter(filterState);
      refreshSettingsUI();
      render();
    });
  }

  filterEnabledCb.addEventListener("change", () => {
    filterState.enabled = filterEnabledCb.checked;
    seniorSectionEl.hidden = !filterState.enabled;
    saveFilter(filterState);
    render();
  });
  filterSplitCb.addEventListener("change", () => {
    filterState.split = filterSplitCb.checked;
    lettersS2El.hidden = !filterState.split;
    saveFilter(filterState);
    render();
  });

  // event delegation, since the wave-toggle buttons only exist once a
  // period is live and get rebuilt whenever the live period changes -- a
  // listener attached directly to them could be gone by the time a real
  // click fires.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".wave-pill");
    if (!btn) return;
    liveWaveOverride = btn.dataset.wave;
    tickCurrentPeriodBar();
  });

  function openPanel(which) {
    overlay.hidden = false;
    settingsPanel.hidden = which !== "settings";
    helpPanel.hidden = which !== "help";
    if (which === "settings") refreshSettingsUI();
  }
  function closeOverlay() {
    overlay.hidden = true;
  }

  document.getElementById("settings-btn").addEventListener("click", () => openPanel("settings"));
  document.getElementById("help-btn").addEventListener("click", () => openPanel("help"));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(); });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeOverlay));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeOverlay(); });

  // ---- startup ----
  render();
  setTab(tabFromHash() || "progress", { fromHash: true });
  setInterval(render, REFRESH_MS);
  setInterval(tickCurrentPeriodBar, 100);
}

main();
