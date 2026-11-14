"""Site raster loader - decodes app/public/data/site exactly like app/scripts/nodeSite.ts
(and src/engine/site.ts in the browser), so training sees the same grid as the app.

 core_h.bin.gz      uint16, n x n (1601) render heights, z = zMin + q * (zMax - zMin) / 65535 (stored float32)
 core_layers.bin.gz uint8,  len(layers) x na x na (800), value / meta.core.scale[name]
 analysis height    3x3 tent (1,2,1)x(1,2,1) around every second render vertex -> 5 m grid
 slope              central-difference gradient of the analysis heights (one-sided at the border), degrees
"""
import gzip, json, os
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_DIR = os.path.join(ROOT, "data", "site")
CELL = 5.0


def load_grid(site_dir=SITE_DIR):
    with open(os.path.join(site_dir, "meta.json"), "r", encoding="utf8") as f:
        meta = json.load(f)
    core = meta["core"]
    n, na = int(core["n"]), int(core["na"])
    N = na * na
    with open(os.path.join(site_dir, "core_h.bin.gz"), "rb") as f:
        q = np.frombuffer(gzip.decompress(f.read()), dtype="<u2")
    assert q.size == n * n, (q.size, n)
    k = (core["zMax"] - core["zMin"]) / 65535
    # JS: Float32Array[i] = zMin + q * k   (double arithmetic, float32 store)
    coreH = (core["zMin"] + q.astype(np.float64) * k).astype(np.float32).reshape(n, n)
    H = coreH.astype(np.float64)
    r = 2 * np.arange(na) + 1
    s = np.zeros((na, na), np.float64)
    w = 0
    for dr in (-1, 0, 1):          # same accumulation order as the JS loop
        for dc in (-1, 0, 1):
            ww = (2 if dr == 0 else 1) * (2 if dc == 0 else 1)
            s += H[np.ix_(r + dr, r + dc)] * ww
            w += ww
    z = (s / w).astype(np.float32)
    zd = z.astype(np.float64)
    idx = np.arange(na)
    i0 = np.maximum(0, idx - 1); i1 = np.minimum(na - 1, idx + 1)
    gy = (zd[i1, :] - zd[i0, :]) / ((i1 - i0)[:, None] * core["cell"])
    gx = (zd[:, i1] - zd[:, i0]) / ((i1 - i0)[None, :] * core["cell"])
    slope = (np.arctan(np.hypot(gx, gy)) * 180 / np.pi).astype(np.float32)
    with open(os.path.join(site_dir, "core_layers.bin.gz"), "rb") as f:
        layers = np.frombuffer(gzip.decompress(f.read()), dtype=np.uint8)
    names = core["layers"]
    assert layers.size == len(names) * N

    def layer(name):
        i = names.index(name)
        return (layers[i * N:(i + 1) * N].astype(np.float64) / core["scale"][name]).astype(np.float32)

    grid = {
        "n": na,
        "z": z.reshape(-1).copy(), "slope": slope.reshape(-1).copy(),
        "rough": layer("rough"), "sand": layer("sand"), "beta": layer("beta"),
        "sky": layer("sky"), "pit": layer("pit"),
    }
    return grid, meta


if __name__ == "__main__":
    g, meta = load_grid()
    n = g["n"]
    print("n", n, "z", g["z"].min(), g["z"].max(), "slope median", np.median(g["slope"]),
          "sand mean", g["sand"].mean(), "sky max", g["sky"].max())
