#!/usr/bin/env python3
"""Pull the SLUH "School Calendar" (the big public Google Calendar) and keep
only the events everyone in a department office cares about: Masses,
assemblies, faculty/department meetings, late starts, no-school days and
breaks, exams, grade deadlines, conferences, early dismissals, and so on.

Writes data/school-events.csv, which the wall displays fetch at runtime.

Usage:
    python3 scripts/school_events.py              # download fresh, then filter
    python3 scripts/school_events.py --offline    # re-filter the saved copy

Re-run whenever the calendar changes. The CSV is REGENERATED every time, so
don't hand-edit it -- choose what shows on the event filter page (editor/).
Pass --report to also print every hidden title (handy for
checking the filter after the calendar gets a batch of new entries).

Only the Python standard library is used. Recurring events (e.g. "First
Friday Mass", entered once as "every first Friday") are expanded here,
including their skipped dates (EXDATE) and one-off moved/edited dates
(RECURRENCE-ID).
"""
import csv
import json
import os
import re
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

CAL_ID = "sluh.org_puustjlg2fanhl18qpavr6jp1c@group.calendar.google.com"
ICS_URL = f"https://calendar.google.com/calendar/ical/{CAL_ID.replace('@', '%40')}/public/basic.ics"

# The site folder whose files get read and written. Normally this repo; on
# the server the editor's save service sets SITE_ROOT to the live htdocs/.
ROOT = os.environ.get("SITE_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_PATH = os.path.join(ROOT, "data", "source", "school_calendar_raw.ics")
OUT_PATH = os.path.join(ROOT, "data", "school-events.csv")

# Only this window is written out (the current school year, through summer).
WINDOW_START = date(2026, 8, 1)
WINDOW_END = date(2027, 6, 30)

CHICAGO = ZoneInfo("America/Chicago")

# ---------------------------------------------------------------------------
# The filter lives in data/event-filter.json (shared, so other dashboards and
# calendars can use the same choices), edited with the event filter page in
# editor/. Each event title falls into the FIRST category whose pattern
# matches it; it's shown when its category is switched on, unless the title
# has its own "show"/"hide" override.
# ---------------------------------------------------------------------------
FILTER_PATH = os.path.join(ROOT, "data", "event-filter.json")
# every title in the calendar with its category -- what the filter page lists
CATALOG_PATH = os.path.join(ROOT, "data", "source", "school-events-catalog.json")


def load_filter(path=FILTER_PATH):
    with open(path, encoding="utf-8") as f:
        flt = json.load(f)
    for cat in flt["categories"]:
        cat["_res"] = [re.compile(p, re.IGNORECASE) for p in cat["patterns"]]
    flt.setdefault("overrides", {})
    return flt


def unescape(title):
    """ICS escapes commas and semicolons; titles are compared unescaped."""
    return title.replace("\\,", ",").replace("\\;", ";").strip()


def categorize(title, flt):
    for cat in flt["categories"]:
        if any(r.search(title) for r in cat["_res"]):
            return cat
    return flt["categories"][-1]  # no match at all: the last ("Everything else")


def is_shown(title, flt):
    override = flt["overrides"].get(title)
    if override in ("show", "hide"):
        return override == "show"
    return bool(categorize(title, flt)["show"])


def clean_title(title):
    """Tidy calendar shorthand into something readable on a wall display."""
    t = unescape(title)
    # "Mass Schedule-Mass of Praise and Gratitude" -> "Mass of Praise and Gratitude"
    t = re.sub(r"^Mass Schedule-", "", t)
    # "Assembly Schedule-Voices of SLUH" -> "Assembly: Voices of SLUH"
    t = re.sub(r"^Assembly Schedule-", "Assembly: ", t)
    # "Late Start-Faculty Meeting" -> "Late Start · Faculty Meeting"
    t = re.sub(r"^Late Start-", "Late Start · ", t)
    t = re.sub(r"^No School-", "No School · ", t)
    t = re.sub(r"\s+", " ", t)
    return t


# ---------------------------------------------------------------------------
# Minimal ICS reading. Unlike scripts/parse_ics.py (built for the day-schedule
# calendar), this keeps property parameters (TZID, VALUE=DATE) and repeated
# properties (EXDATE), which recurring events need.
# ---------------------------------------------------------------------------
def read_events(raw):
    """Return a list of events; each is {NAME: [(params, value), ...]}."""
    lines = raw.replace("\r\n", "\n").split("\n")
    unfolded = []
    for line in lines:
        if line.startswith((" ", "\t")) and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)

    events, cur = [], None
    for line in unfolded:
        if line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT":
            if cur is not None:
                events.append(cur)
            cur = None
        elif cur is not None and ":" in line:
            key, _, value = line.partition(":")
            name, *param_parts = key.split(";")
            params = dict(p.split("=", 1) for p in param_parts if "=" in p)
            cur.setdefault(name, []).append((params, value))
    return events


