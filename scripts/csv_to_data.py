#!/usr/bin/env python3
"""Build the site's data.js (and the intermediate JSON) from the
hand-editable schedule CSV.

Run this after every edit to the CSV -- snow days, on-the-fly period
changes, whatever. It validates the sheet first and refuses to touch the
site's data if anything looks broken, so a bad edit can't silently corrupt
the live page.

An optional "quarter_end" column may mark "1" on Q1's last day and "3" on
Q3's last day (Q2 always ends at the semester boundary, Q4 at the last day
of the year, so neither needs marking). Leave it blank/omit the column to
fall back to an even split-by-period-count approximation.

On most days, one period runs twice at different clock times -- once for
freshmen/sophomores (class, then lunch) and once for juniors/seniors
(lunch, then class). Optional "split_letter"/"jrsr_start"/"jrsr_end"
columns record that day's Jr/Sr variant (the {letter}_start/{letter}_end
columns already hold the Fr/So time for that letter).

An optional "blocks" column lists the day's named non-class blocks --
Studium, Activity Period, Advisory Period, etc. -- as
"Name HH:MM-HH:MM", separated by semicolons, e.g.
"Advisory Period 09:35-10:35; Studium 10:35-11:25". They're written to
data.js as each day's "blocks" list (left off on days without any), for
displays that show the whole day rather than just the A-G classes.

An optional "senior_s2" column marks "start" on the first day seniors'
second-semester schedule resumes and "end" on their last day of classes,
for periods a teacher marks as seniors-only in Settings.

Usage: python3 csv_to_data.py <input.csv> <output.json> <output.js>
"""
import csv
import json
import os
import re
import sys
from datetime import datetime

LETTERS = ["A", "B", "C", "D", "E", "F", "G"]
TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
# one entry of the "blocks" column: "Studium 10:35-11:25"
BLOCK_RE = re.compile(r"^(.+?)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$")


