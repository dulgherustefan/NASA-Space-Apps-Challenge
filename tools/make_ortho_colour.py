"""Colour versions of the two terrain orthoimages (core 4096 x 4096, region 2048 x 8192).

    uv run --no-project --with numpy --with pillow --with scipy --with rasterio python -I tools/make_ortho_colour.py

Reads  (all under the repo root)
  unreal_import/core_ortho_4096.png, region_ortho_2048x8192.png   brightness and detail: the existing HiRISE RED based
                                                                    greyscale-plus-flat-tint orthoimages (kept as they are)
  unreal_import/core_height_2017.png, region_height_568x1765.png + import_values.json   heights (for parallax correction)
  data_raw/colour/viking_mdim21_colour/*.png    USGS/NASA Viking MDIM 2.1 colourised mosaic, 256 px/deg (about 232 m/px)
  data_raw/colour/hirise_ESP_028857_1700_mrgb/  HiRISE merged RGB product (colour strip about 1.2 km wide, rest grey)
Writes (never overwrites the old files)
  unreal_import/core_ortho_colour_4096.png, region_ortho_colour_2048x8192.png   8-bit sRGB, same pixel grid as the old files
  data_raw/colour/preview_old_vs_new.png, data_raw/colour/ortho_colour_params.json

Method (what is data and what is a look)
  Brightness : CIE L* of the existing orthoimage, unchanged (HiRISE RED, 1 m).  [data, via the old file]
  Dust index t in [0, 1] (0 = dark basaltic sand, 1 = bright dust):
     inside the HiRISE colour strip: t from the red/blue ratio (R-B)/(R+B) of the HiRISE RGB, low-passed to 4 m, rescaled
        by the 5th and 95th percentile over the core strip. The HiRISE product is a stretched relative colour, so only the
        pattern is used, not the absolute colour. The image is registered to the orthoimage with a parallax model fitted
        here (phase correlation on tiles). [data, relative]
     elsewhere: t = F(smoothed L*), the monotone relation between brightness and t measured inside the strip
        (darker = more sand-like). [inferred from data, not observed]
     the two are blended with a feathered strip mask, so there is no step at the strip edge.
  Hue / saturation offset: from the Viking colourised mosaic, valid pixels only (over-exposed slopes and blue artefacts
     are masked and filled from valid neighbours), low-passed (sigma 3 px, about 0.7 km), expressed as a hue offset in
     degrees and a chroma ratio relative to the regional median, clipped to +-8 deg and 0.85 .. 1.20.  [data, low amplitude]
  Absolute colour: two end members (dust, sand) in CIE Lab hue and chroma-per-lightness, soft-limited to C* 30, chosen to match the colours measured
     on NASA rover Mastcam / Mastcam-Z photographs (data_raw/reference_photos).  [a look, not a measurement of Melas]
  Colours outside the sRGB gamut are desaturated until they fit; lightness is never changed.
"""
import argparse
import json
import math
import os
import time

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import Window
from scipy import ndimage as ndi

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, "unreal_import")
COL = os.path.join(ROOT, "data_raw", "colour")
VIKING_PNG = os.path.join(COL, "viking_mdim21_colour", "mdim21_colour_lon289.5-290.5_lat-10.75--9.25_256ppd.png")
VIKING_BBOX = (289.5, -10.75, 290.5, -9.25)   # lon_w, lat_s, lon_e, lat_n ; 256 px per degree
MRGB = os.path.join(COL, "hirise_ESP_028857_1700_mrgb", "ESP_028857_1700_MRGB.JP2")

# ---- georeference of the site frame (data/site/meta.json) and of the MRGB product (its PDS label)
R_SITE, LAT0 = 3396190.0, -10.0
PROJ_X, PROJ_Y = -4150721.364564072, -584833.3464244048
C0 = math.cos(math.radians(LAT0))
M_W, M_E, M_N, M_S = 289.9740029875, 290.09442055153, -9.8670489003168, -10.144194807499
M_NC, M_NR = 14057, 32850
M_DLON, M_DLAT = (M_E - M_W) / M_NC, (M_N - M_S) / M_NR
M_PX = 0.5   # metres per MRGB pixel