def parse_when(params, value):
    """An ICS date/time -> (local Chicago datetime, is_all_day)."""
    if params.get("VALUE") == "DATE" or len(value) == 8:
        d = datetime.strptime(value[:8], "%Y%m%d")
        return d.replace(tzinfo=CHICAGO), True
    if value.endswith("Z"):
        dt = datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    else:
        tz = ZoneInfo(params.get("TZID", "America/Chicago"))
        dt = datetime.strptime(value, "%Y%m%dT%H%M%S").replace(tzinfo=tz)
    return dt.astimezone(CHICAGO), False


# ---------------------------------------------------------------------------
# Recurrence expansion: just the RRULE shapes this calendar actually uses
# (DAILY / WEEKLY with BYDAY / MONTHLY with BYDAY like "1FR" or BYMONTHDAY,
# YEARLY), with UNTIL, COUNT and INTERVAL.
# ---------------------------------------------------------------------------
WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


def nth_weekday_of_month(year, month, weekday, n):
    """The n-th (1-based; -1 = last) given weekday of a month, or None."""
    if n > 0:
        d = date(year, month, 1)
        d += timedelta(days=(weekday - d.weekday()) % 7)
        d += timedelta(weeks=n - 1)
        return d if d.month == month else None
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    d = nxt - timedelta(days=1)
    d -= timedelta(days=(d.weekday() - weekday) % 7)
    d -= timedelta(weeks=-n - 1)
    return d if d.month == month else None


def expand_rrule(start, rule_text, hard_stop):
    """Yield every occurrence start (local datetime) of a recurring event."""
    rule = dict(part.split("=", 1) for part in rule_text.split(";") if "=" in part)
    freq = rule.get("FREQ")
    interval = int(rule.get("INTERVAL", "1"))
    count = int(rule["COUNT"]) if "COUNT" in rule else None
    until = None
    if "UNTIL" in rule:
        until, _ = parse_when({}, rule["UNTIL"])
        if len(rule["UNTIL"]) == 8:
            until += timedelta(days=1) - timedelta(seconds=1)  # whole UNTIL day counts
    stop = min(hard_stop, until) if until else hard_stop

    def at(d):  # a date at the event's original wall-clock time
        return datetime.combine(d, start.timetz().replace(tzinfo=None), CHICAGO)

    candidates = []
    if freq == "DAILY":
        d = start.date()
        while at(d) <= stop:
            candidates.append(at(d))
            d += timedelta(days=interval)
    elif freq == "WEEKLY":
        days = [WEEKDAYS[x] for x in rule.get("BYDAY", "").split(",") if x] or [start.weekday()]
        week = start.date() - timedelta(days=start.weekday())
        while at(week) <= stop:
            for wd in sorted(days):
                candidates.append(at(week + timedelta(days=wd)))
            week += timedelta(weeks=interval)
    elif freq == "MONTHLY":
        y, m = start.year, start.month
        while at(date(y, m, 1)) <= stop:
            if "BYDAY" in rule:
                for spec in rule["BYDAY"].split(","):
                    mm = re.match(r"(-?\d+)?([A-Z]{2})", spec)
                    n = int(mm.group(1) or "1")
                    d = nth_weekday_of_month(y, m, WEEKDAYS[mm.group(2)], n)
                    if d:
                        candidates.append(at(d))
            else:
                day = int(rule.get("BYMONTHDAY", start.day))
                try:
                    candidates.append(at(date(y, m, day)))
                except ValueError:
                    pass  # e.g. the 31st in a 30-day month
            m += interval
            y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
    elif freq == "YEARLY":
        y = start.year
        while at(date(y, 1, 1)) <= stop:
            try:
                candidates.append(at(start.date().replace(year=y)))
            except ValueError:
                pass
            y += interval
    else:
        candidates.append(start)  # unknown shape: just the first occurrence

    emitted = 0
    for c in sorted(candidates):
        if c < start or c > stop:
            continue
        yield c
        emitted += 1
        if count is not None and emitted >= count:
            return


