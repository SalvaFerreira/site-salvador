"""The ground's height: Lisbon's hills, from the Copernicus 30 m elevation model.

Copernicus GLO-30 is a surface model: it includes buildings and trees. A grey
opening over about 200 m (the lowest value around each cell, then the highest
of those) removes anything narrower than that, which leaves the hills, and a
light blur smooths the steps. The river is set to 0 m.

Input:  data/raw/dem/Copernicus_DSM_COG_10_N38_00_W0{10,09}_00_DEM.tif (downloaded
        if missing, from the AWS open data bucket), data/raw/_land.wkb,
        public/data/manifest.json (02_process.py)
Output: public/data/relief.png  the shading of the hills, for the map (grey, 128 = flat ground;
                                 lighter on slopes that face the sun, darker on the others),
                                 rows from the north; and public/data/relief.json, its index
        data/raw/terrain.bin (not published yet: for drawing the hills in 3D later), little-endian:
            "LXH1", u16 columns, u16 rows, f32 x0, f32 y0 (south-west corner, metres
            from the scene origin), f32 cell size in metres,
            u16[rows * columns] height in decimetres, row by row from the south
        public/data/terrain.json  index and statistics

Elevation data: Copernicus DEM GLO-30, (c) DLR e.V. 2010-2014 and (c) Airbus Defence
and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA.
"""
import json
import struct

import numpy as np
import rasterio
import requests
import shapely
from rasterio.features import rasterize
from rasterio.merge import merge
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from PIL import Image
from scipy import ndimage

from config import CRS_METRIC, ORIGIN_LAT, ORIGIN_LON, OUT, RAW

TILES = ["N38_00_W010_00", "N38_00_W009_00"]
URL = "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{t}_DEM/Copernicus_DSM_COG_10_{t}_DEM.tif"
CELL_M = 30
OPENING_CELLS = 5      # 150 m: wider than a building or a clump of trees, narrow enough to keep the hilltops
BLUR_CELLS = 1.5
MARGIN_M = 600
COPERNICUS = ("Elevation: Copernicus DEM GLO-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH "
              "2014-2018, provided under COPERNICUS by the European Union and ESA")
# Light from the west-south-west and 37 degrees up, as on the buildings (SUN in buildingMaterial.ts).
SUN = np.array([-0.72, -0.34, 0.6]) / np.linalg.norm([-0.72, -0.34, 0.6])
# Slopes are made this much steeper for the shading, so Lisbon's gentle hills read from above.
SLOPE_EXAGGERATION = 2.5
SHADE_STRENGTH = 100


