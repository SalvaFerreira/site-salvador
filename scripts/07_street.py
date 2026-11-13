"""Street furniture and buses: crossings, traffic lights, bus lines, the big
squares paved in calçada, and the north end of the Vasco da Gama bridge.

Input:  OpenStreetMap via Overpass (cached in data/raw/), data/raw/_land.wkb and
        public/data/manifest.json (from 02_process.py), data/raw/roads_*.json
Output: public/data/street.bin   crossings and traffic lights (layout below)
        public/data/bus.bin      bus lines (LXR1 lines, class = line number in street.json)
        public/data/cycle.bin    cycle paths (LXR1 lines)
        public/data/street.json  index, squares, bridge, funiculars, the Santa Justa lift,
                                 viewpoints (miradouros) and café terraces

street.bin, little-endian, every coordinate in half metres from the scene origin:
    "LXS1", u32 crossings C, u32 lights L, u32 junctions J
    i16[C] x, i16[C] y, i16[L] x, i16[L] y, u16[L] junction
    u8[C] angle of the street (0..255 = 0..180 degrees, from east towards north)
    u8[C] kind (0 marked crossing, 1 crossing at traffic lights)
    u8[L] angle of the street the light stands on

Data (c) OpenStreetMap contributors, ODbL.
"""
import importlib
import json
import math
import struct

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import linemerge, unary_union
from shapely.strtree import STRtree

from config import EAST, NORTH, OUT, RAW, SOUTH, WEST

D = importlib.import_module("01_download")
P = importlib.import_module("02_process")
L = importlib.import_module("05_plan")

UNITS = 2
MARKED = {"zebra", "marked", "uncontrolled", "traffic_signals"}
MARKINGS = {"zebra", "yes", "lines", "dashes", "surface", "dots", "ladder"}
JUNCTION_M = 30          # traffic lights closer than this work together
MAX_BUS_LINES = 80
BUS_SIMPLIFY_M = 2.0
SQUARES = ["Praça do Comércio", "Praça Dom Pedro IV", "Rossio"]
VDG_DECK_M = 14          # height of the bridge's viaduct near the north shore


def download():
    area = D.bbox(SOUTH, WEST, NORTH, EAST)
    NL = chr(10)
    D.fetch("street_points", "(" + 'node["highway"="crossing"](' + area + ");"
            + 'node["highway"="traffic_signals"](' + area + ");" + ");" + NL + "out;")
    # Ways once, with their geometry; relations with their member list only.
    D.fetch("bus_relations", 'relation["route"="bus"](' + area + ");" + NL + "out body;")
    D.fetch("bus_ways", 'relation["route"="bus"](' + area + ")->.r;" + NL + "way(r.r)(" + area + ");" + NL + "out tags geom;")
    names = "|".join(SQUARES)
    D.fetch("squares", "(" + 'way["name"~"^(' + names + ')$"]["highway"="pedestrian"](' + area + ");"
            + 'way["name"~"^(' + names + ')$"]["place"="square"](' + area + ");"
            + 'relation["name"~"^(' + names + ')$"]["place"="square"](' + area + ");" + ");" + NL + "out body geom;")
    D.fetch("vasco_da_gama", 'way["name"="Ponte Vasco da Gama"]["bridge"](' + area + ");" + NL + "out tags geom;")
    # Life in the city: funiculars, the Santa Justa lift, cycle paths, viewpoints and café terraces.
    D.fetch("funiculars", 'way["railway"="funicular"](' + area + ");" + NL + "out tags geom;")
    D.fetch("santa_justa", 'nwr["name"~"Elevador de Santa Justa"](' + area + ");" + NL + "out center tags;")
    D.fetch("cycleways", 'way["highway"="cycleway"](' + area + ");" + NL + "out tags geom;")
    D.fetch("viewpoints", 'nwr["tourism"="viewpoint"]["name"~"^Miradouro"](' + area + ");" + NL + "out center tags;")
    D.fetch("terraces", 'node["amenity"~"^(cafe|restaurant|bar)$"]["outdoor_seating"="yes"](' + area + ");" + NL + "out;")
    D.fetch("monuments", "(" + 'nwr["historic"~"^(memorial|monument)$"](' + area + ");"
            + 'nwr["tourism"="artwork"]["artwork_type"~"^(statue|sculpture|bust)$"](' + area + ");"
            + 'nwr["man_made"~"^(obelisk|column)$"](' + area + ");" + ");" + NL + "out center tags;")


def street_lines():
    lines = []
    for f in sorted(RAW.glob("roads_*.json")):
        for el in json.loads(f.read_text(encoding="utf-8"))["elements"]:
            pts = el.get("geometry") or []
            if len(pts) >= 2 and el.get("tags", {}).get("area") != "yes":
                lines.append(LineString(P.local_coords(pts)))
    return lines


