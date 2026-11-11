#!/usr/bin/env python3
"""Import the math department's color-coded teaching schedule (.xlsx) into
the dashboard's teacher-location files, one per semester:

    python3 scripts/import_teaching_schedule.py "<Teaching Schedule>.xlsx"           # report only
    python3 scripts/import_teaching_schedule.py "<Teaching Schedule>.xlsx" --write   # write the files

The workbook has one sheet per semester ("Semester 1", "Semester2"): a row
per teacher (last name), a Studium column, then periods A-G with cells like
"Alg 1 (M209)". The GRADE of each class is only in the cell's fill color,
matched against the color key the sheet itself carries (a row with
"freshman", "sophomore", "junior", "senior", "non-math" cells). Junior and
senior classes are Jr/Sr: they meet in the later lunch wave.

What it writes (math-next/math-teachers-s1.csv / -s2.csv; name,period,room,wave):
  - If the semester's file already exists, ONLY the wave column changes:
    rooms, Studium, Activity Period and prefecting entries typed in the
    editor are kept. Differences between the file and the sheet are listed
    so they can be fixed by hand in the editor.
  - If it doesn't exist yet, it's built from the sheet. Studium rooms the
    sheet leaves blank, and Advisory and Activity Period locations, are carried over from
    the Semester 1 file; room names are spelled the way Semester 1 spells
    them (e.g. "M21" -> "M21 - iLab").
Non-math electives (gray) have no grade, so they stay Fr/So.

Standard library only (reads the .xlsx XML directly), so no installs.
"""
import csv
import io
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = {1: os.path.join(ROOT, "math-next", "math-teachers-s1.csv"),
       2: os.path.join(ROOT, "math-next", "math-teachers-s2.csv")}
PERIODS = ["A", "B", "C", "D", "E", "F", "G"]
JRSR_GRADES = {"junior", "senior"}
M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


# ---------- reading the workbook (values + fill colors) ----------

def read_workbook(path):
    """{sheet name: {(row, col letter): (text, fill rgb or None)}}"""
    z = zipfile.ZipFile(path)
    strings = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(f"{M}si"):
            strings.append("".join(t.text or "" for t in si.iter(f"{M}t")))
    styles = ET.fromstring(z.read("xl/styles.xml"))
    fills = []
    for f in styles.find(f"{M}fills"):
        pf = f.find(f"{M}patternFill")
        fg = pf.find(f"{M}fgColor") if pf is not None else None
        solid = pf is not None and pf.get("patternType") not in (None, "none")
        fills.append(fg.get("rgb")[-6:].upper() if solid and fg is not None and fg.get("rgb") else None)
    cell_fill = [fills[int(x.get("fillId", 0))] for x in styles.find(f"{M}cellXfs")]

    # sheet names in order -> sheetN.xml (this workbook's rels keep that order)
    names = [s.get("name") for s in ET.fromstring(z.read("xl/workbook.xml")).iter(f"{M}sheet")]
    sheets = {}
    for i, name in enumerate(names, start=1):
        grid = {}
        for c in ET.fromstring(z.read(f"xl/worksheets/sheet{i}.xml")).iter(f"{M}c"):
            col, row = re.match(r"([A-Z]+)(\d+)", c.get("r")).groups()
            v = c.find(f"{M}v")
            text = ""
            if v is not None:
                text = strings[int(v.text)] if c.get("t") == "s" else v.text
            grid[(int(row), col)] = ((text or "").strip(), cell_fill[int(c.get("s", 0))])
        sheets[name] = grid
    return sheets


def parse_sheet(grid):
    """-> {last name: {"Studium": room, "A": (room, grade), ...}}"""
    # the color key: cells whose text is a grade word
    key = {fill: text.lower() for (text, fill) in grid.values()
           if text.lower() in ("freshman", "sophomore", "junior", "senior", "non-math") and fill}
    # header row: the one with TEACHER in column A
    header_row = next(r for (r, c), (t, _) in grid.items() if c == "A" and t.upper() == "TEACHER")
    cols = {t: c for (r, c), (t, _) in grid.items() if r == header_row and t}
    teachers = {}
    r = header_row + 1
    while (r, "A") in grid and grid[(r, "A")][0] and not grid[(r, "A")][0].lower().startswith("teachers in"):
        last = grid[(r, "A")][0]
        entry = {"Studium": grid.get((r, cols.get("Studium", "B")), ("", None))[0]}
        for p in PERIODS:
            text, fill = grid.get((r, cols[p]), ("", None))
            if text:
                m = re.search(r"\(([^)]*)\)\s*$", text)
                entry[p] = ((m.group(1) if m else text).strip(), key.get(fill, "unknown"), text)
        teachers[last] = entry
        r += 1
    return teachers, key


# ---------- the CSV files ----------

def read_csv(path):
    rows = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for i, rec in enumerate(csv.reader(f)):
            rec = [x.strip() for x in rec]
            if i == 0 or not rec or not rec[0]:
                continue
            rows.append({"name": rec[0], "period": rec[1], "room": rec[2] if len(rec) > 2 else "",
                         "wave": rec[3] if len(rec) > 3 else ""})
    return rows


def write_csv(path, rows):
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(["name", "period", "room", "wave"])
    for r in rows:
        w.writerow([r["name"], r["period"], r["room"], r["wave"]])
    with open(path, "w", encoding="utf-8") as f:
        f.write(out.getvalue())


def last_name(full):
    return full.split()[-1]


def bare(room):
    """'*Cafeteria' -> 'Cafeteria'; 'M21 - iLab' -> 'M21' (the code part)"""
    return re.split(r"\s+-\s+", room.strip("* "))[0].strip()


