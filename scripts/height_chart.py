"""Chart of the height model's scores for the "This website" panel, from the
numbers 02_process.py wrote to the manifest (stats.heightModel).

Output: public/images/height-model.svg (dark, for the panel's background).
Run after 02_process.py.
"""
import json
from xml.sax.saxutils import escape

from config import OUT, ROOT

W = 526
LEFT = 74
RIGHT = 44
TOP = 58
BAR = 12
GAP = 2
GROUP = 18
MODEL = "#d4772f"
PREVIOUS = "#5e8ccc"
INK = "#efe9df"
MUTED = "#a9a59d"
GRID = "#3a3d43"
FONT = "system-ui, -apple-system, Segoe UI, sans-serif"
# The tallest band (a few hundred towers, about 20 m off for both) would flatten the rest: it is
# given in a note under the chart instead.
SCALE_MAX_M = 6


def main():
    report = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))["stats"]["heightModel"]
    bands = [b for b in report["byHeight"] if max(b["modelMaeM"], b["previousMaeM"]) <= SCALE_MAX_M]
    tall = [b for b in report["byHeight"] if b not in bands]
    plot_w = W - LEFT - RIGHT
    x = lambda v: LEFT + plot_w * v / SCALE_MAX_M
    bottom = TOP + len(bands) * (2 * BAR + GAP + GROUP) - GROUP + 6
    height = bottom + 34 + 18 * max(0, len(tall) - 1) + 10

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{height}" viewBox="0 0 {W} {height}" '
           f'font-family="{FONT}" role="img">']
    out.append(f'<rect width="{W}" height="{height}" fill="#1d1f23"/>')
    out.append(f'<text x="0" y="16" fill="{INK}" font-size="14">Mean height error by building height, in metres</text>')
    out.append(f'<text x="0" y="34" fill="{MUTED}" font-size="12">Lower is better. Scored on parts of the city each model had not seen.</text>')
    # Legend.
    lx = 0
    for color, label in [(MODEL, "Model"), (PREVIOUS, "Previous method (median of nearby buildings)")]:
        out.append(f'<rect x="{lx}" y="42" width="10" height="10" rx="2" fill="{color}"/>')
        out.append(f'<text x="{lx + 15}" y="51" fill="{MUTED}" font-size="12">{escape(label)}</text>')
        lx += 15 + 7.2 * len(label) + 18
    # Grid.
    for v in range(0, SCALE_MAX_M + 1, 2):
        out.append(f'<line x1="{x(v):.1f}" y1="{TOP + 4}" x2="{x(v):.1f}" y2="{bottom}" stroke="{GRID}" stroke-width="1"/>')
        out.append(f'<text x="{x(v):.1f}" y="{bottom + 14}" fill="{MUTED}" font-size="11" text-anchor="middle">{v} m</text>')
    # Bars: thin, rounded at the data end, anchored to the baseline.
    y = TOP + 8
    for b in bands:
        out.append(f'<text x="{LEFT - 10}" y="{y + BAR + 4}" fill="{INK}" font-size="12" text-anchor="end">{escape(b["band"])}</text>')
        for value, color in [(b["modelMaeM"], MODEL), (b["previousMaeM"], PREVIOUS)]:
            w = max(1.0, x(value) - LEFT)
            out.append(f'<path d="M{LEFT},{y} h{w - 4:.1f} a4,4 0 0 1 4,4 v{BAR - 8} a4,4 0 0 1 -4,4 h{-(w - 4):.1f} z" fill="{color}"/>')
            out.append(f'<text x="{LEFT + w + 6:.1f}" y="{y + BAR - 2}" fill="{INK}" font-size="11">{value:.1f}</text>')
            y += BAR + GAP
        y += GROUP - GAP
    # The bands left out, and the totals.
    ny = bottom + 34
    for b in tall:
        out.append(f'<text x="0" y="{ny}" fill="{MUTED}" font-size="12">{escape(b["band"])} ({b["count"]} buildings, not drawn): '
                   f'model {b["modelMaeM"]:.1f} m, previous {b["previousMaeM"]:.1f} m.</text>')
        ny += 18
    out.append("</svg>")
    path = ROOT / "public" / "images" / "height-model.svg"
    path.write_text("\n".join(out), encoding="utf-8")
    print(f"{path.name}: {len(bands)} bands drawn, {len(tall)} in the note")


if __name__ == "__main__":
    main()