def angle_of_street(tree, lines, x, y):
    """Direction of the nearest street at a point, 0..pi."""
    p = Point(x, y)
    line = lines[tree.nearest(p)]
    d = line.project(p)
    a = line.interpolate(max(0.0, d - 3))
    b = line.interpolate(min(line.length, d + 3))
    return math.atan2(b.y - a.y, b.x - a.x) % math.pi, line.distance(p)


def points(land):
    tree_lines = street_lines()
    tree = STRtree(tree_lines)
    crossings, lights = [], []
    for el in P.load("street_points"):
        tags = el.get("tags", {})
        (x, y), = P.local_coords([el])
        if not land.contains(Point(x, y)):
            continue
        if tags.get("highway") == "traffic_signals":
            angle, dist = angle_of_street(tree, tree_lines, x, y)
            if dist < 15:
                lights.append((x, y, angle))
            continue
        marked = tags.get("crossing") in MARKED or tags.get("crossing:markings") in MARKINGS
        if not marked or tags.get("crossing:markings") == "no":
            continue
        angle, dist = angle_of_street(tree, tree_lines, x, y)
        if dist < 6:
            kind = 1 if tags.get("crossing") == "traffic_signals" or tags.get("crossing:signals") == "yes" else 0
            crossings.append((x, y, angle, kind))

    # Lights near each other belong to one junction and change together.
    blobs = unary_union([Point(x, y).buffer(JUNCTION_M / 2) for x, y, _ in lights])
    blobs = list(blobs.geoms) if hasattr(blobs, "geoms") else [blobs]
    blob_tree = STRtree(blobs)
    junction = [int(blob_tree.query(Point(x, y), predicate="intersects")[0]) for x, y, _ in lights]
    return crossings, lights, junction, len(blobs)


def write_points(crossings, lights, junction, junctions):
    def q(v):
        return np.round(np.asarray(v, dtype=float) * UNITS).astype("<i2")

    def a8(v):
        return np.minimum(255, np.round(np.asarray(v, dtype=float) / math.pi * 256)).astype(np.uint8)

    c = np.asarray(crossings, dtype=float).reshape(-1, 4)
    lt = np.asarray(lights, dtype=float).reshape(-1, 3)
    data = b"".join([
        struct.pack("<4sIII", b"LXS1", len(c), len(lt), junctions),
        q(c[:, 0]).tobytes(), q(c[:, 1]).tobytes(), q(lt[:, 0]).tobytes(), q(lt[:, 1]).tobytes(),
        np.asarray(junction, dtype="<u2").tobytes(),
        a8(c[:, 2]).tobytes(), c[:, 3].astype(np.uint8).tobytes(), a8(lt[:, 2]).tobytes(),
    ])
    (OUT / "street.bin").write_bytes(data)
    return len(data)


def bus_lines(view):
    """One way through each bus line (by its number): the longest unbroken stretch in view."""
    ways = {el["id"]: LineString(P.local_coords(el["geometry"])) for el in P.load("bus_ways") if len(el.get("geometry") or []) >= 2}
    best = {}
    for rel in P.load("bus_relations"):
        tags = rel.get("tags", {})
        ref = tags.get("ref") or str(rel["id"])
        parts = [ways[m["ref"]] for m in rel.get("members", []) if m["type"] == "way" and m["ref"] in ways]
        if not parts:
            continue
        joined = unary_union(parts)
        merged = (joined if joined.geom_type == "LineString" else linemerge(joined)).intersection(view)
        pieces = [g for g in getattr(merged, "geoms", [merged]) if g.geom_type == "LineString"]
        if not pieces:
            continue
        line = max(pieces, key=lambda g: g.length)
        if line.length > 1500 and (ref not in best or line.length > best[ref].length):
            best[ref] = line
    chosen = sorted(best.items(), key=lambda kv: -kv[1].length)[:MAX_BUS_LINES]
    lines = [line.simplify(BUS_SIMPLIFY_M) for _, line in chosen]
    info = L.write_lines(OUT / "bus.bin", lines, list(range(len(lines))), 1)
    info["lines"] = [ref for ref, _ in chosen]
    info["km"] = round(sum(line.length for line in lines) / 1000, 1)
    return info


def squares():
    out = []
    for el in P.load("squares"):
        for poly in P.polygons_of(P.element_polygon(el)):
            if poly.area > 2000:
                out.append([[round(x, 1), round(y, 1)] for x, y in poly.simplify(1.0).exterior.coords[:-1]])
    return out


