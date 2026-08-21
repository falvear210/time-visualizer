"""Shared ICS-parsing helpers, imported by ics_to_csv.py. Not run directly
-- there's no CLI entry point here on purpose, so there's only one path
from a fresh ICS to the site's data (ics_to_csv.py -> csv_to_data.py)
instead of a second one that could silently produce a stale schema.
"""
import re


def unfold(raw: str) -> list[str]:
    """Undo RFC5545 line folding (continuation lines start with a space)."""
    lines = raw.replace("\r\n", "\n").split("\n")
    out = []
    for line in lines:
        if line.startswith(" ") and out:
            out[-1] += line[1:]
        else:
            out.append(line)
    return out


def parse_events(raw: str):
    """Turn a raw ICS file into a list of {ICS-property-name: value} dicts,
    one per VEVENT."""
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
