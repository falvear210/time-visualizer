#!/usr/bin/env python3
"""Parse the SLUH 'School Day Schedule' public Google Calendar ICS export
into a JSON file of school days with their period schedules, for use by
the time-visualizer front end.

Usage: python3 parse_ics.py <input.ics> <output.json> [--from YYYYMMDD] [--to YYYYMMDD]
"""
import json
import re
import sys
from datetime import datetime


def unfold(raw: str) -> list[str]:
    lines = raw.replace("\r\n", "\n").split("\n")
    out = []
    for line in lines:
        if line.startswith(" ") and out:
            out[-1] += line[1:]
        else:
            out.append(line)
    return out


def parse_events(raw: str):
    lines = unfold(raw)
    events = []
    cur = None
    for line in lines:
        if line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT":
            if cur is not None:
                events.append(cur)
            cur = None
        elif cur is not None and ":" in line:
            key, _, val = line.partition(":")
            key_name = key.split(";")[0]
            cur[key_name] = val.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";")
    return events


# e.g. "8:25 - 9:30am Period 1 + Prayer & Announcements [E]" (start meridiem often omitted)
LINE_RE = re.compile(
    r"^(\d{1,2}):(\d{2})\s*([ap]m)?\s*-\s*(\d{1,2}):(\d{2})\s*([ap]m)\s+(.+)$",
    re.IGNORECASE,
)
# only lines tagged with a rotating class letter, e.g. "Period 3 (Fr/So) [G]" -> "G".
# this naturally excludes exam periods, advisory, studium, activity period, zero
# hour, mass, lunch, homeroom, etc. -- none of those carry a letter tag.
LETTER_RE = re.compile(r"\[([A-G])\]\s*$")


def to_minutes(hour: int, minute: int, meridiem: str) -> int:
    hour = hour % 12
    if meridiem.lower() == "pm":
        hour += 12
    return hour * 60 + minute


def parse_periods(description: str):
    """Return one square per lettered class (A-G) in the day, in chronological
    order, using the *first* variant encountered when a letter appears twice
    (e.g. split Fr/So vs Jr/Sr lunch-wave sections of the same class)."""
    seen = {}
    for line in description.split("\n"):
        line = line.strip()
        m = LINE_RE.match(line)
        if not m:
            continue
        sh, sm, smer, eh, em, emer, label = m.groups()
        label = label.strip()
        lm = LETTER_RE.search(label)
        if not lm:
            continue  # no rotating-class letter: exam/advisory/studium/lunch/etc.
        letter = lm.group(1)

        end_minutes = to_minutes(int(eh), int(em), emer)
        if smer:
            start_minutes = to_minutes(int(sh), int(sm), smer)
        else:
            # infer start meridiem from end meridiem, flipping if that would
            # put start after end (e.g. "11:55 - 12:55pm" -> start is am)
            start_minutes = to_minutes(int(sh), int(sm), emer)
            if start_minutes > end_minutes:
                start_minutes = to_minutes(int(sh), int(sm), "am" if emer.lower() == "pm" else "pm")

        if letter in seen:
            continue
        seen[letter] = {
            "label": letter,
            "startMinutes": start_minutes,
            "endMinutes": end_minutes,
        }

    return [seen[k] for k in sorted(seen, key=lambda k: seen[k]["startMinutes"])]


BREAK_KEYWORDS = ["break", "no school", "no classes", "holiday"]


def is_break(summary: str) -> bool:
    s = summary.lower()
    return any(k in s for k in BREAK_KEYWORDS)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    in_path, out_path = sys.argv[1], sys.argv[2]
    date_from = date_to = None
    for i, arg in enumerate(sys.argv):
        if arg == "--from":
            date_from = sys.argv[i + 1]
        if arg == "--to":
            date_to = sys.argv[i + 1]

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
        weekday = datetime.strptime(d, "%Y%m%d").strftime("%A")
        entry = {
            "date": d,
            "weekday": weekday,
            "summary": summary,
            "isBreak": is_break(summary) or not periods,
            "periods": periods,
        }
        # if duplicate date appears, prefer the one with periods
        if d not in days or (not days[d]["periods"] and periods):
            days[d] = entry

    ordered = [days[d] for d in sorted(days)]
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(ordered, f, indent=2)

    print(f"Parsed {len(ordered)} days -> {out_path}")
    breaks = [d for d in ordered if d["isBreak"]]
    print(f"  {len(breaks)} marked as break/no-school")
    with_periods = [d for d in ordered if d["periods"]]
    print(f"  {len(with_periods)} with a parsed period schedule")


if __name__ == "__main__":
    main()
