"""Numba port of app/src/engine/planner.ts (the reference). Keep in sync with that file.

Goal-rooted Dijkstra on the 5 m analysis grid, 16-connected. Edge cost = walking time at the NASA
planning speed, slowed by slope (Tobler-shaped), loose sand and roughness (timeMul), multiplied by a
risk weight (riskMul: slope^2 and rockfall band). Hard constraints: impassable cells, max grade along
the direction of travel, knight moves may not squeeze between blocked cells.

The port reproduces the float32 storage of the TS typed arrays (cost/time/heap keys are Float32Array,
arithmetic is double) and the same binary heap, so that ties resolve the same way.
"""
import math
import numpy as np
from numba import njit

CELL = 5.0
ROUGH0 = 0.15
K_ROUGH = 0.6

# parameter defaults used by the planner (app/src/engine/params.ts)
PARAMS = dict(slopeMaxDeg=20.0, slopeHardDeg=25.0, vPlan=0.56, kSand=0.8, alphaDeg=27.8, skyShelterMin=0.27)
PRESET_BALANCED = dict(wSlope=0.5, wBandStanding=0.15, wBandActive=8.0)

NB = np.array([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
               [1, 2], [1, -2], [-1, 2], [-1, -2], [2, 1], [2, -1], [-2, 1], [-2, -1]], np.int64)   # (di, dj)

OPP = np.array([1, 0, 3, 2, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12], np.int64)        # NB[OPP[k]] = -NB[k]

GCODE_NONE = 6 * 13 + 6        # guidance target offset code (dy+6)*13 + (dx+6); 84 = no guidance
NEXT_NONE = 255                # next-cell neighbour code (index into NB); 255 = none


@njit(cache=True)
def speed_factor(grade):
    return math.exp(-3.5 * abs(grade + 0.05)) / math.exp(-0.175)


def build_blocked(g, slope_hard_deg=PARAMS["slopeHardDeg"], keepout=None):
    b = g["slope"].astype(np.float64) > slope_hard_deg
    if keepout is not None:
        b = b | (keepout > 0)
    return b.astype(np.uint8)


@njit(cache=True)
def _build_keepout(z, n, slope_deg, buffer_cells, smooth_cells):
    N = n * n
    a = np.zeros(N, np.float32); zs = np.zeros(N, np.float32)
    w = 2 * smooth_cells + 1
    for i in range(n):
        acc = 0.0
        for j in range(-smooth_cells, smooth_cells + 1):
            acc += z[i * n + min(n - 1, max(0, j))]
        for j in range(n):
            a[i * n + j] = acc / w
            acc += z[i * n + min(n - 1, j + smooth_cells + 1)] - z[i * n + max(0, j - smooth_cells)]
    a64 = a.astype(np.float64)
    for j in range(n):
        acc = 0.0
        for i in range(-smooth_cells, smooth_cells + 1):
            acc += a64[min(n - 1, max(0, i)) * n + j]
        for i in range(n):
            zs[i * n + j] = acc / w
            acc += a64[min(n - 1, i + smooth_cells + 1) * n + j] - a64[max(0, i - smooth_cells) * n + j]
    zs64 = zs.astype(np.float64)
    tanT = math.tan(slope_deg * math.pi / 180)
    src = np.zeros(N, np.uint8)
    for i in range(n):
        for j in range(n):
            i0 = max(0, i - 1); i1 = min(n - 1, i + 1); j0 = max(0, j - 1); j1 = min(n - 1, j + 1)
            gy = (zs64[i1 * n + j] - zs64[i0 * n + j]) / ((i1 - i0) * CELL)
            gx = (zs64[i * n + j1] - zs64[i * n + j0]) / ((j1 - j0) * CELL)
            src[i * n + j] = 1 if math.hypot(gx, gy) >= tanT else 0
    tmp = np.zeros(N, np.uint8); out = np.zeros(N, np.uint8)
    for i in range(n):
        for j in range(n):
            v = 0
            for d in range(-buffer_cells, buffer_cells + 1):
                jj = j + d
                if jj >= 0 and jj < n and src[i * n + jj]:
                    v = 1; break
            tmp[i * n + j] = v
    for i in range(n):
        for j in range(n):
            v = 0
            for d in range(-buffer_cells, buffer_cells + 1):
                ii = i + d
                if ii >= 0 and ii < n and tmp[ii * n + j]:
                    v = 1; break
            out[i * n + j] = v
    return out


