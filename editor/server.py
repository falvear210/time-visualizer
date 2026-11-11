#!/usr/bin/env python3
"""Local editor for the dashboards' data -- run it on your own computer:

    python3 editor/server.py          # then open http://localhost:8421/editor/

It serves the whole site like `python3 -m http.server` does, plus a few
POST endpoints so the editor pages can SAVE straight to the files in this
repo (a plain static server can't write files):

    POST /api/event-filter      body: the whole event-filter JSON
        -> writes data/event-filter.json, then re-filters the calendar
           (data/school-events.csv + the catalog the page lists)
    POST /api/refresh-calendar  (no body)
        -> downloads a fresh copy of the School Calendar and re-filters
    POST /api/teachers          body: {"rows": [{"name","period","room","wave"}, ...]}
        body also has "semester": 1 or 2
        -> the Teacher Locations grid. With the teacher database present it
           updates that semester in the database and rewrites both CSVs from
           it; without one, writes math-next/math-teachers-s1.csv or -s2.csv
    POST /api/teacher-db/load   (no body)
        -> returns the teacher database (data/source/math-teachers.json).
           A POST, not a plain file, so on the server it's only readable
           through the password-protected /edit/ (nginx refuses the file).
    POST /api/teacher-db        body: the whole database
        -> writes it, then rewrites both location CSVs from it

The pages call these as RELATIVE urls (api/teachers), so the same paths
work under any folder: /editor/api/teachers here, /edit/api/teachers on the
server. Any path ending in one of the routes above is accepted.

Only listens on 127.0.0.1, so nobody else on the network can reach it.

ON THE SERVER this same file also runs as a small service (see
server/editor/README.md): nginx puts a password on https://sluhtime.alvear.cl/edit/
and hands its api/ calls to this program, which then writes straight into
the live site (SITE_ROOT) -- a save shows on the TVs within a minute, no
deploy needed. deploy.sh pulls those online edits back into this repo before
it uploads, so a deploy never overwrites them. The public /editor/ copy stays
a read-only preview (preview-mode.js).
"""
import csv
import io
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# CODE_ROOT: where this program and scripts/ live. ROOT: the site whose
# files are read and written -- the same folder locally, but on the server
# the service sets SITE_ROOT to the live htdocs/ (see server/editor/).
CODE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.environ.get("SITE_ROOT") or CODE_ROOT
sys.path.insert(0, os.path.join(CODE_ROOT, "scripts"))
import school_events  # noqa: E402  (needs the sys.path line above)

FILTER_PATH = school_events.FILTER_PATH
# teacher locations, one file per semester (the dashboard picks by date)
TEACHERS_PATHS = {sem: os.path.join(ROOT, "math-next", f"math-teachers-s{sem}.csv") for sem in (1, 2)}

# periods a teacher row may name: the class letters plus the whole-school
# blocks that have their own locations (keep in sync with editor/teachers.html)
TEACHER_PERIODS = ["A", "B", "C", "D", "E", "F", "G", "Studium", "Activity Period"]

# The teacher database (see scripts/build_teacher_db.py for its shape): the
# one place teachers are edited, by editor/teacher-details.html. The location
# CSVs above are written FROM it. Not in git -- it holds support-site data.
TEACHER_DB_PATH = os.path.join(ROOT, "data", "source", "math-teachers.json")
# everything the database tracks: the TV's periods plus AD (advisory)
DB_PERIODS = ["A", "B", "C", "D", "E", "F", "G", "AD", "Studium", "Activity Period"]
SLOT_KINDS = ("class", "prefecting", "location")


def save_event_filter(body):
    flt = json.loads(body)
    # light validation: the page sends back what it loaded, so these always
    # exist unless something is badly wrong -- refuse rather than corrupt.
    if not isinstance(flt.get("categories"), list) or not isinstance(flt.get("overrides"), dict):
        raise ValueError("expected 'categories' (list) and 'overrides' (object)")
    for cat in flt["categories"]:
        if not {"id", "label", "show", "patterns"} <= cat.keys():
            raise ValueError(f"category missing fields: {cat}")
    flt["overrides"] = {t: v for t, v in sorted(flt["overrides"].items()) if v in ("show", "hide")}
    with open(FILTER_PATH, "w", encoding="utf-8") as f:
        json.dump(flt, f, indent=2, ensure_ascii=False)
        f.write("\n")
    shown, titles = school_events.rebuild(fetch=False)
    return {"shown": shown, "titles": titles}


