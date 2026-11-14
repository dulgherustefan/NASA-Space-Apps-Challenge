"""Turn the processed site rasters (data/site) into files Unreal can import.

    uv run python tools/make_unreal_terrain.py

Writes to unreal_import/:
  core_height_2017.png     16-bit grey, 2017 x 2017, the 4 x 4 km EVA box (HiRISE DTM)
  region_height_568x1765.png  16-bit grey, the 9 x 28 km strip with the canyon wall (HiRISE + CTX)
  core_ortho_4096.png      8-bit RGB orthoimage over the core box (approximate colour)
  core_lum_4096.png        8-bit grey luminance of the same (the material tints it)
  region_ortho_2048x8192.png, region_lum_2048x8192.png
  import_values.json       scale, location and component layout for the Landscape import dialog

Heights map to Unreal like this (ALandscape): world_cm = (v - 32768) / 128 * Scale.Z + Location.Z.
Storing z = zMin + v * (zMax - zMin) / 65535 therefore needs Scale.Z = 12800 * (zMax - zMin) / 65535.
Coordinates: Unreal X = east * 100, Y = south * 100 (see docs/CONTRACT.md).
"""
import gzip
import json
import os

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "data", "site")
OUT = os.path.join(ROOT, "unreal_import")

CORE_N = 2017          # 16 x 16 components of 2 x 2 sections of 63 quads
REG_NX, REG_NY = 568, 1765   # 9 x 28 components of one 63-quad section
REG_CROP = 4           # columns dropped on each side of the 576-wide region grid
SINK_M = 40.0          # the region is pushed down under the core box so the two never z-fight
SINK_INSET_M = 24.0


def load_u16(name, shape):
    with open(os.path.join(SITE, name), "rb") as f:
        q = np.frombuffer(gzip.decompress(f.read()), dtype="<u2")
    assert q.size == shape[0] * shape[1], (name, q.size, shape)
    return q.reshape(shape).astype(np.float64)


def bilinear(a, ny, nx):
    """Resample a vertex grid to (ny, nx) vertices spanning the same extent."""
    h, w = a.shape
    y = np.linspace(0, h - 1, ny)
    x = np.linspace(0, w - 1, nx)
    y0 = np.minimum(np.floor(y).astype(int), h - 2)
    x0 = np.minimum(np.floor(x).astype(int), w - 2)
    fy = (y - y0)[:, None]
    fx = (x - x0)[None, :]
    a00 = a[np.ix_(y0, x0)]
    a01 = a[np.ix_(y0, x0 + 1)]
    a10 = a[np.ix_(y0 + 1, x0)]
    a11 = a[np.ix_(y0 + 1, x0 + 1)]
    return (a00 * (1 - fx) + a01 * fx) * (1 - fy) + (a10 * (1 - fx) + a11 * fx) * fy


def save_u16(arr, name):
    q = np.clip(np.rint(arr), 0, 65535).astype(np.uint16)
    Image.fromarray(q).save(os.path.join(OUT, name))   # mode I;16
    return q


def z_scale(zmin, zmax):
    return 12800.0 * (zmax - zmin) / 65535.0


def z_mid(zmin, zmax):
    return zmin + 32768.0 * (zmax - zmin) / 65535.0


