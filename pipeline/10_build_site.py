"""Build every static terrain/hazard asset the web app needs, from NASA/USGS source rasters.

Inputs (public, see REFERENCES.md):
  * MRO HiRISE DTM  DTEEC_028857_1700_028923_1700_A01 (1 m)  + RED orthoimage (1 m)   [USGS STAC, CC0]
  * MRO CTX   DTM   D04_028857_1684 / D04_028923_1684 (20 m) + orthoimage             [USGS STAC, CC0]

Outputs (app/public/data/site/):
  far_*   : CTX context, 80 m cells            (backdrop: 5 km canyon wall up to the plateau)
  reg_*   : HiRISE+CTX merged "region", 16 m   (rockfall sources / runout, mid-distance render)
  core_*  : HiRISE EVA box 4 x 4 km            (2.5 m render heights, 5 m analysis layers)
  meta.json

Local frame: e = metres east, s = metres south of the HiRISE DTM bbox top-left corner, true ground
metres at latitude LAT0 (the source rasters are equirectangular with lat_ts = 0, so x is scaled
by cos(LAT0)).

Everything derived here is a MODEL of the hazard, not a measurement; the app labels it as such.
"""
import gzip, json, math, os, sys, time
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling
from affine import Affine
from numba import njit, prange
from scipy import ndimage as ndi
from PIL import Image

t00 = time.time()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "app", "public", "data", "site")
os.makedirs(OUT, exist_ok=True)
PREV = os.path.join(ROOT, "data_raw", "preview")
os.makedirs(PREV, exist_ok=True)

RM = 3396190.0
LAT0 = -10.0
C = math.cos(math.radians(LAT0))
HI_DTM = os.path.join(ROOT, "data_raw", "hirise", "DTEEC_028857_1700_028923_1700_A01.tif")
HI_RED = os.path.join(ROOT, "data_raw", "hirise", "ESP_028857_1700_RED_C_01_ORTHO.tif")
CTX = ("/vsicurl/https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/"
       "D04_028857_1684_XN_11S069W__D04_028923_1684_XN_11S069W/D04_028857_1684_XN_11S069W__D04_028923_1684_XN_11S069W")

with rasterio.open(HI_DTM) as ds:
    X0, Y0 = ds.bounds.left, ds.bounds.top          # projected origin of the local frame

# ----------------------------------------------------------------------------- grids
CORE = dict(e0=1650.0, s0=6600.0, size=4000.0)       # EVA box (local metres)
CORE_RENDER = 2.5                                     # m, render height grid (1601^2 vertices)
CORE_CELL = 5.0                                       # m, analysis grid (800^2)
REG = dict(e0=-1008.0, s0=-12000.0, w=9216.0, h=28224.0, cell=16.0)    # 576 x 1764
FAR = dict(e0=-18000.0, s0=-32000.0, w=56000.0, h=68000.0, cell=80.0)  # 700 x 850
SRC_SLOPE = 32.0                                      # deg: rockfall source threshold
ALPHAS = [12.0, 14.0, 16.2, 18.4, 20.0, 21.8, 24.0, 26.0, 27.8, 29.5, 31.4, 33.0, 34.8, 37.0]


def warp(path, e0, s0, ncol, nrow, cell, resampling, band=1, scale=True):
    """Affine resample of a source raster into the local frame (true metres)."""
    dst = np.full((nrow, ncol), np.nan, np.float32)
    with rasterio.open(path) as ds:
        # destination pixel grid expressed in the source CRS: X = X0 + e / C, Y = Y0 - s
        dstT = Affine(cell / C, 0, X0 + e0 / C, 0, -cell, Y0 - s0)
        reproject(source=rasterio.band(ds, band), destination=dst, src_transform=ds.transform, src_crs=ds.crs,
                  dst_transform=dstT, dst_crs=ds.crs, resampling=resampling,
                  src_nodata=ds.nodata, dst_nodata=np.nan, num_threads=8)
        if scale and (ds.scales[band - 1] != 1.0 or ds.offsets[band - 1] != 0.0):
            dst = dst * ds.scales[band - 1] + ds.offsets[band - 1]
    return dst


