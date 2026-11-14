"""Make the crew suit textures without the agency insignia and the mission emblem.

    uv run --no-project --with numpy --with pillow --with scipy python -I tools/make_suit_texture.py

Reads (parsed as plain data): assets_src/nasa_z2_spacesuit/z2_spacesuit.glb, its JPEG textures z2_Color_s, z2_spec_color_s
and z2_Bump_s.
Writes: unreal_import/crew/z2_Color_s.jpg       base colour, the two round patches painted in the suit fabric colour
        unreal_import/crew/z2_spec_color_s.jpg  specular colour, the same two patches painted black (as the fabric is)
        unreal_import/crew/z2_Bump_s.jpg        normal map made from the bump image, flat where the two patches were

The project does not show the NASA insignia, so the two patches of the model become plain fabric.
The model stores its relief as a grey bump (height) image in the slot of a normal map; the engine reads that slot as
normals, so the bump is turned into a real normal map here. Its strength is a look: the model gives no depth for it.
unreal/scripts/import_crew.py imports the three files over the textures of the static suit.
Credit: Z-2 suit model NASA/LaRC/Advanced Concepts Lab (NASA 3D Resources).
"""
import io
import json
import os
import struct

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "assets_src", "nasa_z2_spacesuit", "z2_spacesuit.glb")
OUT = os.path.join(ROOT, "unreal_import", "crew")
# a point inside each patch and a search box (x0, y0, x1, y1) around it, in the 4096 x 4096 textures;
# the patch is the connected shape under the point, standing on the white background of the atlas
PATCHES = {"insignia": ((281, 3525), (180, 3420, 380, 3620)), "emblem": ((135, 3590), (30, 3480, 240, 3700))}
FABRIC_FROM = (560, 3180, 660, 3300)     # a clean piece of suit fabric: its median colour fills the patches
BACKGROUND = 232                         # atlas background is white; a pixel belongs to a shape when any channel is darker
GROW_PX = 4                              # cover the soft edge of the patch as well
NORMAL_SIZE = 2048                       # the normal map is written at half the size of the bump image
RELIEF = 10.0                            # slope of the normal per unit of bump height change over one pixel


def glb_images(path):
    """name -> JPEG bytes for every JPEG image stored in the binary chunk."""
    b = open(path, "rb").read()
    if b[:4] != b"glTF":
        raise ValueError("not a binary glTF file")
    n, _ = struct.unpack_from("<II", b, 12)
    doc = json.loads(b[20:20 + n])
    m, _ = struct.unpack_from("<II", b, 20 + n)
    blob = b[28 + n:28 + n + m]
    out = {}
    for im in doc.get("images", []):
        if im.get("mimeType") != "image/jpeg":
            continue
        bv = doc["bufferViews"][im["bufferView"]]
        start = bv.get("byteOffset", 0)
        out[im["name"]] = blob[start:start + bv["byteLength"]]
    return out


def paint(img, fill):
    """Replace each patch (the connected shape under its point) with one colour; its neighbours stay as they are."""
    a = np.asarray(img).copy()
    covered = {}
    painted = np.zeros(a.shape[:2], dtype=bool)
    for name, ((px, py), (x0, y0, x1, y1)) in PATCHES.items():
        box = a[y0:y1, x0:x1]
        shapes, _count = ndimage.label(box.min(axis=2) < BACKGROUND)
        patch = shapes[py - y0, px - x0]
        if patch == 0:
            raise ValueError(f"{name}: no patch under its point")
        whole = ndimage.binary_fill_holes(shapes == patch)      # white lettering inside the patch belongs to it
        grown = ndimage.binary_dilation(whole, iterations=GROW_PX)
        mask = whole | (grown & (shapes == 0))                  # the soft edge, but never a neighbouring shape
        box[mask] = fill
        painted[y0:y1, x0:x1] |= mask
        covered[name] = int(mask.sum())
    return Image.fromarray(a), covered, painted


def normal_map(bump, colour, painted):
    """Tangent-space normal map (green up, as glTF stores it) from the bump image, flat off the suit and on the patches."""
    step = bump.width // NORMAL_SIZE
    grey = bump.convert("L")
    h = np.asarray(grey.reduce(step), dtype=np.float32) / 255.0
    outside = (np.asarray(colour).min(axis=2) >= BACKGROUND) & (np.asarray(grey) >= BACKGROUND)
    still = outside | ndimage.binary_dilation(painted, iterations=GROW_PX)
    still = still.reshape(NORMAL_SIZE, step, NORMAL_SIZE, step).any(axis=(1, 3))
    still = ndimage.binary_dilation(still, iterations=2)      # a slope next to them is the edge of the atlas, not relief
    dx = ndimage.sobel(h, axis=1) / 8.0
    dy = ndimage.sobel(h, axis=0) / 8.0
    dx[still] = 0.0
    dy[still] = 0.0
    tilt = np.degrees(np.arctan(RELIEF * np.hypot(dx, dy)[~still]))
    n = np.dstack([-RELIEF * dx, RELIEF * dy, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    out = Image.fromarray(np.round((n * 0.5 + 0.5) * 255.0).astype(np.uint8))
    return out, [round(float(v), 1) for v in np.percentile(tilt, [50, 95, 99])]


def main():
    images = glb_images(SOURCE)
    os.makedirs(OUT, exist_ok=True)
    colour = Image.open(io.BytesIO(images["z2_Color_s"])).convert("RGB")
    x0, y0, x1, y1 = FABRIC_FROM
    fabric = tuple(int(v) for v in np.median(np.asarray(colour)[y0:y1, x0:x1].reshape(-1, 3), axis=0))
    for name, fill in (("z2_Color_s", fabric), ("z2_spec_color_s", (0, 0, 0))):
        img = Image.open(io.BytesIO(images[name])).convert("RGB")
        if img.size != (4096, 4096):
            raise ValueError(f"{name}: {img.size}, the patch boxes are for 4096 x 4096")
        out, covered, painted = paint(img, fill)
        path = os.path.join(OUT, name + ".jpg")
        out.save(path, quality=93, subsampling=0)
        print(f"wrote {path} fill {fill} patch pixels {covered}")
        if name == "z2_Color_s":
            suit, patches = img, painted
    bump = Image.open(io.BytesIO(images["z2_Bump_s"]))
    if bump.size != suit.size:
        raise ValueError(f"z2_Bump_s: {bump.size}, not the size of the colour texture")
    out, tilt = normal_map(bump, suit, patches)
    path = os.path.join(OUT, "z2_Bump_s.jpg")
    out.save(path, quality=95, subsampling=0)
    print(f"wrote {path} {out.size} tilt of the relief, median / 95 % / 99 %: {tilt} degrees")


if __name__ == "__main__":
    main()