def vasco_da_gama(view, land):
    """The carriageways of the bridge inside the map, over the river and the viaduct on land
    (the site ramps it down to the ground where the viaduct ends)."""
    lines, span = [], []
    for el in P.load("vasco_da_gama"):
        line = LineString(P.local_coords(el["geometry"]))
        # The cable-stayed main bridge: its ends, for the towers and stays.
        if "cable" in el.get("tags", {}).get("bridge:structure", "") and el.get("tags", {}).get("bridge"):
            ends = list(line.coords)
            span.append([[round(ends[0][0], 1), round(ends[0][1], 1)], [round(ends[-1][0], 1), round(ends[-1][1], 1)]])
        clipped = line.intersection(view)
        for part in getattr(clipped, "geoms", [clipped]):
            if part.geom_type == "LineString" and part.length > 40:
                lines.append([[round(x, 1), round(y, 1)] for x, y in part.simplify(1.0).coords])
    return {"deck": VDG_DECK_M, "lines": lines, "span": span}


def center_xy(el):
    c = el.get("center") or ({"lat": el["lat"], "lon": el["lon"]} if "lat" in el else None)
    if not c:
        return None
    (x, y), = P.local_coords([c])
    return x, y


def funiculars(view):
    """The three funiculars (Glória, Bica, Lavra): each its track as a line, in metres."""
    best = {}
    for el in P.load("funiculars"):
        line = LineString(P.local_coords(el["geometry"])).intersection(view)
        name = el.get("tags", {}).get("name", str(el["id"]))
        # Some are mapped as two tracks: one line per funicular, the longer.
        if line.geom_type == "LineString" and line.length > 60 and (name not in best or line.length > best[name].length):
            best[name] = line
    return [{"name": name, "points": [[round(x, 1), round(y, 1)] for x, y in line.simplify(0.5).coords]} for name, line in best.items()]


def named_points(name, view, land):
    out = []
    for el in P.load(name):
        xy = center_xy(el)
        if xy and view.contains(Point(*xy)) and land.buffer(30).contains(Point(*xy)):
            out.append([round(xy[0], 1), round(xy[1], 1)])
    return out


STATUE, COLUMN, OBELISK, BUST, SCULPTURE = range(5)
# Default heights in metres, when OpenStreetMap gives none.
MONUMENT_HEIGHT = {STATUE: 7, COLUMN: 27, OBELISK: 18, BUST: 3, SCULPTURE: 4}
# Which kind wins when two are mapped at the same spot.
MONUMENT_RANK = [COLUMN, OBELISK, STATUE, SCULPTURE, BUST]


def monument_kind(tags):
    """What to draw for a memorial, monument or artwork; None for plaques, benches and the like."""
    memorial = tags.get("memorial", "")
    artwork = tags.get("artwork_type", "")
    height = P.number(tags.get("height")) or 0
    if tags.get("man_made") == "obelisk" or "obelisk" in memorial:
        return OBELISK
    if "column" in memorial or (tags.get("historic") == "monument" and height >= 20):
        return COLUMN
    if "statue" in memorial or artwork == "statue":
        return STATUE
    if "bust" in memorial or artwork == "bust":
        return BUST
    if "sculpture" in memorial or artwork == "sculpture":
        return SCULPTURE
    # Columns with no name are mostly parts of buildings, not monuments.
    return None


# Famous monuments whose OpenStreetMap tags do not say what they look like: kind and height.
MONUMENT_OVERRIDES = {
    "Dom Pedro IV": (COLUMN, 27),
    "Dom José I": (STATUE, 14),
    "Aos Restauradores de 1640": (OBELISK, 30),
}
# Drawn by hand in the site (Landmarks.tsx), so not as a generic monument.
HAND_MADE = {"Arco do Triunfo da Rua Augusta", "Padrão dos Descobrimentos"}


def monuments(view, land):
    """Statues, busts, sculptures, obelisks and commemorative columns: [x, y, kind, height]."""
    found = []
    for el in P.load("monuments"):
        tags = el.get("tags", {})
        name = tags.get("name", "")
        # The hand-made landmarks, and anything mapped as part of them.
        if name in HAND_MADE or any(h in name for h in ("Padrão dos Descobrimentos", "Arco do Triunfo")):
            continue
        kind = monument_kind(tags)
        override = MONUMENT_OVERRIDES.get(name)
        if override:
            kind = override[0]
        xy = center_xy(el)
        if kind is None or not xy or not view.contains(Point(*xy)) or not land.contains(Point(*xy)):
            continue
        height = (override[1] if override else None) or P.number(tags.get("height")) or MONUMENT_HEIGHT[kind]
        # A statue, bust or sculpture taller than this is a mapping slip (the height of a building nearby).
        cap = 60 if kind in (COLUMN, OBELISK) else 16
        found.append((MONUMENT_RANK.index(kind), xy, kind, min(height, cap)))
    # The same monument is often mapped twice (a point and an area): keep one, the grander kind.
    kept = []
    for rank, (x, y), kind, height in sorted(found, key=lambda f: f[0]):
        if all((x - k[0]) ** 2 + (y - k[1]) ** 2 > 15 ** 2 for k in kept):
            kept.append([round(x, 1), round(y, 1), kind, round(height, 1)])
    return kept


