"""Heights for the buildings OpenStreetMap gives no height or number of floors.

About two in three buildings in the area have neither. A gradient-boosted model
learns height from the ones that do, from the building's own shape and kind and
from its surroundings (the heights of the tagged buildings nearby, how dense
the block is, where in the city it stands).

It is checked with spatial cross-validation: the map is cut into 600 m squares
and each fold holds out whole squares, so the model is always scored on parts
of the city it has not seen. The previous method (the median height of the 8
nearest tagged buildings within 250 m) is scored on the same folds.

Predictions are rounded to whole floors (3 m): most mapped heights are a number
of floors times 3 m, and rounding scores better on every measure but R² there.
"""
import numpy as np
import shapely
from scipy.spatial import cKDTree
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import GroupKFold

NEIGHBOURS = 8
FLOOR_M = 3.0
NEIGHBOUR_RADIUS_M = 250
DENSITY_RADIUS_M = 100
BLOCK_M = 600
FOLDS = 5
KINDS = ["yes", "residential", "apartments", "house", "commercial", "retail", "industrial", "office", "school",
         "university", "church", "hospital", "hotel", "public", "warehouse", "detached", "terrace", "civic", "part"]


def features(gdf, height, known):
    """One row of features per building. A tagged building never sees its own height."""
    geoms = gdf.geometry.to_numpy()
    area = gdf.geometry.area.to_numpy()
    perimeter = gdf.geometry.length.to_numpy()
    centroid = gdf.geometry.centroid
    xy = np.column_stack([centroid.x, centroid.y])
    env = shapely.oriented_envelope(geoms)
    ex = shapely.get_coordinates(shapely.get_exterior_ring(env)).reshape(len(geoms), -1, 2)[:, :3]
    sides = np.sort(np.stack([np.hypot(*(ex[:, 1] - ex[:, 0]).T), np.hypot(*(ex[:, 2] - ex[:, 1]).T)], axis=1), axis=1)
    elongation = sides[:, 1] / np.maximum(sides[:, 0], 0.5)
    vertices = shapely.get_num_coordinates(shapely.get_exterior_ring(geoms))
    kind = np.array([KINDS.index(k) if k in KINDS else len(KINDS) for k in gdf["kind"]])

    # Tagged neighbours: query one more and drop the building itself.
    tree = cKDTree(xy[known])
    known_h = height[known]
    known_index = np.flatnonzero(known)
    dist, idx = tree.query(xy, k=NEIGHBOURS + 1, distance_upper_bound=NEIGHBOUR_RADIUS_M)
    found = np.isfinite(dist)
    safe = np.minimum(idx, len(known_h) - 1)
    is_self = found & (known_index[safe] == np.arange(len(xy))[:, None])
    use = found & ~is_self
    # Keep the first NEIGHBOURS that are not the building itself.
    rank = np.cumsum(use, axis=1)
    use &= rank <= NEIGHBOURS
    nh = np.where(use, known_h[safe], np.nan)
    nd = np.where(use, dist, np.nan)
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            n_median = np.nanmedian(nh, axis=1)
            n_mean = np.nanmean(nh, axis=1)
            n_max = np.nanmax(nh, axis=1)
            n_min = np.nanmin(nh, axis=1)
            n_near = np.nanmin(nd, axis=1)
            # Height of the nearest tagged neighbour.
            first = np.argmax(use, axis=1)
            n_first = np.where(use.any(axis=1), nh[np.arange(len(xy)), first], np.nan)
    n_count = use.sum(axis=1)

    # How built-up the surroundings are.
    all_tree = cKDTree(xy)
    near = all_tree.query_ball_point(xy, DENSITY_RADIUS_M)
    density = np.array([len(n) for n in near])
    mean_area = np.array([area[n].mean() for n in near])

    X = np.column_stack([
        np.log1p(area), np.log1p(perimeter), 4 * np.pi * area / np.maximum(perimeter, 1) ** 2, elongation, vertices,
        kind, n_median, n_mean, n_max, n_min, n_first, n_near, n_count, density, np.log1p(mean_area),
        xy[:, 0], xy[:, 1], np.hypot(xy[:, 0], xy[:, 1]),
    ])
    names = ["log area", "log perimeter", "compactness", "elongation", "vertices", "kind",
             "neighbours median", "neighbours mean", "neighbours max", "neighbours min", "nearest neighbour",
             "distance to nearest tagged", "tagged neighbours", "density 100 m", "log mean area 100 m",
             "x", "y", "distance to centre"]
    return X, names, n_median, xy


def _floors(h):
    return np.maximum(FLOOR_M, np.round(h / FLOOR_M) * FLOOR_M)


def _model():
    return HistGradientBoostingRegressor(
        max_iter=500, learning_rate=0.06, max_leaf_nodes=48, min_samples_leaf=30, l2_regularization=1.0,
        categorical_features=[5], random_state=0,
    )


def fit_and_predict(gdf, height, known):
    """Trains on the tagged buildings, reports spatial cross-validation, predicts the rest.

    Returns (predicted heights for every building, report dict).
    """
    X, names, baseline, xy = features(gdf, height, known)
    # Kept for trying other models without running the whole pipeline (data/raw is not in git).
    from config import RAW
    np.savez_compressed(RAW / "_height_features.npz", X=X, height=height, known=known, baseline=baseline, xy=xy)
    y = np.log(height[known])
    Xk = X[known]
    blocks = (np.floor(xy[known, 0] / BLOCK_M) * 10007 + np.floor(xy[known, 1] / BLOCK_M)).astype(np.int64)

    pred = np.full(known.sum(), np.nan)
    for train, test in GroupKFold(n_splits=FOLDS).split(Xk, y, blocks):
        m = _model().fit(Xk[train], y[train])
        pred[test] = m.predict(Xk[test])
    truth = height[known]
    model_h = _floors(np.exp(pred))
    base_h = baseline[known]
    base_ok = ~np.isnan(base_h)
    base_h = np.where(base_ok, base_h, 3 * 3.0)

    def scores(p):
        err = np.abs(p - truth)
        return {
            "maeM": round(float(err.mean()), 2),
            "medianErrorM": round(float(np.median(err)), 2),
            "withinOneFloor": round(float((err <= 3.0).mean()), 3),
            "r2": round(float(1 - ((p - truth) ** 2).sum() / ((truth - truth.mean()) ** 2).sum()), 3),
        }

    report = {
        "trainedOn": int(known.sum()),
        "predicted": int((~known).sum()),
        "folds": FOLDS,
        "blockM": BLOCK_M,
        "model": scores(model_h),
        "previousMethod": scores(base_h),
    }
    # Error by height band, for the chart.
    bands = [(0, 7), (7, 13), (13, 22), (22, 40), (40, 1000)]
    report["byHeight"] = [
        {
            "band": f"{lo}-{hi} m" if hi < 1000 else f"{lo}+ m",
            "count": int(((truth >= lo) & (truth < hi)).sum()),
            "modelMaeM": round(float(np.abs(model_h - truth)[(truth >= lo) & (truth < hi)].mean()), 2),
            "previousMaeM": round(float(np.abs(base_h - truth)[(truth >= lo) & (truth < hi)].mean()), 2),
        }
        for lo, hi in bands
        if ((truth >= lo) & (truth < hi)).any()
    ]

    final = _model().fit(Xk, y)
    out = height.copy()
    out[~known] = _floors(np.exp(final.predict(X[~known])))
    return out, report
