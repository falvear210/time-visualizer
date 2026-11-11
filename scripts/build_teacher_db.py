#!/usr/bin/env python3
"""One-time: build the math teacher database (data/source/math-teachers.json)
from the two things we already had:

  - math-next/math-teachers-s1.csv / -s2.csv  -- where each teacher is, by
    period (hand-edited, so its ROOM names win: "M21 - iLab", Studium rooms...)
  - data/source/math-teacher-schedule.csv    -- the scrape of support.sluh.org:
    course, course code, class size, and which rows are Prefecting.

    python3 scripts/build_teacher_db.py      # refuses to overwrite; --force to

After this, the database is the one place to edit teachers: editor/
teacher-details.html edits it, and every save rewrites the two location CSVs
from it (editor/server.py, write_location_csvs). It is NOT in git -- the
support-site data (class sizes, duties) comes from a staff-login site and the
repo is public. deploy.sh uploads it to the server, where nginx won't serve it.

The database, one slot per teacher per semester per period (no slot = free):
  {"rooms":    [{"room": "M220", "aliases": ["Computer Lab"]}],
   "teachers": [{"name", "slug", "notes",
                 "slots": [{"sem": 1, "period": "A", "kind": "class",
                            "course", "code", "room", "jrsr": bool, "size"}]}]}
kind: "class", "prefecting" (shows as *Room on the TV), or "location"
(somewhere that's neither, e.g. a Studium room).
"""
import csv
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT, "data", "source", "math-teachers.json")
SCRAPE_PATH = os.path.join(ROOT, "data", "source", "math-teacher-schedule.csv")
LOCATIONS = {sem: os.path.join(ROOT, "math-next", f"math-teachers-s{sem}.csv") for sem in (1, 2)}

# same order the editor shows them in; AD = advisory (not on the TV)
PERIOD_ORDER = ["A", "B", "C", "D", "E", "F", "G", "AD", "Studium", "Activity Period"]
CLASS_LETTERS = set("ABCDEFG")
# the quarter that stands for each semester when reading the scrape
SEMESTER_QUARTER = {1: "1", 2: "3"}


def read_locations():
    """{(name, sem, period): (room without *, had a *, jrsr)}"""
    out = {}
    for sem, path in LOCATIONS.items():
        for r in csv.DictReader(open(path, encoding="utf-8")):
            raw = r["room"].strip()
            prefect = raw.startswith("*") or raw.endswith("*")
            out[(r["name"], sem, r["period"])] = (raw.strip("*").strip(), prefect, r["wave"] == "jrsr")
    return out


def read_scrape():
    """{(name, sem, period): support-site row}, plus {name: slug}"""
    rows, slugs = {}, {}
    for r in csv.DictReader(open(SCRAPE_PATH, encoding="utf-8")):
        slugs[r["name"]] = r["slug"]
        for sem, q in SEMESTER_QUARTER.items():
            if q in r["quarters"].split():
                rows[(r["name"], sem, r["period"])] = r
    return rows, slugs


def main():
    if os.path.exists(DB_PATH) and "--force" not in sys.argv:
        sys.exit(f"{DB_PATH} already exists -- it's the one you edit now. Use --force to rebuild it.")
    locations = read_locations()
    support, slugs = read_scrape()

    teachers = {}
    added_from_support = []
    for key in sorted(set(locations) | set(support)):
        name, sem, period = key
        sup = support.get(key)
        slot = {"sem": sem, "period": period, "kind": "location", "course": "", "code": "",
                "room": "", "jrsr": False, "size": ""}
        if sup and sup["course"] != "Prefecting":
            slot.update(course=sup["course"], code=sup["code"], size=sup["size"])

        if key in locations:
            room, prefect, jrsr = locations[key]
            slot.update(room=room, jrsr=jrsr)
            # Prefecting if the file had a *, or the support site says so. The
            # site only lists duties for quarters 1-2, so a semester-2 row in
            # the same spot as a semester-1 duty counts as that duty too.
            s1 = support.get((name, 1, period))
            if (prefect or (sup and sup["course"] == "Prefecting")
                    or (sem == 2 and not sup and s1 and s1["course"] == "Prefecting" and s1["room"] == room)):
                slot["kind"] = "prefecting"
            elif sup or period in CLASS_LETTERS:
                slot["kind"] = "class"
        else:
            # only on the support site: advisory (never on the TV), or a class
            # the location files are missing
            slot.update(room=sup["room"], kind="prefecting" if sup["course"] == "Prefecting" else "class")
            if period != "AD":
                added_from_support.append(f"{name} S{sem} {period} {sup['course']}")

        t = teachers.setdefault(name, {"name": name, "slug": slugs.get(name, ""), "notes": "", "slots": []})
        t["slots"].append(slot)

    for t in teachers.values():
        t["slots"].sort(key=lambda s: (s["sem"], PERIOD_ORDER.index(s["period"])))
    db = {
        # other names people use for a room; the TV always shows the room itself
        "rooms": [{"room": "M220", "aliases": ["Computer Lab"]}],
        "teachers": sorted(teachers.values(), key=lambda t: t["name"]),
    }
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"Wrote {DB_PATH}: {len(teachers)} teachers")
    if added_from_support:
        print("Classes only the support site had (check these):\n  " + "\n  ".join(added_from_support))


if __name__ == "__main__":
    main()
