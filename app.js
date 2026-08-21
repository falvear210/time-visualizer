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
const DEFAULT_FILTER = { enabled: false, split: false, s1: ["A", "B", "D", "G"], s2: ["A", "B", "D", "G"] };

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

// 0 (hasn't happened), 1 (fully done), or a fraction in between for the
// currently-live period.
function periodProgress(day, period, now) {
  if (day.date < now.dateStr) return 1;
  if (day.date > now.dateStr) return 0;
  if (now.minutes < period.startMinutes) return 0;
  if (now.minutes >= period.endMinutes) return 1;
  return (now.minutes - period.startMinutes) / (period.endMinutes - period.startMinutes);
}

// sums periodProgress() across a list of days, for the Progress tab's bars.
function progressOf(dayList, now) {
  let total = 0, done = 0;
  for (const day of dayList) {
    for (const p of day.periods) {
      total += 1;
      done += periodProgress(day, p, now);
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

function daysBetween(a, b) {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8));
  return Math.round((db - da) / 86400000);
}

// "3d 4h 05m 09.3s" style countdown, for the Next Break bar's live timer.
// The tenths digit is pure comedy -- nobody needs a break countdown this
// precise, which is exactly the point.
function formatCountdownTenths(totalMs) {
  totalMs = Math.max(0, Math.round(totalMs));
  const d = Math.floor(totalMs / 86400000);
  const h = Math.floor((totalMs % 86400000) / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const tenths = Math.floor((totalMs % 1000) / 100);
  const parts = [];
  if (d) parts.push(`${d}d`);
  parts.push(`${h}h`, `${String(m).padStart(d || h ? 2 : 1, "0")}m`, `${String(s).padStart(2, "0")}.${tenths}s`);
  return parts.join(" ");
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

function bar(label, pct, sub) {
  const clamped = Math.max(0, Math.min(100, pct));
  return `
    <div class="bar-row">
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
  const gridContinuousEl = document.getElementById("grid-continuous");
  const gridWeeklyEl = document.getElementById("grid-weekly");
  const infoPanel = document.getElementById("info-panel");
  const debugInput = document.getElementById("debug-time");
  const debugLiveBtn = document.getElementById("debug-live");

  let override = null; // {dateStr, minutes} while debugging, else null
  let filterState = loadFilter();

  // ---- "my periods" filter ----

  function isLetterActive(day, letter) {
    if (!filterState.enabled) return true;
    const sem = day.date <= boundary ? "s1" : "s2";
    const set = filterState.split && sem === "s2" ? filterState.s2 : filterState.s1;
    return set.includes(letter);
  }

  // same shape progressOf() expects, but with non-matching periods dropped
  // when the "my periods" filter is on.
  function progressOfFiltered(dayList, now) {
    if (!filterState.enabled) return progressOf(dayList, now);
    const mapped = dayList.map((d) => ({
      date: d.date,
      periods: d.periods.filter((p) => isLetterActive(d, p.label)),
    }));
    return progressOf(mapped, now);
  }

  function countVisiblePeriods() {
    let count = 0;
    for (const day of days) {
      for (const p of day.periods) {
        if (isLetterActive(day, p.label)) count += 1;
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
    if (!isLetterActive(day, p.label)) sq.classList.add("is-filtered");

    const fill = document.createElement("div");
    fill.className = "period-fill";
    const progress = periodProgress(day, p, now);
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

  function barOrEmpty(label, prog, emptyText) {
    if (prog.total === 0) return bar(label, 0, emptyText);
    return bar(label, prog.pct, `${Math.round(prog.done)} of ${prog.total} periods · ${Math.round(prog.total - prog.done)} left`);
  }

  function findLivePeriod(now) {
    const today = days.find((d) => d.date === now.dateStr);
    if (!today) return null;
    for (const p of today.periods) {
      if (!isLetterActive(today, p.label)) continue;
      const prog = periodProgress(today, p, now);
      if (prog > 0 && prog < 1) return p;
    }
    return null;
  }

  function currentPeriodBarHtml() {
    const now = getNow();
    const live = findLivePeriod(now);

    if (!live) {
      return `
        <div class="bar-row" id="current-period-bar">
          <div class="bar-top"><div class="bar-label">Current Period</div><div class="bar-pct">—</div></div>
          <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
          <div class="bar-sub">No period in progress</div>
        </div>`;
    }

    const totalMs = (live.endMinutes - live.startMinutes) * 60000;
    const elapsedMs = Math.min(totalMs, Math.max(0, (now.minutes - live.startMinutes) * 60000 + now.seconds * 1000 + now.ms));
    const remainingMs = totalMs - elapsedMs;
    const pct = (elapsedMs / totalMs) * 100;

    return `
      <div class="bar-row" id="current-period-bar">
        <div class="bar-top"><div class="bar-label">Current Period — ${live.label}</div><div class="bar-pct">${Math.round(pct)}%</div></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-sub">${formatClockTenths(elapsedMs)} elapsed · ${formatClockTenths(remainingMs)} remaining</div>
      </div>`;
  }

  // For tired teachers: how far through the current stretch we are until
  // the next break of 3+ calendar days (PD days don't count as part of a
  // break -- they're a workday, so they can't extend or create one).
  function nextBreakBarHtml() {
    const now = getNow();

    let nb = null;
    for (const b of qualifyingBreaks) {
      if (b.end >= now.dateStr) { nb = b; break; }
    }

    if (!nb) {
      return `
        <div class="bar-row" id="next-break-bar">
          <div class="bar-top"><div class="bar-label">Next Break (3+ days)</div><div class="bar-pct">—</div></div>
          <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
          <div class="bar-sub">No more qualifying breaks left this year</div>
        </div>`;
    }

    const name = breakName(nb.start, nb.end, daysByDate);
    const onBreak = nb.start <= now.dateStr && now.dateStr <= nb.end;

    if (onBreak) {
      return `
        <div class="bar-row" id="next-break-bar">
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
    const periodsLeft = Math.max(0, Math.round(prog.total - prog.done));
    const pct = prog.total ? (prog.done / prog.total) * 100 : 100;

    const lastSchoolDay = [...days].reverse().find((d) => d.periods.length && d.date < nb.start);
    let ms = 0;
    if (lastSchoolDay) {
      const lastPeriod = lastSchoolDay.periods[lastSchoolDay.periods.length - 1];
      ms = daysBetween(now.dateStr, lastSchoolDay.date) * 86400000
        + (lastPeriod.endMinutes * 60000 - (now.minutes * 60000 + now.seconds * 1000 + now.ms));
    }

    return `
      <div class="bar-row" id="next-break-bar">
        <div class="bar-top"><div class="bar-label">Next Break (3+ days) — ${name}</div><div class="bar-pct">${Math.round(pct)}%</div></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-sub">${periodsLeft} periods · ${formatCountdownTenths(ms)} to go</div>
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
      return bar("Until Winter Break", prog.pct, `${left} school day${left === 1 ? "" : "s"} left`);
    }

    if (now.dateStr <= winterBreak.end) {
      return bar("Winter Break", 100, "Enjoy the holidays — you earned it.");
    }

    const stretch = days.filter((d) => d.periods.length && d.date > winterBreak.end);
    const prog = schoolDayProgress(stretch, now);
    const left = Math.max(0, Math.round(prog.total - prog.done));
    return bar("Until End of Year", prog.pct, `${left} school day${left === 1 ? "" : "s"} left`);
  }

  // Current Period and Next Break tick fast enough for their tenths-of-a-
  // second digit to actually move (via the interval at the bottom of
  // main()); everything else only needs the 30s full render.
  function tickCurrentPeriodBar() {
    const el = document.getElementById("current-period-bar");
    if (el) el.outerHTML = currentPeriodBarHtml();
    const nb = document.getElementById("next-break-bar");
    if (nb) nb.outerHTML = nextBreakBarHtml();
  }

  function renderProgress(now) {
    const semester = now.dateStr <= boundary ? 1 : 2;
    const quarter = quarterOfDate(now.dateStr, boundary, qb);

    const year = progressOfFiltered(days, now);
    const semDays = days.filter((d) => semester === 1 ? d.date <= boundary : d.date > boundary);
    const sem = progressOfFiltered(semDays, now);
    const qDays = days.filter((d) => d.periods.length && quarterOfDate(d.date, boundary, qb) === quarter);
    const q = progressOfFiltered(qDays, now);

    const mon = mondayOf(now.dateStr);
    const weekDays = days.filter((d) => d.periods.length && mondayOf(d.date) === mon);
    const week = progressOfFiltered(weekDays, now);

    const today = days.find((d) => d.date === now.dateStr);
    const dayProg = progressOfFiltered(today ? [today] : [], now);

    progressEl.classList.add("progress-list");
    progressEl.innerHTML = [
      barOrEmpty("Academic Year", year, "No school"),
      barOrEmpty(`Semester ${semester}`, sem, "No school"),
      barOrEmpty(`Quarter ${quarter}`, q, "No school"),
      nextBreakBarHtml(),
      milestoneBarHtml(now),
      barOrEmpty("This Week", week, "No school this week"),
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
  }

  filterEnabledCb.addEventListener("change", () => {
    filterState.enabled = filterEnabledCb.checked;
    saveFilter(filterState);
    render();
  });
  filterSplitCb.addEventListener("change", () => {
    filterState.split = filterSplitCb.checked;
    lettersS2El.hidden = !filterState.split;
    saveFilter(filterState);
    render();
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