# ---- colour end members, matched to the rover photographs (Lab hue in degrees, chroma divided by L*)
H_DUST, K_DUST = 63.0, 0.60
H_SAND, K_SAND = 53.0, 0.46
C_OFF = 10.0   # chroma floor so dark ground stays brown, not grey
C_MAX = 42.0   # soft ceiling for chroma (rover soil/dust measured C* 16-36 at L* 36-58); keeps bright slopes from going neon

FRAMES = {
    "core": dict(old="core_ortho_4096.png", out="core_ortho_colour_4096.png", e0=1650.0, s0=6600.0, w=4000.0, h=4000.0,
                 nx=4096, ny=4096, iso=1.0, tile=512, mread=2),
    "region": dict(old="region_ortho_2048x8192.png", out="region_ortho_colour_2048x8192.png", e0=-1008.0, s0=-12000.0,
                   w=9216.0, h=28224.0, nx=2048, ny=8192, iso=4.0, tile=256, mread=4),
}

M_RGB2XYZ = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
M_XYZ2RGB = np.linalg.inv(M_RGB2XYZ)
WHITE = np.array([0.95047, 1.0, 1.08883])


def t_log(msg):
    print("[%6.1fs] %s" % (time.time() - T0, msg), flush=True)


T0 = time.time()


# ------------------------------------------------------------------ colour maths
def srgb_to_lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(v):
    v = np.clip(v, 0, 1)
    return np.where(v <= 0.0031308, 12.92 * v, 1.055 * np.power(v, 1 / 2.4) - 0.055) * 255.0


def lab_f(t):
    return np.where(t > 216 / 24389, np.cbrt(t), (24389 / 27 * t + 16) / 116)


def lab_finv(f):
    return np.where(f ** 3 > 216 / 24389, f ** 3, (116 * f - 16) * 27 / 24389)


def lum_lstar(rgb8):
    lin = srgb_to_lin(rgb8.astype(np.float32))
    y = lin @ M_RGB2XYZ[1].astype(np.float32)
    return (116 * lab_f(y) - 16).astype(np.float32)


def srgb8_to_lab(rgb8):
    lin = srgb_to_lin(rgb8.astype(np.float64))
    xyz = lin @ M_RGB2XYZ.T / WHITE
    f = lab_f(xyz)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lab_to_lin(L, a, b):
    fy = (L + 16) / 116
    xyz = np.stack([lab_finv(fy + a / 500), lab_finv(fy), lab_finv(fy - b / 200)], -1) * WHITE.astype(np.float32)
    return xyz @ M_XYZ2RGB.T.astype(np.float32)


def lab_to_srgb_gamut(L, a, b, iters=9):
    """Lab -> sRGB; where the colour is outside the gamut the chroma is scaled down (bisection), L* is kept."""
    lin = lab_to_lin(L, a, b)
    bad = (lin.min(-1) < 0) | (lin.max(-1) > 1)
    if bad.any():
        lo = np.zeros(L.shape, np.float32)
        hi = np.ones(L.shape, np.float32)
        for _ in range(iters):
            mid = (lo + hi) / 2
            l2 = lab_to_lin(L, a * mid, b * mid)
            ok = (l2.min(-1) >= 0) & (l2.max(-1) <= 1)
            lo = np.where(ok, mid, lo)
            hi = np.where(ok, hi, mid)
        k = np.where(bad, lo, 1.0)
        lin = lab_to_lin(L, a * k, b * k)
    return np.rint(lin_to_srgb(lin)).astype(np.uint8)


# ------------------------------------------------------------------ geometry
def frame_axes(fr):
    e = fr["e0"] + (np.arange(fr["nx"]) + 0.5) * fr["w"] / fr["nx"]
    s = fr["s0"] + (np.arange(fr["ny"]) + 0.5) * fr["h"] / fr["ny"]
    return e, s


