"""Football grounds: the stands of the stadiums, and the lines on the pitches.

Called from 02_process.py. Buildings tagged stadium, grandstand or bleachers that
face a pitch leave the ordinary blocks and are drawn as stands instead (Stadiums.tsx):
seats raked down towards the pitch, and a roof over the outer part where the
whole ground is roofed. An arena with no pitch (MEO Arena) stays a building.

Output: public/data/stadiums.json
    stands:  [{rings, height, ring, seats, roof}]  rings in metres from the scene origin,
             the outline first; "ring" when the stand goes all the way round the pitch
             (its hole is the pitch side); "seats" names the club colour, if any;
             "roof" the outline(s) of the roof over the outer seats
    pitches: [[x, y, length, width, angle, stadium]]  football pitches as rectangles,
             angle of the long side from east towards north, stadium 1 when stands face it

Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import math

from shapely.geometry import Polygon

STAND_KINDS = {"stadium", "grandstand"}
# A stand without a hole faces the nearest pitch within this distance.
NEAR_PITCH_M = 60
# Grounds that go all the way round and are this tall are roofed (Luz, Alvalade).
ROOFED_MIN_HEIGHT_M = 25
# Seats in the club colour, for the stadiums of the three Lisbon clubs in the top flight
# (stands within RADIUS_M of the point).
CLUBS = [
    ("red", -9.1847, 38.7527),    # Estádio da Luz, Benfica
    ("green", -9.1609, 38.7612),  # Estádio José Alvalade, Sporting
    ("blue", -9.2085, 38.7027),   # Estádio do Restelo, Belenenses
]
CLUB_RADIUS_M = 260
# Stands with no height in OpenStreetMap: the height model is made for blocks of flats and
# does not know them, so their height comes from how deep the seats go, at the usual rake.
RAKE = math.tan(math.radians(30))
# Pitches drawn with lines: football, roughly rectangular, at least five-a-side.
MIN_PITCH = (25, 15)
RECTANGULAR = 0.85


def read_pitches(P):
    pitches = []
    for el in P.load("cover_green"):
        tags = el.get("tags", {})
        if tags.get("leisure") not in ("pitch", "track"):
            continue
        for poly in P.polygons_of(P.element_polygon(el)):
            pitches.append({"poly": poly, "soccer": "soccer" in tags.get("sport", ""), "stadium": False})
    return pitches


def best_pitch(candidates):
    """Football first, then the largest."""
    return max(candidates, key=lambda p: (p["soccer"], p["poly"].area), default=None)


def as_rectangle(poly):
    """[x, y, length, width, angle] of a pitch, or None if it is not close to a rectangle."""
    rect = poly.minimum_rotated_rectangle
    if rect.area <= 0 or poly.area / rect.area < RECTANGULAR:
        return None
    (x0, y0), (x1, y1), (x2, y2) = list(rect.exterior.coords)[:3]
    a, b = math.hypot(x1 - x0, y1 - y0), math.hypot(x2 - x1, y2 - y1)
    angle = math.atan2(y1 - y0, x1 - x0) if a >= b else math.atan2(y2 - y1, x2 - x1)
    length, width = max(a, b), min(a, b)
    if length < MIN_PITCH[0] or width < MIN_PITCH[1]:
        return None
    angle = (angle + math.pi) % math.pi
    c = rect.centroid
    return [round(c.x, 1), round(c.y, 1), round(length, 1), round(width, 1), round(angle, 4)]


def club_colour(P, poly):
    c = poly.centroid
    for colour, lon, lat in CLUBS:
        x, y = P.to_metric.transform(lon, lat)
        if math.hypot(c.x - (x - P.OX), c.y - (y - P.OY)) < CLUB_RADIUS_M:
            return colour
    return None


def ring_coords(ring):
    return [[round(x, 1), round(y, 1)] for x, y in list(ring.coords)[:-1]]


def split(P, b):
    """Take the stands out of the buildings. Returns (buildings, stadiums.json content, stats)."""
    pitches = read_pitches(P)
    stands, keep = [], []
    for i, row in b.iterrows():
        poly = row.geometry
        if not row["stand"]:
            keep.append(i)
            continue
        holes = [Polygon(r) for r in poly.interiors if Polygon(r).area > 400]
        if holes:
            hole = max(holes, key=lambda h: h.area)
            pitch = best_pitch([p for p in pitches if p["poly"].representative_point().within(hole)])
        else:
            hole = None
            pitch = best_pitch([p for p in pitches if p["poly"].distance(poly) < NEAR_PITCH_M])
        if pitch is None:
            keep.append(i)
            continue
        pitch["stadium"] = True
        height = float(row["height"])
        if row["height_source"] == "estimated":
            if hole is not None:
                depth = poly.area / ((poly.exterior.length + hole.length) / 2)
            else:
                # The thickness of a long, narrow outline.
                depth = 2 * poly.area / poly.exterior.length
            height = min(45.0, max(3.0, round(depth * RAKE)))
        stand = {
            "rings": [ring_coords(poly.exterior)] + [ring_coords(r) for r in poly.interiors],
            "height": int(height),
            "ring": hole is not None,
            "seats": club_colour(P, poly),
        }
        if hole is not None and height >= ROOFED_MIN_HEIGHT_M:
            # The roof covers the outer part of the seats, back to the outer wall.
            depth = (Polygon(poly.exterior).area - hole.area) / poly.exterior.length
            roof = Polygon(poly.exterior).difference(hole.buffer(0.7 * depth, join_style="round")).simplify(1.0)
            stand["roof"] = [[ring_coords(p.exterior)] + [ring_coords(r) for r in p.interiors] for p in P.polygons_of(roof)]
        if hole is None:
            # A stand on one side: the outline of the pitch its seats look at, for the rake.
            stand["pitch"] = ring_coords(pitch["poly"].simplify(0.5).exterior)
        stands.append(stand)

    out_pitches = []
    for p in pitches:
        if not p["soccer"]:
            continue
        rect = as_rectangle(p["poly"])
        if rect:
            out_pitches.append(rect + [1 if p["stadium"] else 0])
    data = {
        "attribution": "Stadiums and pitches (c) OpenStreetMap contributors, ODbL",
        "stands": stands,
        "pitches": out_pitches,
    }
    stats = {"stands": len(stands), "pitchesWithLines": len(out_pitches)}
    return b.loc[keep].reset_index(drop=True), data, stats
