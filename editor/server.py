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
    POST /api/teachers          body: {"rows": [{"name","period","room"}, ...]}
        -> writes math-next/math-teachers.csv

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
TEACHERS_PATH = os.path.join(ROOT, "math-next", "math-teachers.csv")

# periods a teacher row may name: the class letters plus the whole-school
# blocks that have their own locations (keep in sync with editor/teachers.html)
TEACHER_PERIODS = ["A", "B", "C", "D", "E", "F", "G", "Studium"]


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


def save_teachers(body):
    rows = json.loads(body)["rows"]
    out = io.StringIO()
    out.write("name,period,room\n")
    w = csv.writer(out, lineterminator="\n")
    kept = 0
    for r in rows:
        name, period, room = (str(r.get(k, "")).strip() for k in ("name", "period", "room"))
        if not name or not room:
            continue  # an empty cell means "not teaching / no location"
        if period not in TEACHER_PERIODS:
            raise ValueError(f"unknown period {period!r}")
        if "," in name or "," in room:
            # the dashboard's CSV reader splits on commas without quoting
            raise ValueError(f"no commas allowed in names or rooms: {name!r} / {room!r}")
        w.writerow([name, period, room])
        kept += 1
    with open(TEACHERS_PATH, "w", encoding="utf-8") as f:
        f.write(out.getvalue())
    return {"rows": kept}


ROUTES = {
    "/api/event-filter": save_event_filter,
    "/api/refresh-calendar": lambda body: dict(zip(("shown", "titles"), school_events.rebuild(fetch=True))),
    "/api/teachers": save_teachers,
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