def fill_nan(a, max_iter=400):
    """Fill voids by iterative neighbourhood averaging (smooth inpainting)."""
    a = a.copy()
    mask = ~np.isfinite(a)
    if not mask.any():
        return a
    idx = ndi.distance_transform_edt(mask, return_distances=False, return_indices=True)
    a[mask] = a[tuple(i[mask] for i in idx)]          # nearest-valid seed
    for _ in range(40):                               # relax the seeded area
        sm = ndi.uniform_filter(a, 5, mode="nearest")
        a[mask] = sm[mask]
    return a


def slope_deg(z, cell):
    gy, gx = np.gradient(z.astype(np.float64), cell)
    return np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)


def save_gz(name, arr):
    p = os.path.join(OUT, name)
    with gzip.open(p, "wb", compresslevel=7) as f:
        f.write(np.ascontiguousarray(arr).tobytes())
    return os.path.getsize(p)


def quant16(z):
    lo, hi = float(np.floor(np.nanmin(z))), float(np.ceil(np.nanmax(z)))
    q = np.round((z - lo) / (hi - lo) * 65535.0).astype(np.uint16)
    return q, lo, hi


# ----------------------------------------------------------------------------- 1. heights
print("[1] warping heights ...", flush=True)
rw, rh = int(REG["w"] / REG["cell"]), int(REG["h"] / REG["cell"])
fw, fh = int(FAR["w"] / FAR["cell"]), int(FAR["h"] / FAR["cell"])
cn = int(CORE["size"] / CORE_RENDER) + 1               # 1601 vertices
ca = int(CORE["size"] / CORE_CELL)                     # 800 analysis cells

far_ctx = warp(CTX + "_dtm.tif", FAR["e0"], FAR["s0"], fw, fh, FAR["cell"], Resampling.average)
reg_ctx = warp(CTX + "_dtm.tif", REG["e0"], REG["s0"], rw, rh, REG["cell"], Resampling.bilinear)
reg_hi = warp(HI_DTM, REG["e0"], REG["s0"], rw, rh, REG["cell"], Resampling.average)
print("   far valid %.1f%%  reg ctx valid %.1f%%  reg hirise valid %.1f%%" % (
    100 * np.isfinite(far_ctx).mean(), 100 * np.isfinite(reg_ctx).mean(), 100 * np.isfinite(reg_hi).mean()))

both = np.isfinite(reg_ctx) & np.isfinite(reg_hi)
off = float(np.nanmedian(reg_hi[both] - reg_ctx[both]))
rms = float(np.sqrt(np.nanmean((reg_hi[both] - reg_ctx[both] - off) ** 2)))
print("   HiRISE - CTX vertical offset: median %.1f m, residual RMS %.1f m" % (off, rms))

reg_ctx_f = fill_nan(reg_ctx) + off
hi_ok = np.isfinite(reg_hi)
d_in = ndi.distance_transform_edt(hi_ok) * REG["cell"]
w = np.clip(d_in / 320.0, 0, 1) ** 2 * (3 - 2 * np.clip(d_in / 320.0, 0, 1))   # smoothstep feather 320 m
reg_z = np.where(hi_ok, w * np.nan_to_num(reg_hi) + (1 - w) * reg_ctx_f, reg_ctx_f).astype(np.float32)

far_valid = np.isfinite(far_ctx)
far_z = fill_nan(far_ctx) + off
# keep far consistent with region where they overlap (resample region into far cells)
far_alpha = ndi.gaussian_filter(far_valid.astype(np.float32), 2.0)
far_alpha = np.clip((far_alpha - 0.5) * 2.4, 0, 1)                       # soft edge of CTX footprint

# core render heights straight from the 1 m HiRISE DTM
dstT_e0 = CORE["e0"] - CORE_RENDER / 2                 # vertices sit on cell centres of a 2.5 m raster
core_z = warp(HI_DTM, dstT_e0, CORE["s0"] - CORE_RENDER / 2, cn, cn, CORE_RENDER, Resampling.average)
nv = int((~np.isfinite(core_z)).sum())
print("   core render grid %dx%d, voids: %d" % (cn, cn, nv))
if nv:
    # fill from region grid (bilinear upsample) where HiRISE has no data
    yy, xx = np.mgrid[0:cn, 0:cn]
    re = (CORE["e0"] + xx * CORE_RENDER - REG["e0"]) / REG["cell"] - 0.5
    rs = (CORE["s0"] + yy * CORE_RENDER - REG["s0"]) / REG["cell"] - 0.5
    up = ndi.map_coordinates(reg_z, [rs, re], order=1, mode="nearest")
    core_z = np.where(np.isfinite(core_z), core_z, up).astype(np.float32)

