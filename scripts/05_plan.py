"""The "Plan" layer: ecology and infrastructure, from Lisbon City Council open data.

Downloads public layers from the council's ArcGIS services (cached in
data/raw/) and writes:

    public/data/plan-green.bin   green spaces and green corridors (LXB1 polygons)
    public/data/plan-rail.bin    LXR1 lines. Class 0 railway, 1 underground railway (council);
                                 2 metro, 3 tram (OpenStreetMap, from 01_download.py)
    public/data/plan.json        index and attribution, plus the route of the tram
                                 that runs through the city scene

Binary layouts are documented in 02_process.py.
Source: Câmara Municipal de Lisboa (geodados).
"""
import importlib
import json
import struct
import sys

import geopandas as gpd
import numpy as np
import requests
import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge, unary_union

from config import CRS_METRIC, EAST, NORTH, OUT, RAW, SOUTH, WEST

P = importlib.import_module("02_process")

SERVICES = "https://services.arcgis.com/1dSrzEWVQn5kHHyK/arcgis/rest/services"
LAYERS = {
    "green_spaces": "Ambiente_DMEVAE/FeatureServer/4",
    "green_corridors": "Ambiente_DMEVAE/FeatureServer/2",
    "rail": "Cartografia_Base/FeatureServer/2",
    "rail_underground": "Cartografia_Base/FeatureServer/3",
}
HEADERS = {"User-Agent": "lisbon-night-city-pipeline/0.1"}
GREEN_SIMPLIFY_M = 3.0
GREEN_MIN_AREA_M2 = 400.0
GREEN_UNITS = 1
RAIL_UNITS = 2


def download(name, layer):
    path = RAW / f"cml_{name}.geojson"
    if path.exists():
        print(f"  {name}: cached")
        return path
    features, offset = [], 0
    while True:
        r = requests.get(
            f"{SERVICES}/{layer}/query",
            params={"where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson",
                    "resultOffset": offset, "resultRecordCount": 1000},
            headers=HEADERS, timeout=120,
        )
        r.raise_for_status()
        page = r.json()
        if "error" in page:
            sys.exit(f"{name}: {page['error']}")
        features += page["features"]
        if not page["features"] or not page.get("properties", {}).get("exceededTransferLimit"):
            break
        offset += len(page["features"])
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    print(f"  {name}: {len(features)} features")
    return path


def local(path, area):
    """Read a GeoJSON file into local metres, clipped to the visible area."""
    gdf = gpd.read_file(path).set_crs("EPSG:4326", allow_override=True).to_crs(CRS_METRIC)
    gdf["geometry"] = gdf.geometry.translate(-P.OX, -P.OY)
    gdf = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()]
    gdf["geometry"] = gdf.geometry.buffer(0) if gdf.geom_type.iloc[0].endswith("Polygon") else gdf.geometry
    gdf["geometry"] = gdf.geometry.intersection(area)
    return gdf[~gdf.geometry.is_empty].explode(index_parts=False)


def write_lines(path, lines, classes, units):
    vert_counts, coords, kept = [], [], []
    for line, cls in zip(lines, classes):
        pts = np.round(np.asarray(line.coords)[:, :2] * units).astype(np.int64)
        keep = np.ones(len(pts), dtype=bool)
        keep[1:] = np.any(pts[1:] != pts[:-1], axis=1)
        pts = pts[keep]
        if len(pts) < 2:
            continue
        deltas = pts.copy()
        deltas[1:] -= pts[:-1]
        if np.abs(deltas).max() > 32767 or len(pts) > 65535:
            sys.exit(f"{path.name}: a line does not fit the 16 bit encoding.")
        vert_counts.append(len(pts))
        coords.append(deltas)
        kept.append(cls)
    flat = np.concatenate(coords).astype("<i2")
    data = b"".join([
        struct.pack("<4sII", b"LXR1", len(vert_counts), len(flat)),
        np.asarray(vert_counts, dtype="<u2").tobytes(),
        flat.tobytes(),
        np.asarray(kept, dtype=np.uint8).tobytes(),
    ])
    path.write_bytes(data)
    return {"file": path.name, "unitsPerMetre": units, "lines": len(vert_counts), "bytes": len(data)}


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    print("Downloading council layers")
    files = {name: download(name, layer) for name, layer in LAYERS.items()}

    cx, cy = P.to_metric.transform([WEST, EAST, EAST, WEST], [SOUTH, SOUTH, NORTH, NORTH])
    area = Polygon(zip(np.asarray(cx) - P.OX, np.asarray(cy) - P.OY))

    print("Green spaces")
    green = gpd.pd.concat([local(files["green_spaces"], area), local(files["green_corridors"], area)])
    green = green[green.geom_type == "Polygon"]
    # Merge overlapping pieces so nothing is drawn twice, then simplify.
    merged = green.geometry.union_all().simplify(GREEN_SIMPLIFY_M, preserve_topology=True)
    polygons = [p for p in P.polygons_of(merged) if p.area >= GREEN_MIN_AREA_M2]
    green_info = P.write_bin(OUT / "plan-green.bin", polygons, np.zeros(len(polygons)), GREEN_UNITS, np.array([0, 0]))

    print("Railways")
    lines, classes = [], []
    for name, cls in (("rail", 0), ("rail_underground", 1)):
        gdf = local(files[name], area)
        for geom in gdf.geometry:
            if geom.geom_type == "LineString" and geom.length > 5:
                lines.append(geom.simplify(1.5))
                classes.append(cls)
    # Metro and tram lines only where the map has land (the south bank is not shown).
    land_file = RAW / "_land.wkb"
    shore = shapely.from_wkb(land_file.read_bytes()).buffer(40) if land_file.exists() else area

    trams = []
    for el in P.load("transit"):
        pts = el.get("geometry") or []
        tags = el.get("tags", {})
        if len(pts) < 2 or tags.get("service") in ("yard", "siding", "spur"):
            continue
        line = LineString(P.local_coords(pts)).intersection(shore)
        if line.geom_type != "LineString" or line.length < 5:
            continue
        is_tram = tags["railway"] == "tram"
        lines.append(line.simplify(1.5))
        classes.append(3 if is_tram else 2)
        if is_tram:
            trams.append(line)

    # The tram in the scene follows the longest unbroken stretch of track near the Baixa.
    centre = Point(0, -350).buffer(2500)
    merged = linemerge(unary_union(trams).intersection(centre))
    stretches = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
    route = max((g for g in stretches if g.geom_type == "LineString"), key=lambda g: g.length).simplify(1.0)

    rail_info = write_lines(OUT / "plan-rail.bin", lines, classes, RAIL_UNITS)

    plan = {
        "attribution": "Green spaces and railways: Câmara Municipal de Lisboa. Metro and tram: OpenStreetMap contributors",
        "green": {"file": "plan-green.bin", "unitsPerMetre": GREEN_UNITS, "polygons": green_info["buildings"],
                  "bytes": green_info["bytes"], "km2": round(sum(p.area for p in polygons) / 1e6, 2)},
        "rail": rail_info,
        "tramRoute": [[round(x, 1), round(y, 1)] for x, y in route.coords],
    }
    (OUT / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    summary = {**plan, "tramRoute": f"{len(plan['tramRoute'])} points, {route.length:.0f} m"}
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