def landmarks():
    """Where the hand-made landmarks stand, from their outlines in OpenStreetMap:
    {name: [x, y, angle of the long side (radians from east towards north), length, width]}."""
    from config import EXTRA_STRIPS, TILES
    names = [f"buildings_{i}_{j}" for i in range(TILES) for j in range(TILES)] + ["building_relations"]
    names += [f"buildings_extra_{strip[0]}" for strip in EXTRA_STRIPS] + [f"building_relations_extra_{strip[0]}" for strip in EXTRA_STRIPS]
    out = {}
    for name in names:
        if not (RAW / f"{name}.json").exists():
            continue
        for el in P.load(name):
            label = el.get("tags", {}).get("name", "")
            if label not in HAND_MADE or label in out:
                continue
            for poly in P.polygons_of(P.element_polygon(el)):
                box = poly.minimum_rotated_rectangle
                pts = list(box.exterior.coords)[:4]
                sides = [(pts[i], pts[(i + 1) % 4]) for i in range(2)]
                (a, b), (c, d) = sides
                la = math.hypot(b[0] - a[0], b[1] - a[1])
                lc = math.hypot(d[0] - c[0], d[1] - c[1])
                (p0, p1), length, width = ((a, b), la, lc) if la >= lc else ((c, d), lc, la)
                angle = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
                out[label] = [round(poly.centroid.x, 1), round(poly.centroid.y, 1), round(angle, 3), round(length, 1), round(width, 1)]
    return out


def cycle_paths(land):
    lines = []
    for el in P.load("cycleways"):
        line = LineString(P.local_coords(el["geometry"])).intersection(land)
        for part in getattr(line, "geoms", [line]):
            if part.geom_type == "LineString" and part.length > 80:
                lines.append(part.simplify(1.0))
    info = L.write_lines(OUT / "cycle.bin", lines, [0] * len(lines), 1)
    info["km"] = round(sum(l.length for l in lines) / 1000, 1)
    return info


def main():
    download()
    manifest = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
    view = box(*manifest["view"])
    land = shapely.from_wkb((RAW / "_land.wkb").read_bytes())

    crossings, lights, junction, junctions = points(land)
    size = write_points(crossings, lights, junction, junctions)
    bus = bus_lines(view)
    index = {
        "attribution": "Crossings, traffic lights, bus lines and squares (c) OpenStreetMap contributors, ODbL",
        "file": "street.bin",
        "unitsPerMetre": UNITS,
        "crossings": len(crossings),
        "lights": len(lights),
        "junctions": junctions,
        "bus": {"file": bus["file"], "unitsPerMetre": bus["unitsPerMetre"], "lines": bus["lines"]},
        "squares": squares(),
        "vascoDaGama": vasco_da_gama(view, land),
        "funiculars": funiculars(view),
        "santaJusta": (named_points("santa_justa", view, land) or [None])[0],
        "viewpoints": named_points("viewpoints", view, land),
        "terraces": named_points("terraces", view, land),
        "monuments": monuments(view, land),
        "landmarks": landmarks(),
        "cycle": {k: v for k, v in cycle_paths(land).items() if k in ("file", "unitsPerMetre", "lines", "bytes", "km")},
    }
    text = json.dumps(index, separators=(",", ":"), ensure_ascii=False)
    (OUT / "street.json").write_text(text, encoding="utf-8")
    print(f"street.bin: {len(crossings)} crossings, {len(lights)} traffic lights in {junctions} junctions, {size / 1e3:.0f} kB")
    print(f"bus.bin: {len(bus['lines'])} lines, {bus['km']} km, {bus['bytes'] / 1e3:.0f} kB")
    print(f"street.json: {len(index['squares'])} squares, {len(index['vascoDaGama']['lines'])} bridge lines, {len(text.encode()) / 1e3:.0f} kB")
    print(f"funiculars: {[f['name'] for f in index['funiculars']]}, Santa Justa: {index['santaJusta']}")
    print(f"viewpoints: {len(index['viewpoints'])}, terraces: {len(index['terraces'])}, cycle paths: {index['cycle']}")
    kinds = ["statue", "column", "obelisk", "bust", "sculpture"]
    print("monuments:", {k: sum(1 for m in index["monuments"] if m[2] == i) for i, k in enumerate(kinds)})
    print("landmarks:", index["landmarks"])
    total = sum(f.stat().st_size for f in OUT.iterdir() if f.is_file())
    print(f"all city data: {total / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
