#!/usr/bin/env python3
"""Bootstrap a human-editable CSV schedule from the SLUH public ICS feed.

Run this ONCE per academic year, when the new calendar is published. After
that, the CSV is the source of truth for the year -- hand-edit it directly
for snow days, on-the-fly schedule changes, etc. Re-running this script
will NOT overwrite an existing CSV (use --force if you really mean to
replace it and are prepared to lose any hand edits).

Usage: python3 ics_to_csv.py <input.ics> <output.csv> [--from YYYYMMDD] [--to YYYYMMDD] [--force]
"""
import csv
import os
import sys
from datetime import datetime

from parse_ics import parse_events, parse_periods

LETTERS = ["A", "B", "C", "D", "E", "F", "G"]


def minutes_to_hhmm(m):
    h, mm = divmod(m, 60)
    return f"{h:02d}:{mm:02d}"


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    in_path, out_path = sys.argv[1], sys.argv[2]
    date_from = date_to = None
    force = "--force" in sys.argv
    for i, arg in enumerate(sys.argv):
        if arg == "--from":
            date_from = sys.argv[i + 1]
        if arg == "--to":
            date_to = sys.argv[i + 1]

    if os.path.exists(out_path) and not force:
        print(f"Refusing to overwrite existing {out_path} (pass --force to replace it).")
        print("If the school published an updated calendar, generate to a new file")
        print("and diff/merge by hand so you don't lose any edits already made.")
        sys.exit(1)

    raw = open(in_path, encoding="utf-8").read()
    events = parse_events(raw)

    days = {}
    for ev in events:
        dtstart = ev.get("DTSTART")
        if not dtstart or len(dtstart) < 8:
            continue
        d = dtstart[:8]
        if date_from and d < date_from:
            continue
        if date_to and d > date_to:
            continue
        summary = ev.get("SUMMARY", "").strip()
        description = ev.get("DESCRIPTION", "").strip()
        periods = parse_periods(description)
        entry = {"date": d, "summary": summary, "periods": periods}
        if d not in days or (not days[d]["periods"] and periods):
            days[d] = entry

    header = ["date", "weekday", "summary"]
    for letter in LETTERS:
        header += [f"{letter}_start", f"{letter}_end"]
    header += ["quarter_end", "split_letter", "jrsr_start", "jrsr_end", "senior_s2"]

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        for d in sorted(days):
            entry = days[d]
            iso_date = datetime.strptime(d, "%Y%m%d").strftime("%Y-%m-%d")
            weekday = datetime.strptime(d, "%Y%m%d").strftime("%A")
            by_letter = {p["label"]: p for p in entry["periods"]}
            row = [iso_date, weekday, entry["summary"]]
            split_letter, jrsr_start, jrsr_end = "", "", ""
            for letter in LETTERS:
                p = by_letter.get(letter)
                if p:
                    row += [minutes_to_hhmm(p["startMinutes"]), minutes_to_hhmm(p["endMinutes"])]
                    if "jrsrStartMinutes" in p:
                        split_letter = letter
                        jrsr_start = minutes_to_hhmm(p["jrsrStartMinutes"])
                        jrsr_end = minutes_to_hhmm(p["jrsrEndMinutes"])
                else:
                    row += ["", ""]
            row.append("")  # quarter_end: fill in by hand once real dates are known
            row += [split_letter, jrsr_start, jrsr_end]
            row.append("")  # senior_s2: fill in by hand once real dates are known
            writer.writerow(row)

    print(f"Wrote {len(days)} days -> {out_path}")


if __name__ == "__main__":
    main()
