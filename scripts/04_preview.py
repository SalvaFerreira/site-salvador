"""Decode public/data/ back from binary and draw a top-down preview PNG.

A check that the exported files are complete and readable, using only what
the website itself will have (manifest.json + .bin files).
Writes data/raw/preview.png (not committed).
"""
import json
import struct

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.collections import PolyCollection

from config import OUT, RAW


def read_bin(path, units, origin):
    """Returns [(height, [ring, ...]), ...] with rings as (n, 2) arrays in local metres."""
    data = path.read_bytes()
    magic, n_buildings, n_rings, n_verts = struct.unpack_from("<4sIII", data, 0)
    assert magic == b"LXB1"
    off = 16
    vert_counts = np.frombuffer(data, "<u2", n_rings, off).astype(int); off += n_rings * 2
    coords = np.frombuffer(data, "<i2", n_verts * 2, off).reshape(-1, 2).astype(np.int64); off += n_verts * 4
    heights = np.frombuffer(data, np.uint8, n_buildings, off); off += n_buildings
    ring_counts = np.frombuffer(data, np.uint8, n_buildings, off).astype(int); off += n_buildings
    assert off == len(data)

    rings, v = [], 0
    for count in vert_counts:
        rings.append(np.cumsum(coords[v:v + count], axis=0) / units + origin)
        v += count
    out, r = [], 0
    for h, count in zip(heights, ring_counts):
        out.append((int(h), rings[r:r + count]))
        r += count
    return out


def main():
    m = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
    fig, ax = plt.subplots(figsize=(16, 15), facecolor="#05070a")
    ax.set_facecolor("#05070a")

    land = read_bin(OUT / m["land"]["file"], m["land"]["unitsPerMetre"], np.array(m["land"]["origin"]))
    ax.add_collection(PolyCollection([rings[0] for _, rings in land], facecolors="#14171c", edgecolors="none"))

    outlines, heights, total = [], [], 0
    for c in m["chunks"]:
        buildings = read_bin(OUT / c["file"], m["unitsPerMetre"], np.array(c["origin"]))
        assert len(buildings) == c["buildings"]
        total += len(buildings)
        for h, rings in buildings:
            outlines.append(rings[0])
            heights.append(h)
    assert total == m["stats"]["buildings"]
    pc = PolyCollection(outlines, array=np.clip(heights, 0, 45), cmap="YlOrBr_r", edgecolors="none")
    ax.add_collection(pc)

    for way in m["bridge"]:
        pts = np.array(way["points"])
        ax.plot(pts[:, 0], pts[:, 1], color="#ff5540", linewidth=1)

    minx, miny, maxx, maxy = m["bbox"]
    ax.set_xlim(minx, maxx)
    ax.set_ylim(miny, maxy)
    ax.set_aspect("equal")
    ax.axis("off")
    out = RAW / "preview.png"
    fig.savefig(out, dpi=110, bbox_inches="tight", facecolor=fig.get_facecolor())
    print(f"Decoded {total} buildings; wrote {out}")


if __name__ == "__main__":
    main()
