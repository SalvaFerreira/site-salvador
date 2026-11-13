"""Parks, campuses and the airport up close: footpaths in green spaces and on
campuses, pedestrian squares, hedges, flagpoles, the stands where planes park
and the jet bridges that reach them.

Input:  OpenStreetMap via Overpass (cached in data/raw/), data/raw/_land.wkb,
        public/data/manifest.json (02_process.py) and public/data/cover.json (06_cover.py)
Output: public/data/grounds.bin   lines (LXR1, 1 m units), class per line:
                                  0 footpath, 1 wide path or track, 2 steps, 3 hedge, 4 jet bridge
        public/data/grounds.json  index, pedestrian squares (outline, then holes), flagpoles, aircraft stands

Data (c) OpenStreetMap contributors, ODbL.
"""
import importlib
import json
import math

import shapely
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import nearest_points, unary_union
from shapely.strtree import STRtree

from config import EAST, NORTH, OUT, RAW, SOUTH, WEST

D = importlib.import_module("01_download")
P = importlib.import_module("02_process")
L = importlib.import_module("05_plan")

PATH, WIDE, STEPS, HEDGE, JET_BRIDGE = range(5)
PATH_KINDS = {"footway": PATH, "path": PATH, "bridleway": PATH, "pedestrian": WIDE, "track": WIDE, "steps": STEPS}
# Footways that are really part of a street: drawn by the streets already.
STREET_FOOTWAYS = {"sidewalk", "crossing", "traffic_island", "link"}
SQUARE_MIN_M2 = 250
STAND_MERGE_M = 30


def download():
    area = D.bbox(SOUTH, WEST, NORTH, EAST)
    NL = chr(10)
    D.fetch("footpaths", 'way["highway"~"^(footway|path|bridleway|pedestrian|track|steps)$"](' + area + ");" + NL + "out tags geom;")
    D.fetch("green_and_campus", "(" + 'nwr["leisure"~"^(park|garden)$"](' + area + ");"
            + 'nwr["amenity"~"^(university|college)$"](' + area + ");"
            + 'nwr["landuse"="education"](' + area + ");" + ");" + NL + "out body geom;")
    D.fetch("pedestrian_areas", "(" + 'way["highway"="pedestrian"]["area"="yes"](' + area + ");"
            + 'relation["highway"="pedestrian"](' + area + ");" + ");" + NL + "out body geom;")
    D.fetch("hedges", 'way["barrier"="hedge"](' + area + ");" + NL + "out tags geom;")
    D.fetch("flagpoles", 'nwr["man_made"="flagpole"](' + area + ");" + NL + "out center tags;")
    D.fetch("aeroway_stands", "(" + 'nwr["aeroway"="parking_position"](' + area + ");"
            + 'way["aeroway"="jet_bridge"](' + area + ");" + ");" + NL + "out tags geom;")


def parts(geom):
    return [g for g in getattr(geom, "geoms", [geom]) if g.geom_type == "LineString"]


def green_and_campus(view):
    polys = []
    for el in P.load("green_and_campus"):
        polys += P.polygons_of(P.element_polygon(el))
    return unary_union(polys).buffer(4).intersection(view)


def footpaths(where):
    """Paths inside parks, gardens and campuses: the rest of the city has its pavements."""
    lines, classes = [], []
    for el in P.load("footpaths"):
        tags = el.get("tags", {})
        if tags.get("footway") in STREET_FOOTWAYS or tags.get("area") == "yes" or tags.get("tunnel"):
            continue
        pts = el.get("geometry") or []
        if len(pts) < 2:
            continue
        line = LineString(P.local_coords(pts))
        if not line.intersects(where):
            continue
        for part in parts(line.intersection(where)):
            if part.length > 6:
                lines.append(part.simplify(0.8))
                classes.append(PATH_KINDS.get(tags["highway"], PATH))
    return lines, classes


def hedges(view):
    lines = []
    for el in P.load("hedges"):
        pts = el.get("geometry") or []
        if len(pts) >= 2:
            lines += [p.simplify(0.4) for p in parts(LineString(P.local_coords(pts)).intersection(view)) if p.length > 2]
    return lines


def pedestrian_squares(view, land):
    out = []
    for el in P.load("pedestrian_areas"):
        for poly in P.polygons_of(P.element_polygon(el)):
            poly = poly.intersection(land).intersection(view)
            for p in P.polygons_of(poly):
                if p.area >= SQUARE_MIN_M2:
                    p = p.simplify(0.8)
                    if p.geom_type == "Polygon" and not p.is_empty:
                        # The outline, then its holes (the lawns of a parterre, a fountain).
                        rings = [p.exterior] + [r for r in p.interiors if Polygon(r).area > 20]
                        out.append([[[round(x), round(y)] for x, y in r.coords[:-1]] for r in rings])
    return out