# 1 m heights of the core for slope / roughness (4000^2)
print("[2] core 1 m analysis ...", flush=True)
n1 = int(CORE["size"])
z1 = warp(HI_DTM, CORE["e0"], CORE["s0"], n1, n1, 1.0, Resampling.bilinear)
if (~np.isfinite(z1)).any():
    z1 = fill_nan(z1)
# slope over a ~3 m baseline: smooth to 3 m then gradient
z3 = ndi.uniform_filter(z1, 3, mode="nearest")
s1 = slope_deg(z3, 1.0)
k = int(CORE_CELL)
blk = lambda a, f: f(a.reshape(ca, k, ca, k), axis=(1, 3))
core_slope_mean = blk(s1, np.mean)
core_slope_p = np.percentile(s1.reshape(ca, k, ca, k).transpose(0, 2, 1, 3).reshape(ca, ca, k * k), 90, axis=2).astype(np.float32)
resid = z1 - ndi.uniform_filter(z1, 9, mode="nearest")
core_rough = np.sqrt(blk(resid ** 2, np.mean)).astype(np.float32)        # m RMS at <9 m wavelength
core_za = blk(z1, np.mean).astype(np.float32)                            # 5 m mean height
print("   slope p90 per 5 m cell: median %.1f deg, >20: %.1f%%, >32: %.1f%%; roughness median %.2f m" % (
    np.median(core_slope_p), 100 * (core_slope_p > 20).mean(), 100 * (core_slope_p > 32).mean(), np.median(core_rough)))
del z3, resid

# ----------------------------------------------------------------------------- 3. rockfall reach-angle field
print("[3] rockfall energy-line cones ...", flush=True)


@njit(cache=True)
def cone_sweep(z, src, tan_a, cell, n_iter):
    """E(x) = max over sources s of ( z_s - tan(alpha) * dist(s, x) ).
    Two-pass chamfer propagation (5x5 mask: 8 neighbours + knight moves)."""
    H, W = z.shape
    E = np.full((H, W), -1e9, np.float32)
    for i in range(H):
        for j in range(W):
            if src[i, j]:
                E[i, j] = z[i, j]
    d1 = cell * tan_a
    d2 = cell * 1.41421356 * tan_a
    d3 = cell * 2.23606798 * tan_a
    for it in range(n_iter):
        for i in range(H):
            for j in range(W):
                e = E[i, j]
                if j > 0 and E[i, j - 1] - d1 > e: e = E[i, j - 1] - d1
                if i > 0:
                    if E[i - 1, j] - d1 > e: e = E[i - 1, j] - d1
                    if j > 0 and E[i - 1, j - 1] - d2 > e: e = E[i - 1, j - 1] - d2
                    if j < W - 1 and E[i - 1, j + 1] - d2 > e: e = E[i - 1, j + 1] - d2
                    if j > 1 and E[i - 1, j - 2] - d3 > e: e = E[i - 1, j - 2] - d3
                    if j < W - 2 and E[i - 1, j + 2] - d3 > e: e = E[i - 1, j + 2] - d3
                if i > 1:
                    if j > 0 and E[i - 2, j - 1] - d3 > e: e = E[i - 2, j - 1] - d3
                    if j < W - 1 and E[i - 2, j + 1] - d3 > e: e = E[i - 2, j + 1] - d3
                E[i, j] = e
        for i in range(H - 1, -1, -1):
            for j in range(W - 1, -1, -1):
                e = E[i, j]
                if j < W - 1 and E[i, j + 1] - d1 > e: e = E[i, j + 1] - d1
                if i < H - 1:
                    if E[i + 1, j] - d1 > e: e = E[i + 1, j] - d1
                    if j > 0 and E[i + 1, j - 1] - d2 > e: e = E[i + 1, j - 1] - d2
                    if j < W - 1 and E[i + 1, j + 1] - d2 > e: e = E[i + 1, j + 1] - d2
                    if j > 1 and E[i + 1, j - 2] - d3 > e: e = E[i + 1, j - 2] - d3
                    if j < W - 2 and E[i + 1, j + 2] - d3 > e: e = E[i + 1, j + 2] - d3
                if i < H - 2:
                    if j > 0 and E[i + 2, j - 1] - d3 > e: e = E[i + 2, j - 1] - d3
                    if j < W - 1 and E[i + 2, j + 1] - d3 > e: e = E[i + 2, j + 1] - d3
                E[i, j] = e
    return E


