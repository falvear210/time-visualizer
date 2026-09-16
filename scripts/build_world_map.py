#!/usr/bin/env python3
"""
Builds world-map.svg (used by mcl-office.js) from Natural Earth's 110m
admin-0 country boundaries, projected with Equal Earth -- an equal-*area*
projection, so a country's size on screen is proportional to its real area
instead of the Mercator-style bias (Greenland/Russia/Canada blown up) that
the previous hand-drawn vendored map had.

Run ONCE (country borders don't change often enough to justify rerunning):
    python3 scripts/build_world_map.py data/ne_110m_admin_0_countries.geojson ../world-map.svg

The source GeoJSON is cached in data/ (Natural Earth is public domain, no
attribution required) so this has no network dependency and is
reproducible. Re-download it from
https://github.com/nvkelso/natural-earth-vector (geojson/ne_110m_admin_0_countries.geojson)
only if you want a newer Natural Earth release.

Each country becomes a single <path id="xx"> keyed by its lowercase ISO
3166-1 alpha-2 code (a handful of disputed/unrecognized places that Natural
Earth doesn't give an ISO code get an "_name" id instead, same convention as
the map this replaces) -- multi-part countries (islands, exclaves) are just
multiple "M...Z" subpaths within that one <path>.

Each <path> also carries data-lx/data-ly: Natural Earth's own hand-curated
"best point for this country's label" (LABEL_X/LABEL_Y), projected the same
way as the boundary. mcl-office.js reads this directly for zooming to /
dropping a pin on a country -- it lands in the populated heartland, unlike a
geometric centroid computed from the outline, which for a circumpolar giant
(Canada, Russia) or a country with far-flung territories (France) can be
nowhere near it.

The viewBox is sized to LON_CROP_MIN/MAX below, not the full -180..180 --
a flat world map is already a wide ~2:1 rectangle, and the strip either side
of the Americas/Asia (mid-Pacific: Hawaii, Fiji, New Zealand, ...) is empty
ocean this dashboard has no use for, so it's dropped to let the map panel be
less letterboxed. Every country still gets its full geometry (nothing is
filtered out of what's *drawn*), so anything with land outside the crop
(the western Aleutians, Pacific island nations, ...) just extends past the
visible edge and is clipped there, same as a paper map's border.
"""
import json
import math
import sys

# Equal Earth projection (Savric, Patterson & Jenny, 2018) -- the same
# closed-form formula d3-geo-projection uses. Forward-only; this script never
# needs to invert it.
_A1, _A2, _A3, _A4 = 1.340264, -0.081106, 0.000893, 0.003796
_M = math.sqrt(3) / 2

# The window used to size the viewBox (see the module docstring). Chosen so
# every country in mcl-map-languages.csv/mcl-map-places.csv, plus Australia
# and Japan for a recognizable world map, sit comfortably inside it; New
# Zealand, Fiji, and other mid-Pacific nations fall outside and are clipped.
# Widen this if a future pin/language needs land beyond it.
#
# Note LON_CROP_MIN in particular has limited effect: Equal Earth's meridians
# converge toward the poles, so high-latitude land (Alaska, northern Canada)
# can sit *less* far left on the flat map than mid-latitude land (coastal
# California) despite a much more negative longitude. In practice nothing
# currently drawn projects further west than the US west coast regardless of
# where this is set between roughly -125 and -170 -- see the `margin` comment
# below for the knob that actually controls how much ocean shows at the edge.
LON_CROP_MIN, LON_CROP_MAX = -142, 145


def equal_earth(lon_deg, lat_deg):
    lam = math.radians(lon_deg)
    phi = math.radians(lat_deg)
    param_lat = math.asin(_M * math.sin(phi))
    p2 = param_lat * param_lat
    p6 = p2 * p2 * p2
    x = lam * math.cos(param_lat) / (_M * (_A1 + 3 * _A2 * p2 + p6 * (7 * _A3 + 9 * _A4 * p2)))
    y = param_lat * (_A1 + _A2 * p2 + p6 * (_A3 + _A4 * p2))
    return x, y


def iso_of(props, seen, dupes):
    for key in ("ISO_A2", "ISO_A2_EH"):
        iso = props.get(key)
        # a plain ISO 3166-1 alpha-2 code is exactly two letters -- Natural
        # Earth stamps a few disputed places (Taiwan: "CN-TW") with something
        # else in ISO_A2 itself, which isn't a code mcl-map-*.csv can match,
        # so skip straight to the next candidate instead of accepting it.
        if iso and iso != "-99" and len(iso) == 2 and iso.isalpha():
            iso = iso.lower()
            if iso in seen:
                dupes.append((iso, props.get("NAME")))
            seen.add(iso)
            return iso
    # a few disputed/unrecognized places carry no ISO code at all -- fall
    # back to a "_name" slug (matches the convention of the map this
    # replaces) so they still render, just not shade/pin-able by ISO code.
    slug = "_" + "".join(c if c.isalnum() else "_" for c in props.get("NAME", "unknown").lower())
    seen.add(slug)
    return slug