def build_keepout(g, slope_deg=27.0, buffer_cells=3, smooth_cells=4):
    return _build_keepout(g["z"].astype(np.float64), g["n"], float(slope_deg), int(buffer_cells), int(smooth_cells))


def build_cell_costs(g, band_active, alpha_deg, k_sand=PARAMS["kSand"], w=PRESET_BALANCED):
    """timeMul (soil), riskMul (slope risk, rockfall band) as float32 (double arithmetic, like the TS)."""
    rough = g["rough"].astype(np.float64); sand = g["sand"].astype(np.float64)
    slope = g["slope"].astype(np.float64); beta = g["beta"].astype(np.float64)
    wb = w["wBandActive"] if band_active else w["wBandStanding"]
    r = np.minimum(np.maximum(rough - ROUGH0, 0), 1)
    time_mul = ((1 + k_sand * sand) * (1 + K_ROUGH * r)).astype(np.float32)
    s = slope / 20
    in_band = (beta >= alpha_deg).astype(np.float64)
    risk_mul = (1 + w["wSlope"] * s * s + wb * in_band).astype(np.float32)
    return time_mul, risk_mul


@njit(cache=True, nogil=True)
def _cost_to_go(z, n, blocked, time_mul, risk_mul, goals, tan_max, v_plan, max_cost):
    # z, time_mul, risk_mul: float64 copies of the float32 arrays (JS reads Float32Array as double)
    N = n * n
    cost = np.full(N, np.inf, np.float32)
    time = np.full(N, np.inf, np.float32)
    nxt = np.full(N, -1, np.int32)
    nextk = np.full(N, NEXT_NONE, np.uint8)
    dist = np.empty(16, np.float64)
    for k in range(16):
        dist[k] = CELL * math.sqrt(float(NB[k, 0] * NB[k, 0] + NB[k, 1] * NB[k, 1]))
    cap = N
    hkey = np.empty(cap, np.float32); hval = np.empty(cap, np.int32)
    size = 0
    for q in range(goals.shape[0]):
        gidx = goals[q]
        cost[gidx] = 0.0; time[gidx] = 0.0
        # push(0, gidx)
        if size == cap:
            nk = np.empty(cap * 2, np.float32); nv = np.empty(cap * 2, np.int32)
            nk[:cap] = hkey; nv[:cap] = hval; hkey = nk; hval = nv; cap *= 2
        i = size; size += 1
        kk = 0.0
        while i > 0:
            p = (i - 1) >> 1
            if np.float64(hkey[p]) <= kk: break
            hkey[i] = hkey[p]; hval[i] = hval[p]; i = p
        hkey[i] = kk; hval[i] = gidx
    while size > 0:
        # pop
        c = np.float64(hkey[0]); u = hval[0]
        size -= 1
        if size > 0:
            k32 = hkey[size]; v32 = hval[size]
            i = 0
            while True:
                ch = 2 * i + 1
                if ch >= size: break
                if ch + 1 < size and hkey[ch + 1] < hkey[ch]: ch += 1
                if hkey[ch] >= k32: break
                hkey[i] = hkey[ch]; hval[i] = hval[ch]; i = ch
            hkey[i] = k32; hval[i] = v32
        if c > np.float64(cost[u]): continue
        if c > max_cost: break
        ui = u // n; uj = u - ui * n
        zu = z[u]
        mul = time_mul[u]; rk = risk_mul[u]
        for k in range(16):
            di = NB[k, 0]; dj = NB[k, 1]
            vi = ui + di; vj = uj + dj
            if vi < 0 or vi >= n or vj < 0 or vj >= n: continue
            v = vi * n + vj
            if blocked[v]: continue
            d = dist[k]
            grade = (zu - z[v]) / d                    # the walker moves v -> u
            if grade > tan_max or grade < -tan_max: continue
            if k >= 8:                                 # knight move: the two cells it passes between
                if di == 2 or di == -2:
                    ai = ui + di // 2; bi = ui + di // 2
                else:
                    ai = ui + di; bi = ui
                if dj == 2 or dj == -2:
                    aj = uj + dj // 2; bj = uj + dj // 2
                else:
                    aj = uj; bj = uj + dj
                if blocked[ai * n + aj] or blocked[bi * n + bj]: continue
            t = d / (v_plan * speed_factor(grade)) * mul
            nc = c + t * rk
            if nc < np.float64(cost[v]):
                cost[v] = nc; time[v] = np.float64(time[u]) + t; nxt[v] = u
                nextk[v] = OPP[k]                      # offset from v to u
                if size == cap:
                    nk = np.empty(cap * 2, np.float32); nv = np.empty(cap * 2, np.int32)
                    nk[:cap] = hkey; nv[:cap] = hval; hkey = nk; hval = nv; cap *= 2
                i = size; size += 1
                while i > 0:
                    p = (i - 1) >> 1
                    if np.float64(hkey[p]) <= nc: break
                    hkey[i] = hkey[p]; hval[i] = hval[p]; i = p
                hkey[i] = nc; hval[i] = v
    # guidance: direction to the cell three hops down the pointer chain
    # (shortened to 2 or 1 hops when the straight line to that cell would clip an impassable cell)
    gx = np.zeros(N, np.float32); gy = np.zeros(N, np.float32)
    gcode = np.full(N, GCODE_NONE, np.uint8)
    for c0 in range(N):
        if nxt[c0] < 0: continue
        ci = c0 // n; cj = c0 - ci * n
        h1 = nxt[c0]
        h2 = nxt[h1] if nxt[h1] >= 0 else h1
        h3 = nxt[h2] if nxt[h2] >= 0 else h2
        t = h1
        for q in range(2):
            cand = h3 if q == 0 else h2
            if cand == h1: continue
            ti = cand // n; tj = cand - ti * n
            clear = True
            for s in range(1, 6):
                fi = int(math.floor(ci + (ti - ci) * s / 6 + 0.5))      # JS Math.round
                fj = int(math.floor(cj + (tj - cj) * s / 6 + 0.5))
                if blocked[fi * n + fj]:
                    clear = False; break
            if clear:
                t = cand; break
        ti = t // n; tj = t - ti * n
        dx = tj - cj; dy = ti - ci
        l = math.sqrt(float(dx * dx + dy * dy))
        gx[c0] = dx / l; gy[c0] = dy / l
        gcode[c0] = (dy + 6) * 13 + (dx + 6)
    return cost, time, nxt, gx, gy, nextk, gcode