def hillshade(ground):
    """0-255, 128 on flat ground. ground: rows from the north, metres."""
    dy, dx = np.gradient(ground * SLOPE_EXAGGERATION, CELL_M)
    # Rows run north to south, so the northward slope is -dy.
    n = np.stack([-dx, dy, np.ones_like(dx)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    lit = n @ SUN
    relative = lit / SUN[2] - 1.0
    return np.clip(128 + relative * SHADE_STRENGTH, 0, 255)


def download():
    (RAW / "dem").mkdir(parents=True, exist_ok=True)
    paths = []
    for t in TILES:
        path = RAW / "dem" / f"Copernicus_DSM_COG_10_{t}_DEM.tif"
        if not path.exists():
            print(f"  downloading {t}")
            r = requests.get(URL.format(t=t), timeout=600)
            r.raise_for_status()
            path.write_bytes(r.content)
        paths.append(path)
    return paths


def main():
    from pyproj import Transformer

    manifest = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
    minx, miny, maxx, maxy = manifest["bbox"]
    minx, miny, maxx, maxy = minx - MARGIN_M, miny - MARGIN_M, maxx + MARGIN_M, maxy + MARGIN_M
    ox, oy = Transformer.from_crs("EPSG:4326", CRS_METRIC, always_xy=True).transform(ORIGIN_LON, ORIGIN_LAT)

    sources = [rasterio.open(p) for p in download()]
    mosaic, transform = merge(sources)
    cols = int(np.ceil((maxx - minx) / CELL_M))
    rows = int(np.ceil((maxy - miny) / CELL_M))
    # Destination grid in the metric CRS, north up (rasterio's convention), then flipped.
    dst = np.zeros((rows, cols), dtype=np.float32)
    dst_transform = from_origin(ox + minx, oy + miny + rows * CELL_M, CELL_M, CELL_M)
    reproject(mosaic[0], dst, src_transform=transform, src_crs=sources[0].crs,
              dst_transform=dst_transform, dst_crs=CRS_METRIC, resampling=Resampling.average)

    raw = dst.copy()
    ground = ndimage.grey_opening(dst, size=(OPENING_CELLS, OPENING_CELLS))
    ground = ndimage.gaussian_filter(ground, BLUR_CELLS)
    # Shading from the ground before the river is cut out, so the shore gets no false edge.
    shade = hillshade(ground)

    # The river at 0; the land never below half a metre.
    land = shapely.from_wkb((RAW / "_land.wkb").read_bytes())
    local_transform = from_origin(minx, miny + rows * CELL_M, CELL_M, CELL_M)
    on_land = rasterize([land], out_shape=(rows, cols), transform=local_transform, fill=0, default_value=1).astype(bool)
    ground = np.where(on_land, np.maximum(ground, 0.5), 0.0)
    # Soften the shore: blend land cells near water towards 0 over a cell or two.
    ground = np.where(on_land, np.minimum(ground, ndimage.distance_transform_edt(on_land) * CELL_M * 0.25 + 0.5), 0.0)

    south_up = ground[::-1]
    dm = np.clip(np.round(south_up * 10), 0, 65535).astype("<u2")
    data = struct.pack("<4sHHfff", b"LXH1", cols, rows, minx, miny, CELL_M) + dm.tobytes()
    (RAW / "terrain.bin").write_bytes(data)

    # The shading, neutral on the water. Rows from the north, as images are.
    relief = np.where(on_land, shade, 128).astype(np.uint8)
    Image.fromarray(relief, mode="L").save(OUT / "relief.png", optimize=True)
    relief_index = {
        "attribution": COPERNICUS,
        "file": "relief.png",
        # South-west corner and size of the image on the map, in metres from the scene origin.
        "box": [round(minx, 1), round(miny, 1), cols * CELL_M, rows * CELL_M],
        "bytes": (OUT / "relief.png").stat().st_size,
    }
    (OUT / "relief.json").write_text(json.dumps(relief_index, separators=(",", ":")), encoding="utf-8")
    print(f"relief.png: {cols} x {rows}, {relief_index['bytes'] / 1e3:.0f} kB")

    def at(lon, lat):
        x, y = Transformer.from_crs("EPSG:4326", CRS_METRIC, always_xy=True).transform(lon, lat)
        c = int((x - ox - minx) / CELL_M)
        r = int((y - oy - miny) / CELL_M)
        return round(float(south_up[r, c]), 1), round(float(raw[::-1][r, c]), 1)

    checks = {
        "Castelo de São Jorge": at(-9.1334, 38.7139),
        "Praça do Comércio": at(-9.1364, 38.7075),
        "Miradouro da Senhora do Monte": at(-9.1329, 38.7191),
        "Parque Eduardo VII (top)": at(-9.1545, 38.7305),
        "Monsanto (Alto da Serafina)": at(-9.1830, 38.7330),
        "Aeroporto": at(-9.1340, 38.7750),
    }
    index = {
        "attribution": COPERNICUS,
        "file": "terrain.bin",
        "columns": cols,
        "rows": rows,
        "cellM": CELL_M,
        "maxM": round(float(ground.max()), 1),
        "bytes": len(data),
    }
    (RAW / "terrain.json").write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"terrain.bin: {cols} x {rows} cells of {CELL_M} m, {len(data) / 1e3:.0f} kB, highest {index['maxM']} m")
    print("ground / surface model at a few places (m):", checks)
    np.save(RAW / "_terrain_preview.npy", south_up)


if __name__ == "__main__":
    main()
