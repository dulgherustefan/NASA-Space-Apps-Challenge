"""Two extra map layers for the dashboard, both derived from the HiRISE elevation model.

    runtime/overlay_contours.png   elevation contours every 20 m, heavier every 100 m (1600 x 1600, the 2.5 m grid)
    runtime/overlay_comm.png       where a walker has no direct radio line of sight to the habitat or the rover (800 x 800)

They are written once at start. They are not among the seven hazard layers of the contract and are not sent to the
3D window. Line of sight is geometric: straight rays over the terrain between antenna heights that are team
assumptions (engine/params.py). Diffraction, reflections and relay satellites are not modelled.
"""
import gzip
import json
import os

import numpy as np
from numba import njit

from . import RUNTIME, SITE_DIR
from .hazards import write_png
from .params import PARAMS

CONTOUR_M = 20.0
INDEX_M = 100.0


def contours_image(site_dir=SITE_DIR):
    with open(os.path.join(site_dir, "meta.json"), encoding="utf8") as f:
        core = json.load(f)["core"]
    n = int(core["n"])
    with open(os.path.join(site_dir, "core_h.bin.gz"), "rb") as f:
        q = np.frombuffer(gzip.decompress(f.read()), dtype="<u2").reshape(n, n)
    z = core["zMin"] + q.astype(np.float64) * (core["zMax"] - core["zMin"]) / 65535
    m = n - 1                                             # 1600 cells over the box

    def lines(step):
        lev = np.floor(z / step)
        a = lev[:m, :m]
        return (a != lev[:m, 1:]) | (a != lev[1:, :m])

    minor, index = lines(CONTOUR_M), lines(INDEX_M)
    img = np.zeros((m, m, 4), np.uint8)
    img[minor] = (236, 226, 208, 70)
    img[index] = (246, 238, 222, 150)
    return img


@njit(cache=True)
def _viewshed(z, n, si, sj, h_src, h_tgt):
    """1 where a point h_tgt above the cell sees a point h_src above cell (si, sj)."""
    out = np.zeros((n, n), np.uint8)
    zs = z[si, sj] + h_src
    for i in range(n):
        for j in range(n):
            di = i - si
            dj = j - sj
            steps = max(abs(di), abs(dj))
            if steps <= 1:
                out[i, j] = 1
                continue
            zt = z[i, j] + h_tgt
            seen = 1
            for s in range(1, steps):
                f = s / steps
                if z[int(si + di * f + 0.5), int(sj + dj * f + 0.5)] > zs + (zt - zs) * f:
                    seen = 0
                    break
            out[i, j] = seen
    return out


def line_of_sight(site, sources):
    """n x n bool: True where a walker sees at least one source. sources: [(x, y, antenna height m)], core metres."""
    seen = np.zeros((site.n, site.n), np.uint8)
    z = np.ascontiguousarray(site.z2)
    for x, y, h in sources:
        i, j = site.cell_ij(x, y)
        seen |= _viewshed(z, site.n, i, j, float(h), float(PARAMS["antCrewM"]))
    return seen.astype(bool)


def comm_image(seen):
    n = seen.shape[0]
    img = np.zeros((n, n, 4), np.uint8)
    img[~seen] = (16, 20, 28, 175)                        # dim the ground that has no line of sight
    return img


_cache = {}


def ensure(site, sources):
    """Compute and write both layers once per set of sources. Returns the line-of-sight mask."""
    key = tuple((round(x, 1), round(y, 1), round(h, 2)) for x, y, h in sources)
    if key not in _cache:
        seen = line_of_sight(site, sources)
        write_png("overlay_comm.png", comm_image(seen))
        if not os.path.exists(os.path.join(RUNTIME, "overlay_contours.png")):
            write_png("overlay_contours.png", contours_image(site.site_dir))
        _cache[key] = seen
    return _cache[key]


def metres_without_sight(site, seen, points):
    """Length of a polyline (local metres e, s, z) that lies on cells without line of sight."""
    total = 0.0
    for (e0, s0, _a), (e1, s1, _b) in zip(points, points[1:]):
        x, y = site.local_to_core((e0 + e1) / 2, (s0 + s1) / 2)
        i, j = site.cell_ij(x, y)
        if not seen[i, j]:
            total += float(np.hypot(e1 - e0, s1 - s0))
    return total
