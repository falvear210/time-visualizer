#!/usr/bin/env python3
"""Wrap sluh-period-widget.js into sluh-period.scriptable.

A .scriptable file is the JSON bundle Scriptable imports when you open it
from Safari ("Open in Scriptable") -- no copy/paste, no typing. Re-run this
whenever sluh-period-widget.js changes:

    python3 api/build-scriptable.py
"""
import json
import pathlib

here = pathlib.Path(__file__).parent
src = (here / "sluh-period-widget.js").read_text(encoding="utf-8")

bundle = {
    "always_run_in_app": False,
    "icon": {"color": "red", "glyph": "clock"},
    "name": "SLUH Period",
    "script": src,
}

out = here / "sluh-period.scriptable"
out.write_text(json.dumps(bundle), encoding="utf-8")
print(f"wrote {out} ({len(src)} chars of script)")
