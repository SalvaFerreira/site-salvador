"""Download raw OpenStreetMap data for the visible area via the Overpass API.

Writes JSON files to data/raw/ (not committed). Requests are cached: a file
that already exists is not downloaded again. Delete data/raw/ to refresh.

Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import sys
import time

import requests

from config import EAST as AREA_EAST, EXTRA_STRIPS, GRID_EAST as EAST, GRID_NORTH as NORTH, NORTH as AREA_NORTH, RAW, SOUTH, TILES, WEST

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
HEADERS = {"User-Agent": "lisbon-night-city-pipeline/0.1"}


def bbox(s, w, n, e):
    return f"{s:.5f},{w:.5f},{n:.5f},{e:.5f}"


FULL = bbox(SOUTH, WEST, NORTH, EAST)


def fetch(name, query):
    path = RAW / f"{name}.json"
    if path.exists():
        print(f"  {name}: cached")
        return
    body = f"[out:json][timeout:180];\n{query}"
    last = None
    for attempt in range(6):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            r = requests.post(url, data={"data": body}, headers=HEADERS, timeout=240)
            if r.status_code == 200:
                data = r.json()
                if "remark" in data and "error" in data["remark"].lower():
                    raise RuntimeError(data["remark"])
                path.write_text(json.dumps(data), encoding="utf-8")
                print(f"  {name}: {len(data['elements'])} elements, {len(r.content) / 1e6:.1f} MB")
                time.sleep(2)
                return
            last = f"HTTP {r.status_code}"
        except Exception as exc:  # network errors, bad JSON, server remarks
            last = repr(exc)
        wait = 10 * (attempt + 1)
        print(f"  {name}: {last}, retrying in {wait}s")
        time.sleep(wait)
    sys.exit(f"Failed to download {name}: {last}")


def main():
    RAW.mkdir(parents=True, exist_ok=True)

    print("Buildings")
    dlat = (NORTH - SOUTH) / TILES
    dlon = (EAST - WEST) / TILES
    for i in range(TILES):
        for j in range(TILES):
            b = bbox(SOUTH + i * dlat, WEST + j * dlon, SOUTH + (i + 1) * dlat, WEST + (j + 1) * dlon)
            fetch(
                f"buildings_{i}_{j}",
                f'way["building"]({b});\nout tags geom qt;',
            )

    # Relations need "body" output: "tags" alone drops the member geometry.
    fetch(
        "building_relations",
        f'relation["building"]["type"="multipolygon"]({FULL});\nout body geom qt;',
    )

    print("Coastline and river")
    fetch("coastline", f'way["natural"="coastline"]({FULL});\nout geom;')
    fetch(
        "water",
        f'(way["natural"="water"]({FULL});relation["natural"="water"]({FULL}););\nout body geom;',
    )

    print("Ponte 25 de Abril")
    fetch(
        "bridge",
        f'(way["bridge"]["name"~"25 de Abril"]({FULL});way["man_made"="bridge"]["name"~"25 de Abril"]({FULL}););\nout tags geom;',
    )

    print("Freguesias (neighbourhood boundaries)")
    fetch(
        "freguesias",
        f'relation["boundary"="administrative"]["admin_level"="8"]({FULL});\nout body geom;',
    )

    print("Streets")
    kinds = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian"
    dlat = (NORTH - SOUTH) / 2
    dlon = (EAST - WEST) / 2
    for i in range(2):
        for j in range(2):
            b = bbox(SOUTH + i * dlat, WEST + j * dlon, SOUTH + (i + 1) * dlat, WEST + (j + 1) * dlon)
            fetch(f"roads_{i}_{j}", f'way["highway"~"^({kinds})(_link)?$"]({b});\nout tags geom qt;')

    print("Strips added to the area")
    # The coastline again, for the whole extended area (the first download stops short of it).
    fetch("coastline_extra", "way[\"natural\"=\"coastline\"](" + bbox(SOUTH, WEST, AREA_NORTH, AREA_EAST) + ");" + chr(10) + "out geom;")
    for name, s, w, n, e in EXTRA_STRIPS:
        b = bbox(s, w, n, e)
        fetch(f"buildings_extra_{name}", f'way["building"]({b});\nout tags geom qt;')
        fetch(f"building_relations_extra_{name}", f'relation["building"]["type"="multipolygon"]({b});\nout body geom qt;')
        fetch(f"roads_extra_{name}", f'way["highway"~"^({kinds})(_link)?$"]({b});\nout tags geom qt;')

    print("Ground cover: airport, woods, pitches, cemeteries, industrial and railway land")
    area = bbox(SOUTH, WEST, AREA_NORTH, AREA_EAST)
    NL = chr(10)
    fetch("cover_airport", 'way["aeroway"~"^(runway|taxiway|apron)$"](' + area + ");" + NL + "out body geom;")
    green = "forest|wood|scrub|meadow|grass|pitch|golf_course|allotments|cemetery|recreation_ground"
    fetch(
        "cover_green",
        "("
        + 'way["landuse"~"^(' + green + ')$"](' + area + ");"
        + 'relation["landuse"~"^(' + green + ')$"](' + area + ");"
        + 'way["natural"~"^(wood|scrub|sand|beach)$"](' + area + ");"
        + 'relation["natural"~"^(wood|scrub)$"](' + area + ");"
        + 'way["leisure"~"^(pitch|track|golf_course)$"](' + area + ");"
        + ");" + NL + "out body geom;",
    )
    fetch(
        "cover_grey",
        "("
        + 'way["landuse"~"^(industrial|railway|military|construction|commercial|retail)$"](' + area + ");"
        + 'relation["landuse"~"^(industrial|railway|military)$"](' + area + ");"
        + 'way["amenity"="parking"](' + area + ");"
        + ");" + NL + "out body geom;",
    )

    print("Railway tracks")
    fetch("rails", 'way["railway"="rail"](' + area + ");" + NL + "out tags geom;")

    print("Tram and metro lines")
    fetch("transit", f'way["railway"~"^(tram|subway)$"]({FULL});\nout tags geom;')


if __name__ == "__main__":
    main()