def reach_angle(Es, z, alphas):
    """beta(x) = steepest energy-line angle alpha for which a boulder still reaches x (deg);
    0 where even the shallowest cone does not reach. Linear interpolation between sampled alphas."""
    beta = np.zeros(z.shape, np.float32)
    margin = [E - z for E in Es]                       # >= 0  -> reached at this alpha
    reached_prev = margin[0] >= 0
    beta[reached_prev] = alphas[0]
    for i in range(1, len(alphas)):
        r = margin[i] >= 0
        beta[r] = alphas[i]
        cross = reached_prev & ~r                      # reached at alphas[i-1] but not at alphas[i]
        m0, m1 = margin[i - 1][cross], margin[i][cross]
        t = m0 / np.maximum(m0 - m1, 1e-6)
        beta[cross] = alphas[i - 1] + t * (alphas[i] - alphas[i - 1])
        reached_prev = r
    return beta


@njit(cache=True)
def talus_apex(z, src, cell, L):
    """Shadow-angle method: the energy line starts at the *talus apex*, i.e. at the lowest
    source cells of each flow line. A source cell is an apex when no other source cell lies
    within L metres further down its steepest-descent (D8) path."""
    H, W = z.shape
    order = np.argsort(z.ravel())
    dnext = np.full(H * W, 1e9, np.float32)        # path distance to the next source cell below
    apex = np.zeros((H, W), np.bool_)
    for idx in order:
        i = idx // W; j = idx % W
        best = 0.0; bi = -1; bj = -1; bstep = 0.0
        for di in range(-1, 2):
            for dj in range(-1, 2):
                if di == 0 and dj == 0: continue
                a = i + di; b = j + dj
                if a < 0 or a >= H or b < 0 or b >= W: continue
                step = cell * (1.41421356 if (di != 0 and dj != 0) else 1.0)
                g = (z[i, j] - z[a, b]) / step
                if g > best:
                    best = g; bi = a; bj = b; bstep = step
        if bi >= 0:
            r = bi * W + bj
            dnext[idx] = bstep if src[bi, bj] else dnext[r] + bstep
        if src[i, j] and dnext[idx] > L:
            apex[i, j] = True
    return apex


reg_slope = slope_deg(reg_z, REG["cell"])
reg_srczone = reg_slope >= SRC_SLOPE
core_srczone = core_slope_mean >= SRC_SLOPE
# Reach angles (Fahrboeschung) in the literature we cite are measured from the SOURCE to the stop
# point (Terra Sirenum 27.8-34.8 deg, Jezero mean 21.8, Moon mean 18.4), so every source cell
# emits a cone. (talus_apex() is kept for the shadow-angle variant, exported as a second field.)
reg_src = reg_srczone
core_src = core_srczone
reg_apex = talus_apex(reg_z, reg_srczone, REG["cell"], 300.0)
print("   source zone: %.1f%% of region (%d cells, %d talus-apex cells); core source zone %.1f%%" % (
    100 * reg_srczone.mean(), reg_srczone.sum(), reg_apex.sum(), 100 * core_srczone.mean()))
# upsample helpers region -> core analysis grid
yy, xx = np.mgrid[0:ca, 0:ca]
c2r_e = (CORE["e0"] + (xx + 0.5) * CORE_CELL - REG["e0"]) / REG["cell"] - 0.5
c2r_s = (CORE["s0"] + (yy + 0.5) * CORE_CELL - REG["s0"]) / REG["cell"] - 0.5
Es_reg, Es_core = [], []
for a in ALPHAS:
    ta = math.tan(math.radians(a))
    Er = cone_sweep(reg_z, reg_src, ta, REG["cell"], 2)
    Ec_local = cone_sweep(core_za, core_src, ta, CORE_CELL, 2)
    Ec_far = ndi.map_coordinates(Er, [c2r_s, c2r_e], order=1, mode="nearest")
    Es_reg.append(Er)
    Es_core.append(np.maximum(Ec_local, Ec_far))
