"""Work out where the Unreal scene puts things on the terrain.

    uv run python tools/make_scene_layout.py

Reads data/scenario/mission.json and data/site, writes unreal_import/scene_layout.json. Every position is in
Unreal centimetres (X = east * 100, Y = south * 100, Z = (z - Z_REF) * 100) with z taken from the 2.5 m render
grid, the same heights the terrain meshes are built from, so objects sit on the visible surface.

  places          the scenario's places (science site, rover, habitat, shelters, boulder, epicentre)
  props           set dressing near the habitat (seismic station, helicopter), on the flattest ground nearby
  boulders        rocks scattered in the rockfall runout band (illustrative positions, seeded; not mapped boulders)
  stones          small loose rocks around the places and between them (set dressing, seeded; not mapped rocks)
  rockfall_paths  downhill tracks from steep source cells, used to animate falling rocks during the marsquake
  cameras         fixed camera poses for the cues of docs/CONTRACT.md
"""
import gzip
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from rl.terrain import load_grid  # noqa: E402

SITE = os.path.join(ROOT, "data", "site")
OUT = os.path.join(ROOT, "unreal_import", "scene_layout.json")
REACH_DEG = 27.8          # rockfall reach angle used by the engine (Grindrod et al. 2021)
SEED = 20261115


def main():
    grid, meta = load_grid()
    core, reg = meta["core"], meta["reg"]
    n, na, cell = int(core["n"]), int(core["na"]), float(core["cell"])
    e0, s0, size = core["e0"], core["s0"], core["size"]
    with open(os.path.join(SITE, "core_h.bin.gz"), "rb") as f:
        q = np.frombuffer(gzip.decompress(f.read()), dtype="<u2").astype(np.float64).reshape(n, n)
    cz = core["zMin"] + q * (core["zMax"] - core["zMin"]) / 65535.0
    with open(os.path.join(SITE, "reg_h.bin.gz"), "rb") as f:
        q = np.frombuffer(gzip.decompress(f.read()), dtype="<u2").astype(np.float64).reshape(int(reg["ny"]), int(reg["nx"]))
    rz = reg["zMin"] + q * (reg["zMax"] - reg["zMin"]) / 65535.0
    z_ref = core["zMin"] + 32768.0 * (core["zMax"] - core["zMin"]) / 65535.0
    step = size / (n - 1)                                   # 2.5 m between render vertices

    def bilinear(a, fx, fy):
        ny, nx = a.shape
        fx = min(max(fx, 0.0), nx - 1.001)
        fy = min(max(fy, 0.0), ny - 1.001)
        j, i = int(fx), int(fy)
        tx, ty = fx - j, fy - i
        return float((a[i, j] * (1 - tx) + a[i, j + 1] * tx) * (1 - ty) + (a[i + 1, j] * (1 - tx) + a[i + 1, j + 1] * tx) * ty)

    def z_at(x, y):
        """Height at core metres (x east, y south): render grid inside the box, regional grid outside."""
        if 0.0 <= x <= size and 0.0 <= y <= size:
            return bilinear(cz, x / step, y / step)
        return bilinear(rz, (e0 + x - reg["e0"]) / reg["cell"] - 0.5, (s0 + y - reg["s0"]) / reg["cell"] - 0.5)

    def ue(x, y, lift_m=0.0):
        return [round((e0 + x) * 100.0, 1), round((s0 + y) * 100.0, 1), round((z_at(x, y) + lift_m - z_ref) * 100.0, 1)]

    slope = grid["slope"].reshape(na, na)
    beta = grid["beta"].reshape(na, na)
    za = grid["z"].reshape(na, na).astype(np.float64)

    def cell_of(x, y):
        return min(max(int(y / cell), 0), na - 1), min(max(int(x / cell), 0), na - 1)

    def flattest(x, y, r0, r1):
        """Flattest analysis cell between r0 and r1 metres from (x, y)."""
        best = None
        for i in range(na):
            yy = (i + 0.5) * cell
            if abs(yy - y) > r1:
                continue
            for j in range(na):
                xx = (j + 0.5) * cell
                d = np.hypot(xx - x, yy - y)
                if r0 <= d <= r1 and (best is None or slope[i, j] < best[0]):
                    best = (float(slope[i, j]), xx, yy)
        return best

    with open(os.path.join(ROOT, "data", "scenario", "mission.json"), encoding="utf8") as f:
        mission = json.load(f)
    places = {}
    for p in mission["places"]:
        i, j = cell_of(p["x"], p["y"])
        inside = 0 <= p["x"] <= size and 0 <= p["y"] <= size
        places[p["id"]] = {"name": p["name"], "kind": p["kind"], "x": p["x"], "y": p["y"], "ue": ue(p["x"], p["y"]),
                           "slope_deg": round(float(slope[i, j]), 1) if inside else None,
                           "reach_deg": round(float(beta[i, j]), 1) if inside else None}

    H, S, A, C, R = (places[k] for k in "HSACR")
    props = {}
    # visual stand-ins sit on the flattest cell near the scenario point; the engine keeps using the scenario point
    for name, at, r0, r1 in (("habitat", H, 0.0, 22.0), ("rover", R, 0.0, 12.0),
                             ("seismic_station", H, 45.0, 80.0), ("helicopter", H, 30.0, 42.0)):
        sl, x, y = flattest(at["x"], at["y"], r0, r1)
        props[name] = {"x": x, "y": y, "ue": ue(x, y), "slope_deg": round(sl, 1)}

    # ---- boulders in the runout band
    rng = np.random.default_rng(SEED)
    ok = np.argwhere((beta >= REACH_DEG + 0.7) & (beta <= 36.0) & (slope <= 24.0))
    pick = ok[rng.choice(len(ok), size=90, replace=False)]
    boulders = []
    for i, j in pick:
        x = (j + rng.uniform(0.2, 0.8)) * cell
        y = (i + rng.uniform(0.2, 0.8)) * cell
        boulders.append({"ue": ue(x, y, -0.25), "size_m": round(float(np.clip(rng.lognormal(0.6, 0.5), 0.8, 6.0)), 2),
                         "yaw": round(float(rng.uniform(0, 360)), 1), "mesh": int(rng.integers(0, 3))})

    # ---- rockfall tracks: steepest descent from steep cells above the crew's working area
    mid = np.array([(S["x"] + A["x"] + C["x"]) / 3.0, (S["y"] + A["y"] + C["y"]) / 3.0])
    src = np.argwhere((slope >= 34.0) & (beta >= 36.0))
    d = np.hypot((src[:, 1] + 0.5) * cell - mid[0], (src[:, 0] + 0.5) * cell - mid[1])
    north = (src[:, 0] + 0.5) * cell < mid[1]
    src = src[(d < 1100.0) & (d > 250.0) & north]
    paths = []
    tries = 0
    while len(paths) < 16 and tries < 400 and len(src):
        tries += 1
        i, j = (int(v) for v in src[rng.integers(0, len(src))])
        track = [(i, j)]
        for _ in range(500):
            best = None
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    a, b = i + di, j + dj
                    if (di or dj) and 0 <= a < na and 0 <= b < na:
                        drop = (za[i, j] - za[a, b]) / (cell * np.hypot(di, dj))
                        if drop > 0 and (best is None or drop > best[0]):
                            best = (drop, a, b)
            if best is None:
                break
            i, j = best[1], best[2]
            track.append((i, j))
            if beta[i, j] < REACH_DEG and slope[i, j] < 14.0:
                break
        length = (len(track) - 1) * cell
        if length < 220.0:
            continue
        xs = np.array([(b + 0.5) * cell for _, b in track])
        ys = np.array([(a + 0.5) * cell for a, _ in track])
        k = np.ones(5) / 5.0                                  # light smoothing of the staircase
        if len(xs) > 8:
            xs[2:-2] = np.convolve(xs, k, "valid")
            ys[2:-2] = np.convolve(ys, k, "valid")
        pts = [ue(float(x), float(y), 0.6) for x, y in zip(xs[::2], ys[::2])]
        paths.append({"points": pts, "length_m": round(float(length), 0), "size_m": round(float(rng.uniform(1.5, 4.5)), 2),
                      "delay_s": round(float(rng.uniform(0.0, 9.0)), 1)})

    # ---- loose stones where the crew works and walks: around the places and along the straight lines between them
    stones = []
    spots = [(q["x"], q["y"], 45.0, 26) for q in (S, A, C, R, H)]
    for p0, p1 in ((S, A), (S, C), (S, R), (R, H), (A, R), (C, R)):
        n_seg = max(2, int(np.hypot(p1["x"] - p0["x"], p1["y"] - p0["y"]) / 40.0))
        spots += [(p0["x"] + (p1["x"] - p0["x"]) * t, p0["y"] + (p1["y"] - p0["y"]) * t, 30.0, 5) for t in np.linspace(0.0, 1.0, n_seg)]
    for cx, cy, spread, count in spots:
        for _ in range(count):
            x = float(np.clip(cx + rng.normal(0.0, spread), 2.0, size - 2.0))
            y = float(np.clip(cy + rng.normal(0.0, spread), 2.0, size - 2.0))
            if min(np.hypot(x - q["x"], y - q["y"]) for q in (H, R)) < 14.0:      # keep the habitat and the rover clear
                continue
            size_m = float(np.clip(rng.lognormal(-1.1, 0.55), 0.12, 1.4))
            stones.append({"ue": ue(x, y, -0.18 * size_m), "size_m": round(size_m, 2), "yaw": round(float(rng.uniform(0, 360)), 1),
                           "tilt": round(float(rng.uniform(-14, 14)), 1), "mesh": int(rng.integers(0, 3))})

    # ---- cameras (location, look-at target)
    def cam(x, y, up_m, tx, ty, tup_m, fov=55.0):
        loc = ue(x, y, up_m)
        tgt = ue(tx, ty, tup_m)
        return {"loc": loc, "target": tgt, "fov": fov}

    mx, my = float(mid[0]), float(mid[1])
    ax = float(np.mean([p["x"] for p in (S, A, C, R, H)]))      # centre of everything the story uses
    ay = float(np.mean([p["y"] for p in (S, A, C, R, H)]))
    cameras = {
        "overview": cam(ax + 250.0, ay + 2300.0, 1150.0, ax + 100.0, ay - 100.0, 0.0, 58.0),
        "wall": cam(S["x"] + 150.0, S["y"] + 520.0, 160.0, S["x"] - 50.0, S["y"] - 700.0, 220.0, 60.0),
        "shelter": cam(A["x"] - 110.0, A["y"] + 140.0, 45.0, A["x"], A["y"], 4.0, 45.0),
        "failure": cam(mx - 250.0, my + 800.0, 330.0, mx, my, 0.0, 45.0),
    }

    out = {"z_ref_m": z_ref, "note": "Unreal centimetres; z from the 2.5 m render grid. Boulders and rockfall tracks are illustrative.",
           "core_box_cm": [e0 * 100.0, s0 * 100.0, size * 100.0],
           "places": places, "props": props, "crew": mission["crew"], "boulders": boulders, "stones": stones, "rockfall_paths": paths,
           "cameras": cameras}
    with open(OUT, "w", encoding="utf8") as f:
        json.dump(out, f, indent=1)
    for k, p in places.items():
        print(f"  {k} {p['name']:<18} ue {p['ue']}  slope {p['slope_deg']}  reach {p['reach_deg']}")
    for k, p in props.items():
        print(f"  {k:<18} slope {p['slope_deg']}  ue {p['ue']}")
    print(f"  {len(boulders)} boulders, {len(stones)} stones, {len(paths)} rockfall tracks ({min(p['length_m'] for p in paths):.0f}-{max(p['length_m'] for p in paths):.0f} m) -> {OUT}")


if __name__ == "__main__":
    main()
