"""800 x 800 analysis layers and their coloured RGBA overlays (runtime/overlay_<layer>.png).

Images: column j runs east, row i runs south (same as data/site/core_ortho.webp), straight alpha,
transparent where there is nothing to show. Ramps are perceptually ordered and colour-blind safe
(viridis/inferno families and Okabe-Ito hues).
"""
import io
import math
import os

import numpy as np
from PIL import Image

from . import RUNTIME, rel, write_atomic
from .params import PARAMS
from .walk import sep_rate

LAYERS = ["hazard", "slope", "rockfall", "sand", "sky", "dose", "failures"]
LABELS = {
    "hazard": "Combined hazard (slope, rockfall band, loose sand)",
    "slope": "Slope over 10 m (degrees)",
    "rockfall": "Rockfall runout band (reach angle 27.8 deg)",
    "sand": "Loose sand likelihood (image proxy)",
    "sky": "Blocked sky: terrain shielding",
    "dose": "Dose rate in the open, solar storm (uGy/h)",
    "failures": "Where virtual crews failed (local preview)",
}

# ramps: list of (position, (r, g, b))
INFERNO = [(0.0, (40, 11, 84)), (0.25, (101, 21, 110)), (0.5, (188, 55, 84)), (0.75, (249, 142, 9)), (1.0, (252, 255, 164))]
VIRIDIS = [(0.0, (68, 1, 84)), (0.25, (59, 82, 139)), (0.5, (33, 145, 140)), (0.75, (94, 201, 98)), (1.0, (253, 231, 37))]
BLUES = [(0.0, (86, 180, 233)), (1.0, (0, 114, 178))]          # Okabe-Ito sky blue -> blue
ORANGE = [(0.0, (230, 159, 0)), (1.0, (213, 94, 0))]           # Okabe-Ito orange -> vermillion
YELLOW = [(0.0, (240, 228, 66)), (1.0, (230, 159, 0))]         # Okabe-Ito yellow -> orange
PURPLE = [(0.0, (204, 121, 167)), (1.0, (120, 40, 140))]       # Okabe-Ito reddish purple -> purple


def ramp(v, stops):
    v = np.clip(np.asarray(v, np.float64), 0, 1)
    pos = np.array([p for p, _ in stops])
    out = np.zeros(v.shape + (3,), np.float64)
    for c in range(3):
        out[..., c] = np.interp(v, pos, [col[c] for _, col in stops])
    return out


def rgba(value01, alpha01, stops, n):
    rgb = ramp(value01, stops)
    a = np.clip(alpha01, 0, 1)
    img = np.zeros((n, n, 4), np.uint8)
    img[..., :3] = np.round(rgb).reshape(n, n, 3).astype(np.uint8)
    img[..., 3] = np.round(a * 255).reshape(n, n).astype(np.uint8)
    img[img[..., 3] == 0, :3] = 0
    return img


def png_bytes(img):
    buf = io.BytesIO()
    Image.fromarray(img, "RGBA").save(buf, format="PNG", optimize=False, compress_level=6)
    return buf.getvalue()


def write_png(name, img, directory=RUNTIME):
    path = os.path.join(directory, name)
    write_atomic(path, png_bytes(img))
    return rel(path)


def overlay_file(layer):
    return "runtime/overlay_%s.png" % layer


def blur(a, sigma_cells):
    """Separable Gaussian blur (edge-clamped)."""
    if sigma_cells <= 0:
        return a
    r = int(math.ceil(3 * sigma_cells))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_cells) ** 2)
    k /= k.sum()
    p = np.pad(a, ((0, 0), (r, r)), mode="edge")
    a = sum(k[i] * p[:, i:i + a.shape[1]] for i in range(2 * r + 1))
    p = np.pad(a, ((r, r), (0, 0)), mode="edge")
    return sum(k[i] * p[i:i + a.shape[0], :] for i in range(2 * r + 1))


