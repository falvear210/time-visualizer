#!/usr/bin/env python3
"""Build the site's data.js (and the intermediate JSON) from the
hand-editable schedule CSV.

Run this after every edit to the CSV -- snow days, on-the-fly period
changes, whatever. It validates the sheet first and refuses to touch the
site's data if anything looks broken, so a bad edit can't silently corrupt
the live page.

Usage: python3 csv_to_data.py <input.csv> <output.json> <output.js>
"""
import csv
import json
import re
import sys
from datetime import datetime

LETTERS = ["A", "B", "C", "D", "E", "F", "G"]
TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class RowIssue(Exception):
    pass


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

    return {"date": date_str, "weekday": computed_weekday, "summary": summary, "periods": periods}


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

    if warnings:
        print(f"{len(warnings)} warning(s):")
        for w in warnings:
            print(f"  - {w}")

    if errors:
        print(f"\n{len(errors)} error(s) -- data.js was NOT updated:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)

    days.sort(key=lambda d: d["date"])

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(days, f, indent=2)
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("const SCHOOL_YEAR_DATA = ")
        json.dump(days, f)
        f.write(";\n")

    print(f"\nOK: {len(days)} days -> {json_path} and {js_path}")


if __name__ == "__main__":
    main()
