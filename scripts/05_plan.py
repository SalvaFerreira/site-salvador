"""The "Plan" layer: ecology and infrastructure, from Lisbon City Council open data.

Downloads public layers from the council's ArcGIS services (cached in
data/raw/) and writes:

    public/data/plan-green.bin   green spaces and green corridors (LXB1 polygons)
    public/data/plan-rail.bin    LXR1 lines. Class 0 railway, 1 underground railway (council);
                                 2 metro, 3 tram (OpenStreetMap, from 01_download.py)
    public/data/tracks.bin       railway tracks above ground, from OpenStreetMap (LXR1 lines:
                                 class 0 running lines, class 1 yards and sidings)
    public/data/trees.bin        the council's tree inventory (street and garden trees):
                                 char[4] "LXT1", u32 count, then i16 x,y pairs
    public/data/plan.json        index and attribution, plus the routes of what moves in
                                 the scene: trams, trains, ferries and sailing boats

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
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import linemerge, unary_union

from config import CRS_METRIC, EAST, NORTH, OUT, RAW, SOUTH, WEST

P = importlib.import_module("02_process")

SERVICES = "https://services.arcgis.com/1dSrzEWVQn5kHHyK/arcgis/rest/services"
LAYERS = {
    "green_spaces": "Ambiente_DMEVAE/FeatureServer/4",
    "green_corridors": "Ambiente_DMEVAE/FeatureServer/2",
    "rail": "Cartografia_Base/FeatureServer/2",
    "rail_underground": "Cartografia_Base/FeatureServer/3",
    "trees": "Ambiente_DMEVAE/FeatureServer/0",
}
# Only the position of each tree is needed.
FIELDS = {"trees": "COD_SIG"}
TREE_UNITS = 2
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
            params={"where": "1=1", "outFields": FIELDS.get(name, "*"), "outSR": 4326, "f": "geojson",
                    "resultOffset": offset, "resultRecordCount": 2000},
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


# Railway lines a train runs on in the scene, as named on the tracks in OpenStreetMap.
TRAIN_LINES = ["Linha de Cascais", "Linha de Cintura", "Linha do Norte", "Linha do Sul", "Linha de Sintra"]
RAIL_DECK_M = 62  # the railway runs under the road deck of the bridge

# Ferry piers on the north bank and the direction each ferry leaves in, [lon, lat].
FERRIES = [
    ([-9.1452, 38.7050], [-9.1478, 38.6885]),  # Cais do Sodré -> Cacilhas
    ([-9.1330, 38.7062], [-9.1120, 38.6800]),  # Terreiro do Paço -> Barreiro
    ([-9.1975, 38.6952], [-9.2100, 38.6790]),  # Belém -> Porto Brandão
]
SAILING_BOATS = 22


def to_local(lon, lat):
    x, y = P.to_metric.transform(lon, lat)
    return x - P.OX, y - P.OY


def round_points(line, digits=1):
    return [[round(v, digits) for v in pt] for pt in line.coords]


def rail_ways():
    """Every railway track in the area: (line in local metres, tags)."""
    out = []
    for el in P.load("rails"):
        pts = el.get("geometry") or []
        if len(pts) >= 2:
            out.append((LineString(P.local_coords(pts)), el.get("tags", {})))
    return out


def is_tunnel(tags):
    return tags.get("tunnel") == "yes" or str(tags.get("layer", "")).startswith("-")


def train_routes(ways, view, bridge):
    """One track of each line as [x, y, height, hidden] points.

    height: raised to the rail deck where the line crosses the bridge.
    hidden: 1 where the track is in a tunnel, so the train disappears there.
    """
    tunnels = unary_union([line for line, tags in ways if is_tunnel(tags)]).buffer(6)
    routes = []
    for name in TRAIN_LINES:
        # The longest unbroken stretch of a single track ("Via Ascendente ...") of this line.
        tracks = {}
        for line, tags in ways:
            track = tags.get("name", "")
            if track.startswith(name) and "Ascendente" in track and not tags.get("service"):
                tracks.setdefault(track, []).append(line)
        best = None
        for lines in tracks.values():
            merged = linemerge(unary_union(lines))
            for piece in (merged.geoms if hasattr(merged, "geoms") else [merged]):
                piece = piece.intersection(view)
                for part in (piece.geoms if hasattr(piece, "geoms") else [piece]):
                    if part.geom_type == "LineString" and (best is None or part.length > best.length):
                        best = part
        if best is None or best.length < 600:
            continue
        line = best.simplify(1.0).segmentize(25)
        xy = np.asarray(line.coords)[:, :2]
        # Only the line that crosses the river is on the bridge; the others pass underneath it.
        crosses = name == "Linha do Sul"
        on_bridge = np.array([1.0 if crosses and bridge.contains(Point(x, y)) else 0.0 for x, y in xy])
        # A gentle ramp on and off the bridge instead of a step.
        kernel = np.ones(17) / 17
        height = np.convolve(np.pad(on_bridge, 8, mode="edge"), kernel, mode="valid") * RAIL_DECK_M
        hidden = [1 if tunnels.contains(Point(x, y)) else 0 for x, y in xy]
        routes.append({
            "name": name,
            "points": [[round(x, 1), round(y, 1), round(h, 1), hid] for (x, y), h, hid in zip(xy, height, hidden)],
        })
    return routes


def write_tracks(ways, shore, bridge):
    """Tracks above ground and on land. The stretch on the bridge is drawn from the train route instead."""
    lines, classes = [], []
    keep = shore.difference(bridge)
    for line, tags in ways:
        if is_tunnel(tags):
            continue
        cls = 1 if tags.get("service") in ("yard", "siding", "spur") else 0
        clipped = line.intersection(keep)
        for part in (clipped.geoms if hasattr(clipped, "geoms") else [clipped]):
            if part.geom_type == "LineString" and part.length > 8:
                lines.append(part.simplify(0.7))
                classes.append(cls)
    return write_lines(OUT / "tracks.bin", lines, classes, RAIL_UNITS)


def boat_routes(view, land):
    """Ferry crossings from the north bank, and short lanes for sailing boats, all in open water."""
    river = view.difference(land)
    open_water = river.buffer(-220)
    ferries = []
    for pier, towards in FERRIES:
        crossing = LineString([to_local(*pier), to_local(*towards)]).intersection(river.buffer(-25))
        parts = list(crossing.geoms) if hasattr(crossing, "geoms") else [crossing]
        parts = [g for g in parts if g.geom_type == "LineString" and g.length > 400]
        if parts:
            ferries.append(round_points(max(parts, key=lambda g: g.length)))

    rng = np.random.default_rng(7)
    minx, miny, maxx, maxy = open_water.bounds
    sails = []
    for _ in range(4000):
        if len(sails) == SAILING_BOATS:
            break
        x, y = rng.uniform(minx, maxx), rng.uniform(miny, maxy)
        angle = rng.normal(0, 0.5) + (np.pi if rng.random() < 0.5 else 0)  # mostly along the river
        length = rng.uniform(500, 1100)
        lane = LineString([(x, y), (x + np.cos(angle) * length, y + np.sin(angle) * length)])
        if open_water.contains(lane):
            sails.append(round_points(lane))
    return ferries, sails


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

    # Trams in the scene follow the longest unbroken stretches of track around the centre.
    centre = Point(0, -350).buffer(3200)
    merged = linemerge(unary_union(trams).intersection(centre))
    stretches = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
    stretches = sorted((g for g in stretches if g.geom_type == "LineString"), key=lambda g: -g.length)
    tram_routes = [g.simplify(1.0) for g in stretches[:4] if g.length > 700]

    print("Trains and boats")
    manifest = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
    view = box(*manifest["view"])
    bridge = unary_union([LineString(w["points"]) for w in manifest["bridge"] if w["kind"] == "road"]).buffer(45)
    ways = rail_ways()
    trains = train_routes(ways, view, bridge)
    tracks_info = write_tracks(ways, shore, bridge)
    land = shapely.from_wkb(land_file.read_bytes()) if land_file.exists() else Polygon()
    ferries, sails = boat_routes(view, land)

    rail_info = write_lines(OUT / "plan-rail.bin", lines, classes, RAIL_UNITS)

    print("Trees")
    trees = gpd.read_file(files["trees"]).set_crs("EPSG:4326", allow_override=True).to_crs(CRS_METRIC)
    trees = trees[trees.geometry.notna() & ~trees.geometry.is_empty]
    xy = np.column_stack([trees.geometry.x - P.OX, trees.geometry.y - P.OY])
    minx, miny, maxx, maxy = area.bounds
    xy = xy[(xy[:, 0] > minx) & (xy[:, 0] < maxx) & (xy[:, 1] > miny) & (xy[:, 1] < maxy)]
    # Neighbours end up next to each other in the file, which compresses better.
    order = np.lexsort((xy[:, 0], np.floor(xy[:, 1] / 250)))
    quantised = np.unique(np.round(xy[order] * TREE_UNITS).astype("<i2"), axis=0)
    (OUT / "trees.bin").write_bytes(struct.pack("<4sI", b"LXT1", len(quantised)) + quantised.tobytes())
    trees_info = {"file": "trees.bin", "unitsPerMetre": TREE_UNITS, "count": int(len(quantised)),
                  "bytes": 8 + quantised.nbytes}

    plan = {
        "attribution": "Green spaces, trees and railways: Câmara Municipal de Lisboa. Metro and tram: OpenStreetMap contributors",
        "trees": trees_info,
        "green": {"file": "plan-green.bin", "unitsPerMetre": GREEN_UNITS, "polygons": green_info["buildings"],
                  "bytes": green_info["bytes"], "km2": round(sum(p.area for p in polygons) / 1e6, 2)},
        "rail": rail_info,
        "tracks": tracks_info,
        "tramRoutes": [round_points(g) for g in tram_routes],
        "trainRoutes": trains,
        "ferryRoutes": ferries,
        "sailingLanes": sails,
    }
    (OUT / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({k: v for k, v in plan.items() if not k.endswith(("Routes", "Lanes"))}, ensure_ascii=False, indent=1))
    print("trams:", [f"{g.length:.0f} m" for g in tram_routes])
    print("trains:", [(t["name"], f"{len(t['points']) * 25} m", f"deck {max(pt[2] for pt in t['points'])}", f"tunnel points {sum(pt[3] for pt in t['points'])}") for t in trains])
    print("tracks:", tracks_info)
    print("ferries:", [f"{LineString(f).length:.0f} m" for f in ferries], "| sailing lanes:", len(sails))


if __name__ == "__main__":
    main()