# ---------- import ----------

def import_semester(sem, sheet, s1_rows, write, s1_sheet=None):
    # did this teacher have a CLASS in period p in Semester 1 (per its sheet)?
    sheet_s1_class = lambda last, p: s1_sheet is not None and p in s1_sheet.get(last, {})
    path = OUT[sem]
    print(f"\n=== Semester {sem} -> {os.path.relpath(path, ROOT)} ===")
    full_names = {last_name(r["name"]): r["name"] for r in s1_rows}
    jrsr = {(last, p) for last, e in sheet.items() for p in PERIODS if p in e and e[p][1] in JRSR_GRADES}
    unknown = sorted({e[p][2] for e in sheet.values() for p in PERIODS if p in e and e[p][1] in ("non-math", "unknown")})
    print(f"Jr/Sr classes in the sheet: {len(jrsr)}.  Left Fr/So (no grade color): {', '.join(unknown) or 'none'}")

    if os.path.exists(path):
        rows = read_csv(path)
        changed = 0
        for r in rows:
            if r["period"] not in PERIODS:
                continue
            want = "jrsr" if (last_name(r["name"]), r["period"]) in jrsr else ""
            if r["wave"] != want:
                r["wave"] = want
                changed += 1
        # Studium rooms from the sheet, for teachers the file has none for
        has_studium = {r["name"] for r in rows if r["period"] == "Studium"}
        for last, e in sorted(sheet.items()):
            name = full_names.get(last)
            if name and e["Studium"] and name not in has_studium:
                rows.append({"name": name, "period": "Studium", "room": e["Studium"], "wave": ""})
                changed += 1
                print(f"  + {last} Studium: {e['Studium']!r} (from the sheet)")
        rows.sort(key=lambda r: (r["name"], r["period"]))
        print(f"Existing file: {changed} changes (wave marks, new Studium rooms); existing rooms left as they are.")
        # differences worth a look in the editor
        have = {(last_name(r["name"]), r["period"]): r["room"] for r in rows}
        for last, e in sorted(sheet.items()):
            if last not in full_names:
                print(f"  ! {last} is in the sheet but not in the file")
            for p in PERIODS:
                room_here = have.get((last, p))
                if p in e and room_here is None:
                    print(f"  ! {last} {p}: sheet has {e[p][2]!r}, the file has no room")
                elif p in e and bare(room_here) != bare(e[p][0]):
                    print(f"  ~ {last} {p}: file {room_here!r}, sheet {e[p][2]!r}")
                elif p not in e and room_here and not room_here.startswith("*") and not room_here.endswith("*"):
                    print(f"  ~ {last} {p}: file {room_here!r}, sheet has no class")
    else:
        # spell rooms the way Semester 1 does ("M21" -> "M21 - iLab")
        spelled = {}
        for r in s1_rows:
            spelled.setdefault(bare(r["room"]), r["room"].strip("* "))
        s1_by = {(r["name"], r["period"]): r for r in s1_rows}
        rows = []
        for last, e in sorted(sheet.items(), key=lambda kv: full_names.get(kv[0], kv[0])):
            name = full_names.get(last, last)
            if last not in full_names:
                print(f"  ! {last} isn't in Semester 1: added under the last name only, fix in the editor")
            for p in PERIODS:
                if p in e:
                    rows.append({"name": name, "period": p, "room": spelled.get(e[p][0], e[p][0]),
                                 "wave": "jrsr" if (last, p) in jrsr else ""})
            studium = (e["Studium"] or (s1_by.get((name, "Studium")) or {}).get("room", "")
                       or (s1_sheet or {}).get(last, {}).get("Studium", ""))
            if studium:
                if not e["Studium"]:
                    print(f"  + {last} Studium: blank in the sheet, kept Semester 1's {studium!r}")
                rows.append({"name": name, "period": "Studium", "room": studium, "wave": ""})
            for block in ("AD", "Activity Period"):   # not in the sheet: keep Semester 1's
                kept = s1_by.get((name, block))
                if kept:
                    rows.append({**kept, "wave": ""})
            # Semester 1 locations in a FREE period (duties: "Media Center",
            # "Collab"...) carry over when the teacher is still free then
            for p in PERIODS:
                s1 = s1_by.get((name, p))
                if s1 and p not in e and not sheet_s1_class(last, p):
                    rows.append({**s1, "wave": ""})
                    print(f"  + {last} {p}: free period, kept Semester 1's {s1['room']!r} (check it still applies)")
        for last in sorted(set(full_names) - set(sheet)):
            print(f"  ! {full_names[last]} isn't in the Semester {sem} sheet: left out")
        rows.sort(key=lambda r: (r["name"], r["period"]))
        print(f"New file: {len(rows)} rows.")
    if write:
        write_csv(path, rows)
        print("Written.")
    return rows


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv
    if len(args) != 1:
        sys.exit(__doc__)
    sheets = read_workbook(args[0])
    sem_sheets = {}
    for name, grid in sheets.items():
        m = re.search(r"semester\s*(\d)", name, re.I)
        if m:
            sem_sheets[int(m.group(1))] = grid
    s1_rows = read_csv(OUT[1])
    s1_sheet = parse_sheet(sem_sheets[1])[0] if 1 in sem_sheets else None
    for sem in sorted(sem_sheets):
        sheet, key = parse_sheet(sem_sheets[sem])
        rows = import_semester(sem, sheet, s1_rows, write, s1_sheet)
        if sem == 1 and write:
            s1_rows = rows
    if not write:
        print("\n(report only -- run again with --write to save)")


if __name__ == "__main__":
    main()