def site_lon(e):
    return np.degrees((PROJ_X + e / C0) / R_SITE) + 360.0


def site_lat(s):
    return np.degrees((PROJ_Y - s) / R_SITE)


def height_grid(fr_name, e, s):
    """Terrain height in metres at the frame's pixel centres, from the heightmaps used for the Unreal landscape."""
    iv = json.load(open(os.path.join(UI, "import_values.json")))
    if fr_name == "core":
        v = iv["core"]
        h = np.asarray(Image.open(os.path.join(UI, v["heightmap"]))).astype(np.float32)
        n = h.shape[0]
        e0, s0, step = v["location_cm"][0] / 100, v["location_cm"][1] / 100, 4000.0 / (n - 1)
        zmin, zmax = v["z_min_m"], v["z_max_m"]
    else:
        v = iv["region"]
        h = np.asarray(Image.open(os.path.join(UI, v["heightmap"]))).astype(np.float32)
        e0, s0, step = v["location_cm"][0] / 100, v["location_cm"][1] / 100, v["quad_m"]
        zmin, zmax = v["z_min_m"], v["z_max_m"]
    z = zmin + h * (zmax - zmin) / 65535.0
    if fr_name == "region":
        c = iv["core"]["ortho_extent_m"]
        ee, ss = e0 + np.arange(z.shape[1]) * step, s0 + np.arange(z.shape[0]) * step
        sink = np.outer((ss > c["s0"] + 24) & (ss < c["s0"] + c["h"] - 24), (ee > c["e0"] + 24) & (ee < c["e0"] + c["w"] - 24))
        z = np.where(sink, z + v.get("sunk_under_core_m", 40.0), z)
    rr = ((s - s0) / step)[:, None] + 0 * e[None, :]
    cc = ((e - e0) / step)[None, :] + 0 * s[:, None]
    return ndi.map_coordinates(z, [rr, cc], order=1, mode="nearest").astype(np.float32)


def prior_offsets(z):
    """First guess of where the (non-orthorectified) MRGB product shows a ground point, in metres south / east of its
    true position: a constant plus the parallax of the 5 degree emission angle, found on the core box."""
    zc = z.astype(np.float32)
    off_r = 288 - 0.977 * (35.586 + 0.00923 * zc - 0.00223 * 2048 + 0.00626 * 2048)
    off_c = -78 - 0.977 * (-279.637 - 0.09005 * zc + 0.00601 * 2048 - 0.01884 * 2048)
    return off_r.astype(np.float32), off_c.astype(np.float32)