def clean_location_rows(rows):
    """Check the grid's rows and drop empty ones -> [(name, period, room, wave)]."""
    out = []
    for r in rows:
        name, period, room, wave = (str(r.get(k, "") or "").strip() for k in ("name", "period", "room", "wave"))
        if not name or not room:
            continue  # an empty cell means "not teaching / no location"
        if period not in TEACHER_PERIODS:
            raise ValueError(f"unknown period {period!r}")
        if "," in name or "," in room:
            # the dashboard's CSV reader splits on commas without quoting
            raise ValueError(f"no commas allowed in names or rooms: {name!r} / {room!r}")
        if wave not in ("", "jrsr"):
            raise ValueError(f"unknown wave {wave!r} (expected 'jrsr' or empty)")
        if wave and len(period) != 1:
            wave = ""  # only class periods A-G have lunch waves
        out.append((name, period, room, wave))
    return out


# ---- the teacher database -------------------------------------------------

def read_teacher_db():
    with open(TEACHER_DB_PATH, encoding="utf-8") as f:
        return json.load(f)


def write_teacher_db(db):
    """Check the database, save it, and rewrite the TV's location CSVs from it."""
    if not isinstance(db.get("teachers"), list) or not isinstance(db.get("rooms"), list):
        raise ValueError("expected 'teachers' and 'rooms' lists")
    names = set()
    for t in db["teachers"]:
        name = str(t.get("name") or "").strip()
        if not name or "," in name:
            raise ValueError(f"every teacher needs a name, without commas: {name!r}")
        if name.lower() in names:
            raise ValueError(f"{name} is in the list twice")
        names.add(name.lower())
        t["name"] = name
        seen = set()
        for s in t.get("slots", []):
            if s.get("sem") not in (1, 2) or s.get("period") not in DB_PERIODS or s.get("kind") not in SLOT_KINDS:
                raise ValueError(f"{name}: bad slot {s}")
            if (s["sem"], s["period"]) in seen:
                raise ValueError(f"{name}: two entries for semester {s['sem']} period {s['period']}")
            seen.add((s["sem"], s["period"]))
            if "," in str(s.get("room") or ""):
                raise ValueError(f"{name}: no commas allowed in rooms: {s['room']!r}")
        t["slots"].sort(key=lambda s: (s["sem"], DB_PERIODS.index(s["period"])))
    db["teachers"].sort(key=lambda t: t["name"])
    with open(TEACHER_DB_PATH, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=1, ensure_ascii=False)
        f.write("\n")
    return write_location_csvs(db)


def room_namer(db):
    """A function that turns any name for a room ("Computer Lab") into the
    room itself ("M220"), from the database's rooms list."""
    canonical = {}
    for r in db.get("rooms", []):
        for alias in r.get("aliases", []):
            canonical[alias.strip().lower()] = r["room"].strip()
    return lambda room: canonical.get(room.strip().lower(), room.strip())


def write_location_csvs(db):
    """Rewrite math-teachers-s1.csv and -s2.csv (what the TV reads) from the
    database: one row per slot in a TV period, prefecting rooms get a *."""
    name_room = room_namer(db)
    counts = {}
    for sem, path in TEACHERS_PATHS.items():
        out = io.StringIO()
        out.write("name,period,room,wave\n")
        w = csv.writer(out, lineterminator="\n")
        n = 0
        for t in sorted(db["teachers"], key=lambda t: t["name"]):
            for s in sorted(t.get("slots", []), key=lambda s: DB_PERIODS.index(s["period"])):
                room = name_room(str(s.get("room") or ""))
                if s["sem"] != sem or s["period"] not in TEACHER_PERIODS or not room:
                    continue  # other semester, advisory, or no room yet
                if s["kind"] == "prefecting":
                    room = "*" + room
                wave = "jrsr" if s.get("jrsr") and len(s["period"]) == 1 and s["kind"] == "class" else ""
                w.writerow([t["name"], s["period"], room, wave])
                n += 1
        with open(path, "w", encoding="utf-8") as f:
            f.write(out.getvalue())
        counts[f"s{sem}"] = n
    return {"rows": counts}


