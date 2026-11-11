"""Download raw OpenStreetMap data for the visible area via the Overpass API.

Writes JSON files to data/raw/ (not committed). Requests are cached: a file
that already exists is not downloaded again. Delete data/raw/ to refresh.

Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import sys
import time

import requests

from config import EAST, NORTH, RAW, SOUTH, TILES, WEST

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


if __name__ == "__main__":
    main()
