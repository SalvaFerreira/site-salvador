"""Turn the raw OpenStreetMap downloads into compact binary files for the scene.

Input:  data/raw/*.json (from 01_download.py)
Output: public/data/<freguesia>.bin   building footprints + heights, one per neighbourhood
        public/data/land.bin          land polygons (everything else is river)
        public/data/roads.bin         street centre lines, for the street lighting
        public/data/manifest.json     index of the above, bridge geometry, statistics

Coordinates are metres relative to the scene origin (config.ORIGIN_*),
x = east, y = north, projected with EPSG:3763.

Binary layout (little endian), shared by every .bin file:

    char[4]  magic "LXB1"
    u32      nBuildings
    u32      nRings
    u32      nVerts
    u16[nRings]      vertices per ring (rings are not closed)
    i16[nVerts * 2]  x,y pairs in quantised units (manifest "unitsPerMetre").
                     First vertex of a ring is relative to the chunk origin,
                     the following ones are deltas from the previous vertex.
    u8[nBuildings]   height in metres
    u8[nBuildings]   rings per building (first is the outer ring, counter-clockwise;
                     the rest are holes, clockwise)

roads.bin holds polylines instead of polygons:

    char[4]  magic "LXR1"
    u32      nLines
    u32      nVerts
    u16[nLines]      vertices per line
    i16[nVerts * 2]  x,y pairs, delta encoded like the rings above
    u8[nLines]       class: 0 = main roads, 1 = secondary/tertiary, 2 = local streets

Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import re
import struct
import sys
import unicodedata
import warnings

import geopandas as gpd
import pandas as pd
import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import linemerge, polygonize, unary_union

import height_model as H
from config import (
    CRS_METRIC, EAST, EXTRA_STRIPS, LEVEL_HEIGHT_M, MIN_AREA_M2, NORTH, ORIGIN_LAT, ORIGIN_LON,
    OUT, RAW, SIMPLIFY_M, SOUTH, TILES, WEST,
)

UNITS_PER_METRE = 4          # buildings: 0.25 m resolution
LAND_UNITS_PER_METRE = 1     # land outline: 1 m resolution
LAND_SIMPLIFY_M = 4.0
SMALL_TYPES = {"garage", "garages", "shed", "hut", "roof", "carport", "kiosk", "greenhouse", "service"}

to_metric = Transformer.from_crs("EPSG:4326", CRS_METRIC, always_xy=True)
OX, OY = to_metric.transform(ORIGIN_LON, ORIGIN_LAT)


def load(name):
    return json.loads((RAW / f"{name}.json").read_text(encoding="utf-8"))["elements"]


def local_coords(geometry):
    """Overpass [{lat, lon}, ...] -> [(x, y), ...] in local metres."""
    lons = [p["lon"] for p in geometry]
    lats = [p["lat"] for p in geometry]
    xs, ys = to_metric.transform(lons, lats)
    return list(zip(np.asarray(xs) - OX, np.asarray(ys) - OY))


def relation_polygon(el):
    """Assemble a (multi)polygon from the outer/inner member ways of a relation."""
    outers, inners = [], []
    for m in el.get("members", []):
        if m.get("type") != "way" or len(m.get("geometry") or []) < 2:
            continue
        line = LineString(local_coords(m["geometry"]))
        (inners if m.get("role") == "inner" else outers).append(line)
    if not outers:
        return None
    shell = unary_union(list(polygonize(unary_union(outers))))
    if shell.is_empty:
        return None
    if inners:
        holes = list(polygonize(unary_union(inners)))
        if holes:
            shell = shell.difference(unary_union(holes))
    return shell


def element_polygon(el):
    if el["type"] == "way":
        pts = el.get("geometry") or []
        if len(pts) < 4:
            return None
        return Polygon(local_coords(pts))
    if el["type"] == "relation":
        return relation_polygon(el)
    return None


def polygons_of(geom):
    if geom is None or geom.is_empty:
        return []
    if not geom.is_valid:
        geom = geom.buffer(0)
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def number(text):
    m = re.match(r"\s*(\d+(?:[.,]\d+)?)", text or "")
    return float(m.group(1).replace(",", ".")) if m else None


def slugify(name):
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")


# ---------------------------------------------------------------- buildings

# Bridge pylons are mapped as buildings; they are exported apart, as towers.
BRIDGE_TOWERS = []


# The 24 parishes of the city of Lisbon; everything else on the map is the suburbs.
LISBON_FREGUESIAS = {
    "Ajuda", "Alcântara", "Alvalade", "Areeiro", "Arroios", "Avenidas Novas", "Beato", "Belém",
    "Benfica", "Campo de Ourique", "Campolide", "Carnide", "Estrela", "Lumiar", "Marvila",
    "Misericórdia", "Olivais", "Parque das Nações", "Penha de França", "Santa Clara",
    "Santa Maria Maior", "Santo António", "São Domingos de Benfica", "São Vicente",
}
OUTSIDE_MIN_AREA_M2 = 50

# How a roof is drawn (the "roof" byte in the chunk files; see loadChunk in the site).
ROOF_AUTO, ROOF_FLAT, ROOF_PITCHED, ROOF_PYRAMID, ROOF_DOME = range(5)
ROOF_SHAPES = {
    "flat": ROOF_FLAT,
    **{k: ROOF_PITCHED for k in ("gabled", "hipped", "half-hipped", "side_hipped", "mansard", "gambrel", "saltbox", "skillion", "butterfly", "round")},
    **{k: ROOF_PYRAMID for k in ("pyramidal", "cone", "tented")},
    **{k: ROOF_DOME for k in ("dome", "onion")},
}


def use_parts(b):
    """Where a building is mapped in parts, draw the parts instead of its outline.

    An outline goes when parts cover at least half of it. A part with no height
    of its own takes the height of the outline it stands on.
    """
    parts = b[b["kind"] == "part"]
    outlines = b[b["kind"] != "part"]
    if parts.empty:
        return b, 0
    hits = gpd.sjoin(outlines[["geometry"]], parts[["geometry"]], predicate="intersects")
    covered = {}
    for oi, pi in zip(hits.index, hits["index_right"]):
        area = outlines.geometry[oi].intersection(parts.geometry[pi]).area
        covered[oi] = covered.get(oi, 0) + area
    drop = [oi for oi, area in covered.items() if area >= 0.5 * outlines.geometry[oi].area]
    # Heights for parts that have none, from the outline under them.
    for oi, pi in zip(hits.index, hits["index_right"]):
        if pd.isna(b.at[pi, "height_tag"]) and pd.isna(b.at[pi, "levels_tag"]):
            h = b.at[oi, "height_tag"]
            if pd.isna(h) and not pd.isna(b.at[oi, "levels_tag"]):
                h = b.at[oi, "levels_tag"] * LEVEL_HEIGHT_M
            if not pd.isna(h):
                b.at[pi, "height_tag"] = h
    return b.drop(index=drop).reset_index(drop=True), len(drop)


def read_buildings():
    seen, rows = set(), []
    names = [f"buildings_{i}_{j}" for i in range(TILES) for j in range(TILES)] + ["building_relations"]
    for strip, *_ in EXTRA_STRIPS:
        names += [f"buildings_extra_{strip}", f"building_relations_extra_{strip}"]
    if (RAW / "building_parts.json").exists():
        names.append("building_parts")
    for name in names:
        for el in load(name):
            key = (el["type"], el["id"])
            if key in seen:
                continue
            seen.add(key)
            tags = el.get("tags", {})
            if tags.get("location") == "underground" or str(tags.get("layer", "")).startswith("-"):
                continue
            # Statues, columns, arches and other monuments are drawn as models (07_street.py and
            # Landmarks in the site), not as a block raised from their outline.
            if tags.get("historic") in ("memorial", "monument") or tags.get("building") in ("pillar", "monument"):
                continue
            if "bridge:support" in tags:
                for poly in polygons_of(element_polygon(el)):
                    minx, miny, maxx, maxy = poly.bounds
                    BRIDGE_TOWERS.append({
                        "x": round(poly.centroid.x, 1), "y": round(poly.centroid.y, 1),
                        "width": round(maxx - minx, 1), "depth": round(maxy - miny, 1),
                        "height": round(number(tags.get("height")) or 70.0, 1),
                    })
                continue
            part = "building:part" in tags and "building" not in tags
            min_tag = number(tags.get("min_height"))
            if min_tag is None and number(tags.get("building:min_level")) is not None:
                min_tag = number(tags.get("building:min_level")) * LEVEL_HEIGHT_M
            for poly in polygons_of(element_polygon(el)):
                rows.append({
                    "geometry": poly,
                    "kind": "part" if part else tags.get("building", "yes"),
                    "height_tag": number(tags.get("height")),
                    "levels_tag": number(tags.get("building:levels")),
                    "min_tag": min_tag,
                    "roof": ROOF_SHAPES.get(tags.get("roof:shape", ""), ROOF_AUTO),
                })
    return gpd.GeoDataFrame(rows, geometry="geometry")


def simplify(poly):
    simple = poly.simplify(SIMPLIFY_M, preserve_topology=True)
    if simple.is_empty or not simple.is_valid or not isinstance(simple, Polygon):
        return poly
    return simple


# Scores of the height model in the last run, for the manifest.
HEIGHT_REPORT = {}


def assign_heights(gdf):
    """Height from the height tag, else levels x 3 m, else predicted by a model trained on those."""
    height = np.full(len(gdf), np.nan)
    source = np.full(len(gdf), "estimated", dtype=object)

    has_h = gdf["height_tag"].notna() & (gdf["height_tag"] > 0)
    height[has_h] = gdf.loc[has_h, "height_tag"]
    source[has_h] = "height"

    has_l = ~has_h & gdf["levels_tag"].notna() & (gdf["levels_tag"] > 0)
    height[has_l] = gdf.loc[has_l, "levels_tag"] * LEVEL_HEIGHT_M
    source[has_l] = "levels"

    known = ~np.isnan(height)
    small = ~known & (gdf["kind"].isin(SMALL_TYPES) | (gdf["area"] < 40)).to_numpy()

    # The rest: learnt from the tagged buildings (see height_model.py).
    height, report = H.fit_and_predict(gdf, height, known)
    height[small] = LEVEL_HEIGHT_M
    HEIGHT_REPORT.clear()
    HEIGHT_REPORT.update(report)

    gdf["height"] = np.clip(np.round(height), 3, 255).astype(np.uint8)
    gdf["height_source"] = source
    return gdf


# ---------------------------------------------------------------- neighbourhoods

def read_freguesias():
    rows, seen = [], set()
    files = ["freguesias"] + (["freguesias_extra"] if (RAW / "freguesias_extra.json").exists() else [])
    for el in (e for name in files for e in load(name)):
        name = el.get("tags", {}).get("name")
        if el["id"] in seen:
            continue
        seen.add(el["id"])
        polys = polygons_of(relation_polygon(el))
        if name and polys:
            rows.append({"name": name, "geometry": unary_union(polys)})
    return gpd.GeoDataFrame(rows, geometry="geometry")


# ---------------------------------------------------------------- land / river

def build_land(area, buildings):
    """Split the visible rectangle along the coastline; built-up faces are land."""
    ways = {}
    for name in ("coastline", "coastline_extra"):
        if (RAW / f"{name}.json").exists():
            ways.update({el["id"]: el for el in load(name)})
    lines = [LineString(local_coords(el["geometry"])) for el in ways.values() if len(el.get("geometry") or []) >= 2]
    if not lines:
        sys.exit("No coastline found in the area: the land/river split needs another source.")
    merged = linemerge(unary_union(lines))
    faces = list(polygonize(unary_union([area.boundary, merged.intersection(area.buffer(1))])))
    faces = gpd.GeoDataFrame(geometry=faces)
    points = gpd.GeoDataFrame(geometry=buildings.geometry.representative_point())
    counts = gpd.sjoin(points, faces, predicate="within").groupby("index_right").size()
    faces["n"] = counts.reindex(faces.index).fillna(0)
    # Density, not presence: the bridge towers are mapped as buildings standing in the river.
    density = faces["n"] / (faces.geometry.area / 1e6)
    land = unary_union(faces.loc[density > 20, "geometry"].tolist())

    # Large inland water bodies mapped as polygons (docks, river arms).
    water = []
    for el in load("water"):
        for poly in polygons_of(element_polygon(el)):
            if poly.area > 50_000:
                water.append(poly)
    if water:
        land = land.difference(unary_union(water))
    land = land.simplify(LAND_SIMPLIFY_M, preserve_topology=True)
    return [p for p in polygons_of(land) if p.area > 500]


# ---------------------------------------------------------------- streets

ROAD_UNITS_PER_METRE = 2
ROAD_SIMPLIFY_M = 2.5
ROAD_CLASS = {"motorway": 0, "trunk": 0, "primary": 0, "secondary": 1, "tertiary": 1}


ELEVATED_BRIDGES = {"Ponte 25 de Abril", "Ponte Vasco da Gama"}


def write_roads(path, land):
    """Street centre lines on land, as delta-encoded polylines."""
    seen, lines, classes = set(), [], []
    for name in [f"roads_{i}_{j}" for i in range(2) for j in range(2)] + [f"roads_extra_{s[0]}" for s in EXTRA_STRIPS]:
        if not (RAW / f"{name}.json").exists():
            print(f"  {name}: not downloaded yet, skipped")
            continue
        for el in load(name):
            pts = el.get("geometry") or []
            if el["id"] in seen or len(pts) < 2:
                continue
            seen.add(el["id"])
            tags = el.get("tags", {})
            if tags.get("tunnel") in ("yes", "building_passage") or str(tags.get("layer", "")).startswith("-"):
                continue
            if tags.get("area") == "yes":
                continue
            # The two bridges are drawn up in the air, ramps included (Bridge25 and
            # VascoDaGama in the site); a copy on the ground would show under them.
            if tags.get("bridge") and tags.get("name") in ELEVATED_BRIDGES:
                continue
            kind = tags["highway"].replace("_link", "")
            lines.append(LineString(local_coords(pts)))
            classes.append(ROAD_CLASS.get(kind, 2))

    roads = gpd.GeoDataFrame({"cls": classes}, geometry=lines)
    # Keeping only what is on land also drops the bridge deck, which is drawn separately.
    roads["geometry"] = roads.geometry.intersection(unary_union(land).buffer(3))
    roads = roads.explode(index_parts=False)
    roads = roads[roads.geometry.geom_type == "LineString"]
    roads["geometry"] = roads.geometry.simplify(ROAD_SIMPLIFY_M)
    roads = roads[roads.geometry.length > 4]

    vert_counts, coords, kept_classes, length = [], [], [], 0.0
    for line, cls in zip(roads.geometry, roads["cls"]):
        pts = np.round(np.asarray(line.coords)[:, :2] * ROAD_UNITS_PER_METRE).astype(np.int64)
        keep = np.ones(len(pts), dtype=bool)
        keep[1:] = np.any(pts[1:] != pts[:-1], axis=1)
        pts = pts[keep]
        if len(pts) < 2:
            continue
        deltas = pts.copy()
        deltas[1:] -= pts[:-1]
        if np.abs(deltas).max() > 32767 or len(pts) > 65535:
            sys.exit("roads.bin: a street does not fit the 16 bit encoding.")
        vert_counts.append(len(pts))
        coords.append(deltas)
        kept_classes.append(cls)
        length += line.length
    flat = np.concatenate(coords).astype("<i2")
    data = b"".join([
        struct.pack("<4sII", b"LXR1", len(vert_counts), len(flat)),
        np.asarray(vert_counts, dtype="<u2").tobytes(),
        flat.tobytes(),
        np.asarray(kept_classes, dtype=np.uint8).tobytes(),
    ])
    path.write_bytes(data)
    return {"file": path.name, "unitsPerMetre": ROAD_UNITS_PER_METRE, "lines": len(vert_counts),
            "vertices": int(len(flat)), "bytes": len(data), "km": round(length / 1000, 1)}


# ---------------------------------------------------------------- lon/lat -> scene

def fit_projection():
    """Quadratic fit of lon/lat -> local metres, so the site needs no projection library.

    x and y are each  c0 + c1*dl + c2*dp + c3*dl*dp + c4*dl^2 + c5*dp^2
    with dl = lon - origin lon, dp = lat - origin lat (degrees).
    """
    lon, lat = np.meshgrid(np.linspace(WEST, EAST, 40), np.linspace(SOUTH, NORTH, 40))
    lon, lat = lon.ravel(), lat.ravel()
    x, y = to_metric.transform(lon, lat)
    x, y = np.asarray(x) - OX, np.asarray(y) - OY
    dl, dp = lon - ORIGIN_LON, lat - ORIGIN_LAT
    terms = np.column_stack([np.ones_like(dl), dl, dp, dl * dp, dl * dl, dp * dp])
    cx, *_ = np.linalg.lstsq(terms, x, rcond=None)
    cy, *_ = np.linalg.lstsq(terms, y, rcond=None)
    error = float(np.max(np.hypot(terms @ cx - x, terms @ cy - y)))
    return {"x": [float(v) for v in cx], "y": [float(v) for v in cy], "maxErrorM": round(error, 3)}


def north_bank(land):
    """Keep the Lisbon side of the river: the land the scene origin stands on, and anything close to it."""
    origin = Point(0, 150)
    main = min(land, key=lambda p: p.distance(origin))
    return [p for p in land if p.distance(main) < 400]


# ---------------------------------------------------------------- bridge

def read_bridge(area):
    out = []
    for el in load("bridge"):
        pts = el.get("geometry") or []
        if el["type"] != "way" or len(pts) < 2:
            continue
        tags = el.get("tags", {})
        kind = "railway" if "railway" in tags else "road" if "highway" in tags else "structure"
        line = LineString(local_coords(pts)).intersection(area)
        if line.geom_type != "LineString" or line.length < 5:
            continue
        out.append({
            "kind": kind,
            "points": [[round(x, 1), round(y, 1)] for x, y in line.coords],
        })
    return out


# ---------------------------------------------------------------- binary writer

def write_bin(path, polygons, heights, units, origin, extra=None):
    """`extra`, for buildings: (min heights, roof shapes), one byte each per building, written
    after the ring counts (readers that do not know them stop before)."""
    ring_counts, vert_counts, coords = [], [], []
    limit = 32767
    for poly in polygons:
        poly = orient(poly, sign=1.0)
        rings = [poly.exterior] + list(poly.interiors)
        kept = 0
        for ring in rings:
            pts = np.round((np.asarray(ring.coords)[:-1, :2] - origin) * units).astype(np.int64)
            # Drop consecutive duplicates created by quantisation.
            keep = np.ones(len(pts), dtype=bool)
            keep[1:] = np.any(pts[1:] != pts[:-1], axis=1)
            if len(pts) > 1 and np.all(pts[0] == pts[-1]):
                keep[-1] = False
            pts = pts[keep]
            if len(pts) < 3:
                if kept == 0:
                    break  # degenerate outer ring: skip the whole building
                continue
            deltas = pts.copy()
            deltas[1:] -= pts[:-1]
            if np.abs(deltas).max() > limit:
                sys.exit(f"{path.name}: coordinates do not fit in 16 bits; reduce units or split the chunk.")
            vert_counts.append(len(pts))
            coords.append(deltas)
            kept += 1
        ring_counts.append(kept)

    mask = np.array(ring_counts) > 0
    ring_counts = np.array(ring_counts)[mask]
    heights = np.asarray(heights, dtype=np.uint8)[mask]
    extra_bytes = b"".join(np.asarray(e, dtype=np.uint8)[mask].tobytes() for e in extra) if extra is not None else b""
    if ring_counts.max(initial=0) > 255 or max(vert_counts, default=0) > 65535:
        sys.exit(f"{path.name}: too many rings or vertices in one polygon.")
    flat = np.concatenate(coords).astype("<i2") if coords else np.zeros((0, 2), "<i2")
    data = b"".join([
        struct.pack("<4sIII", b"LXB1", len(ring_counts), len(vert_counts), len(flat)),
        np.asarray(vert_counts, dtype="<u2").tobytes(),
        flat.tobytes(),
        heights.tobytes(),
        ring_counts.astype(np.uint8).tobytes(),
        extra_bytes,
    ])
    path.write_bytes(data)
    return {"buildings": int(len(ring_counts)), "vertices": int(len(flat)), "bytes": len(data)}


# ---------------------------------------------------------------- main

def main():
    corners_x, corners_y = to_metric.transform([WEST, EAST, EAST, WEST], [SOUTH, SOUTH, NORTH, NORTH])
    area = Polygon(zip(np.asarray(corners_x) - OX, np.asarray(corners_y) - OY))

    print("Reading buildings")
    b = read_buildings()
    stats = {"raw": int(len(b))}
    b = b[b.geometry.is_valid | b.geometry.buffer(0).is_valid].copy()
    b["geometry"] = b.geometry.buffer(0).where(~b.geometry.is_valid, b.geometry)
    b = b.explode(index_parts=False).reset_index(drop=True)
    b = b[b.geometry.geom_type == "Polygon"]
    b = b[b.geometry.representative_point().within(area)].copy()
    stats["inArea"] = int(len(b))
    b["area"] = b.geometry.area
    b = b[b["area"] >= MIN_AREA_M2].reset_index(drop=True)
    stats["afterMinArea"] = int(len(b))

    print("Land and river")
    land = north_bank(build_land(area, b))
    shore = unary_union(land).buffer(60)
    b = b[b.geometry.representative_point().within(shore)].reset_index(drop=True)
    stats["onNorthBank"] = int(len(b))
    # 05_plan.py clips its lines to the same land.
    (RAW / "_land.wkb").write_bytes(unary_union(land).wkb)

    print("Parts of buildings")
    b = b.reset_index(drop=True)
    b, replaced = use_parts(b)
    stats["parts"] = int((b["kind"] == "part").sum())
    stats["outlinesReplacedByParts"] = int(replaced)

    print("Heights")
    b = assign_heights(b)
    # Where a part starts above the ground (the floors over an arch, the top of a tower).
    b["min_height"] = np.clip(np.nan_to_num(b["min_tag"].to_numpy(dtype=float), nan=0.0), 0, None)
    b["min_height"] = np.minimum(b["min_height"], b["height"].astype(float) - 1).clip(0).round().astype(np.uint8)
    b["roof"] = b["roof"].fillna(ROOF_AUTO).astype(np.uint8)
    stats["heightSource"] = {k: int(v) for k, v in b["height_source"].value_counts().items()}
    stats["heightModel"] = dict(HEIGHT_REPORT)
    print("  height model:", json.dumps(HEIGHT_REPORT["model"]), "previous method:", json.dumps(HEIGHT_REPORT["previousMethod"]))

    print("Simplifying")
    verts_before = int(b.geometry.count_coordinates().sum())
    b["geometry"] = b.geometry.map(simplify)
    stats["verticesBeforeSimplify"] = verts_before

    print("Neighbourhoods")
    f = read_freguesias()
    points = gpd.GeoDataFrame({"i": b.index}, geometry=b.geometry.representative_point())
    joined = gpd.sjoin(points, f, predicate="within")
    joined = joined[~joined.index.duplicated()]
    b["freguesia"] = joined["name"].reindex(b.index)
    missing = b["freguesia"].isna()
    if missing.any():
        nearest = gpd.sjoin_nearest(points[missing], f)
        nearest = nearest[~nearest.index.duplicated()]
        b.loc[missing, "freguesia"] = nearest["name"]
    stats["assignedByNearest"] = int(missing.sum())

    # Outside the city of Lisbon (Odivelas, Loures, Amadora...) the map is mostly seen from
    # far away: sheds, garages and annexes there are less than a pixel and only cost triangles.
    outside = ~b["freguesia"].isin(LISBON_FREGUESIAS)
    tiny = outside & (b.geometry.area < OUTSIDE_MIN_AREA_M2) & (b["kind"] != "part")
    stats["smallOutsideLisbonDropped"] = int(tiny.sum())
    b = b[~tiny].reset_index(drop=True)

    OUT.mkdir(parents=True, exist_ok=True)
    for old in [f for f in OUT.glob("*.bin") if not f.name.startswith("plan-")]:  # plan-* belong to 05_plan.py
        old.unlink()

    print("Writing chunks")
    chunks = []
    for name, group in sorted(b.groupby("freguesia"), key=lambda kv: kv[0]):
        minx, miny, maxx, maxy = group.total_bounds
        origin = np.array([round((minx + maxx) / 2), round((miny + maxy) / 2)])
        slug = slugify(name)
        info = write_bin(
            OUT / f"{slug}.bin", group.geometry.tolist(), group["height"].to_numpy(), UNITS_PER_METRE, origin,
            extra=(group["min_height"].to_numpy(), group["roof"].to_numpy()),
        )
        chunks.append({
            "id": slug,
            "name": name,
            "file": f"{slug}.bin",
            "origin": [int(origin[0]), int(origin[1])],
            "bbox": [round(float(v), 1) for v in (minx, miny, maxx, maxy)],
            "maxHeight": int(group["height"].max()),
            **info,
        })

    land_info = write_bin(OUT / "land.bin", land, np.zeros(len(land)), LAND_UNITS_PER_METRE, np.array([0, 0]))
    land_area = sum(p.area for p in land)

    print("Streets")
    roads_info = write_roads(OUT / "roads.bin", land)

    # The camera never shows anything beyond "view". Its southern edge is in the
    # river, just past the bridge's south tower: the south bank is not part of the map.
    tall = [t for t in BRIDGE_TOWERS if t["height"] >= 150]
    land_miny = min(p.bounds[1] for p in land)
    view_miny = min(t["y"] for t in tall) - 250 if tall else land_miny - 1500
    towers = [t for t in BRIDGE_TOWERS if t["height"] >= 150 or Point(t["x"], t["y"]).within(shore)]

    minx, miny, maxx, maxy = area.bounds
    view = box(minx, view_miny, maxx, maxy)
    manifest = {
        "version": 1,
        "attribution": "Building data (c) OpenStreetMap contributors, ODbL",
        "origin": {"lon": ORIGIN_LON, "lat": ORIGIN_LAT, "crs": CRS_METRIC},
        "bboxLonLat": [WEST, SOUTH, EAST, NORTH],
        "bbox": [round(v, 1) for v in (minx, miny, maxx, maxy)],
        "view": [round(v, 1) for v in view.bounds],
        "unitsPerMetre": UNITS_PER_METRE,
        "chunks": chunks,
        "land": {"file": "land.bin", "unitsPerMetre": LAND_UNITS_PER_METRE, "origin": [0, 0],
                 "polygons": land_info["buildings"], "vertices": land_info["vertices"], "bytes": land_info["bytes"]},
        "roads": roads_info,
        "projection": fit_projection(),
        "bridge": read_bridge(view),
        "bridgeTowers": towers,
        "stats": {
            **stats,
            "buildings": sum(c["buildings"] for c in chunks),
            "vertices": sum(c["vertices"] for c in chunks),
            "areaKm2": round(area.area / 1e6, 1),
            "landKm2": round(land_area / 1e6, 1),
        },
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Done: {manifest['stats']['buildings']} buildings in {len(chunks)} chunks")


if __name__ == "__main__":
    main()