def parse_time(value, row_num, field, errors):
    m = TIME_RE.match(value.strip())
    if not m:
        errors.append(f"row {row_num}: {field}=\"{value}\" is not a valid 24-hour HH:MM time")
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def process_row(row, row_num, errors, warnings):
    raw_date = row.get("date", "").strip()
    try:
        dt = datetime.strptime(raw_date, "%Y-%m-%d")
    except ValueError:
        errors.append(f"row {row_num}: date=\"{raw_date}\" is not YYYY-MM-DD")
        return None

    date_str = dt.strftime("%Y%m%d")
    computed_weekday = dt.strftime("%A")
    csv_weekday = row.get("weekday", "").strip()
    if csv_weekday and not computed_weekday.lower().startswith(csv_weekday.lower()[:3]):
        warnings.append(
            f"row {row_num} ({raw_date}): weekday column says \"{csv_weekday}\" "
            f"but the date is a {computed_weekday} -- using {computed_weekday}"
        )

    summary = row.get("summary", "").strip()

    periods = []
    for letter in LETTERS:
        start_raw = row.get(f"{letter}_start", "").strip()
        end_raw = row.get(f"{letter}_end", "").strip()
        if not start_raw and not end_raw:
            continue
        if bool(start_raw) != bool(end_raw):
            errors.append(
                f"row {row_num} ({raw_date}): period {letter} has "
                f"{'a start but no end' if start_raw else 'an end but no start'}"
            )
            continue
        start = parse_time(start_raw, row_num, f"{letter}_start", errors)
        end = parse_time(end_raw, row_num, f"{letter}_end", errors)
        if start is None or end is None:
            continue
        if end <= start:
            errors.append(f"row {row_num} ({raw_date}): period {letter} ends at or before it starts ({start_raw}-{end_raw})")
            continue
        periods.append({"label": letter, "startMinutes": start, "endMinutes": end})

    if not periods and not summary:
        warnings.append(f"row {row_num} ({raw_date}): no periods and no summary -- no reason given for the day off")

    # the school's rotation always uses a *contiguous* run of the A-G cycle
    # in a day (wrapping G->A is normal, e.g. F,G,A,B,C) -- so in time order,
    # each period's letter should be exactly the next one in the cycle.
    periods = sorted(periods, key=lambda p: p["startMinutes"])
    for i in range(1, len(periods)):
        prev_letter, cur_letter = periods[i - 1]["label"], periods[i]["label"]
        expected = LETTERS[(LETTERS.index(prev_letter) + 1) % 7]
        if cur_letter != expected:
            warnings.append(
                f"row {row_num} ({raw_date}): {prev_letter} is followed by {cur_letter} in time, "
                f"but the rotation would expect {expected} next -- double check the times/letters"
            )

    for i in range(len(periods)):
        for j in range(i + 1, len(periods)):
            a, b = periods[i], periods[j]
            if a["startMinutes"] < b["endMinutes"] and b["startMinutes"] < a["endMinutes"]:
                errors.append(
                    f"row {row_num} ({raw_date}): periods {a['label']} and {b['label']} overlap"
                )

    quarter_end = row.get("quarter_end", "").strip()
    if quarter_end and quarter_end not in ("1", "3"):
        errors.append(
            f"row {row_num} ({raw_date}): quarter_end=\"{quarter_end}\" -- only \"1\" or \"3\" make "
            f"sense here (Q2 always ends at the semester boundary, Q4 at the last day of the year)"
        )
        quarter_end = ""

    split_letter = row.get("split_letter", "").strip().upper()
    jrsr_start_raw = row.get("jrsr_start", "").strip()
    jrsr_end_raw = row.get("jrsr_end", "").strip()
    if split_letter or jrsr_start_raw or jrsr_end_raw:
        if not (split_letter and jrsr_start_raw and jrsr_end_raw):
            errors.append(
                f"row {row_num} ({raw_date}): split_letter/jrsr_start/jrsr_end must all be filled "
                f"in together, or all left blank"
            )
        elif split_letter not in LETTERS:
            errors.append(f"row {row_num} ({raw_date}): split_letter=\"{split_letter}\" is not a period letter A-G")
        else:
            match = next((p for p in periods if p["label"] == split_letter), None)
            if not match:
                errors.append(f"row {row_num} ({raw_date}): split_letter={split_letter} isn't one of this day's periods")
            else:
                jrsr_start = parse_time(jrsr_start_raw, row_num, "jrsr_start", errors)
                jrsr_end = parse_time(jrsr_end_raw, row_num, "jrsr_end", errors)
                if jrsr_start is not None and jrsr_end is not None:
                    if jrsr_end <= jrsr_start:
                        errors.append(f"row {row_num} ({raw_date}): jrsr_end is at or before jrsr_start ({jrsr_start_raw}-{jrsr_end_raw})")
                    else:
                        match["jrsrStartMinutes"] = jrsr_start
                        match["jrsrEndMinutes"] = jrsr_end

    blocks = []
    for item in filter(None, (x.strip() for x in row.get("blocks", "").split(";"))):
        m = BLOCK_RE.match(item)
        if not m:
            errors.append(f"row {row_num} ({raw_date}): blocks entry \"{item}\" should look like \"Studium 10:35-11:25\"")
            continue
        start = parse_time(m.group(2), row_num, "blocks", errors)
        end = parse_time(m.group(3), row_num, "blocks", errors)
        if start is None or end is None:
            continue
        if end <= start:
            errors.append(f"row {row_num} ({raw_date}): block \"{m.group(1)}\" ends at or before it starts")
            continue
        blocks.append({"name": m.group(1), "startMinutes": start, "endMinutes": end})
    blocks.sort(key=lambda b: b["startMinutes"])
    # a block landing on top of a class is almost certainly a typo -- but
    # schedules do get odd, so warn rather than refuse
    for b in blocks:
        for p in periods:
            if b["startMinutes"] < p["endMinutes"] and p["startMinutes"] < b["endMinutes"]:
                warnings.append(f"row {row_num} ({raw_date}): block \"{b['name']}\" overlaps period {p['label']}")

    senior_s2 = row.get("senior_s2", "").strip().lower()
    if senior_s2 and senior_s2 not in ("start", "end"):
        errors.append(f"row {row_num} ({raw_date}): senior_s2=\"{senior_s2}\" -- only \"start\" or \"end\" make sense here")
        senior_s2 = ""

    return {
        "date": date_str, "weekday": computed_weekday, "summary": summary,
        "periods": periods, "blocks": blocks, "quarter_end": quarter_end, "senior_s2": senior_s2, "row_num": row_num,
    }


