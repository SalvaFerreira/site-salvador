"""Shared settings for the Lisbon data pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "public" / "data"

# Visible area: Algés -> the river east of Parque das Nações, the Tejo -> Loures.
# It reaches well north and east of the places on the map so that the opening
# view, which shows all of them, never sees past the edge.
WEST, SOUTH, EAST, NORTH = -9.23, 38.66, -9.03, 38.843

# The area was first downloaded up to these limits, in a grid of tiles; the
# strips added since (north and east) are downloaded separately, so the files
# already on disk stay valid. Each strip is (name, south, west, north, east).
GRID_EAST, GRID_NORTH = -9.09, 38.78
EXTRA_STRIPS = [
    ("n", GRID_NORTH, WEST, 38.79, -9.08),
    ("e", SOUTH, GRID_EAST, GRID_NORTH, -9.08),
    ("n2", 38.79, WEST, NORTH, EAST),
    ("e2", SOUTH, -9.08, 38.79, EAST),
]

# Scene origin (Praça do Comércio). Everything is exported in metres
# relative to this point: x = east, y = north.
ORIGIN_LON, ORIGIN_LAT = -9.1364, 38.7075

# ETRS89 / Portugal TM06, metres.
CRS_METRIC = "EPSG:3763"

# Buildings are downloaded in TILES x TILES requests to keep each one small.
TILES = 4

LEVEL_HEIGHT_M = 3.0
MIN_AREA_M2 = 12.0
SIMPLIFY_M = 1.0