def cost_to_go(g, blocked, time_mul, risk_mul, goals, slope_max_deg=PARAMS["slopeMaxDeg"], v_plan=PARAMS["vPlan"],
               max_cost=np.inf):
    """Field dict: cost, time (float32, inf if unreachable), next (int32, -1 none), gx, gy (float32),
    nextk (uint8 index into NB, 255 none), gcode (uint8 guidance target offset code)."""
    tan_max = math.tan(slope_max_deg * math.pi / 180)
    cost, time, nxt, gx, gy, nextk, gcode = _cost_to_go(
        g["z"].astype(np.float64), g["n"], np.ascontiguousarray(blocked, dtype=np.uint8),
        time_mul.astype(np.float64), risk_mul.astype(np.float64), np.asarray(goals, np.int64), tan_max, float(v_plan), float(max_cost))
    return dict(cost=cost, time=time, next=nxt, gx=gx, gy=gy, nextk=nextk, gcode=gcode)


def cell_of(n, x, y):
    j = min(n - 1, max(0, int(math.floor(x / CELL))))
    i = min(n - 1, max(0, int(math.floor(y / CELL))))
    return i * n + j


def goal_cells(g, blocked, x, y, radius=10.0):
    """Every free cell within `radius` metres of (x, y)."""
    n = g["n"]; out = []
    r = int(math.ceil(radius / CELL))
    ci = int(math.floor(y / CELL)); cj = int(math.floor(x / CELL))
    for di in range(-r, r + 1):
        for dj in range(-r, r + 1):
            i = ci + di; j = cj + dj
            if i < 0 or i >= n or j < 0 or j >= n: continue
            if math.hypot(di, dj) * CELL > radius: continue
            if not blocked[i * n + j]: out.append(i * n + j)
    if not out:
        out.append(min(n - 1, max(0, ci)) * n + min(n - 1, max(0, cj)))
    return out


