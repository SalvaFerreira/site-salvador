"""Ground cover for the parts of the city that have few buildings.

Input:  data/raw/cover_*.json (from 01_download.py), data/raw/_land.wkb (from 02_process.py)
Output: public/data/cover.bin    polygons (LXB1; the "height" byte holds the class below)
        public/data/cover.json   index, plus the airport's runways and taxiways as lines

Classes: 0 woodland, 1 grass and scrub, 2 sports pitch, 3 cemetery, 4 sand,
         5 industrial, railway and commercial ground, 6 car park, 7 airport apron

Binary layout is documented in 02_process.py.
Data (c) OpenStreetMap contributors, ODbL.
"""
import importlib
import json

import geopandas as gpd
import numpy as np
import shapely
from shapely.geometry import LineString
from shapely.ops import unary_union

from config import OUT, RAW

P = importlib.import_module("02_process")

UNITS = 1
SIMPLIFY_M = 3.0
MIN_AREA_M2 = {0: 600, 1: 600, 2: 150, 3: 600, 4: 400, 5: 1500, 6: 500, 7: 500}

WOOD, GRASS, PITCH, CEMETERY, SAND, GREY, PARKING, APRON = range(8)


def classify(tags):
    landuse, natural, leisure = tags.get("landuse"), tags.get("natural"), tags.get("leisure")
    if tags.get("aeroway") == "apron":
        return APRON
    if landuse == "forest" or natural == "wood":
        return WOOD
    if leisure in ("pitch", "track"):
        return PITCH
    if landuse == "cemetery":
        return CEMETERY
    if natural in ("sand", "beach"):
        return SAND
    if tags.get("amenity") == "parking":
        # Underground and multi-storey car parks are not ground cover.
        return PARKING if tags.get("parking", "surface") == "surface" else None
    if landuse in ("industrial", "railway", "military", "construction", "commercial", "retail"):
        return GREY
    if landuse in ("meadow", "grass", "allotments", "recreation_ground") or natural == "scrub" or leisure == "golf_course":
        return GRASS
    return None


def main():
    land = shapely.from_wkb((RAW / "_land.wkb").read_bytes())

    rows = []
    runways, taxiways = [], []
    for name in ("cover_airport", "cover_green", "cover_grey"):
        for el in P.load(name):
            tags = el.get("tags", {})
            aeroway = tags.get("aeroway")
            if aeroway in ("runway", "taxiway") and el["type"] == "way":
                line = LineString(P.local_coords(el["geometry"])).intersection(land)
                if line.geom_type != "LineString" or line.length < 30:
                    continue
                if aeroway == "runway":
                    width = P.number(tags.get("width")) or 45.0
                    runways.append({"width": width, "points": [[round(x, 1), round(y, 1)] for x, y in line.simplify(1.0).coords]})
                else:
                    taxiways.append([[round(x, 1), round(y, 1)] for x, y in line.simplify(1.5).coords])
                continue
            cls = classify(tags)
            if cls is None:
                continue
            for poly in P.polygons_of(P.element_polygon(el)):
                rows.append({"cls": cls, "geometry": poly})

    cover = gpd.GeoDataFrame(rows, geometry="geometry")
    polygons, classes, areas = [], [], {}
    for cls, group in cover.groupby("cls"):
        # One shape per class, so overlapping pieces are not drawn twice.
        merged = unary_union(group.geometry.tolist()).intersection(land).simplify(SIMPLIFY_M, preserve_topology=True)
        kept = [p for p in P.polygons_of(merged) if p.area >= MIN_AREA_M2[cls]]
        polygons += kept
        classes += [cls] * len(kept)
        areas[int(cls)] = round(sum(p.area for p in kept) / 1e6, 2)

    info = P.write_bin(OUT / "cover.bin", polygons, np.asarray(classes, dtype=np.uint8), UNITS, np.array([0, 0]))
    index = {
        "attribution": "Ground cover (c) OpenStreetMap contributors, ODbL",
        "file": "cover.bin",
        "unitsPerMetre": UNITS,
        "runways": runways,
        "taxiways": taxiways,
    }
    (OUT / "cover.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    print(f"cover.bin: {info['buildings']} polygons, {info['bytes'] / 1e3:.0f} kB; km2 per class: {areas}")
    print(f"runways: {[(r['width'], round(LineString(r['points']).length)) for r in runways]}, taxiways: {len(taxiways)}")


if __name__ == "__main__":
    main()