def main():
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(SITE, "meta.json"), encoding="utf8") as f:
        meta = json.load(f)
    core, reg = meta["core"], meta["reg"]

    # ---- core: 1601 vertices at 2.5 m -> 2017 vertices over the same 4000 m
    cq = load_u16("core_h.bin.gz", (core["n"], core["n"]))
    cq2 = bilinear(cq, CORE_N, CORE_N)
    save_u16(cq2, f"core_height_{CORE_N}.png")
    core_quad_cm = core["size"] * 100.0 / (CORE_N - 1)
    z_ref = z_mid(core["zMin"], core["zMax"])

    # ---- region: 576 x 1764 cells of 16 m (cell centres) -> 568 x 1765 vertices, still 16 m
    rq = load_u16("reg_h.bin.gz", (reg["ny"], reg["nx"]))
    k_reg = (reg["zMax"] - reg["zMin"]) / 65535.0
    rz = reg["zMin"] + rq * k_reg                      # metres
    rz = rz[:, REG_CROP:REG_CROP + REG_NX]
    rz = np.vstack([rz, rz[-1:, :]])                   # one duplicated row at the south end
    assert rz.shape == (REG_NY, REG_NX), rz.shape
    reg_e0 = reg["e0"] + (REG_CROP + 0.5) * reg["cell"]   # first vertex = first kept cell centre
    reg_s0 = reg["s0"] + 0.5 * reg["cell"]
    ee = reg_e0 + np.arange(REG_NX) * reg["cell"]
    ss = reg_s0 + np.arange(REG_NY) * reg["cell"]
    inside_e = (ee > core["e0"] + SINK_INSET_M) & (ee < core["e0"] + core["size"] - SINK_INSET_M)
    inside_s = (ss > core["s0"] + SINK_INSET_M) & (ss < core["s0"] + core["size"] - SINK_INSET_M)
    sink = np.outer(inside_s, inside_e)
    rz = np.where(sink, rz - SINK_M, rz)
    rz_min = float(np.floor(rz.min()))
    rz_max = float(np.ceil(rz.max()))
    save_u16((rz - rz_min) / (rz_max - rz_min) * 65535.0, f"region_height_{REG_NX}x{REG_NY}.png")

    # ---- orthoimages
    co = Image.open(os.path.join(SITE, core["ortho"])).convert("RGB")
    co.save(os.path.join(OUT, "core_ortho_4096.png"))
    co.convert("L").save(os.path.join(OUT, "core_lum_4096.png"))
    ro = Image.open(os.path.join(SITE, reg["ortho"])).convert("RGB")
    reg_ortho_px = ro.size
    ro = ro.resize((2048, 8192), Image.LANCZOS)
    ro.save(os.path.join(OUT, "region_ortho_2048x8192.png"))
    ro.convert("L").save(os.path.join(OUT, "region_lum_2048x8192.png"))

    values = {
        "note": "Unreal X = east*100, Y = south*100, Z = (z - z_ref_m)*100. Heightmap columns run east, rows run south. "
                "location_cm is the Landscape actor's location (its first vertex); panel_location_cm is what the "
                "New Landscape panel asks for (the centre).",
        "z_ref_m": z_ref,
        "core": {
            "heightmap": f"core_height_{CORE_N}.png",
            "resolution": [CORE_N, CORE_N],
            "section_size": "63x63 quads",
            "sections_per_component": "2x2",
            "components": [16, 16],
            "location_cm": [core["e0"] * 100.0, core["s0"] * 100.0, 0.0],
            "panel_location_cm": [(core["e0"] + core["size"] / 2) * 100.0, (core["s0"] + core["size"] / 2) * 100.0, 0.0],
            "scale": [core_quad_cm, core_quad_cm, z_scale(core["zMin"], core["zMax"])],
            "quad_m": core_quad_cm / 100.0,
            "z_min_m": core["zMin"], "z_max_m": core["zMax"],
            "ortho": "core_ortho_4096.png", "luminance": "core_lum_4096.png",
            "ortho_extent_m": {"e0": core["e0"], "s0": core["s0"], "w": core["size"], "h": core["size"]},
        },
        "region": {
            "heightmap": f"region_height_{REG_NX}x{REG_NY}.png",
            "resolution": [REG_NX, REG_NY],
            "section_size": "63x63 quads",
            "sections_per_component": "1x1",
            "components": [9, 28],
            "location_cm": [reg_e0 * 100.0, reg_s0 * 100.0, (z_mid(rz_min, rz_max) - z_ref) * 100.0],
            "panel_location_cm": [(reg_e0 + (REG_NX - 1) * reg["cell"] / 2) * 100.0,
                                  (reg_s0 + (REG_NY - 1) * reg["cell"] / 2) * 100.0,
                                  (z_mid(rz_min, rz_max) - z_ref) * 100.0],
            "scale": [reg["cell"] * 100.0, reg["cell"] * 100.0, z_scale(rz_min, rz_max)],
            "quad_m": reg["cell"],
            "z_min_m": rz_min, "z_max_m": rz_max,
            "sunk_under_core_m": SINK_M,
            "ortho": "region_ortho_2048x8192.png", "luminance": "region_lum_2048x8192.png",
            "ortho_source_px": list(reg_ortho_px),
            "ortho_extent_m": {"e0": reg["e0"], "s0": reg["s0"], "w": reg["w"], "h": reg["h"]},
        },
        "sources": meta["sources"],
    }
    with open(os.path.join(OUT, "import_values.json"), "w", encoding="utf8") as f:
        json.dump(values, f, indent=1)

    for k in ("core", "region"):
        v = values[k]
        print(f"{k:7s} {v['heightmap']:30s} loc {v['location_cm']}  scale {[round(s, 4) for s in v['scale']]}")
    print("z_ref_m", round(z_ref, 3))


if __name__ == "__main__":
    main()
