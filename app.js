const TIME_ZONE = "America/Chicago";
const REFRESH_MS = 30000;

const MONTH_NAMES = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];
const WEEKDAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const ALL_LETTERS = ["A", "B", "C", "D", "E", "F", "G"];

const ACCENT_COLORS = [
  { name: "blue", hex: "#5b8cff", rgb: "91, 140, 255" },
  { name: "violet", hex: "#a78bfa", rgb: "167, 139, 250" },
  { name: "green", hex: "#34d399", rgb: "52, 211, 153" },
  { name: "amber", hex: "#f59e0b", rgb: "245, 158, 11" },
  { name: "rose", hex: "#fb7185", rgb: "251, 113, 133" },
];

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

function parseDate(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  return { y, m, d };
}

function weekdayOf(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function formatFullDate(yyyymmdd, weekday) {
  const { y, m, d } = parseDate(yyyymmdd);
  return `${weekday}, ${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

function ordinal(n) {
  const suf = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (suf[(v - 20) % 10] || suf[v] || suf[0]);
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

const PREVIEW_WINDOW_START = 6 * 60; // 6:00am
const PREVIEW_WINDOW_END = 15 * 60 + 45; // 3:45pm

function inTodayPreviewWindow(now) {
  return now.minutes >= PREVIEW_WINDOW_START && now.minutes < PREVIEW_WINDOW_END;
}

function periodProgress(day, period, now) {
  if (day.date < now.dateStr) return 1;
  if (day.date > now.dateStr) return 0;
  if (now.minutes < period.startMinutes) return 0;
  if (now.minutes >= period.endMinutes) return 1;
  return (now.minutes - period.startMinutes) / (period.endMinutes - period.startMinutes);
}

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

// Annotate every period in place with its position in the rotation/semester/year,
// used by the hover info panel. Returns the totals needed for percentages.
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

function main() {
  const days = SCHOOL_YEAR_DATA;
  const boundary = findSemesterBoundary(days);
  const qb = computeQuarterBoundaries(days, boundary);
  const { yearTotal, semesterTotals, letterTotals } = computeMeta(days, boundary);
  const daysByDate = new Map(days.map((d) => [d.date, d]));

  const progressEl = document.getElementById("tab-progress");
  const gridContinuousEl = document.getElementById("grid-continuous");
  const gridWeeklyEl = document.getElementById("grid-weekly");
  const infoPanel = document.getElementById("info-panel");
  const debugInput = document.getElementById("debug-time");
  const debugLiveBtn = document.getElementById("debug-live");

  let override = null; // {dateStr, minutes} while debugging, else null
  let filterState = loadFilter();

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
    return override || nowInChicago();
  }

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

    return liveEl || todaySq;
  }

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
            contentEl.addEventListener("mouseenter", (e) => showBreakInfo(info, e));
            contentEl.addEventListener("mousemove", positionInfo);
            contentEl.addEventListener("mouseleave", hideInfo);
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

    return liveEl || todaySlot;
  }

  function barOrEmpty(label, prog, emptyText) {
    if (prog.total === 0) return bar(label, 0, emptyText);
    return bar(label, prog.pct, `${Math.round(prog.done)} of ${prog.total} periods · ${Math.round(prog.total - prog.done)} left`);
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
      barOrEmpty("This Week", week, "No school this week"),
      barOrEmpty("Today", dayProg, "No school today"),
    ].join("");
  }

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

  // --- tabs ---
  const tabButtons = [...document.querySelectorAll(".tab")];
  const panels = {
    progress: document.getElementById("tab-progress"),
    continuous: document.getElementById("tab-continuous"),
    weekly: document.getElementById("tab-weekly"),
  };

  function setTab(tab) {
    tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    Object.entries(panels).forEach(([k, el]) => { el.hidden = k !== tab; });
    if (tab === "continuous" && continuousTarget) continuousTarget.scrollIntoView({ block: "center" });
    if (tab === "weekly" && weeklyTarget) weeklyTarget.scrollIntoView({ block: "center" });
  }

  tabButtons.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  // --- debug time ---
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
  window.addEventListener("hashchange", updateDebugVisibility);

  // --- settings & help overlay ---
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

  render();
  setTab("progress");
  setInterval(render, REFRESH_MS);
}

main();
