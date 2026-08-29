# SLUH Time Visualizer

A small, no-build website that shows the *shape* of the school year: a grid
of squares — one per class period — that fill in as the day, week, quarter,
semester, and year go by. It's meant to be bookmarked as a browser start
page, or thrown up on a wall display in an office.

Everything is plain HTML, CSS, and vanilla JavaScript. There is no
framework, no bundler, and no build step at runtime. The whole schedule for
the year is baked into a single JavaScript file (`data.js`), so the pages
work even when opened directly off disk with no web server running.

---

## The two pages

### 1. `index.html` — the personal start page

The main site. Five tabs, each with its own URL hash so you can bookmark
one directly (`index.html#continuous`, `#weekly`, `#current`, `#dashboard`,
or `#progress`):

| Tab | What it shows |
|---|---|
| **progress** | Stacked progress bars: academic year, current semester, current quarter, the next multi-day break, the winter-break / end-of-year milestone, this week, today, and a live bar for the period happening right now. |
| **continuous** | Every period of the year in one seamless grid, in order, with no gaps between days. Sized to fill the screen on desktop. |
| **weekly** | The same squares laid out one row per calendar week, Monday–Friday as fixed columns, so short weeks (holidays, breaks) show up as visibly empty columns instead of just disappearing. |
| **current period** | Just the live "current period" bar, full-size — a glance at how much of the period is left, nothing else on screen. |
| **dashboard** | A layout built for a large 16:9 screen: the whole school day as one proportionally-sized bar with a "now" line, a big countdown to whatever's next, and a few at-a-glance stat bars. |

Things worth knowing about the main site:

- **Squares fill from the bottom up** as a period elapses. Empty = upcoming,
  solid grey = done, accent color and filling = happening right now.
- **Hover a square** for its date and where it sits in the semester and
  year. In *continuous* this also lights up the rest of that day; in
  *weekly* it lights up the same square's 7-period rotation cycle across
  days. Hovering an empty cell in *weekly* explains why there's no school
  that day, pulled straight from the calendar.
- **The "Next Break" bar** counts down to the next stretch of 3+ consecutive
  calendar days off. A PD day or conference day next to a weekend does *not*
  count — it's still a workday, so it can't create or extend a break. The
  count is in actual school days, not raw calendar time.
- **The milestone bar** below it tracks the big one: school days until
  Winter Break, then automatically switches to school days until the End of
  Year once break is over.
- **The ⚙ settings panel** switches light/dark and accent color, and can
  filter the whole grid (and every progress bar) down to just the periods
  *you* teach — pick your letters for Semester 1, and optionally a different
  set for Semester 2. Filtered-out squares disappear entirely, so the grid
  tightens up around what's actually yours. There are also controls for the
  Jr/Sr lunch wave and seniors-only sections (see "Lunch waves" below).
  Everything here is saved per-browser and sticks across reloads.
- **The ? button** has a shorter, in-page version of all of this.
- **`index.html#debug`** reveals a hidden date/time field for previewing how
  the page looks at any moment without waiting for real time to pass —
  handy when testing a schedule edit. The `#debug` hash is independent of
  the tab hashes; it only shows the field, it doesn't switch tabs.

### 2. `math-office.html` — the wall display

A separate, standalone dashboard designed to run unattended full-screen on
a TV in the math office. It shares `data.js` with the main site but has its
own trimmed-down copy of the schedule helpers — there are no tabs, no
settings, and no personal filtering, because it's a shared display, not a
personalized one.

It shows: a live clock and date, today's schedule as a stack of live
progress bars with a big countdown, the whole year as small squares, a
rotating panel of upcoming breaks / birthdays / free-food days, the list of
teachers teaching this period and their rooms, and current local weather.

Its extra data comes from four hand-editable CSV files that the office can
update without touching any code:

| File | Purpose |
|---|---|
| `teachers.csv` | `name,period,room` — one row per teacher per period (the same teacher can be in a different room different periods). |
| `birthdays.csv` | `date,name,dept` — an optional `dept` of `math` renders that birthday in bold. |
| `food.csv` | `date,name` — free-food / catered-lunch days. |
| `breaks.csv` | `date,name` — override the auto-detected label for a break that starts on `date`. |

The dashboard re-fetches these every 30 minutes, and it also watches
`version.txt` (bumped by `deploy.sh` on every deploy) so it reloads itself
within a minute of a new deploy — no need to SSH into the display for
routine updates.

