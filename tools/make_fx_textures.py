"""Make the dust sprite texture used by the Unreal scene.

    uv run python tools/make_fx_textures.py

Writes unreal_import/fx/dust_atlas.png: four soft, wispy puffs in a 2 x 2 atlas (white, the shape is in every channel).
Procedural (seeded noise shaped by a radial falloff), so there is nothing to credit.
"""
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "unreal_import", "fx", "dust_atlas.png")
CELL = 256
SEED = 20261115


def fbm(rng, n, octaves=5):
    """Fractal value noise in 0..1."""
    out = np.zeros((n, n))
    amp, total = 1.0, 0.0
    for o in range(octaves):
        cells = 4 * 2 ** o
        g = rng.random((cells + 1, cells + 1))
        x = np.linspace(0, cells, n, endpoint=False)
        i = x.astype(int)
        t = x - i
        t = t * t * (3 - 2 * t)
        a = g[np.ix_(i, i)] * (1 - t)[None, :] + g[np.ix_(i, i + 1)] * t[None, :]
        b = g[np.ix_(i + 1, i)] * (1 - t)[None, :] + g[np.ix_(i + 1, i + 1)] * t[None, :]
        out += amp * (a * (1 - t)[:, None] + b * t[:, None])
        total += amp
        amp *= 0.5
    return out / total


def puff(rng):
    y, x = np.mgrid[0:CELL, 0:CELL]
    u = (x + 0.5) / CELL * 2 - 1
    v = (y + 0.5) / CELL * 2 - 1
    warp = (fbm(rng, CELL, 3) - 0.5) * 0.5              # bend the outline so no two puffs look alike
    r = np.hypot(u * rng.uniform(0.9, 1.15) + warp, v * rng.uniform(0.9, 1.15) - warp)
    fall = np.clip(1.0 - r, 0.0, 1.0) ** 1.4
    n = fbm(rng, CELL, 5)
    a = fall * (0.35 + 0.95 * n)
    a = np.clip((a - 0.06) / 0.7, 0.0, 1.0)
    edge = np.clip(1.0 - np.maximum(np.abs(u), np.abs(v)), 0.0, 1.0)
    return a * np.clip(edge * 6.0, 0.0, 1.0)             # nothing may touch the cell border


def main():
    rng = np.random.default_rng(SEED)
    atlas = np.zeros((CELL * 2, CELL * 2))
    for k in range(4):
        atlas[(k // 2) * CELL:(k // 2 + 1) * CELL, (k % 2) * CELL:(k % 2 + 1) * CELL] = puff(rng)
    img = (np.clip(atlas, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    Image.fromarray(np.dstack([img, img, img]), "RGB").save(OUT)
    print(f"wrote {OUT} ({img.shape[1]}x{img.shape[0]}, mean {img.mean() / 255.0:.3f})")


if __name__ == "__main__":
    main()
