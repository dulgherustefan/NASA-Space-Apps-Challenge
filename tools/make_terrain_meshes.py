"""Turn the processed site rasters (data/site) into terrain meshes for Unreal.

    uv run python tools/make_terrain_meshes.py

Writes binary glTF tiles to unreal_import/meshes/ (not in git, rebuilt in seconds) and terrain_meshes.json,
the list unreal/scripts/import_terrain.py reads. Three tiers, all from NASA elevation data:

  core    4 x 4 km at 2.5 m     HiRISE DTM            16 tiles
  region  9 x 28 km at 16 m     HiRISE + CTX DTM       4 tiles, pushed 40 m down under the core box
  far     56 x 68 km at 80 m    regional DTM           1 tile with a hole where the region is

Vertex positions are metres in the local frame of docs/CONTRACT.md, written so that Unreal's glTF importer
(X, Y, Z) = (gltf.x, gltf.z, gltf.y) * 100 puts them at X = east * 100, Y = south * 100, Z = (z - Z_REF) * 100.
Every mesh uses the world origin as its pivot, so every terrain actor sits at 0, 0, 0.
UV0 runs 0..1 across the whole tier (east right, south down), so one orthoimage drapes over all tiles of a tier.
"""
import gzip
import json
import os
import struct

import numpy as np
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "data", "site")
OUT = os.path.join(ROOT, "unreal_import")
MESH = os.path.join(OUT, "meshes")

CORE_TILES = 4            # 4 x 4 tiles of 400 quads
REG_TILES_S = 4           # 4 tiles along south
REG_CROP = 4              # columns dropped on each side of the 576-wide region grid (matches the orthoimage crop)
SINK_M = 40.0             # region pushed down under the core box so the two tiers never z-fight
SINK_INSET_M = 24.0
FAR_HOLE_INSET_CELLS = 2  # far quads this far inside the region footprint are dropped
SKIRT_M = {"core": 6.0, "region": 60.0, "far": 300.0}


def load_u16(name, shape):
    with open(os.path.join(SITE, name), "rb") as f:
        q = np.frombuffer(gzip.decompress(f.read()), dtype="<u2")
    assert q.size == shape[0] * shape[1], (name, q.size, shape)
    return q.reshape(shape).astype(np.float64)


def write_glb(path, pos, nrm, uv, idx, name):
    pos = np.ascontiguousarray(pos, dtype="<f4")
    nrm = np.ascontiguousarray(nrm, dtype="<f4")
    uv = np.ascontiguousarray(uv, dtype="<f4")
    idx = np.ascontiguousarray(idx, dtype="<u4")
    blobs = [pos.tobytes(), nrm.tobytes(), uv.tobytes(), idx.tobytes()]
    views, off = [], 0
    for b, target in zip(blobs, (34962, 34962, 34962, 34963)):
        views.append({"buffer": 0, "byteOffset": off, "byteLength": len(b), "target": target})
        off += len(b)
    n = len(pos)
    doc = {
        "asset": {"version": "2.0", "generator": "make_terrain_meshes.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}, "indices": 3, "mode": 4}]}],
        "buffers": [{"byteLength": off}], "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": n, "type": "VEC3", "min": pos.min(0).tolist(), "max": pos.max(0).tolist()},
            {"bufferView": 1, "componentType": 5126, "count": n, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5126, "count": n, "type": "VEC2"},
            {"bufferView": 3, "componentType": 5125, "count": int(idx.size), "type": "SCALAR"},
        ],
    }
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    blob = b"".join(blobs)
    blob += b"\0" * (-len(blob) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack("<I4s", len(js), b"JSON"))
        f.write(js)
        f.write(struct.pack("<I4s", len(blob), b"BIN\0"))
        f.write(blob)