def find_semester_boundary(days):
    boundary = None
    for d in days:
        if "first semester exams" in d["summary"].lower():
            boundary = d["date"]
    return boundary


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    csv_path, json_path, js_path = sys.argv[1], sys.argv[2], sys.argv[3]

    errors = []
    warnings = []
    days = []
    seen_dates = set()

    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row_num, row in enumerate(reader, start=2):  # header is row 1
            entry = process_row(row, row_num, errors, warnings)
            if entry is None:
                continue
            if entry["date"] in seen_dates:
                errors.append(f"row {row_num}: duplicate date {entry['date']}")
                continue
            seen_dates.add(entry["date"])
            days.append(entry)

    days.sort(key=lambda d: d["date"])
    boundary = find_semester_boundary(days)

    quarter_marks = {}
    for d in days:
        q = d["quarter_end"]
        if not q:
            continue
        if q in quarter_marks:
            errors.append(
                f"row {d['row_num']} ({d['date']}): another row already marked quarter_end={q} "
                f"({quarter_marks[q]}) -- only one row can mark each quarter"
            )
            continue
        if q == "1" and boundary and d["date"] > boundary:
            errors.append(f"row {d['row_num']} ({d['date']}): quarter_end=1 falls after the semester boundary ({boundary}) -- Q1 should be in semester 1")
        if q == "3" and boundary and d["date"] <= boundary:
            errors.append(f"row {d['row_num']} ({d['date']}): quarter_end=3 falls in or before semester 1 (boundary {boundary}) -- Q3 should be in semester 2")
        quarter_marks[q] = d["date"]

    senior_s2 = {}
    for d in days:
        s = d["senior_s2"]
        if not s:
            continue
        if s in senior_s2:
            errors.append(
                f"row {d['row_num']} ({d['date']}): another row already marked senior_s2={s} "
                f"({senior_s2[s]}) -- only one row can mark each"
            )
            continue
        if boundary and d["date"] <= boundary:
            errors.append(f"row {d['row_num']} ({d['date']}): senior_s2={s} falls in or before semester 1 (boundary {boundary}) -- this is a second-semester-only concept")
        senior_s2[s] = d["date"]
    if "start" in senior_s2 and "end" in senior_s2 and senior_s2["start"] > senior_s2["end"]:
        errors.append(f"senior_s2 start ({senior_s2['start']}) is after senior_s2 end ({senior_s2['end']})")

    if warnings:
        print(f"{len(warnings)} warning(s):")
        for w in warnings:
            print(f"  - {w}")

    if errors:
        print(f"\n{len(errors)} error(s) -- data.js was NOT updated:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)

    # strip the CSV-only bookkeeping fields before writing the site's data
    # ("blocks" only appears on days that have some, to keep data.js small)
    clean_days = []
    for d in days:
        clean = {"date": d["date"], "weekday": d["weekday"], "summary": d["summary"], "periods": d["periods"]}
        if d["blocks"]:
            clean["blocks"] = d["blocks"]
        clean_days.append(clean)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(clean_days, f, indent=2)
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("const SCHOOL_YEAR_DATA = ")
        json.dump(clean_days, f)
        f.write(";\n")
        f.write("const QUARTER_MARKS = ")
        json.dump(quarter_marks, f)
        f.write(";\n")
        f.write("const SENIOR_S2 = ")
        json.dump(senior_s2, f)
        f.write(";\n")

    # also drop a trimmed copy where api/period.php (the lock-screen widget
    # endpoint) can read it. Only when the api/ dir exists next to data.js,
    # so this stays a no-op for anyone who doesn't deploy the API.
    api_dir = os.path.join(os.path.dirname(os.path.abspath(js_path)), "api")
    if os.path.isdir(api_dir):
        api_path = os.path.join(api_dir, "schedule.json")
        with open(api_path, "w", encoding="utf-8") as f:
            json.dump({
                "timezone": "America/Chicago",
                "generated": int(datetime.now().timestamp()),
                "days": clean_days,
            }, f)
        print(f"  wrote {api_path} (lock-screen widget API)")

    print(f"\nOK: {len(clean_days)} days -> {json_path} and {js_path}")
    if quarter_marks:
        print(f"  explicit quarter boundaries: {quarter_marks}")
    if senior_s2:
        print(f"  senior second-semester window: {senior_s2}")


if __name__ == "__main__":
    main()