class Hazards:
    def __init__(self, site, alpha=PARAMS["alphaDeg"]):
        self.site = site
        self.n = site.n
        self.alpha = alpha
        n = self.n
        self.slope = site.slope.reshape(n, n)
        self.beta = site.beta.reshape(n, n)
        self.sand = site.sand.reshape(n, n)
        self.sky = site.sky.reshape(n, n)
        self.blocked = site.blocked.reshape(n, n).astype(bool)
        self.band = self.beta >= alpha
        self.shield = np.minimum(0.95, PARAMS["shieldK"] * self.sky)

    # ---------------------------------------------------------------- analysis layers
    def combined(self, band_active):
        hs = np.clip((self.slope - 10.0) / 15.0, 0, 1) ** 1.5
        hb = np.where(self.band, 0.7 if band_active else 0.25, 0.0)
        hd = 0.4 * np.clip(self.sand, 0, 1)
        h = 1 - (1 - hs) * (1 - hb) * (1 - hd)
        return np.where(self.blocked, 1.0, h)

    def dose_open(self, sep_elapsed_s=None):
        """Dose rate (uGy/h) at each cell; at the storm peak if no time is given."""
        p = PARAMS
        if sep_elapsed_s is None:
            sep_elapsed_s = p["sepPeakMin"] * 60.0
        r = p["gcrRate"] + sep_rate(float(sep_elapsed_s), p["sepPeakMin"], p["sepTotal"], p["sepDecayH"])
        return r * (1 - self.shield)

    # ---------------------------------------------------------------- overlays
    def img_slope(self):
        v = (self.slope - 8.0) / 27.0
        a = np.clip((self.slope - 8.0) / 12.0, 0, 1) * 0.75
        return rgba(v, a, INFERNO, self.n)

    def img_rockfall(self):
        depth = np.clip((self.beta - self.alpha) / 6.0, 0, 1)
        a = np.where(self.band, 0.35 + 0.4 * depth, 0.0)
        return rgba(depth, a, ORANGE, self.n)

    def img_sand(self):
        a = np.clip((self.sand - 0.2) / 0.6, 0, 1) * 0.7
        return rgba(self.sand, a, YELLOW, self.n)

    def img_sky(self):
        v = np.clip((self.sky - 0.15) / 0.3, 0, 1)
        a = np.where(self.sky >= 0.15, 0.25 + 0.6 * v, 0.0)
        a = np.where(self.sky >= PARAMS["skyShelterMin"], np.maximum(a, 0.8), a)
        return rgba(v, a, BLUES, self.n)

    def img_dose(self, sep_elapsed_s=None):
        d = self.dose_open(sep_elapsed_s)
        lo, hi = float(d.min()), float(d.max())
        v = (hi - d) / max(hi - lo, 1e-9)              # 0 = most exposed
        v = 1 - v
        a = 0.15 + 0.45 * v
        return rgba(v, a, PURPLE, self.n)

    def img_hazard(self, band_active):
        h = self.combined(band_active)
        a = np.where(h >= 0.1, 0.25 + 0.6 * np.clip(h, 0, 1), 0.0)
        return rgba(h, a, INFERNO, self.n)

    def img_failures(self, density):
        """density: n x n non-negative (already likelihood weighted)."""
        d = blur(np.asarray(density, np.float64), 3.0)
        mx = float(d.max())
        if mx <= 0:
            return np.zeros((self.n, self.n, 4), np.uint8)
        v = np.log1p(d / mx * 1000) / math.log1p(1000)
        a = np.where(v > 0.08, 0.2 + 0.75 * v, 0.0)
        return rgba(0.35 + 0.65 * v, a, INFERNO, self.n)

    def write_static(self):
        out = {}
        out["slope"] = write_png("overlay_slope.png", self.img_slope())
        out["rockfall"] = write_png("overlay_rockfall.png", self.img_rockfall())
        out["sand"] = write_png("overlay_sand.png", self.img_sand())
        out["sky"] = write_png("overlay_sky.png", self.img_sky())
        out["dose"] = write_png("overlay_dose.png", self.img_dose())
        out["hazard"] = write_png("overlay_hazard.png", self.img_hazard(False))
        if not os.path.exists(os.path.join(RUNTIME, "overlay_failures.png")):
            out["failures"] = write_png("overlay_failures.png", np.zeros((self.n, self.n, 4), np.uint8))
        return out

    def failure_density(self, points):
        """points: iterable of (x, y, weight) in core metres."""
        d = np.zeros((self.n, self.n))
        for x, y, w in points:
            i, j = self.site.cell_ij(x, y)
            d[i, j] += w
        return d