Weather comes from [Open-Meteo](https://open-meteo.com/) (free, no API key),
hardcoded to SLUH's coordinates since the display only ever runs in one
place.

---

## Lunch waves and seniors (the tricky scheduling bits)

Two quirks of the SLUH schedule that the code goes out of its way to handle:

- **Lunch waves.** On most days, one period runs *twice* at different clock
  times — once for freshmen/sophomores (class, then lunch) and once for
  juniors/seniors (lunch, then class). Same period letter, two different
  time windows. In `data.js` this is stored as the Fr/So time on the period
  plus an attached `jrsrStartMinutes` / `jrsrEndMinutes`. The main site
  defaults every period to the Fr/So time; a teacher can mark individual
  periods as following the Jr/Sr clock in settings, and the live "current
  period" bar has a Fr/So ⇄ Jr/Sr toggle when the period actually splits.
- **Seniors' shorter second semester.** Seniors finish earlier than
  everyone else. A teacher can mark a period as seniors-only in settings,
  and it then stops meeting in Semester 2 outside the window seniors
  actually attend (recorded in the CSV's `senior_s2` column).

---

## Project structure

```
index.html, style.css, app.js          the personal start page
math-office.html, math-office.css,      the wall display
  math-office.js
data.js                                 the whole year's schedule, embedded as
                                        SCHOOL_YEAR_DATA + QUARTER_MARKS + SENIOR_S2
                                        (this is what the pages actually read)
version.txt                             deploy timestamp; the wall display polls it to self-reload
deploy.sh                               rsync the runtime files to the web host

teachers.csv, birthdays.csv,            hand-editable data for the wall display
  food.csv, breaks.csv

data/
  school_year_2026_2027.csv             the schedule, hand-editable — THE SOURCE OF TRUTH
  school_year_2026_2027.json            intermediate JSON built from the CSV (not read by the site)
  sluh_raw.ics                          cached copy of the school's public calendar feed
  teachers-s1.csv / .xlsx               raw wide-format teacher schedule (source for teachers.csv)

scripts/
  parse_ics.py                          shared ICS-parsing helpers (not run directly)
  ics_to_csv.py                         ICS  -> CSV.  Run ONCE per year, when the calendar is published.
  csv_to_data.py                        CSV  -> JSON + data.js.  Run after every edit to the CSV.
  teachers_wide_to_long.py              wide teacher CSV -> teachers.csv

pi-kiosk/                               Raspberry Pi setup to run the wall display full-screen
```

---

## Running it locally

Any static file server works. The repo ships a config for the built-in
Python one:

```bash
python3 -m http.server 8420
```

Then open <http://localhost:8420/> for the main site or
<http://localhost:8420/math-office.html> for the wall display.

You can also just double-click `index.html` — it works straight off disk
because `data.js` is a plain script with no network dependency. (The wall
display does need a server, since it fetches the CSV files.)

---

## Editing the schedule (snow days, schedule changes, etc.)

The CSV — `data/school_year_2026_2027.csv` — is the thing you actually edit.
Open it in Excel, Numbers, or Google Sheets. One row per school day:

| column | meaning |
|---|---|
| `date` | `YYYY-MM-DD` |
| `weekday` | for readability only — the build script recomputes it from `date` and ignores what's typed |
| `summary` | the day's label / reason for no school (shows on hover for non-school days) |
| `A_start` … `G_end` | start/end time for each lettered period that meets that day, `HH:MM` in 24-hour time. Leave **both** cells blank for a letter that doesn't meet |
| `quarter_end` | optional. `1` on Q1's last day, `3` on Q3's last day. Blank everywhere else — Q2 always ends at the semester boundary and Q4 at the last day of the year |
| `split_letter`, `jrsr_start`, `jrsr_end` | optional, all-or-nothing. Records the Jr/Sr lunch-wave time for whichever period splits that day |
| `senior_s2` | optional. `start` on the first day seniors' second-semester schedule resumes, `end` on their last day |

The rotation cycles continuously through A→B→C→D→E→F→G→A… — a given day
might run, say, `[F,G,A,B,C]`, wrapping past G back to A. That's normal; the
time columns just aren't filled left-to-right on those days.

**To make a change:**

1. Edit the row(s) in the CSV. For a full snow day, blank out every
   period's times for that date and set `summary` to something like
   `No School-Snow Day`. For a shortened day, just edit the time cells.
2. From `scripts/`, rebuild `data.js`:
   ```bash
   python3 csv_to_data.py ../data/school_year_2026_2027.csv \
     ../data/school_year_2026_2027.json ../data.js
   ```
3. Read the output. It prints **warnings** (non-blocking — e.g. a `weekday`
   that doesn't match its `date`) and **errors** (blocking — bad time
   format, a period ending before it starts, overlapping periods, a
   duplicate date). If there are any errors, `data.js` is **not** touched,
   so a bad edit can't break the live site — fix the rows named in the
   output and rerun.
4. Reload the page to confirm it looks right (use `#debug` to jump to the
   relevant date).
5. Commit. This repo is git-tracked specifically so every schedule change
   is a diffable, revertible commit:
   ```bash
   git add -A && git commit -m "snow day 2/3"
   ```
6. Deploy: `./deploy.sh`.

## Updating the wall display's teacher list

`teachers.csv` is hand-editable directly. If you're starting from the
school's wide-format schedule export (one row per teacher, one column per
period), convert it:

```bash
cd scripts
python3 teachers_wide_to_long.py ../data/teachers-s1.csv ../teachers.csv
```

## Starting a new academic year

The year-specific files are named by year, so a new year is a fresh set of
files rather than an overwrite:

1. Download the new year's ICS feed from SLUH:
   ```bash
   curl -sL "<ics-url>" -o data/sluh_raw_2027_2028.ics
   ```
2. Bootstrap the CSV from it (adjust the date range to the new year):
   ```bash
   cd scripts
   python3 ics_to_csv.py ../data/sluh_raw_2027_2028.ics \
     ../data/school_year_2027_2028.csv --from 20270801 --to 20280615
   ```
   This refuses to overwrite an existing CSV; pass `--force` only if you
   deliberately want to regenerate from scratch and are OK losing hand
   edits.
3. Skim the generated CSV for anything odd (the school occasionally changes
   its description formats).
4. Build `data.js`:
   ```bash
   python3 csv_to_data.py ../data/school_year_2027_2028.csv \
     ../data/school_year_2027_2028.json ../data.js
   ```
5. Update the `<title>` and `<h1>` in `index.html` if you want them to name
   the new year.
6. Commit and deploy.

---

## How the computed numbers work

- **Semester boundary** — auto-detected as the last day whose calendar
  summary contains "First Semester Exams". No manual config needed each
  year, as long as the school keeps that label.
- **Quarter boundaries** — the school calendar doesn't carry quarter
  markers, so by default Q1/Q3 end dates are *approximated* by splitting
  each semester's periods exactly in half by count. Once the real dates are
  known, set them exactly via the CSV's `quarter_end` column. This year's
  CSV already has the real Q1 (Oct 13) and Q3 (Mar 11). Q2 and Q4 are never
  approximated — always exactly the semester boundary and the last day.
- **Cycle** ("Cycle N out of M" on hover) — the A–G rotation was verified to
  cycle with zero breaks across the entire year, including across weekends
  and breaks. "Cycle" is just `periods completed ÷ 7`.
- **Next Break** — a break is 3+ consecutive calendar days off (school days,
  weekends, and holidays all counted), found once at load by walking every
  calendar day from the first to the last school day. PD days and
  conference days are deliberately treated as workdays in that walk, so one
  next to a weekend can't masquerade as a break.
- **Time zone** — everything is computed in `America/Chicago` regardless of
  the visitor's own time zone, so the page is correct viewed from anywhere.

---

## Troubleshooting

- **Edited the CSV but the site didn't change** — you have to run
  `csv_to_data.py` after every edit; the site reads `data.js`, never the
  CSV directly.
- **Build says "N error(s) — data.js was NOT updated"** — the CSV has a
  problem (bad time, overlap, duplicate date, etc.). The last good `data.js`
  is untouched; fix the rows listed and rerun.
- **Times look off by AM/PM** — the CSV only accepts 24-hour `HH:MM`
  (`13:20`, not `1:20pm`), specifically to avoid AM/PM ambiguity.
- **Progress numbers look low, or squares are missing from the grid** —
  check whether "Show only my periods" is on in settings; it filters every
  bar and hides non-matching squares entirely.
- **Wall display didn't pick up a deploy** — it polls `version.txt` once a
  minute; `deploy.sh` bumps that file. If it's stale, the display couldn't
  reach `version.txt` (check the network).

---

## Feedback

Ideas for new features, or found something broken? Email
**falvear@sluh.org**.
