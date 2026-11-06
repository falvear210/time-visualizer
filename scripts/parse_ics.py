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
# most days, one period (whichever sits next to lunch) runs twice: once for
# freshmen/sophomores (class, then lunch) and once for juniors/seniors (lunch,
# then class) -- same letter, two different clock times. e.g.
# "Period 2 (Fr/So) [G]" and "Period 2 (Jr/Sr) [G]".
GRADE_RE = re.compile(r"\((Fr/So|Jr/Sr)\)", re.IGNORECASE)


def to_minutes(hour: int, minute: int, meridiem: str) -> int:
    hour = hour % 12
    if meridiem.lower() == "pm":
        hour += 12
    return hour * 60 + minute


def line_minutes(m):
    """(start, end) minutes-since-midnight for a LINE_RE match. The calendar
    often omits the start's am/pm, so infer it from the end's, flipping it
    if that would put the start after the end (e.g. "11:55 - 12:55pm")."""
    sh, sm, smer, eh, em, emer, _ = m.groups()
    end_minutes = to_minutes(int(eh), int(em), emer)
    if smer:
        return to_minutes(int(sh), int(sm), smer), end_minutes
    start_minutes = to_minutes(int(sh), int(sm), emer)
    if start_minutes > end_minutes:
        start_minutes = to_minutes(int(sh), int(sm), "am" if emer.lower() == "pm" else "pm")
    return start_minutes, end_minutes


# Whole-school blocks without a class letter that the displays still want to
# show by name (the iLab display lists them in its day schedule). Matched
# exactly against the calendar's line label. Lunch, homeroom, exams, etc.
# are deliberately not here.
BLOCK_NAMES = (
    "Studium",
    "Activity Period",
    "Advisory Period",
    "Assembly & Advisory",
    "Lunch Advisory",
)


def parse_blocks(description: str):
    """Return the day's named non-class blocks (see BLOCK_NAMES) as
    [{"name", "startMinutes", "endMinutes"}] in time order."""
    blocks = []
    for line in description.split("\n"):
        m = LINE_RE.match(line.strip())
        if not m or m.group(7).strip() not in BLOCK_NAMES:
            continue
        start_minutes, end_minutes = line_minutes(m)
        blocks.append({"name": m.group(7).strip(), "startMinutes": start_minutes, "endMinutes": end_minutes})
    return sorted(blocks, key=lambda b: b["startMinutes"])


def parse_periods(description: str):
    """Return one square per lettered class (A-G) in the day, in chronological
    order. When a letter is split into Fr/So and Jr/Sr lunch-wave variants,
    the Fr/So time is used as the period's primary startMinutes/endMinutes
    (matching plain, unsplit periods) and the Jr/Sr time is attached as
    jrsrStartMinutes/jrsrEndMinutes."""
    frso, jrsr, plain = {}, {}, {}
    for line in description.split("\n"):
        line = line.strip()
        m = LINE_RE.match(line)
        if not m:
            continue
        label = m.group(7).strip()
        lm = LETTER_RE.search(label)
        if not lm:
            continue  # no rotating-class letter: exam/advisory/studium/lunch/etc. (see parse_blocks)
        letter = lm.group(1)
        start_minutes, end_minutes = line_minutes(m)

        entry = {"startMinutes": start_minutes, "endMinutes": end_minutes}
        gm = GRADE_RE.search(label)
        if gm and gm.group(1).lower() == "fr/so":
            frso.setdefault(letter, entry)
        elif gm and gm.group(1).lower() == "jr/sr":
            jrsr.setdefault(letter, entry)
        else:
            plain.setdefault(letter, entry)

    periods = {}
    for letter, entry in plain.items():
        periods[letter] = {"label": letter, **entry}
    for letter, entry in frso.items():
        p = {"label": letter, **entry}
        if letter in jrsr:
            p["jrsrStartMinutes"] = jrsr[letter]["startMinutes"]
            p["jrsrEndMinutes"] = jrsr[letter]["endMinutes"]
        periods[letter] = p
    for letter, entry in jrsr.items():
        if letter not in periods:  # a Jr/Sr line with no matching Fr/So line
            periods[letter] = {"label": letter, **entry}

    return sorted(periods.values(), key=lambda p: p["startMinutes"])