def flagpoles(view):
    """[x, y, height, Portuguese flag 1/0] for each flagpole."""
    out = []
    for el in P.load("flagpoles"):
        c = el.get("center") or ({"lat": el["lat"], "lon": el["lon"]} if "lat" in el else None)
        if not c:
            continue
        (x, y), = P.local_coords([c])
        if not view.contains(Point(x, y)):
            continue
        tags = el.get("tags", {})
        height = min(40.0, P.number(tags.get("height")) or 10.0)
        portugal = tags.get("flag:wikidata") == "Q128812" or tags.get("country") == "PT" or "Portugal" in tags.get("flag:name", "")
        out.append([round(x, 1), round(y, 1), round(height), 1 if portugal else 0])
    return out


def stands(view):
    """Where planes park: [x, y, heading] (heading in radians, from east towards north, nose first).

    Mapped as lines (the lead-in line painted on the apron, ending where the nose
    stops) or as points. A point takes its heading away from the nearest taxiway.
    """
    cover = json.loads((OUT / "cover.json").read_text(encoding="utf-8"))
    taxiways = [LineString(t) for t in cover.get("taxiways", []) if len(t) > 1]
    taxi_tree = STRtree(taxiways) if taxiways else None
    out, bridges = [], []
    elements = P.load("aeroway_stands")
    for el in elements:
        if el.get("tags", {}).get("aeroway") != "parking_position" or el["type"] != "way":
            continue
        pts = P.local_coords(el.get("geometry") or [])
        if len(pts) < 2 or not view.contains(Point(pts[0])):
            continue
        line = LineString(pts)
        # The end further from the taxiways is where the plane stops.
        a, b = Point(pts[0]), Point(pts[-1])
        if taxi_tree is not None:
            near = taxiways[taxi_tree.nearest(a)]
            if a.distance(near) > b.distance(near):
                a, b = b, a
        stop = b
        d = line.project(stop)
        back = line.interpolate(d - 6 if d >= 6 else d + 6)
        heading = math.atan2(stop.y - back.y, stop.x - back.x)
        out.append([round(stop.x, 1), round(stop.y, 1), round(heading, 3)])
    for el in elements:
        tags = el.get("tags", {})
        if tags.get("aeroway") == "jet_bridge":
            pts = P.local_coords(el.get("geometry") or [])
            if len(pts) >= 2 and view.contains(Point(pts[0])):
                bridges.append(LineString(pts))
            continue
        if tags.get("aeroway") != "parking_position" or el["type"] != "node":
            continue
        (x, y), = P.local_coords([{"lat": el["lat"], "lon": el["lon"]}])
        if not view.contains(Point(x, y)) or any(math.hypot(s[0] - x, s[1] - y) < STAND_MERGE_M for s in out):
            continue
        heading = 0.0
        if taxi_tree is not None:
            near = nearest_points(taxiways[taxi_tree.nearest(Point(x, y))], Point(x, y))[0]
            heading = math.atan2(y - near.y, x - near.x)
        out.append([round(x, 1), round(y, 1), round(heading, 3)])
    return out, bridges


def main():
    download()
    manifest = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
    view = box(*manifest["view"])
    land = shapely.from_wkb((RAW / "_land.wkb").read_bytes())

    where = green_and_campus(view)
    paths, classes = footpaths(where)
    hedge_lines = hedges(view)
    stand_points, bridge_lines = stands(view)
    lines = paths + hedge_lines + bridge_lines
    classes = classes + [HEDGE] * len(hedge_lines) + [JET_BRIDGE] * len(bridge_lines)
    info = L.write_lines(OUT / "grounds.bin", lines, classes, 1)
    squares = pedestrian_squares(view, land)
    index = {
        "attribution": "Paths, squares, hedges, flagpoles and aircraft stands (c) OpenStreetMap contributors, ODbL",
        "file": info["file"],
        "unitsPerMetre": info["unitsPerMetre"],
        "squares": squares,
        "flagpoles": flagpoles(view),
        "stands": stand_points,
    }
    text = json.dumps(index, separators=(",", ":"), ensure_ascii=False)
    (OUT / "grounds.json").write_text(text, encoding="utf-8")
    km = lambda cls: round(sum(l.length for l, c in zip(lines, classes) if c == cls) / 1000, 1)
    print(f"grounds.bin: {info['lines']} lines, {info['bytes'] / 1e3:.0f} kB; km: paths {km(PATH)}, wide {km(WIDE)}, steps {km(STEPS)}, hedges {km(HEDGE)}, jet bridges {len(bridge_lines)}")
    print(f"grounds.json: {len(squares)} squares, {len(index['flagpoles'])} flagpoles, {len(stand_points)} stands, {len(text.encode()) / 1e3:.0f} kB")
    total = sum(f.stat().st_size for f in OUT.iterdir() if f.is_file())
    print(f"all city data: {total / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