def rings_of(geometry):
    t = geometry["type"]
    polys = geometry["coordinates"] if t == "MultiPolygon" else [geometry["coordinates"]]
    for poly in polys:
        for ring in poly:
            yield ring


def main():
    if len(sys.argv) != 3:
        print("usage: build_world_map.py <source.geojson> <dest.svg>", file=sys.stderr)
        sys.exit(1)
    src_path, dest_path = sys.argv[1], sys.argv[2]

    data = json.load(open(src_path))
    features = data["features"]

    seen_ids, dupes = set(), []
    countries = []  # (id, name, [ [(x,y), ...], ... rings ], label_point) in equal-earth units
    all_x, all_y = [], []
    for f in features:
        props = f["properties"]
        cid = iso_of(props, seen_ids, dupes)
        rings = []
        for ring in rings_of(f["geometry"]):
            pts = [equal_earth(lon, lat) for lon, lat in ring]
            rings.append(pts)
            for (lon, _lat), (x, y) in zip(ring, pts):
                if LON_CROP_MIN <= lon <= LON_CROP_MAX:
                    all_x.append(x)
                    all_y.append(y)
        # Natural Earth ships a hand-curated "best point for this country's
        # label" per feature (LABEL_X/Y) -- cartographer-placed, so it lands
        # in the populated heartland rather than a country's geometric
        # centroid, which for a circumpolar giant (Canada, Russia) or one
        # with far-flung territories (France) can be nowhere near it. This is
        # exactly the point mcl-office.js wants for zooming to / dropping a
        # pin on a country, so we project it here rather than recomputing
        # something worse from the outline in the browser.
        label_pt = equal_earth(props["LABEL_X"], props["LABEL_Y"])
        countries.append((cid, props.get("NAME", cid), rings, label_pt))

    if dupes:
        print(f"warning: {len(dupes)} duplicate ids (last one wins): {dupes}", file=sys.stderr)

    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)

    width = 800.0
    scale = width / (max_x - min_x)  # ONE scale for both axes -- an equal-area
    height = (max_y - min_y) * scale  # projection stops being equal-area the moment x and y scale differently
    # Land is drawn right up to this margin on every side -- it's what gives a
    # bit of visible ocean around the outermost coastline instead of it
    # touching the panel's edge. LON_CROP_MIN/MAX won't buy you this: Equal
    # Earth's meridians converge toward the poles, so a high-latitude place
    # (Alaska, northern Canada) can have a very negative longitude and still
    # land *less* far left on the flat map than a mid-latitude one (coastal
    # California) -- moving the crop past whatever mid-latitude point is
    # actually the leftmost *on the map* does nothing, which is why -130 and
    # -142 looked identical. This margin is the real "add breathing room" knob.
    margin = 16.0

    def to_svg(pt):
        x, y = pt
        # flip Y: latitude increases northward, SVG y increases downward
        return (x - min_x) * scale + margin, (max_y - y) * scale + margin

    path_elems = []
    for cid, name, rings, label_pt in countries:
        subpaths = []
        for ring in rings:
            pts = [to_svg(p) for p in ring]
            d = "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in pts) + " Z"
            subpaths.append(d)
        d = " ".join(subpaths)
        lx, ly = to_svg(label_pt)
        safe_name = name.replace("&", "&amp;").replace('"', "&quot;")
        path_elems.append(
            f'<path id="{cid}" data-name="{safe_name}" data-lx="{lx:.2f}" data-ly="{ly:.2f}" '
            f'fill-rule="evenodd" d="{d}"/>'
        )

    vb_w = width + 2 * margin
    vb_h = height + 2 * margin
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vb_w:.2f} {vb_h:.2f}">'
        "<title>World Map (Equal Earth)</title>"
        "<desc>Natural Earth 110m admin-0 countries (public domain), "
        "projected with the Equal Earth equal-area projection "
        "(Savric, Patterson &amp; Jenny 2018) by scripts/build_world_map.py. "
        "IDs are ISO 3166-1 alpha-2, lowercase.</desc>"
        + "".join(path_elems)
        + "</svg>"
    )
    open(dest_path, "w").write(svg)
    print(f"wrote {dest_path}: {len(countries)} countries, viewBox 0 0 {vb_w:.1f} {vb_h:.1f}, {len(svg)} bytes")


if __name__ == "__main__":
    main()
