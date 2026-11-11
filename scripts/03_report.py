"""Print the Phase 1 report from public/data/: counts, sizes, covered area."""
import gzip
import json

from config import OUT


def main():
    manifest_path = OUT / "manifest.json"
    m = json.loads(manifest_path.read_text(encoding="utf-8"))
    s = m["stats"]

    files = [OUT / c["file"] for c in m["chunks"]] + [OUT / m["land"]["file"], OUT / m["roads"]["file"], manifest_path]
    raw = sum(p.stat().st_size for p in files)
    gz = sum(len(gzip.compress(p.read_bytes(), 9)) for p in files)

    print(f"Area covered       {s['areaKm2']} km2 (of which land {s['landKm2']} km2)")
    print(f"Bounding box       lon {m['bboxLonLat'][0]} to {m['bboxLonLat'][2]}, lat {m['bboxLonLat'][1]} to {m['bboxLonLat'][3]}")
    print(f"Buildings          {s['buildings']} (downloaded {s['raw']}, in area {s['inArea']}, >= min area {s['afterMinArea']})")
    print(f"Vertices           {s['vertices']} (before simplification {s['verticesBeforeSimplify']})")
    print(f"Height source      {s['heightSource']}")
    print(f"Chunks             {len(m['chunks'])} neighbourhoods + land + manifest")
    print(f"Size on disk       {raw / 1e6:.2f} MB")
    print(f"Size gzipped       {gz / 1e6:.2f} MB")
    print(f"Land outline       {m['land']['polygons']} polygons, {m['land']['vertices']} vertices")
    print(f"Streets            {m['roads']['lines']} lines, {m['roads']['km']} km, {m['roads']['bytes'] / 1e6:.2f} MB")
    print(f"Projection fit     max error {m['projection']['maxErrorM']} m")
    print(f"Bridge             {len(m['bridge'])} ways")
    print()
    print(f"{'Neighbourhood':<45}{'buildings':>10}{'kB':>8}{'max h':>7}")
    for c in sorted(m["chunks"], key=lambda c: -c["buildings"]):
        print(f"{c['name']:<45}{c['buildings']:>10}{c['bytes'] / 1e3:>8.0f}{c['maxHeight']:>7}")


if __name__ == "__main__":
    main()
