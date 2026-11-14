"""Make the habitat, lander and helicopter textures without logos.

    uv run --no-project --with numpy --with pillow --with scipy python -I tools/make_prop_textures.py

Reads (parsed as plain data): the Habitat Demonstration Unit, InSight and Ingenuity models in assets_src/ (binary glTF),
the textures stored in them.
Writes unreal_import/props/:
    habitat_hdu_01.png             habitat colour: the agency insignia, the programme logos and the unit patches painted out
    insight_tex_02.png             lander colour: the three agency logos of the calibration target painted out
    ingenuity_blade.png            helicopter colour: the two logo plates left plain
    ingenuity_chopper_sp_r2.png    helicopter roughness and metal: the two logos painted out
    ingenuity_chopper_sp_n2.png    helicopter normal map: the two embossed logos flattened

The project does not show agency logos. Each logo is replaced by the plain surface next to it; nothing else changes.
unreal/scripts/import_prop_textures.py imports the files over the textures of the three models.
Credit: Habitat Demonstration Unit model NASA; InSight lander and Ingenuity helicopter models NASA/JPL-Caltech.
"""
import io
import json
import os
import struct

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets_src")
OUT = os.path.join(ROOT, "unreal_import", "props")
HABITAT = os.path.join(SRC, "nasa_habitat_demonstration_unit", "Habitat_Demonstration_Unit_part1.glb")
INSIGHT = os.path.join(SRC, "nasa_insight_lander", "insight_deployed_mars_team.glb")
INGENUITY = os.path.join(SRC, "nasa_ingenuity_helicopter", "ingenuity_v3_mars_team.glb")

# output file: (model, image name in the model, image size, patches)
# a patch is a box (x0, y0, x1, y1) and how the logo is found in it:
#   "marks"  every pixel of the box that differs from the plain surface around it
#   (x, y)   the connected shape under that point (the bolts next to it stay)
#   "all"    the whole box (relief has no outline to find)
SEGMENT_ICONS = [((130, y - 11, 150, y + 9), "marks") for y in (45, 124, 204, 286, 367, 448, 529, 611)]   # one small insignia per hull segment
TEXTURES = {
    "habitat_hdu_01.png": (HABITAT, "HDU_01", (1024, 1024), SEGMENT_ICONS + [
        ((188, 148, 254, 210), "marks"), ((188, 472, 254, 536), "marks"),      # insignia
        ((184, 230, 260, 289), "marks"), ((184, 554, 260, 613), "marks"),      # programme logo
        ((36, 234, 93, 284), "marks"), ((64, 558, 123, 607), "marks")]),       # unit patch
    "insight_tex_02.png": (INSIGHT, "InSIGHT_tex_02.jpg.001", (1024, 1024), [((148, 310, 358, 359), "marks")]),
    "ingenuity_blade.png": (INGENUITY, "blade", (1024, 512), [((16, 164, 154, 209), "marks"), ((884, 396, 1024, 510), (954, 452))]),
    "ingenuity_chopper_sp_r2.png": (INGENUITY, "chopper_sp_r2", (1024, 512), [((880, 345, 1024, 510), "marks")]),
    "ingenuity_chopper_sp_n2.png": (INGENUITY, "chopper_sp_n2", (1024, 512), [((868, 335, 1024, 512), "all")]),
}
DIFFERENT = 18       # a pixel is part of a logo when a channel is this far from the plain surface
GROW_PX = 5          # cover the soft edge of the logo as well
AROUND_PX = 24       # how far around the box the surface is read when the box holds nothing plain
BLUR_PX = 4.0        # smoothing of the filled-in surface


def glb_images(path):
    """name -> image bytes for every image stored in the binary chunk (the small WebP copies are left out)."""
    b = open(path, "rb").read()
    if b[:4] != b"glTF":
        raise ValueError("not a binary glTF file")
    n, _ = struct.unpack_from("<II", b, 12)
    doc = json.loads(b[20:20 + n])
    m, _ = struct.unpack_from("<II", b, 20 + n)
    blob = b[28 + n:28 + n + m]
    out = {}
    for im in doc.get("images", []):
        if im.get("mimeType") == "image/webp":
            continue
        bv = doc["bufferViews"][im["bufferView"]]
        start = bv.get("byteOffset", 0)
        out.setdefault(im["name"], blob[start:start + bv["byteLength"]])
    return out


def logo_mask(box, how):
    """Which pixels of the box (an array) belong to the logo, and which show the plain surface."""
    if how == "all":
        return np.ones(box.shape[:2], dtype=bool), np.zeros(box.shape[:2], dtype=bool)
    frame = np.concatenate([box[:2].reshape(-1, 3), box[-2:].reshape(-1, 3), box[:, :2].reshape(-1, 3), box[:, -2:].reshape(-1, 3)])
    marks = np.abs(box.astype(int) - np.median(frame, axis=0)).max(axis=2) > DIFFERENT
    plain = ~marks
    if how != "marks":
        shapes, _count = ndimage.label(marks)
        x, y = how
        if shapes[y, x] == 0:
            raise ValueError("no shape under the point")
        marks = shapes == shapes[y, x]
    logo = ndimage.binary_dilation(ndimage.binary_fill_holes(marks), iterations=GROW_PX)
    return logo, plain & ~logo


def paint(a, patch):
    """Replace the logo of one patch with the plain surface next to it. Returns the number of pixels replaced."""
    (x0, y0, x1, y1), how = patch
    if how not in ("marks", "all"):
        how = (how[0] - x0, how[1] - y0)
    box = a[y0:y1, x0:x1]
    mask, plain = logo_mask(box, how)
    if plain.sum() < 16:                                      # nothing plain in the box: the colour around the box
        h, w = a.shape[:2]
        wx0, wy0, wx1, wy1 = max(0, x0 - AROUND_PX), max(0, y0 - AROUND_PX), min(w, x1 + AROUND_PX), min(h, y1 + AROUND_PX)
        around = np.ones((wy1 - wy0, wx1 - wx0), dtype=bool)
        around[y0 - wy0:y1 - wy0, x0 - wx0:x1 - wx0] = False
        box[mask] = np.median(a[wy0:wy1, wx0:wx1][around], axis=0)
        return int(mask.sum())
    _distance, (iy, ix) = ndimage.distance_transform_edt(~plain, return_indices=True)
    filled = box[iy, ix].astype(float)                          # every logo pixel takes the nearest plain pixel of the box
    inside = mask.astype(float)
    weight = np.maximum(ndimage.gaussian_filter(inside, BLUR_PX), 1e-6)
    for c in range(3):                                          # smooth the fill, using fill values only
        smooth = ndimage.gaussian_filter(filled[..., c] * inside, BLUR_PX) / weight
        box[..., c][mask] = np.clip(np.round(smooth[mask]), 0, 255)
    return int(mask.sum())


def main():
    os.makedirs(OUT, exist_ok=True)
    stored = {}
    for name, (model, image, size, patches) in TEXTURES.items():
        if model not in stored:
            stored[model] = glb_images(model)
        img = Image.open(io.BytesIO(stored[model][image])).convert("RGB")
        if img.size != size:
            raise ValueError(f"{image}: {img.size}, the patch boxes are for {size}")
        a = np.asarray(img).copy()
        replaced = [paint(a, patch) for patch in patches]
        path = os.path.join(OUT, name)
        Image.fromarray(a).save(path, optimize=True)
        print(f"wrote {path} {size} pixels replaced per patch {replaced}")


if __name__ == "__main__":
    main()