@njit(cache=True)
def _find_shelters(sky, blocked, n, sky_min, min_cells):
    N = n * n
    mark = np.zeros(N, np.uint8)
    stack = np.empty(N, np.int64)
    res_best = []; res_cnt = []
    for s in range(N):
        if mark[s] or blocked[s] or sky[s] < sky_min: continue
        sp = 0
        stack[sp] = s; sp += 1; mark[s] = 1
        cnt = 0; best = s
        while sp > 0:
            sp -= 1
            c = stack[sp]
            cnt += 1
            if sky[c] > sky[best]: best = c
            i = c // n; j = c - i * n
            for di in range(-1, 2):
                for dj in range(-1, 2):
                    a = i + di; b = j + dj
                    if a < 0 or a >= n or b < 0 or b >= n: continue
                    q = a * n + b
                    if (not mark[q]) and (not blocked[q]) and sky[q] >= sky_min:
                        mark[q] = 1; stack[sp] = q; sp += 1
        if cnt >= min_cells:
            res_best.append(best); res_cnt.append(cnt)
    return res_best, res_cnt


def find_terrain_shelters(g, blocked, sky_min=PARAMS["skyShelterMin"], min_cells=6):
    """Terrain cells that hide a large part of the sky, clustered (same flood fill order as the TS)."""
    n = g["n"]
    best, cnt = _find_shelters(g["sky"].astype(np.float64), np.ascontiguousarray(blocked, dtype=np.uint8), n, float(sky_min), int(min_cells))
    out = []
    for b, c in zip(best, cnt):
        i = b // n; j = b - i * n
        out.append(dict(x=(j + 0.5) * CELL, y=(i + 0.5) * CELL, sky=float(g["sky"][b]), cells=int(c), beta=float(g["beta"][b])))
    out.sort(key=lambda s: -s["sky"])      # stable, like Array.prototype.sort
    return out


def statics(g, slope_hard_deg=PARAMS["slopeHardDeg"]):
    keep = build_keepout(g)
    return keep, build_blocked(g, slope_hard_deg, keep)


def plan(g, blocked, gx, gy, band_active, alpha_deg, **kw):
    tm, rm = build_cell_costs(g, band_active, alpha_deg)
    return cost_to_go(g, blocked, tm, rm, goal_cells(g, blocked, gx, gy), **kw)


if __name__ == "__main__":
    import time as _t
    from terrain import load_grid
    g, meta = load_grid()
    keep, blocked = statics(g)
    print("blocked %.1f%%  keepout %.1f%%" % (100 * blocked.mean(), 100 * keep.mean()))
    sh = find_terrain_shelters(g, blocked)
    print("terrain shelters: " + " | ".join("(%.0f,%.0f) sky %.2f beta %.1f n%d" % (s["x"], s["y"], s["sky"], s["beta"], s["cells"]) for s in sh))
    plan(g, blocked, 2598, 1858, False, 27.8)
    t0 = _t.time()
    f = plan(g, blocked, 2598, 1858, False, 27.8)
    print("field %.0f ms; S->A plan %.1f min" % (1000 * (_t.time() - t0), f["time"][cell_of(g["n"], 2800, 1500)] / 60))
