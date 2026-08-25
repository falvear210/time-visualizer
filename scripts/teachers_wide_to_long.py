#!/usr/bin/env python3
"""Convert a wide teacher schedule CSV (one row per teacher, one column per
period, cells like "Course Name (Room)") into the long format the Math
Office dashboard actually reads (teachers.csv: name,period,room -- one row
per teacher/period, since the same teacher can be in a different room for
different periods).

The "Studium" column (a homeroom, not one of the rotating A-G periods) is
dropped -- the dashboard only tracks the lettered periods.

Usage: python3 teachers_wide_to_long.py <input_wide.csv> <output_long.csv>
"""
import csv
import re
import sys

LETTERS = ["A", "B", "C", "D", "E", "F", "G"]
ROOM_RE = re.compile(r"\(([^)]+)\)\s*$")


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    in_path, out_path = sys.argv[1], sys.argv[2]

    rows = []
    with open(in_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = f"{row['First Name'].strip()} {row['Last Name'].strip()}"
            for letter in LETTERS:
                cell = (row.get(letter) or "").strip()
                if not cell:
                    continue
                m = ROOM_RE.search(cell)
                if not m:
                    print(f"warning: {name} period {letter} (\"{cell}\") has no (Room) suffix -- skipped")
                    continue
                rows.append({"name": name, "period": letter, "room": m.group(1)})

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["name", "period", "room"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} teacher/period rows -> {out_path}")


if __name__ == "__main__":
    main()