def apply_grid_to_db(db, semester, rows):
    """The Teacher Locations grid saved one semester: copy its rooms, Jr/Sr
    switches and * marks into the database, keeping each slot's course info.
    A cell the grid left empty becomes free (advisory, which the grid doesn't
    show, is left alone)."""
    by_name = {t["name"]: t for t in db["teachers"]}
    grid = {}
    for name, period, room, wave in rows:
        grid.setdefault(name, {})[period] = (room, wave)
    for name in grid:
        if name not in by_name:  # added in the grid
            by_name[name] = {"name": name, "slug": "", "notes": "", "slots": []}
            db["teachers"].append(by_name[name])
    for name, t in by_name.items():
        cells = grid.get(name, {})
        old = {s["period"]: s for s in t["slots"] if s["sem"] == semester}
        keep = [s for s in t["slots"] if s["sem"] != semester or s["period"] not in TEACHER_PERIODS]
        for period, (raw, wave) in cells.items():
            prefect = raw.startswith("*") or raw.endswith("*")
            slot = old.get(period) or {"sem": semester, "period": period, "course": "", "code": "", "size": ""}
            if prefect:
                kind = "prefecting"
            elif slot.get("kind") in ("class", "location"):
                kind = slot["kind"]
            else:  # new, or was prefecting and lost its *
                kind = "class" if len(period) == 1 else "location"
            keep.append({**slot, "kind": kind, "room": raw.strip("*").strip(), "jrsr": wave == "jrsr"})
        t["slots"] = keep
    # a teacher with nothing left in either semester leaves the database, the
    # same way the grid drops them from the CSV
    db["teachers"] = [t for t in db["teachers"] if t["slots"]]
    return db


def load_teacher_db(body):
    if not os.path.exists(TEACHER_DB_PATH):
        raise ValueError("No teacher database yet: run  python3 scripts/build_teacher_db.py")
    return {"db": read_teacher_db()}


def save_teacher_db(body):
    return write_teacher_db(json.loads(body))


def save_teachers(body):
    data = json.loads(body)
    rows = data["rows"]
    semester = int(data.get("semester") or 1)
    if semester not in TEACHERS_PATHS:
        raise ValueError(f"unknown semester {semester!r}")
    # with the database present, it stays the one source: the grid's edits go
    # into it, and both CSVs are rewritten from it
    if os.path.exists(TEACHER_DB_PATH):
        result = write_teacher_db(apply_grid_to_db(read_teacher_db(), semester, clean_location_rows(rows)))
        return {"rows": result["rows"][f"s{semester}"]}
    out = io.StringIO()
    # wave: "jrsr" for a Jr/Sr class (meets in the later lunch wave), else
    # empty (Fr/So). Only class periods have waves.
    out.write("name,period,room,wave\n")
    w = csv.writer(out, lineterminator="\n")
    kept = clean_location_rows(rows)
    w.writerows(kept)
    with open(TEACHERS_PATHS[semester], "w", encoding="utf-8") as f:
        f.write(out.getvalue())
    return {"rows": len(kept)}


ROUTES = {
    "/api/event-filter": save_event_filter,
    "/api/refresh-calendar": lambda body: dict(zip(("shown", "titles"), school_events.rebuild(fetch=True))),
    "/api/teachers": save_teachers,
    "/api/teacher-db/load": load_teacher_db,
    "/api/teacher-db": save_teacher_db,
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # always serve fresh copies -- these are files we're editing
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        # On the server, nginx serves the pages itself; this service only
        # takes Saves. Refuse to serve files there, so nothing in htdocs
        # (e.g. the stats key) can ever be read through it.
        if os.environ.get("SITE_ROOT"):
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if os.environ.get("SITE_ROOT"):
            self.send_error(404)
            return
        super().do_HEAD()

    def do_POST(self):
        # match on the ending, so /api/x, /editor/api/x and /edit/api/x all work
        path = self.path.split("?")[0]
        route = next((fn for name, fn in ROUTES.items() if path.endswith(name)), None)
        if not route:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8")
        try:
            result, status = {"ok": True, **route(body)}, 200
        except Exception as e:  # report any failure to the page instead of crashing
            result, status = {"ok": False, "error": str(e)}, 400
        payload = json.dumps(result).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8421"))
    print(f"Editor running at http://localhost:{port}/editor/  (Ctrl-C to stop)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