reg_beta = reach_angle(Es_reg, reg_z, ALPHAS)
core_beta = reach_angle(Es_core, core_za, ALPHAS)
for a in (18.4, 21.8, 27.8, 31.4, 34.8):
    print("   alpha %.1f deg: band covers %.1f%% of core, %.1f%% of region" % (
        a, 100 * (core_beta >= a).mean(), 100 * (reg_beta >= a).mean()))
del Es_reg, Es_core

# ----------------------------------------------------------------------------- 4. sky obstruction (terrain shielding)
print("[4] horizon / blocked-sky fraction ...", flush=True)


@njit(cache=True)
def bil(a, r, c):
    H, W = a.shape
    if r < 0: r = 0.0
    if c < 0: c = 0.0
    if r > H - 1.001: r = H - 1.001
    if c > W - 1.001: c = W - 1.001
    i = int(r); j = int(c); fr = r - i; fc = c - j
    return (a[i, j] * (1 - fr) * (1 - fc) + a[i, j + 1] * (1 - fr) * fc +
            a[i + 1, j] * fr * (1 - fc) + a[i + 1, j + 1] * fr * fc)


@njit(parallel=True, cache=True)
def sky_blocked(core, ccell, ce0, cs0, reg, rcell, re0, rs0, far, fcell, fe0, fs0, naz, eye):
    """Fraction of the sky hemisphere (solid angle) hidden by terrain, per core cell.
    blocked = mean_az( sin(horizon_elevation) ); also returns the mean horizon elevation north half."""
    n = core.shape[0]
    out = np.zeros((n, n), np.float32)
    csize = n * ccell
    rW = reg.shape[1] * rcell; rH = reg.shape[0] * rcell
    fW = far.shape[1] * fcell; fH = far.shape[0] * fcell
    for i in prange(n):
        for j in range(n):
            e = ce0 + (j + 0.5) * ccell
            s = cs0 + (i + 0.5) * ccell
            z0 = core[i, j] + eye
            acc = 0.0
            for a in range(naz):
                th = 2 * math.pi * a / naz
                de = math.sin(th); dn = math.cos(th)
                best = 0.0
                d = ccell
                while d < 30000.0:
                    pe = e + de * d
                    ps = s - dn * d
                    if pe >= ce0 and pe < ce0 + csize and ps >= cs0 and ps < cs0 + csize:
                        zz = bil(core, (ps - cs0) / ccell - 0.5, (pe - ce0) / ccell - 0.5)
                    elif pe >= re0 and pe < re0 + rW and ps >= rs0 and ps < rs0 + rH:
                        zz = bil(reg, (ps - rs0) / rcell - 0.5, (pe - re0) / rcell - 0.5)
                    elif pe >= fe0 and pe < fe0 + fW and ps >= fs0 and ps < fs0 + fH:
                        zz = bil(far, (ps - fs0) / fcell - 0.5, (pe - fe0) / fcell - 0.5)
                    else:
                        break
                    t = (zz - z0) / d
                    if t > best: best = t
                    d *= 1.18
                acc += best / math.sqrt(1 + best * best)          # sin(atan(t))
            out[i, j] = acc / naz
    return out


core_sky = sky_blocked(core_za, CORE_CELL, CORE["e0"], CORE["s0"], reg_z, REG["cell"], REG["e0"], REG["s0"],
                       far_z.astype(np.float32), FAR["cell"], FAR["e0"], FAR["s0"], 32, 1.6)
print("   blocked-sky fraction: min %.3f median %.3f p95 %.3f max %.3f" % (
    core_sky.min(), np.median(core_sky), np.percentile(core_sky, 95), core_sky.max()))

# ----------------------------------------------------------------------------- 5. closed depressions (pits)
print("[5] closed depressions ...", flush=True)
import heapq


