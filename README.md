# SLUH Time Visualizer

A single-page, no-build website that shows the shape of the school year as a
grid of squares — one per class period — filling in as the day, week,
semester, and year progress. Meant to be bookmarked as a start page.

## What it does

The page has three tabs:

- **Progress** — stacked progress bars for Academic Year, current Semester,
  current Quarter, This Week, and Today. Each shows percent complete and
  periods left, updating live.
- **Continuous** — every period of the year in one seamless grid, in order.
  No gaps between days. Hover a square to see its date and where it sits in
  the semester/year; during the school day (6:00am–3:45pm) today's
  not-yet-started periods get a distinct shade so you can see the day's
  shape before it starts.
- **Weekly** — the same data laid out as one row per calendar week, Mon–Fri
  as fixed columns. A short week (holiday, etc.) shows as visibly empty
  columns instead of just vanishing. Hovering an empty column that has a
  reason on the calendar (Labor Day, a retreat, a PD day, etc.) shows why
  there's no school that day. Winter break is intentionally left
  unexplained on hover — it's the obvious gap between semesters.

There's also a **debug time** field in the header, for previewing how the
page looks at any date/time without waiting for it — useful when testing a
schedule edit.

The page is fully self-contained: `data.js` has the whole year's schedule
baked in as a JS constant, so `index.html` works by just opening the file
directly (double-click, or set as your browser's start page) — no server,
no network request, no build step at runtime.

## Project structure

```
index.html, style.css, app.js   the site itself
data.js                          the schedule, embedded as SCHOOL_YEAR_DATA (what the site actually reads)

data/
  school_year_2026_2027.csv      the schedule, hand-editable — THE SOURCE OF TRUTH during the year
  school_year_2026_2027.json     intermediate JSON built from the CSV (not read by the site directly)
  sluh_raw.ics                   cached copy of the school's public calendar feed

scripts/
  parse_ics.py                   shared ICS-parsing helpers (not run directly)
  ics_to_csv.py                  ICS -> CSV. Run ONCE per year, when the new calendar is published.
  csv_to_data.py                 CSV -> JSON + data.js. Run after every edit to the CSV.
```

## Editing the schedule (snow days, schedule changes, etc.)

The CSV is the thing you actually edit. Open
`data/school_year_2026_2027.csv` in Excel, Numbers, or Google Sheets. One
row per school day:

| column | meaning |
|---|---|
| `date` | `YYYY-MM-DD` |
| `weekday` | just for readability — the build script recomputes this from `date` and ignores what's typed here |
| `summary` | the day's label / reason for no school (shows on hover for non-school days) |
| `A_start` … `G_end` | start/end time for each lettered period that meets that day, `HH:MM` in 24-hour time. Leave **both** cells blank for a letter that doesn't meet |

The school's rotation cycles continuously through A→B→C→D→E→F→G→A… — a day
might run e.g. `[F,G,A,B,C]`, wrapping past G back to A. That's normal; the
columns just aren't all filled left-to-right on those days.

**To make a change:**

1. Edit the row(s) in the CSV. For a full snow day, blank out every letter's
   start/end for that date and set `summary` to something like
   `No School-Snow Day`. For a shortened/modified day, just edit the time
   cells.
2. From `scripts/`, run:
   ```bash
   python3 csv_to_data.py ../data/school_year_2026_2027.csv ../data/school_year_2026_2027.json ../data.js
   ```
3. Read the output. It prints **warnings** (non-blocking — e.g. a
   `weekday` column that doesn't match its `date`) and **errors**
   (blocking — bad time format, a period ending before it starts,
   overlapping periods, a duplicate date). If there are any errors,
   `data.js` is **not** touched, so a bad edit can't break the live site —
   fix the row(s) named in the error output and rerun.
4. Reload `index.html` in your browser to confirm it looks right.
5. Commit: `git add -A && git commit -m "snow day 2/3"` (or whatever). This
   repo is git-tracked specifically so every schedule change is a diffable,
   revertible commit.

## Starting a new academic year

The `[YEAR]` files are year-specific by filename, so a new year is a fresh
set of files rather than overwriting these:

1. Get the new academic year's ICS URL from SLUH (same calendar, just look
   for the new year's events) and download it:
   ```bash
   curl -sL "<ics-url>" -o data/sluh_raw_2027_2028.ics
   ```
2. Bootstrap the CSV from it:
   ```bash
   cd scripts
   python3 ics_to_csv.py ../data/sluh_raw_2027_2028.ics ../data/school_year_2027_2028.csv \
     --from 20270801 --to 20280615
   ```
   Adjust the `--from`/`--to` dates to the new year's range. This script
   refuses to overwrite an existing CSV — pass `--force` only if you
   deliberately want to regenerate one from scratch and are OK losing any
   hand edits already made to it.
3. Skim the generated CSV for anything odd before trusting it (the school
   occasionally changes description formats).
4. Build the data file:
   ```bash
   python3 csv_to_data.py ../data/school_year_2027_2028.csv \
     ../data/school_year_2027_2028.json ../data.js
   ```
5. Update the `<title>` in `index.html` and the header text if you want it
   to say the new year.
6. Commit.

## How the computed numbers work (and one caveat)

- **Semester boundary**: auto-detected as the last day whose calendar
  summary contains "First Semester Exams". No manual configuration needed
  each year, as long as the school keeps using that label.
- **Quarter boundary**: this year's calendar doesn't carry explicit quarter
  markers, so quarters are **approximated** by splitting each semester's
  periods exactly in half by count. It'll be close but isn't guaranteed to
  match the school's actual grading-period cutoff to the day. If a future
  year's calendar does carry real quarter markers, this could be made
  exact — flag it if you want that revisited.
- **Cycle** (Progress tab, and "Cycle N out of M" on hover): the A–G letter
  tag was verified to cycle with zero breaks across the entire year's
  period sequence, including across weekends and breaks. "Cycle" is just
  `periods completed ÷ 7`.

## Troubleshooting

- **Edited the CSV but the site didn't change** — you have to run
  `csv_to_data.py` after every edit; the site reads `data.js`, never the
  CSV directly.
- **Build says "N error(s) — data.js was NOT updated"** — the CSV has a
  problem (bad time, overlap, duplicate date, etc.). The site's last good
  data is untouched; fix the row(s) listed and rerun.
- **Times look off by the AM/PM you expected** — the CSV only accepts
  24-hour `HH:MM` (e.g. `13:20`, not `1:20pm`), specifically to avoid the
  AM/PM ambiguity bugs the original ICS parsing had.
- **Testing how something will look on a specific date/time** — use the
  **debug time** field in the page header instead of waiting for real time
  to pass, or editing your system clock.
