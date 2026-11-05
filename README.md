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

## The pages

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

### 2. `/math/` — the wall display

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
update without touching any code — two of its own, and two **shared** with
every other dashboard (see [Shared data](#shared-data)):

| File | Purpose |
|---|---|
| `math/math-teachers.csv` | `name,period,room` — one row per teacher per period (the same teacher can be in a different room different periods). |
| `math/math-food.csv` | `date,name` — free-food / catered-lunch days. |
| `data/birthdays.csv` | **shared** — the whole faculty/staff list. A `dept` of `math` renders that birthday in bold *here*. |
| `data/breaks.csv` | **shared** — override the auto-detected label for a break that starts on `date`. |

The dashboard re-fetches these every 30 minutes, and it also watches
`version.txt` (bumped by `deploy.sh` on every deploy) so it reloads itself
within a minute of a new deploy — no need to SSH into the display for
routine updates.

Weather comes from [Open-Meteo](https://open-meteo.com/) (free, no API key),
hardcoded to SLUH's coordinates since the display only ever runs in one
place.

### 3. `/mcl/` — the Modern & Classical Languages wall display

A sibling of `/math/` for the languages department: same SLUH
theme, same "runs unattended full-screen on a TV" job, same `data.js` for
the school calendar, its own trimmed-down copy of the schedule helpers.
`mcl-office.js` / `mcl-office.css` are a deliberate fork of the
`math-office.*` files — each helper block points back to its counterpart.

What's different from the math display:

- **A rotating saying** in the header — a proverb in one of the taught
  languages (*Petit à petit, l'oiseau fait son nid.*), its English meaning
  in smaller type underneath, and a dim tag naming the language plus, where
  it helps, a romanization or an attribution (*Classical Greek · pánta rheî
  · Heraclitus*). It comes from `mcl-sayings.csv` and turns every 13
  seconds — slow, because unlike the one-word *Hola* this spot started as, a
  proverb has to be read. The rotation is round-robin **by language**, so
  consecutive turns are always in different languages no matter how the file
  is grouped; if the CSV is missing or empty the header falls back to that
  original *Hola · Bonjour · مرحبًا · 你好 · Привет · Salvē · Χαῖρε* rotation
  rather than going blank.
- **A world-map panel** in place of "Year at a Glance". It rotates between:
  one "Where *&lt;language&gt;* is spoken" page per row of
  `mcl-map-languages.csv` (the countries shaded — one per language the
  department teaches: Spanish, French, Chinese, Arabic, Russian, and for the
  classical languages "where the language left its mark"), then
  **Our exchange partners**, **Where SLUH travels**, and
  **Senior Project sites**. The three pin pages show **one place at a
  time**: the map zooms and re-centers on that country, tints it, and drops
  a pulsing dot with its name ("Colegio San Ignacio El Bosque — Santiago ·
  Chile") — while the *other* places on the list stay visible as small
  dimmed dots, so the department's fuller reach still shows through. Six
  places per pass, and a page with more than six advances its window each
  time the rotation leaves it, so a long list (18 travel programs) is walked
  through over successive passes instead of replaying the same first six.
  The zoom/highlight/dots for the next place are all set while the panel is
  faded out, so nothing is ever seen moving.

  The map itself is `world-map.svg`, built by
  [`scripts/build_world_map.py`](scripts/build_world_map.py) from Natural
  Earth's public-domain 110m country boundaries (cached at
  `data/source/ne_110m_admin_0_countries.geojson`), projected with **Equal Earth**
  — an equal-*area* projection, so a country's size on screen matches its
  real area instead of the Mercator-style bias toward Greenland/Russia/
  Canada that most simple world maps have. Each country is one `<path>`
  keyed by its ISO 3166-1 alpha-2 code, carrying `data-lx`/`data-ly` —
  Natural Earth's own hand-curated "best point for this country's label",
  projected the same way — which is what the pin/zoom logic in
  `mcl-office.js` actually anchors to (a geometric centroid would land in
  the Arctic for Canada or Russia, or the Atlantic for France once its
  overseas departments are counted). Its viewBox is cropped to
  `LON_CROP_MIN`/`MAX` in the script (currently -160°/155°) rather than the
  full -180..180 world — every country still gets its full geometry, so
  nothing referenced by the CSVs is actually removed, but the ~2:1 whole
  world was still noticeably flatter than the panel it sits in, and the
  strip either side (mid-Pacific: Hawaii, Fiji, New Zealand, ...) was empty
  ocean this dashboard has no use for. A forced non-uniform stretch to fill
  the panel exactly was tried and dropped instead — it visibly warped
  coastlines, worse than the letterboxing it was meant to fix. Widen the
  crop in the script if a future pin needs land outside it. Rerun the
  script only to refresh from a newer Natural Earth release or to change
  the crop; country borders don't otherwise change often enough to need it.

  A thin dashed outline (`#mcl-map-frame`) marks exactly where the map's
  own content lands inside the panel — a debugging aid (see
  `renderMapFrame` in `mcl-office.js`) for judging letterboxing at a
  glance, not a permanent part of the design.
- **"Languages Teaching Now"** — the teacher list, but every row also carries
  the language + level being taught that period.
- The **rotating box** carries a **Cultural Calendar** — upcoming festivities
  and national days for the countries behind the taught languages (plus the
  UN language days) — and **Cultural & Affinity Clubs**, each club's next
  meeting time and room, alongside the shared breaks / birthdays pages.
- **Weather** shows St. Louis as the big current reading, with the cities
  around the language world beside it in two rows — each with its current
  temperature and its **local time**, so a glance tells you whether it's a
  reasonable hour to call a partner school. Times are formatted by `Intl`
  from the IANA zone in `mcl-cities.csv`, so DST takes care of itself.

Its data comes from its own set of hand-editable CSV files (all prefixed
`mcl-` so they never collide with the math display's), re-fetched every 30
minutes:

| File | Purpose |
|---|---|
| `mcl/mcl-teachers.csv` | `name,period,room,language` — one row per teacher per period. |
| `mcl/mcl-culture.csv` | `date,name,language` — `date` is `MM-DD` for a fixed festival (resolved to its next occurrence) or `YYYY-MM-DD` for a movable one (Lunar New Year, Orthodox Easter); `language` is a dim tag. |
| `mcl/mcl-sayings.csv` | `language,saying,translation,note` — the header proverbs. `note` is optional (a romanization, or who said it) and shows after the language in the dim tag line. **This is the one CSV whose cells may contain commas**, so its values are `"quoted"` and it's read by a real quote-aware splitter (`csvFields`) rather than the naive comma-split the others use; a literal `"` inside a quoted cell is written `""`. |
| `mcl/mcl-clubs.csv` | `name,weekday,time,location` — cultural / affinity clubs; `time` is 24-hour `HH:MM`. The list shows each club's next meeting. |
| `data/birthdays.csv` | **shared** — the whole faculty/staff list. A `dept` of `mcl` renders that birthday in bold *here*. |
| `data/breaks.csv` | **shared** — override a break's auto-detected label. |
| `mcl/mcl-cities.csv` | `label,lat,lon,tz` — the world cities in the weather panel, each showing its current temperature *and* local time. `tz` is an IANA timezone name (`Europe/Madrid`); it's optional, and a row without one just gets no clock line. They lay out in two rows beside the big St. Louis reading, so an even number of cities looks best. |
| `mcl/mcl-map-languages.csv` | `language,flag,color,countries` — one "Where X is spoken" page per row; `countries` is a space-separated list of ISO 3166-1 alpha-2 codes (lowercase). Add or remove rows freely. For Latin and Classical Greek the list is "where the language left its mark" (the Romance countries of Europe; Greece and Cyprus), not a native-speaker map. `color` is optional (defaults to the SLUH accent). Note `gf` (French Guiana) is a separate code from `fr`: Natural Earth draws it as part of France, so `build_world_map.py` splits it into its own path (`SPLIT_TERRITORIES`) to keep South America off the Latin page — it's listed explicitly on the French row. |
| `mcl/mcl-map-places.csv` | `label,kind,country,dx,dy,detail` — `kind` is `partner`, `trip`, or `senior` (one map page each, see `PIN_PAGES` in `mcl-office.js`); the pin drops on `country`'s label point (see below), and `dx,dy` nudge it (percent of the map panel, after the zoom) toward the actual city; `detail` is the caption line. Six per page per pass, in file order, with the window advancing on each pass. |

**Where this data came from.** The names in `mcl-teachers.csv`, the clubs in
`mcl-clubs.csv`, and every place in `mcl-map-places.csv` are real, taken from
sluh.org: the [faculty & staff
directory](https://www.sluh.org/about-sluh/faculty-staff-directory) filtered
to Modern & Classical Languages, the [student organizations
list](https://www.sluh.org/discover-sluh/student-organizations) (which names
each club's moderator), the [Global
Education](https://www.sluh.org/discover-sluh/globaleducation) program and
Senior Project listings, and the 2026-27 Curriculum Guide (which is where the
course names — *Honors Spanish III*, *AP Latin*, *Classical Greek* — come
from). **What is invented:** every period, room number, and club meeting
time. The department's real bell schedule isn't published, so those are
plausible filler — swap them for the real ones before this goes on a wall.
The proverbs in `mcl-sayings.csv` are the standard, widely-taught ones for
each language (the Delphic maxims, *ad maiorem Dei gloriam*, *век живи — век
учись*), with translations kept literal rather than idiomatic so a student
can map the English back onto the original word by word — the department
should feel free to replace them with whatever it actually teaches.
Teacher-to-language assignments are sourced where the site says so (Prep News
articles, club moderator roles, titles); Dina Fachin and Carson Cornett are
listed only as MCL faculty, so their Spanish assignment is a guess.

A pin's default position is the country's `data-lx`/`data-ly` (see the
world-map.svg description above) — already close to the right city for most
countries, so `dx,dy` only needs to be a small nudge (a couple of percent).
The zoom itself always centers on that same unnudged point, so the
highlighted country stays framed regardless of how large a nudge a
particular pin uses.

### 4. `/ilab/` — iLab classroom display

A small screen in the iLab, built to be read from across the room, so it
shows only four things:

- **Header** (navy): clock, date, and the weather (current temperature,
  conditions, today's high/low, and rain chance when it's 20% or more).
  Weather comes from Open-Meteo, set up the same way as `math/`.
- **Now:** the class meeting right now (course, teacher, section), a
  countdown to the end of the period, and a progress bar (floored, never
  reads done early). Between periods it shows *Passing* or *Break* (gaps of
  15+ minutes) with a countdown to the next one; it also covers *Before
  School*, *Classes are done*, and no-school days (e.g. *Thanksgiving Break*).
- **Next:** the next period today, or after school / on days off, the first
  period of the next school day.
- **Today:** every period of the day with its start time; the current one is
  highlighted in navy and finished ones fade out.

Period letters and times come from `data.js`. Which class meets in each
letter comes from **`ilab/ilab-classes.csv`** (`period,teacher,course,section,lunch`);
edit it when the room's schedule changes. A blank `course` means the room is
open that period. `lunch` is `jrsr` for a class on the Jr/Sr lunch wave
(anything else means Fr/So). It only matters on days that class's period
lands in the lunch slot. Everything is sized from one viewport unit, so the
layout fits any screen without scrolling. Add `#debug` to the URL for the
time-jump field. Like the other displays, it reloads itself after a deploy.

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

## Shared data

Some data isn't specific to one department. Birthdays cover all faculty and
staff; a break is a break for the whole school. Both live once, in `data/`,
and every dashboard fetches them from there:

| File | Purpose |
|---|---|
| `data/birthdays.csv` | `date,name,dept` — the whole faculty/staff list. Every dashboard shows every name; `dept` only decides **which names render bold on which display** (`math` → bold on `/math/`, `mcl` → bold on `/mcl/`, blank → bold nowhere). One dept per person. |
| `data/breaks.csv` | `date,name` — override the auto-detected label for the break starting on `date`. Normally empty; the labels come from the calendar in `data.js`. |

Adding a department means a new `dept` value here **and** a one-line opt-in
in that dashboard's `parseBirthdaysCsv`. There's no central registry of
department names — each display only knows its own.

Both files take `#` comment lines, and each carries a header explaining its
own columns, so the office can edit them without opening any code.

### `data/` vs `data/source/`

`data/` is **shipped** — the dashboards fetch those CSVs from the live site
at runtime. `data/source/` is **not**: it holds the bulky build inputs
(`sluh_raw.ics`, the Natural Earth GeoJSON, the teacher `.xlsx`) that
`scripts/` reads to generate `data.js` and `world-map.svg`. `deploy.sh`
excludes `data/source/` specifically, so **put new build inputs there**, not
in `data/` — anything dropped directly in `data/` becomes public.

---

## Project structure

```
index.html, style.css, app.js           the personal start page
math-office.html, mcl-office.html       redirect stubs for the pre-folder URLs
                                        (see server/nginx-office-folders.conf)

math/                                   the math-office wall display -- /math/
  index.html, math-office.css,
  math-office.js
  math-teachers.csv, math-food.csv      its own hand-editable data (section 2)

mcl/                                    the Modern & Classical Languages
  index.html, mcl-office.css,           wall display -- /mcl/
  mcl-office.js
  mcl-*.csv                             its own hand-editable data (section 3)
  world-map.svg                         built by scripts/build_world_map.py

ilab/                                   classroom display -- /ilab/ (section 4)
  index.html, ilab.css, ilab.js         the display itself
  ilab-classes.csv                      which class meets in each period letter

data/                                   SHIPPED. Data shared by every dashboard:
  birthdays.csv                         all faculty/staff; dept picks who's bold
  breaks.csv                            break-label overrides
  source/                               NOT shipped -- build inputs only:
    sluh_raw.ics                        raw school calendar export
    school_year_*.csv, .json            the editable schedule + its JSON build
    ne_110m_*.geojson                   Natural Earth, for world-map.svg
    teachers-s1.csv, .xlsx              the wide teacher schedule

data.js                                 the whole year's schedule, embedded as
                                        SCHOOL_YEAR_DATA + QUARTER_MARKS + SENIOR_S2
                                        (this is what the pages actually read)
version.txt                             deploy timestamp; the wall display polls it to self-reload
deploy.sh                               rsync the runtime files to the web host

api/                                    JSON endpoint for the phone lock-screen widget:
  period.php                            "what period is it, how long is left" — computed
                                        server-side in America/Chicago on every request
  schedule.json                         trimmed copy of data.js, written by csv_to_data.py
  sluh-period-widget.js                 the Scriptable script that draws the widget
  sluh-period.scriptable                importable bundle of that script (build-scriptable.py)
  scriptable.php                        serves the bundle as a download for the phone
                                        (see api/README.md)

stats.php                               OLD standalone usage counter — kept for its
                                        historical .stats-data.json only; retired once the
                                        unified dashboard is confirmed (see "Usage stats")

teachers.csv, birthdays.csv,            hand-editable data for the math-office display
  food.csv, breaks.csv
mcl-*.csv                               hand-editable data for the mcl-office display
                                        (teachers, culture, clubs, birthdays, breaks,
                                        cities, map-languages, map-places)

data/
  school_year_2026_2027.csv             the schedule, hand-editable — THE SOURCE OF TRUTH
  school_year_2026_2027.json            intermediate JSON built from the CSV (not read by the site)
  sluh_raw.ics                          cached copy of the school's public calendar feed
  teachers-s1.csv / .xlsx               raw wide-format teacher schedule (source for teachers.csv)
  ne_110m_admin_0_countries.geojson     Natural Earth country boundaries (source for world-map.svg)

scripts/
  parse_ics.py                          shared ICS-parsing helpers (not run directly)
  ics_to_csv.py                         ICS  -> CSV.  Run ONCE per year, when the calendar is published.
  csv_to_data.py                        CSV  -> JSON + data.js.  Run after every edit to the CSV.
  teachers_wide_to_long.py              wide teacher CSV -> math/math-teachers.csv
  build_world_map.py                    geojson -> mcl/world-map.svg (Equal Earth projection). Rerun
                                        only to pick up a newer Natural Earth release.

pi-kiosk/                               Raspberry Pi setup to run the wall display full-screen
                                        (kiosk display only -- fleet tracking/find-my-Pi now
                                        lives in ../analytics.alvear.cl. See pi-kiosk/README.md.)

server/                                 web-host setup, installed by hand (not shipped by deploy.sh):
                                        subdomain move + the old-URL redirect. See server/README.md.
```

## Where it's hosted

The site is served from **<https://sluhtime.alvear.cl/>** (wall displays at
`/math/` and `/mcl/`). It has its own subdomain — rather than a subfolder of
`static.alvear.cl` — so the host can run PHP for it. The old
`static.alvear.cl/sluh-time-visualizer/` URL 301-redirects to the new one,
deep links and all. Host-side setup lives in `server/`.

## Phone lock-screen widget

`api/period.php` is a small JSON endpoint —
<https://sluhtime.alvear.cl/api/period.php> — that returns the current
period and the seconds left in it, computed server-side in
`America/Chicago` on every request. `api/sluh-period-widget.js` is a
[Scriptable](https://scriptable.app/) script that renders it as an iPhone
Lock Screen (or Home Screen) widget. Both ship with `deploy.sh`;
`schedule.json` next to them is regenerated by `csv_to_data.py`. Full
details, response shape, and setup steps are in [`api/README.md`](api/README.md).

## Usage stats

Usage tracking is now unified across the alvear.cl sites at
**analytics.alvear.cl** (repo: `../analytics.alvear.cl`). Both pages load the
shared beacon:

```html
<script src="https://analytics.alvear.cl/a.js" data-site="time-visualizer" defer></script>
```

An inline `window.xaExtra` next to it hands the beacon the same fields the old
`stats.js` computed — which page/view, light/dark, desktop/mobile, whether the
"my periods" filter is on. A random per-browser id lives in `localStorage`.
**No IP, cookie, referrer, or names.** The per-site dashboard is at
**analytics.alvear.cl/time-visualizer.php** (HTTP basic auth).

The old `stats.php` is still deployed (its `.stats-data.json` counters stay
readable at `stats.php?key=THEKEY`) but no longer receives new hits; it'll be
removed once the unified dashboard is confirmed.

There's also **Cloudflare Web Analytics** on `index.html` (a `<script>` tag)
for raw pageview/geography numbers; all independent.

---

## Running it locally

Any static file server works. The repo ships a config for the built-in
Python one:

```bash
python3 -m http.server 8420
```

Then open <http://localhost:8420/> for the main site or
<http://localhost:8420/math/> for the wall display.

You can also just double-click `index.html` — it works straight off disk
because `data.js` is a plain script with no network dependency. (The wall
display does need a server, since it fetches the CSV files.)

---

## Editing the schedule (snow days, schedule changes, etc.)

The CSV — `data/source/school_year_2026_2027.csv` — is the thing you actually edit.
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
   python3 csv_to_data.py ../data/source/school_year_2026_2027.csv \
     ../data/source/school_year_2026_2027.json ../data.js
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
python3 teachers_wide_to_long.py ../data/source/teachers-s1.csv ../math/math-teachers.csv
```

## Starting a new academic year

The year-specific files are named by year, so a new year is a fresh set of
files rather than an overwrite:

1. Download the new year's ICS feed from SLUH:
   ```bash
   curl -sL "<ics-url>" -o data/source/sluh_raw_2027_2028.ics
   ```
2. Bootstrap the CSV from it (adjust the date range to the new year):
   ```bash
   cd scripts
   python3 ics_to_csv.py ../data/source/sluh_raw_2027_2028.ics \
     ../data/source/school_year_2027_2028.csv --from 20270801 --to 20280615
   ```
   This refuses to overwrite an existing CSV; pass `--force` only if you
   deliberately want to regenerate from scratch and are OK losing hand
   edits.
3. Skim the generated CSV for anything odd (the school occasionally changes
   its description formats).
4. Build `data.js`:
   ```bash
   python3 csv_to_data.py ../data/source/school_year_2027_2028.csv \
     ../data/source/school_year_2027_2028.json ../data.js
   ```
5. Commit and deploy.

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
