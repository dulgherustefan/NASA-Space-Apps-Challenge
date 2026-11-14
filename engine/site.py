"""Terrain and hazard layers of the site, loaded with rl/terrain.py, plus coordinate helpers.

Frames
  core  (x, y)  metres east / south of the EVA-box corner (planner and walk model frame)
  local (e, s)  metres east / south of the origin in data/site/meta.json (contract frame); e = e0 + x, s = s0 + y
Analysis cell (i, j): row i runs south, column j east; centre at x = (j + 0.5) * 5, y = (i + 0.5) * 5.
"""
import gzip
import json
import math
import os
import sys

import numpy as np

from . import RL_DIR, ROOT, SITE_DIR

if RL_DIR not in sys.path:
    sys.path.insert(0, RL_DIR)

import planner as rl_planner  # noqa: E402  (rl/planner.py, reused unchanged)
import terrain as rl_terrain  # noqa: E402  (rl/terrain.py, reused unchanged)


class Site:
    def __init__(self, site_dir=SITE_DIR):
        g, meta = rl_terrain.load_grid(site_dir)
        self.g = g
        self.meta = meta
        core = meta["core"]
        self.n = int(g["n"])
        self.cell = float(core["cell"])
        self.e0 = float(core["e0"])
        self.s0 = float(core["s0"])
        self.size = float(core["size"])
        self.site_dir = site_dir
        n = self.n
        self.z = g["z"].astype(np.float64)
        self.slope = g["slope"].astype(np.float64)
        self.sand = g["sand"].astype(np.float64)
        self.rough = g["rough"].astype(np.float64)
        self.beta = g["beta"].astype(np.float64)
        self.sky = g["sky"].astype(np.float64)
        self.keepout, self.blocked = rl_planner.statics(g)
        self.blocked = np.ascontiguousarray(self.blocked, dtype=np.uint8)
        self.z2 = self.z.reshape(n, n)
        with open(os.path.join(ROOT, "unreal_import", "import_values.json"), encoding="utf8") as f:
            self.z_ref = float(json.load(f)["z_ref_m"])
        self._reg = None

    # ------------------------------------------------------------------ frames
    def core_to_local(self, x, y):
        return self.e0 + x, self.s0 + y

    def local_to_core(self, e, s):
        return e - self.e0, s - self.s0

    def to_unreal(self, e, s, z):
        return e * 100.0, s * 100.0, (z - self.z_ref) * 100.0

    def inside_core(self, x, y):
        return 0.0 <= x < self.size and 0.0 <= y < self.size

    # ------------------------------------------------------------------ cells
    def cell_ij(self, x, y):
        n = self.n
        j = min(n - 1, max(0, int(math.floor(x / self.cell))))
        i = min(n - 1, max(0, int(math.floor(y / self.cell))))
        return i, j

    def cell_index(self, x, y):
        i, j = self.cell_ij(x, y)
        return i * self.n + j

    def cell_center(self, i, j):
        return (j + 0.5) * self.cell, (i + 0.5) * self.cell

    def cell_center_local(self, i, j):
        x, y = self.cell_center(i, j)
        return self.core_to_local(x, y)

    def layer_at(self, name, x, y):
        return float(getattr(self, name)[self.cell_index(x, y)])

    def is_blocked(self, x, y):
        return bool(self.blocked[self.cell_index(x, y)])

    # ------------------------------------------------------------------ heights
    def z_at_core(self, x, y):
        """Bilinear on the 5 m analysis grid (same as zAt in sim.ts)."""
        n = self.n
        fx = x / self.cell - 0.5
        fy = y / self.cell - 0.5
        fx = min(max(fx, 0.0), n - 1.001)
        fy = min(max(fy, 0.0), n - 1.001)
        j = int(fx); i = int(fy); tx = fx - j; ty = fy - i
        z = self.z2
        return float((z[i, j] * (1 - tx) + z[i, j + 1] * tx) * (1 - ty) + (z[i + 1, j] * (1 - tx) + z[i + 1, j + 1] * tx) * ty)

    def z_at_local(self, e, s):
        x, y = self.local_to_core(e, s)
        if self.inside_core(x, y):
            return self.z_at_core(x, y)
        return self._z_regional(e, s)

    def _z_regional(self, e, s):
        if self._reg is None:
            reg = self.meta["reg"]
            with open(os.path.join(self.site_dir, "reg_h.bin.gz"), "rb") as f:
                q = np.frombuffer(gzip.decompress(f.read()), dtype="<u2")
            k = (reg["zMax"] - reg["zMin"]) / 65535
            self._reg = (reg["zMin"] + q.astype(np.float64) * k).reshape(int(reg["ny"]), int(reg["nx"]))
        reg = self.meta["reg"]
        ny, nx = self._reg.shape
        fx = (e - reg["e0"]) / reg["cell"] - 0.5
        fy = (s - reg["s0"]) / reg["cell"] - 0.5
        fx = min(max(fx, 0.0), nx - 1.001)
        fy = min(max(fy, 0.0), ny - 1.001)
        j = int(fx); i = int(fy); tx = fx - j; ty = fy - i
        a = self._reg
        return float((a[i, j] * (1 - tx) + a[i, j + 1] * tx) * (1 - ty) + (a[i + 1, j] * (1 - tx) + a[i + 1, j + 1] * tx) * ty)

    # ------------------------------------------------------------------ metadata for hello
    def hello_site(self):
        core = self.meta["core"]
        return {"name": "NE Melas Chasma", "lat": round(core["centerLat"], 4), "lon": round(core["centerLon"], 4),
                "core": {"e0": self.e0, "s0": self.s0, "size": self.size, "cell": self.cell, "n": self.n},
                "z_ref": round(self.z_ref, 3), "ortho": "data/site/core_ortho.webp",
                "origin": {"lon": self.meta["origin"]["lon"], "lat": self.meta["origin"]["lat"]},
                "sources": self.meta.get("sources", {})}


_SITE = None


def get_site():
    global _SITE
    if _SITE is None:
        _SITE = Site()
    return _SITE


def heading_deg(dx, dy):
    """Degrees clockwise from north for a move (dx east, dy south)."""
    return (math.degrees(math.atan2(dx, -dy)) + 360.0) % 360.0