# ------------------------------------------------------------------ HiRISE MRGB
def read_mrgb_window(fr, f, margin_m=900.0):
    """Read the part of the MRGB mosaic that can cover the frame, reduced by factor f. Returns (rgb[3,h,w], col_off, row_off)."""
    e, s = frame_axes(fr)
    lon = site_lon(np.array([e.min(), e.max()]))
    lat = site_lat(np.array([s.min(), s.max()]))
    pad = margin_m / M_PX
    c0 = int(max(0, (lon.min() - M_W) / M_DLON - pad)) // f * f
    c1 = int(min(M_NC, (lon.max() - M_W) / M_DLON + pad)) // f * f
    r0 = int(max(0, (M_N - lat.max()) / M_DLAT - pad)) // f * f
    r1 = int(min(M_NR, (M_N - lat.min()) / M_DLAT + pad)) // f * f
    with rasterio.open(MRGB) as ds:
        arr = ds.read(window=Window(c0, r0, c1 - c0, r1 - r0), out_shape=(3, (r1 - r0) // f, (c1 - c0) // f))
    return arr, c0, r0


def mrgb_channels(arr, f, sigma_m):
    """luminance, blurred red/blue index, blurred colour-strip indicator, validity, all at MRGB reduced resolution."""
    a = arr.astype(np.float32)
    valid = (a.max(0) > 0).astype(np.float32)
    lum = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]
    cm = ((np.abs(a[0] - a[1]) + np.abs(a[1] - a[2]) > 2) & (valid > 0)).astype(np.float32)
    rho = (a[0] - a[2]) / (a[0] + a[2] + 1.0)
    sg = sigma_m / (M_PX * f)
    num = ndi.gaussian_filter(rho * cm, sg)
    den = ndi.gaussian_filter(cm, sg)
    return lum, num / np.maximum(den, 1e-4), den, valid


def sample_mrgb(chs, f, c_off, r_off, e, s, off_r, off_c):
    lon, lat = site_lon(e), site_lat(s)
    col = ((lon - M_W) / M_DLON - 0.5)[None, :] + off_c / M_PX
    row = ((M_N - lat) / M_DLAT - 0.5)[:, None] + off_r / M_PX
    kc = (col - c_off - (f - 1) / 2.0) / f
    kr = (row - r_off - (f - 1) / 2.0) / f
    return [ndi.map_coordinates(c, [kr, kc], order=1, mode="constant", cval=0.0).astype(np.float32) for c in chs]


def lowpass(x, sigma_m, fr):
    return ndi.gaussian_filter(x, (sigma_m * fr["ny"] / fr["h"], sigma_m * fr["nx"] / fr["w"]))


def band(x, s1, s2):
    return ndi.gaussian_filter(x, s1) - ndi.gaussian_filter(x, s2)


def register(name, fr, lum_old, z, mr):
    """Fit sample offsets (m) = c0 + cz*z + ce*e + cs*s for the MRGB product by tile phase correlation against the
    existing orthoimage. Works on an isotropic working grid."""
    arr, c_off, r_off, f = mr
    lum_m, rho_m, cm_m, val_m = mrgb_channels(arr, f, 1.0)
    iso, T = fr["iso"], fr["tile"]
    nxi, nyi = int(round(fr["w"] / iso)), int(round(fr["h"] / iso))
    ei = fr["e0"] + (np.arange(nxi) + 0.5) * iso
    si = fr["s0"] + (np.arange(nyi) + 0.5) * iso
    # existing orthoimage and heights on the working grid
    rr = ((si - fr["s0"]) / fr["h"] * fr["ny"] - 0.5)[:, None] + 0 * ei[None, :]
    cc = ((ei - fr["e0"]) / fr["w"] * fr["nx"] - 0.5)[None, :] + 0 * si[:, None]
    L_i = ndi.map_coordinates(ndi.gaussian_filter(lum_old, (max(0.0, iso * fr["ny"] / fr["h"] / 2), max(0.0, iso * fr["nx"] / fr["w"] / 2))),
                              [rr, cc], order=1, mode="nearest").astype(np.float32)
    z_i = ndi.map_coordinates(z, [rr, cc], order=1, mode="nearest").astype(np.float32)
    pr, pc = prior_offsets(z_i)
    model = None   # (cr, cc) coefficient vectors for [1, z, e, s]
    for it in range(3):
        if model is None:
            off_r, off_c = pr, pc
        else:
            X = np.stack([np.ones_like(z_i), z_i, ei[None, :] + 0 * z_i, si[:, None] + 0 * z_i], 0)
            off_r = np.tensordot(model[0], X, 1).astype(np.float32)
            off_c = np.tensordot(model[1], X, 1).astype(np.float32)
        lm, vm = sample_mrgb([lum_m, val_m], f, c_off, r_off, ei, si, off_r, off_c)
        g = max(1.0, 1.5 / iso)
        A = band(L_i, g, 12.0 / iso)
        B = band(lm, g, 12.0 / iso)
        w2 = np.outer(np.hanning(T), np.hanning(T)).astype(np.float32)
        rows = []
        for ty in range(0, nyi - T + 1, T // 2):
            for tx in range(0, nxi - T + 1, T // 2):
                if vm[ty:ty + T, tx:tx + T].min() < 0.5:
                    continue
                a_, b_ = A[ty:ty + T, tx:tx + T], B[ty:ty + T, tx:tx + T]
                if a_.std() < 1e-3 or b_.std() < 1e-3:
                    continue
                F = np.fft.fft2(a_ * w2) * np.conj(np.fft.fft2(b_ * w2))
                F /= np.abs(F) + 1e-9
                r = np.real(np.fft.ifft2(F))
                iy, ix = np.unravel_index(r.argmax(), r.shape)
                q = float(r.max())
                iy = iy - T if iy > T // 2 else iy
                ix = ix - T if ix > T // 2 else ix
                if q < 0.06:
                    continue
                cy, cx = ty + T // 2, tx + T // 2
                rows.append((ei[cx], si[cy], float(z_i[ty:ty + T, tx:tx + T].mean()), off_r[cy, cx] - iy * iso, off_c[cy, cx] - ix * iso, q))
        rows = np.array(rows)
        t_log("%s registration pass %d: %d usable tiles" % (name, it, len(rows)))
        if len(rows) < 12:
            raise RuntimeError("too few tiles to register the HiRISE colour strip (%s)" % name)
        X = np.c_[np.ones(len(rows)), rows[:, 2], rows[:, 0], rows[:, 1]]
        keep = np.ones(len(rows), bool)
        for _ in range(3):
            cr = np.linalg.lstsq(X[keep], rows[keep, 3], rcond=None)[0]
            ccf = np.linalg.lstsq(X[keep], rows[keep, 4], rcond=None)[0]
            res = np.hypot(X @ cr - rows[:, 3], X @ ccf - rows[:, 4])
            keep = res < max(3.0 * iso, 2.5 * np.median(res))
        model = (cr, ccf)
        t_log("   fit rms residual %.1f m (tiles kept %d), z terms: rows %.4f cols %.4f m/m" % (np.sqrt(np.mean(res[keep] ** 2)), keep.sum(), cr[1], ccf[1]))
    return model


# ------------------------------------------------------------------ Viking
def viking_fields():
    """Hue offset (deg), chroma ratio and a coverage weight on the Viking pixel grid. Valid pixels only, then low-passed."""
    v = np.asarray(Image.open(VIKING_PNG).convert("RGB")).astype(np.float64)
    lab = srgb8_to_lab(v)
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    C = np.hypot(a, b)
    h = np.degrees(np.arctan2(b, a))
    valid = (v.max(-1) < 235) & (L > 12) & (a > 2) & (b > 2) & (h < 75)
    valid = ndi.binary_opening(valid, iterations=1)
    # fill invalid pixels from the nearest valid ones, then low-pass (sigma 3 px, about 0.7 km)
    idx = ndi.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    ua, ub, Cf = (a / np.maximum(C, 1e-3))[tuple(idx)], (b / np.maximum(C, 1e-3))[tuple(idx)], C[tuple(idx)]
    sg = 3.0
    ua, ub, Cf = ndi.gaussian_filter(ua, sg), ndi.gaussian_filter(ub, sg), ndi.gaussian_filter(Cf, sg)
    hue = np.degrees(np.arctan2(ub, ua))
    return hue, Cf, valid


def sample_viking(field, lon, lat):
    ppd = 256.0
    col = ((lon - VIKING_BBOX[0]) * ppd - 0.5)[None, :] + 0 * lat[:, None]
    row = ((VIKING_BBOX[3] - lat) * ppd - 0.5)[:, None] + 0 * lon[None, :]
    return ndi.map_coordinates(field, [row, col], order=1, mode="nearest").astype(np.float32)


# ------------------------------------------------------------------ main
def smoothstep(x, lo, hi):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=UI)
    ap.add_argument("--suffix", default="", help="added before .png, for test variants")
    ap.add_argument("--no-hirise", action="store_true", help="Viking hue/saturation and a flat dust index only (comparison)")
    ap.add_argument("--only", choices=["core", "region"])
    args = ap.parse_args()

    for nm, fr in FRAMES.items():
        if args.only and nm != args.only:
            continue
        target = os.path.join(args.out_dir, fr["out"].replace(".png", args.suffix + ".png"))
        if os.path.abspath(target) == os.path.abspath(os.path.join(UI, fr["old"])):
            raise SystemExit("refusing to overwrite the old orthoimage")
    hue_v, c_v, valid_v = viking_fields()
    ref_win = (slice(int((-9.25 + 9.664) * 256), int(np.ceil((-9.25 + 10.14) * 256))), slice(int((289.958 - 289.5) * 256), int(np.ceil((290.115 - 289.5) * 256))))
    hue_ref = float(np.median(hue_v[ref_win]))
    c_ref = float(np.median(c_v[ref_win]))
    t_log("Viking regional medians: hue %.1f deg, chroma %.1f (valid fraction in box %.2f)" % (hue_ref, c_ref, valid_v[ref_win].mean()))

    params = {"viking_hue_ref_deg": hue_ref, "viking_chroma_ref": c_ref, "H_DUST": H_DUST, "K_DUST": K_DUST, "H_SAND": H_SAND, "K_SAND": K_SAND, "C_MAX": C_MAX, "C_OFF": C_OFF}
    calib = None   # (p5, p95, F curve) fitted on the core strip, reused for the region
    results = {}
    for nm in ("core", "region"):
        fr = FRAMES[nm]
        if args.only and nm != args.only and not (nm == "core" and not args.no_hirise):
            continue
        old = np.asarray(Image.open(os.path.join(UI, fr["old"])).convert("RGB"))
        assert old.shape[:2] == (fr["ny"], fr["nx"]), (nm, old.shape)
        Lo = lum_lstar(old)
        e, s = frame_axes(fr)
        lon, lat = site_lon(e), site_lat(s)
        t_log("%s: old ortho L* %.0f .. %.0f (median %.0f)" % (nm, Lo.min(), Lo.max(), np.median(Lo)))

        # ---- Viking regional offsets
        dh = np.clip(sample_viking(hue_v, lon, lat) - hue_ref, -8, 8)
        cs = np.clip(sample_viking(c_v, lon, lat) / c_ref, 0.85, 1.20)

        Llp = lowpass(Lo, 25.0, fr)
        t_l = None
        t_final = None
        strip_w = None
        if not args.no_hirise:
            f = fr["mread"]
            arr, c_off, r_off = read_mrgb_window(fr, f)
            t_log("%s: MRGB window %s read at 1/%d" % (nm, arr.shape, f))
            z = height_grid(nm, e, s)
            model = register(nm, fr, Lo, z, (arr, c_off, r_off, f))
            X = np.stack([np.ones_like(z), z, e[None, :] + 0 * z, s[:, None] + 0 * z], 0)
            off_r, off_c = np.tensordot(model[0], X, 1).astype(np.float32), np.tensordot(model[1], X, 1).astype(np.float32)
            lum_m, rho_m, cm_m, val_m = mrgb_channels(arr, f, 4.0)
            del arr
            lm, rho, cm, vm = sample_mrgb([lum_m, rho_m, cm_m, val_m], f, c_off, r_off, e, s, off_r, off_c)
            # local agreement of the registered MRGB brightness with the existing orthoimage
            A, B = band(Lo, 1.2, 10.0), band(lm, 1.2, 10.0)
            sg = 40.0
            ma, mb = lowpass(A, sg, fr), lowpass(B, sg, fr)
            cov = lowpass(A * B, sg, fr) - ma * mb
            va, vb = lowpass(A * A, sg, fr) - ma * ma, lowpass(B * B, sg, fr) - mb * mb
            corr = cov / np.sqrt(np.maximum(va * vb, 1e-9))
            strip = (cm > 0.6) & (vm > 0.9)
            strip_in = ndi.binary_erosion(strip, iterations=max(1, int(round(12.0 * fr["nx"] / fr["w"]))))
            agree = smoothstep(corr, 0.30, 0.55)
            w = lowpass(strip_in.astype(np.float32), 30.0, fr) * agree
            w = np.where(strip_in, np.maximum(w, 0.0), w) * (lowpass(strip.astype(np.float32), 30.0, fr) > 0.5)
            t_log("%s: strip covers %.1f%% of the frame, usable (registered, correlated) %.1f%%, mean corr in strip %.2f" % (
                nm, 100 * strip.mean(), 100 * (w > 0.5).mean(), float(corr[strip_in].mean()) if strip_in.any() else float("nan")))
            if calib is None:
                p5, p95 = np.percentile(rho[strip_in & (corr > 0.5)], [5, 95])
                tH = np.clip((rho - p5) / (p95 - p5), 0, 1)
                msk = strip_in & (corr > 0.5)
                # F: monotone relation between smoothed brightness and t, medians in 24 quantile bins
                edges = np.percentile(Llp[msk], np.linspace(0, 100, 25))
                xs, ys = [], []
                for k in range(24):
                    m = msk & (Llp >= edges[k]) & (Llp <= edges[k + 1])
                    if m.sum() > 500:
                        xs.append(float(np.median(Llp[m])))
                        ys.append(float(np.median(tH[m])))
                ys = np.maximum.accumulate(np.array(ys))
                calib = (float(p5), float(p95), np.array(xs), ys)
                params["hirise_rho_p5"], params["hirise_rho_p95"] = float(p5), float(p95)
                params["F_L_to_t"] = {"L": calib[2].round(2).tolist(), "t": calib[3].round(3).tolist()}
                t_log("core strip: rho p5 %.3f p95 %.3f; F(L): %s" % (p5, p95, list(zip(calib[2].round(0), calib[3].round(2)))[::4]))
            p5, p95, xs, ys = calib
            tH = np.clip((rho - p5) / (p95 - p5), 0, 1)
            t_l = np.interp(Llp, xs, ys).astype(np.float32)
            t_final = t_l + w * (tH - t_l)
            strip_w = w
        else:
            if calib is None:
                calib = True
            t_final = np.full(Lo.shape, 0.5, np.float32) + 0.0 * Lo

        # ---- colour
        t = np.clip(t_final, 0, 1)
        hue = np.radians(H_SAND + t * (H_DUST - H_SAND) + dh)
        kap = (K_SAND + t * (K_DUST - K_SAND)) * cs
        Cst = C_MAX * np.tanh((C_OFF + kap * Lo) / C_MAX)
        out = lab_to_srgb_gamut(Lo, (Cst * np.cos(hue)).astype(np.float32), (Cst * np.sin(hue)).astype(np.float32))
        L_new = lum_lstar(out)
        t_log("%s: L* change after gamut fit: mean abs %.2f, p99 %.2f" % (nm, float(np.abs(L_new - Lo).mean()), float(np.percentile(np.abs(L_new - Lo), 99))))
        os.makedirs(args.out_dir, exist_ok=True)
        path = os.path.join(args.out_dir, fr["out"].replace(".png", args.suffix + ".png"))
        Image.fromarray(out).save(path, optimize=False)
        t_log("%s written: %s (%dx%d)" % (nm, path, out.shape[1], out.shape[0]))
        results[nm] = (old, out)
        if strip_w is not None:
            params[nm + "_strip_usable_fraction"] = float((strip_w > 0.5).mean())

    # ---- preview: old vs new, downsized
    if len(results) == 2:
        def small(a, size):
            return Image.fromarray(a).resize(size, Image.LANCZOS)
        parts = [small(results["core"][0], (640, 640)), small(results["core"][1], (640, 640)),
                 small(results["region"][0], (200, 800)), small(results["region"][1], (200, 800))]
        sheet = Image.new("RGB", (640 * 2 + 200 * 2 + 30, 800), (24, 24, 24))
        xx = 0
        for p in parts:
            sheet.paste(p, (xx, 0))
            xx += p.size[0] + 10
        sheet.save(os.path.join(COL, "preview_old_vs_new" + args.suffix + ".png"))
        with open(os.path.join(COL, "ortho_colour_params" + args.suffix + ".json"), "w", encoding="utf8") as fh:
            json.dump(params, fh, indent=1)
        t_log("preview written")


if __name__ == "__main__":
    main()