def grid_normals(z, cell):
    """Unit normals of a height grid (rows south, columns east) as (east, up, south) components."""
    dzds, dzde = np.gradient(z, cell)
    n = np.stack([-dzde, np.ones_like(z), -dzds], axis=-1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def tile_mesh(ee, ss, z, nrm, u, v, r0, r1, c0, c1, skirt, keep=None):
    """Mesh for rows r0..r1 and columns c0..c1 (inclusive vertex ranges) of a grid, with a skirt around it.

    ee, ss: 1-D east and south coordinates of the vertices; z, nrm: full grids; u, v: 1-D drape coordinates.
    keep: optional bool grid of quads (rows-1, cols-1) of the full grid; quads that are False are dropped.
    """
    rows, cols = r1 - r0 + 1, c1 - c0 + 1
    E, S = np.meshgrid(ee[c0:c1 + 1], ss[r0:r1 + 1])
    Z = z[r0:r1 + 1, c0:c1 + 1]
    pos = np.stack([E, Z, S], axis=-1).reshape(-1, 3)
    nr = nrm[r0:r1 + 1, c0:c1 + 1].reshape(-1, 3)
    U, V = np.meshgrid(u[c0:c1 + 1], v[r0:r1 + 1])
    uv = np.stack([U, V], axis=-1).reshape(-1, 2)

    i = np.arange(rows * cols).reshape(rows, cols)
    a, b, c, d = i[:-1, :-1], i[1:, :-1], i[:-1, 1:], i[1:, 1:]     # a: here, b: south, c: east, d: south-east
    if keep is not None:
        k = keep[r0:r1, c0:c1]
        a, b, c, d = a[k], b[k], c[k], d[k]
    # counter-clockwise seen from above in glTF's right-handed (east, up, south) frame
    tris = [np.stack([a, b, c], axis=-1).reshape(-1, 3), np.stack([c, b, d], axis=-1).reshape(-1, 3)]

    if skirt > 0 and keep is None:
        base = len(pos)
        edges = [  # (vertex ids along the edge, True if the outward side is to the left of travel)
            (i[0, :], True),       # north edge, travelling east
            (i[-1, :], False),     # south edge, travelling east
            (i[:, 0], False),      # west edge, travelling south
            (i[:, -1], True),      # east edge, travelling south
        ]
        extra_pos, extra_nr, extra_uv = [], [], []
        for top, left in edges:
            low = base + np.arange(len(top))
            base += len(top)
            p = pos[top].copy()
            p[:, 1] -= skirt
            extra_pos.append(p)
            extra_nr.append(nr[top])
            extra_uv.append(uv[top])
            t0, t1, l0, l1 = top[:-1], top[1:], low[:-1], low[1:]
            if left:
                tris += [np.stack([t0, t1, l0], axis=-1), np.stack([t1, l1, l0], axis=-1)]
            else:
                tris += [np.stack([t0, l0, t1], axis=-1), np.stack([t1, l0, l1], axis=-1)]
        pos = np.vstack([pos] + extra_pos)
        nr = np.vstack([nr] + extra_nr)
        uv = np.vstack([uv] + extra_uv)
    return pos, nr, uv, np.vstack(tris).reshape(-1)


def splits(n_quads, parts):
    step = n_quads // parts
    assert step * parts == n_quads, (n_quads, parts)
    return [(k * step, (k + 1) * step) for k in range(parts)]


def main():
    os.makedirs(MESH, exist_ok=True)
    with open(os.path.join(SITE, "meta.json"), encoding="utf8") as f:
        meta = json.load(f)
    core, reg, far = meta["core"], meta["reg"], meta["far"]
    z_ref = core["zMin"] + 32768.0 * (core["zMax"] - core["zMin"]) / 65535.0
    manifest = {"z_ref_m": z_ref, "note": "positions are local metres (east, south, z - z_ref); actors sit at 0,0,0", "meshes": []}

    def emit(tier, name, pos, nr, uv, idx):
        pos = pos.copy()
        pos[:, 1] -= z_ref
        path = os.path.join(MESH, name + ".glb")
        write_glb(path, pos, nr, uv, idx, name)
        manifest["meshes"].append({
            "tier": tier, "name": name, "file": f"meshes/{name}.glb",
            "vertices": int(len(pos)), "triangles": int(idx.size // 3),
            "bounds_m": {"e": [float(pos[:, 0].min()), float(pos[:, 0].max())],
                         "s": [float(pos[:, 2].min()), float(pos[:, 2].max())],
                         "up": [float(pos[:, 1].min()), float(pos[:, 1].max())]},
        })

    # ---- core: 1601 x 1601 vertices at 2.5 m
    n = core["n"]
    cz = core["zMin"] + load_u16("core_h.bin.gz", (n, n)) * (core["zMax"] - core["zMin"]) / 65535.0
    cell = core["size"] / (n - 1)
    ee = core["e0"] + np.arange(n) * cell
    ss = core["s0"] + np.arange(n) * cell
    nrm = grid_normals(cz, cell)
    uu = np.linspace(0.0, 1.0, n)
    for ri, (r0, r1) in enumerate(splits(n - 1, CORE_TILES)):
        for ci, (c0, c1) in enumerate(splits(n - 1, CORE_TILES)):
            emit("core", f"SM_Core_{ri}{ci}", *tile_mesh(ee, ss, cz, nrm, uu, uu, r0, r1, c0, c1, SKIRT_M["core"]))

    # ---- region: 576 x 1764 cells of 16 m (values at cell centres), 4 columns cropped on each side
    rz = reg["zMin"] + load_u16("reg_h.bin.gz", (reg["ny"], reg["nx"])) * (reg["zMax"] - reg["zMin"]) / 65535.0
    rz = rz[:, REG_CROP:reg["nx"] - REG_CROP]
    rz = np.vstack([rz, rz[-1:, :]])                       # one duplicated row so the row count splits evenly
    ny, nx = rz.shape
    ee = reg["e0"] + (REG_CROP + 0.5 + np.arange(nx)) * reg["cell"]
    ss = reg["s0"] + (0.5 + np.arange(ny)) * reg["cell"]
    inside_e = (ee > core["e0"] + SINK_INSET_M) & (ee < core["e0"] + core["size"] - SINK_INSET_M)
    inside_s = (ss > core["s0"] + SINK_INSET_M) & (ss < core["s0"] + core["size"] - SINK_INSET_M)
    nrm = grid_normals(rz, reg["cell"])                    # normals of the real surface, before the sink
    rz = np.where(np.outer(inside_s, inside_e), rz - SINK_M, rz)
    uu = (ee - reg["e0"]) / reg["w"]
    vv = (ss - reg["s0"]) / reg["h"]
    for ri, (r0, r1) in enumerate(splits(ny - 1, REG_TILES_S)):
        emit("region", f"SM_Region_{ri}", *tile_mesh(ee, ss, rz, nrm, uu, vv, r0, r1, 0, nx - 1, SKIRT_M["region"]))
    reg_box = (float(ee[0]), float(ee[-1]), float(ss[0]), float(ss[-1]))

    # ---- far: 700 x 850 cells of 80 m, with a hole under the region
    fz = far["zMin"] + load_u16("far_h.bin.gz", (far["ny"], far["nx"])) * (far["zMax"] - far["zMin"]) / 65535.0
    ny, nx = fz.shape
    ee = far["e0"] + (0.5 + np.arange(nx)) * far["cell"]
    ss = far["s0"] + (0.5 + np.arange(ny)) * far["cell"]
    nrm = grid_normals(fz, far["cell"])
    inset = FAR_HOLE_INSET_CELLS * far["cell"]
    in_e = (ee > reg_box[0] + inset) & (ee < reg_box[1] - inset)
    in_s = (ss > reg_box[2] + inset) & (ss < reg_box[3] - inset)
    vin = np.outer(in_s, in_e)
    hole = vin[:-1, :-1] & vin[1:, :-1] & vin[:-1, 1:] & vin[1:, 1:]
    uu = (ee - far["e0"]) / far["w"]
    vv = (ss - far["s0"]) / far["h"]
    emit("far", "SM_Far_0", *tile_mesh(ee, ss, fz, nrm, uu, vv, 0, ny - 1, 0, nx - 1, 0.0, keep=~hole))

    # ---- drapes (written by make_unreal_terrain.py); the far tier has no usable orthoimage and is shaded with a flat tint
    manifest["drapes"] = {
        "core": {"ortho": "core_ortho_4096.png", "extent_m": {"e0": core["e0"], "s0": core["s0"], "w": core["size"], "h": core["size"]}},
        "region": {"ortho": "region_ortho_2048x8192.png", "extent_m": {"e0": reg["e0"], "s0": reg["s0"], "w": reg["w"], "h": reg["h"]}},
    }
    manifest["sources"] = meta["sources"]
    with open(os.path.join(OUT, "terrain_meshes.json"), "w", encoding="utf8") as f:
        json.dump(manifest, f, indent=1)

    tris = sum(m["triangles"] for m in manifest["meshes"])
    size = sum(os.path.getsize(os.path.join(OUT, m["file"])) for m in manifest["meshes"])
    print(f"{len(manifest['meshes'])} meshes, {tris / 1e6:.2f} M triangles, {size / 1e6:.0f} MB -> {MESH}")
    for tier in ("core", "region", "far"):
        ms = [m for m in manifest["meshes"] if m["tier"] == tier]
        print(f"  {tier:6s} {len(ms):2d} tiles  up {min(m['bounds_m']['up'][0] for m in ms):8.1f} .. {max(m['bounds_m']['up'][1] for m in ms):8.1f} m")


if __name__ == "__main__":
    main()
