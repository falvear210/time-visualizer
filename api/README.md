# `api/` — the lock-screen widget endpoint

A tiny read-only JSON API that answers one question: **what school period
is it right now, and how much time is left?** Built to back an iPhone
Lock Screen widget, but it's just JSON — anything can call it.

| file | what it is |
|---|---|
| `period.php` | the endpoint. Computes everything in `America/Chicago` on each request — no cron, always current. |
| `schedule.json` | a trimmed copy of `data.js`, written by `scripts/csv_to_data.py` on every build (only if this `api/` dir exists). **Generated — rebuild it, don't hand-edit.** |
| `sluh-period-widget.js` | the [Scriptable](https://scriptable.app/) script that draws the widget. |

Both `period.php` and `schedule.json` ship with `deploy.sh`, along with
`scriptable.php` and the two Scriptable files it hands out. The only thing
here that stays local is `build-scriptable.py` — it's a build script, so
`deploy.sh` excludes it by name. After editing the schedule CSV, the normal
`csv_to_data.py` run refreshes `schedule.json` too — then `./deploy.sh`.

## The endpoint

```
GET https://sluhtime.alvear.cl/api/period.php
```

Optional query params (for testing / personal tweaks):

| param | effect |
|---|---|
| `?now=2026-09-08T10:15:00` | pretend it's this local (Chicago) time |
| `?wave=jrsr` / `?wave=frso` | force the lunch wave; default auto-detects (same rule as `app.js`'s `liveWaveOf`) |

### Response

`state` is always present and is one of:

| `state` | meaning | key fields |
|---|---|---|
| `in-period` | a period is happening | `period`, `wave`, `startedAt`, `endsAt`, `secondsLeft`, `secondsTotal`, `next` (if another period follows today) |
| `passing-period` | between periods, same day | `endsAt`, `secondsLeft`, `next` |
| `before-school` | school day, hasn't started | `next`, `secondsUntilNext` |
| `after-school` | school day, all periods done | `next` (first period next school day), `secondsUntilNext` |
| `no-school` | weekend / break / holiday | `daySummary`, `next`, `secondsUntilNext` |
| `error` | `schedule.json` unreadable | `error` |

Every response also carries `date`, `timezone`, `generatedAt`, and
`daySummary` (the calendar label for the day, when there is one).

Times are ISO-8601 with the correct Central offset (`-05:00` / `-06:00`).
The schedule only has minute-resolution bells, but `secondsLeft` is exact —
it's the real clock measured against the period's minute boundary.

Example (`?now=2026-09-08T09:00:00`):

```json
{
  "state": "in-period",
  "date": "2026-09-08",
  "timezone": "America/Chicago",
  "generatedAt": "2026-09-08T09:00:00-05:00",
  "daySummary": "4 Period [EFGA]",
  "period": "E",
  "wave": "frso",
  "startedAt": "2026-09-08T08:25:00-05:00",
  "endsAt": "2026-09-08T09:30:00-05:00",
  "secondsLeft": 1800,
  "secondsTotal": 3900,
  "next": { "period": "F", "startsAt": "2026-09-08T11:30:00-05:00" }
}
```

## The widget (Scriptable)

The API returns a ready-made `display: { title, big, sub }` plus a
`refreshAt`, so the widget script barely does anything. Scriptable has no
"import from URL" button, so there are three ways in — easiest first.

### A. Open the `.scriptable` bundle (no typing)

1. Install **Scriptable** (free, App Store).
2. On the phone, open **<https://sluhtime.alvear.cl/api/scriptable.php>** in
   Safari. It downloads `SLUH Period.scriptable`; tap it → **Open in
   Scriptable** → it imports as a new script.
3. Long-press the Lock Screen → **Customize** → tap the widget row → add
   **Scriptable** → pick `SLUH Period`.

Regenerate the bundle whenever `sluh-period-widget.js` changes:
`python3 api/build-scriptable.py`.

### B. Type the short version

1. Install **Scriptable**.
2. Tap **+**, name it `SLUH Period`, and type this:

   ```js
   const d = await new Request("https://sluhtime.alvear.cl/api/period.php").loadJSON()
   const w = new ListWidget()
   w.addText(d.display.title).textColor = Color.white()
   w.addSpacer(2)
   w.addText(d.display.big).font = Font.boldSystemFont(17)
   w.addSpacer(1)
   const s = w.addText(d.display.sub); s.textColor = Color.white(); s.textOpacity = 0.7
   if (d.refreshAt) w.refreshAfterDate = new Date(d.refreshAt)
   Script.setWidget(w)
   Script.complete()
   ```

3. Long-press the Lock Screen → **Customize** → tap the widget row →
   add **Scriptable** → pick the `SLUH Period` script.

### C. One-line loader (type even less, updates itself)

New script, two lines — it runs `sluh-period-widget.js` off the server
every time, so the widget's look can change later with nothing to edit on
the phone:

```js
const s = await new Request("https://sluhtime.alvear.cl/api/sluh-period-widget.js").loadString()
await new Function(`return (async () => { ${s} })()`)()
```

### `.js` on this endpoint

`sluh-period-widget.js` is served with `Content-Type: text/javascript`, so
opening it in Safari on the phone shows the source (handy for typing it in,
or for the loader above to fetch).

iOS controls widget refresh timing (~5–15 min, and it rations it), so the
countdown moves in steps rather than ticking every second. The script sets
`refreshAfterDate` to the moment the current period ends so the change
lands promptly. A true second-by-second lock-screen countdown would need a
native WidgetKit app (`Text(timerInterval:)`), which is a much bigger lift
(Xcode, Apple Developer account).