# ---------------------------------------------------------------------------
# Turning events into rows.
# ---------------------------------------------------------------------------
def occurrences(events):
    """Every (start, end, all_day, title) occurrence, recurrences expanded."""
    hard_stop = datetime.combine(WINDOW_END, datetime.max.time(), CHICAGO)

    # One-off edits of a recurring event share its UID and carry the
    # RECURRENCE-ID of the occurrence they replace.
    overridden = set()
    for ev in events:
        if "RECURRENCE-ID" in ev:
            p, v = ev["RECURRENCE-ID"][0]
            overridden.add((ev["UID"][0][1], parse_when(p, v)[0]))

    for ev in events:
        if "DTSTART" not in ev or "SUMMARY" not in ev:
            continue
        if ev.get("STATUS", [({}, "")])[0][1] == "CANCELLED":
            continue
        title = unescape(ev["SUMMARY"][0][1])
        start, all_day = parse_when(*ev["DTSTART"][0])
        if "DTEND" in ev:
            end, _ = parse_when(*ev["DTEND"][0])
        else:
            end = start + (timedelta(days=1) if all_day else timedelta(0))
        length = end - start
        uid = ev.get("UID", [({}, "")])[0][1]

        if "RRULE" in ev and "RECURRENCE-ID" not in ev:
            skipped = set()
            for p, v in ev.get("EXDATE", []):
                for one in v.split(","):
                    skipped.add(parse_when(p, one)[0])
            for occ in expand_rrule(start, ev["RRULE"][0][1], hard_stop):
                if occ in skipped or (uid, occ) in overridden:
                    continue
                yield occ, occ + length, all_day, title
        else:
            yield start, end, all_day, title


def in_window(start, end, all_day):
    last_day = (end - timedelta(days=1)).date() if all_day else end.date()
    return not (last_day < WINDOW_START or start.date() > WINDOW_END), last_day


def to_rows(events, flt):
    rows = {}
    for start, end, all_day, title in occurrences(events):
        inside, last_day = in_window(start, end, all_day)
        if not inside or not is_shown(title, flt):
            continue
        name = clean_title(title)
        row = {
            "date": start.strftime("%Y%m%d"),
            "end_date": last_day.strftime("%Y%m%d") if last_day > start.date() else "",
            "time": "" if all_day else start.strftime("%H:%M"),
            "name": name,
        }
        # the calendar often lists the same thing twice (e.g. "Mass of X" and
        # "Mass Schedule-Mass of X"); keep one per day + name, preferring the
        # copy that has a time.
        key = (row["date"], name.lower())
        if key not in rows or (row["time"] and not rows[key]["time"]):
            rows[key] = row
    return sorted(rows.values(), key=lambda r: (r["date"], r["time"] or "00:00", r["name"]))


def catalog(events, flt):
    """Every distinct title this school year, with its category and dates --
    the list the event filter page shows."""
    by_title = {}
    for start, end, all_day, title in occurrences(events):
        inside, last_day = in_window(start, end, all_day)
        if not inside:
            continue
        entry = by_title.setdefault(title, {
            "title": title,
            "name": clean_title(title),
            "category": categorize(title, flt)["id"],
            "dates": [],
        })
        entry["dates"].append(start.strftime("%Y%m%d"))
    for entry in by_title.values():
        entry["dates"] = sorted(set(entry["dates"]))
    return sorted(by_title.values(), key=lambda e: (e["dates"][0], e["title"]))


HEADER = """# Important school-wide dates -- GENERATED by scripts/school_events.py from
# the SLUH "School Calendar" Google Calendar, filtered by data/event-filter.json.
# Don't hand-edit: change what's shown on the event filter page
# (python3 editor/server.py) or re-run the script. Read by /math-next/.
#   date, end_date: YYYYMMDD (end_date only for multi-day events, inclusive)
#   time: HH:MM 24-hour, empty for all-day events
"""


def download():
    print(f"Downloading {ICS_URL}")
    with urllib.request.urlopen(ICS_URL, timeout=60) as resp:
        data = resp.read().decode("utf-8")
    with open(RAW_PATH, "w", encoding="utf-8") as f:
        f.write(data)


def rebuild(fetch=False):
    """Re-filter the saved calendar (downloading a fresh copy first when
    fetch=True); writes the dashboards' CSV and the filter page's catalog.
    Returns (events shown, distinct titles). The editor server calls this."""
    if fetch:
        download()
    with open(RAW_PATH, encoding="utf-8") as f:
        events = list(read_events(f.read()))
    flt = load_filter()

    rows = to_rows(events, flt)
    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        f.write(HEADER)
        w = csv.DictWriter(f, fieldnames=["date", "end_date", "time", "name"])
        w.writeheader()
        w.writerows(rows)

    titles = catalog(events, flt)
    with open(CATALOG_PATH, "w", encoding="utf-8") as f:
        json.dump({"generated": datetime.now(CHICAGO).isoformat(timespec="seconds"), "titles": titles}, f, indent=1)
    return len(rows), len(titles)


def main():
    shown, titles = rebuild(fetch="--offline" not in sys.argv)
    print(f"Wrote {shown} events to {os.path.relpath(OUT_PATH, ROOT)} "
          f"({titles} distinct titles in {os.path.relpath(CATALOG_PATH, ROOT)})")
    if "--report" in sys.argv:
        flt = load_filter()
        with open(CATALOG_PATH, encoding="utf-8") as f:
            for e in json.load(f)["titles"]:
                if not is_shown(e["title"], flt):
                    print(f"  hidden [{e['category']}] {e['title']}")


if __name__ == "__main__":
    main()