def priority_flood(z):
    H, W = z.shape
    filled = z.copy(); done = np.zeros(z.shape, bool); pq = []
    for i in range(H):
        for j in (0, W - 1):
            heapq.heappush(pq, (float(z[i, j]), i, j)); done[i, j] = True
    for j in range(W):
        for i in (0, H - 1):
            if not done[i, j]:
                heapq.heappush(pq, (float(z[i, j]), i, j)); done[i, j] = True
    while pq:
        h, i, j = heapq.heappop(pq)
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            a, b = i + di, j + dj
            if 0 <= a < H and 0 <= b < W and not done[a, b]:
                done[a, b] = True
                v = max(float(z[a, b]), h); filled[a, b] = v
                heapq.heappush(pq, (v, a, b))
    return filled


# run at 10 m to keep it quick, upsample
z10 = core_za.reshape(ca // 2, 2, ca // 2, 2).mean(axis=(1, 3))
pit10 = priority_flood(z10) - z10
core_pit = np.kron(pit10, np.ones((2, 2), np.float32)).astype(np.float32)
print("   depressions >= 1.5 m deep: %.2f%% of core; max depth %.1f m" % (100 * (core_pit >= 1.5).mean(), core_pit.max()))

# ----------------------------------------------------------------------------- 6. orthoimages
print("[6] orthoimages ...", flush=True)


def tone(a, lo, hi, gamma=0.62):
    """Global tone curve shared by all three orthos: gamma lift for the dark canyon floor,
    soft shoulder so the bright dusty wall does not clip."""
    x = np.clip((a - lo) / (hi - lo), 0, None)
    v = (1.0 - np.exp(-1.9 * x)) / (1.0 - math.exp(-1.9))
    return np.clip(v, 0, 1.08) ** gamma / 1.08 ** gamma


def mars_colour(v, relief=None):
    """Approximate Mars palette for a single-band (RED) reflectance image. NOT true colour."""
    dark = np.array([0.105, 0.062, 0.045]); mid = np.array([0.56, 0.335, 0.215]); bright = np.array([0.93, 0.74, 0.56])
    v = v[..., None]
    lowmix = np.clip(v / 0.55, 0, 1); himix = np.clip((v - 0.55) / 0.45, 0, 1)
    rgb = dark + (mid - dark) * lowmix + (bright - mid) * himix
    return (np.clip(rgb, 0, 1) * 255).astype(np.uint8)


ORTHO_N = 4096
core_red = warp(HI_RED, CORE["e0"], CORE["s0"], ORTHO_N, ORTHO_N, CORE["size"] / ORTHO_N, Resampling.cubic)
ok = np.isfinite(core_red) & (core_red > 0.064)
lo = float(np.percentile(core_red[ok], 0.3))
with rasterio.open(HI_RED) as _ds:      # global white point from the whole HiRISE strip (decimated)
    _a = _ds.read(1, out_shape=(_ds.height // 16, _ds.width // 16)).astype(np.float32)
    _a = _a[_a > 0] * _ds.scales[0] + _ds.offsets[0]
hi = float(np.percentile(_a, 99.5))
print("   ortho I/F black %.4f white %.4f (core p99.8 %.4f), valid %.1f%%" % (lo, hi, np.percentile(core_red[ok], 99.8), 100 * ok.mean()))
core_v = tone(np.where(ok, core_red, lo), lo, hi)
Image.fromarray(mars_colour(core_v)).save(os.path.join(OUT, "core_ortho.webp"), quality=88, method=6)
core_albedo5 = core_v.reshape(ca, ORTHO_N // ca, ca, ORTHO_N // ca).mean(axis=(1, 3)) if ORTHO_N % ca == 0 else \
    np.asarray(Image.fromarray((core_v * 255).astype(np.uint8)).resize((ca, ca), Image.BOX), np.float32) / 255

# region ortho at 4 m: HiRISE where valid, CTX elsewhere (histogram matched)
RO = 4.0
rw4, rh4 = int(REG["w"] / RO), int(REG["h"] / RO)
reg_red = warp(HI_RED, REG["e0"], REG["s0"], rw4, rh4, RO, Resampling.average)
reg_cx = warp(CTX + "_orthoimage.tif", REG["e0"], REG["s0"], rw4, rh4, RO, Resampling.cubic)
okh = np.isfinite(reg_red) & (reg_red > 0.064); okc = np.isfinite(reg_cx)
bo = okh & okc
# linear match CTX -> HiRISE in the overlap
A = np.polyfit(reg_cx[bo][::50], reg_red[bo][::50], 1)
print("   CTX->HiRISE radiometric fit: gain %.3f offset %.3f" % (A[0], A[1]))
cx_m = np.where(okc, reg_cx * A[0] + A[1], np.nan)
cx_m = fill_nan(cx_m)
dh = ndi.distance_transform_edt(okh) * RO
wh = np.clip(dh / 200.0, 0, 1)
reg_mix = np.where(okh, wh * np.nan_to_num(reg_red) + (1 - wh) * cx_m, cx_m)
reg_v = tone(reg_mix, lo, hi)
Image.fromarray(mars_colour(reg_v)).save(os.path.join(OUT, "reg_ortho.webp"), quality=84, method=6)

# far ortho at 40 m
FO = 40.0
fw4, fh4 = int(FAR["w"] / FO), int(FAR["h"] / FO)
far_cx = warp(CTX + "_orthoimage.tif", FAR["e0"], FAR["s0"], fw4, fh4, FO, Resampling.average)
okf = np.isfinite(far_cx)
far_m = fill_nan(np.where(okf, far_cx * A[0] + A[1], np.nan))
far_v = tone(far_m, lo, hi)
far_rgb = mars_colour(far_v)
fa = np.asarray(Image.fromarray((far_alpha * 255).astype(np.uint8)).resize((fw4, fh4), Image.BILINEAR))
Image.fromarray(np.dstack([far_rgb, fa])).save(os.path.join(OUT, "far_ortho.webp"), quality=84, method=6)

# loose-sand likelihood (photogeologic PROXY, not validated): dark + smooth + gentle surfaces
alb_s = ndi.gaussian_filter(core_albedo5, 2.0)
a_lo, a_hi = np.percentile(alb_s, 12), np.percentile(alb_s, 45)
dark = 1.0 - np.clip((alb_s - a_lo) / (a_hi - a_lo), 0, 1)
gentle = 1.0 - np.clip((core_slope_mean - 6.0) / 8.0, 0, 1)
smooth = 1.0 - np.clip((core_rough - 0.12) / 0.15, 0, 1)
core_sand = ndi.gaussian_filter(dark * gentle * smooth, 1.5).astype(np.float32)
print("   loose-sand proxy > 0.5 on %.1f%% of core" % (100 * (core_sand > 0.5).mean()))

# ----------------------------------------------------------------------------- 7. write binaries
print("[7] writing ...", flush=True)
sizes = {}
cq, clo, chi = quant16(core_z); sizes["core_h.bin.gz"] = save_gz("core_h.bin.gz", cq)
rq, rlo, rhi = quant16(reg_z); sizes["reg_h.bin.gz"] = save_gz("reg_h.bin.gz", rq)
fq, flo, fhi = quant16(far_z); sizes["far_h.bin.gz"] = save_gz("far_h.bin.gz", fq)

u8 = lambda a, s: np.clip(np.round(a * s), 0, 255).astype(np.uint8)
layers = dict(
    slope=u8(core_slope_p, 3.0),        # deg * 3  (p90 of 1 m slope inside the 5 m cell)
    slope_mean=u8(core_slope_mean, 3.0),
    rough=u8(core_rough, 100.0),        # cm RMS
    beta=u8(core_beta, 6.0),            # deg * 6  (rockfall reach angle; 0 = never reached)
    sky=u8(core_sky, 255.0),            # blocked-sky fraction * 255
    pit=u8(core_pit, 10.0),             # dm depth of closed depression
    albedo=u8(core_albedo5, 255.0),     # tone-mapped RED reflectance (for surface-type proxy)
    sand=u8(core_sand, 255.0),          # loose-sand likelihood proxy
)
order = list(layers.keys())
sizes["core_layers.bin.gz"] = save_gz("core_layers.bin.gz", np.stack([layers[k] for k in order]))
sizes["reg_layers.bin.gz"] = save_gz("reg_layers.bin.gz", np.stack([u8(reg_slope, 3.0), u8(reg_beta, 6.0)]))

meta = dict(
    site="NE Melas Chasma wall & floor (northern edge of the East Melas Exploration Zone)",
    lat0=LAT0, radius=RM,
    origin=dict(projX=X0, projY=Y0, lon=math.degrees(X0 / RM), lat=math.degrees(Y0 / RM),
                note="local e = (X - projX) * cos(lat0), s = projY - Y  (metres east / south)"),
    core=dict(e0=CORE["e0"], s0=CORE["s0"], size=CORE["size"], renderCell=CORE_RENDER, n=cn,
              cell=CORE_CELL, na=ca, zMin=clo, zMax=chi, layers=order,
              scale=dict(slope=3.0, slope_mean=3.0, rough=100.0, beta=6.0, sky=255.0, pit=10.0, albedo=255.0, sand=255.0),
              ortho="core_ortho.webp", orthoPx=ORTHO_N,
              centerLon=math.degrees((X0 + (CORE["e0"] + CORE["size"] / 2) / C) / RM),
              centerLat=math.degrees((Y0 - (CORE["s0"] + CORE["size"] / 2)) / RM)),
    reg=dict(e0=REG["e0"], s0=REG["s0"], w=REG["w"], h=REG["h"], cell=REG["cell"], nx=rw, ny=rh,
             zMin=rlo, zMax=rhi, layers=["slope", "beta"], ortho="reg_ortho.webp", orthoCell=RO),
    far=dict(e0=FAR["e0"], s0=FAR["s0"], w=FAR["w"], h=FAR["h"], cell=FAR["cell"], nx=fw, ny=fh,
             zMin=flo, zMax=fhi, ortho="far_ortho.webp", orthoCell=FO),
    rockfall=dict(sourceSlopeDeg=SRC_SLOPE, alphas=ALPHAS, apexSearchM=300.0,
                  method="energy-line cone from every source cell (CONEFALL-style reach angle), chamfer sweep"),
    ctxOffsetM=off, ctxResidualRmsM=rms,
    sources=dict(
        hirise_dtm="DTEEC_028857_1700_028923_1700_A01 (USGS Astrogeology STAC mro_hirise_socet_dtms, CC0); credit NASA/JPL/University of Arizona/USGS",
        hirise_ortho="ESP_028857_1700_RED_C_01_ORTHO (1 m); credit NASA/JPL/University of Arizona",
        ctx_dtm="D04_028857_1684_XN_11S069W / D04_028923_1684_XN_11S069W (USGS STAC mro_ctx_controlled_usgs_dtms, CC0); credit NASA/JPL/MSSS/USGS"),
    sizes=sizes,
)
json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)

# previews for a human check
def pv(a, name, lo=None, hi=None):
    lo = np.nanmin(a) if lo is None else lo; hi = np.nanmax(a) if hi is None else hi
    Image.fromarray((np.clip((a - lo) / (hi - lo + 1e-9), 0, 1) * 255).astype(np.uint8)).save(os.path.join(PREV, name))
pv(core_beta, "core_beta.png", 0, 37); pv(core_sky, "core_sky.png", 0, 0.5); pv(core_slope_p, "core_slope.png", 0, 45)
pv(core_pit, "core_pit.png", 0, 5); pv(core_rough, "core_rough.png", 0, 1.0); pv(reg_beta, "reg_beta.png", 0, 37)
pv(reg_z, "reg_z.png"); pv(far_z, "far_z.png"); pv(core_za, "core_z.png")
np.savez_compressed(os.path.join(ROOT, "data_raw", "core_analysis.npz"), z=core_za, slope=core_slope_p, slope_mean=core_slope_mean,
                    rough=core_rough, beta=core_beta, sky=core_sky, pit=core_pit, albedo=core_albedo5, sand=core_sand)
np.savez_compressed(os.path.join(ROOT, "data_raw", "reg_analysis.npz"), z=reg_z, slope=reg_slope, beta=reg_beta)
print("sizes:", {k: "%.2f MB" % (v / 1e6) for k, v in sizes.items()})
for f in ("core_ortho.webp", "reg_ortho.webp", "far_ortho.webp"):
    print("  ", f, "%.2f MB" % (os.path.getsize(os.path.join(OUT, f)) / 1e6))
print("done in %.0f s" % (time.time() - t00))
