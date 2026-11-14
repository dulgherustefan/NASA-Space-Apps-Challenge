"""Walk and consumables model for ONE suited walker following a route polyline.

A numba port of stepAgent() in reference/ts_engine/sim.ts (same speed law, soil slowdown, metabolic rate,
heat storage against the suit cooling limit, O2 use, fall hazard, dose with terrain shielding), with one
change: the walker steers along the planner's polyline (pure pursuit, 15 m look-ahead) instead of the
planner's guidance field, so that the nominal metrics belong to exactly the route that is drawn.

Disturbances for the local preview Monte Carlo follow docs/research/U2_rl_design.md section 9.2:
suit cooling 1 - 0.117 z (floor 0.65), metabolic efficiency exp(0.12 z), navigation offset 53 m sigma
(fading out over the final 200 m), pace drift exp(0.08 z) per step, stumbles and injuries at the
simulator's own probabilities. All z are standard normal clipped to +/-3.
"""
import math

import numpy as np
from numba import njit

from .params import PARAMS, SIM

CELL = 5.0
DT = SIM["DT"]
SUB = SIM["SUB"]

# internal terminal codes
WALKING, ARRIVED, INCAP, HEAT, O2, TIMEOUT, STUCK = 0, 1, 2, 3, 4, 5, 6
# contract status codes (section 3)
C_WALK, C_IDLE, C_STUMBLE, C_INCAP, C_HEAT, C_O2, C_ARRIVED, C_LATE = 0, 1, 2, 3, 4, 5, 6, 7

CHANNELS = ["cooling", "metabolic", "navigation", "stumble", "injury"]

# stats vector layout
ST = dict(status=0, t_end=1, heat_end=2, heat_peak=3, o2_end=4, dose_ugy=5, dose_msv=6, falls=7, band_s=8, dist=9,
          log_p=10, steps=11, end_x=12, end_y=13, dl_x=14, dl_y=15, exp_falls=16, p_incap=17, n_events=18, ascent=19)
NST = 20
# track columns
TR = dict(t=0, x=1, y=2, heading=3, status=4, heat=5, o2=6, dose=7, v=8)
NTR = 9
MAX_EV = 64
SIM_MOVE_LOOK = SIM["MOVE_LOOK"]

# parameter vector layout
PK = ["pace", "kSand", "metBase", "massKg", "gMars", "coolW", "heatWarnKJ", "heatMaxKJ", "fallPerKm", "fallInjuryP",
      "gcrRate", "sepPeakMin", "sepTotal", "sepDecayH", "shieldK", "slopeMaxDeg", "alphaDeg", "bandActive", "terrainError",
      "navDecayM", "sigCool", "sigEff", "sigNav", "sigPace", "qGcr", "qSep", "sepElapsed0", "heat0", "o2kg", "look",
      "tMax", "deadline"]
PI = {k: i for i, k in enumerate(PK)}


@njit(cache=True)
def _zat(z, n, x, y):
    fx = x / CELL - 0.5
    fy = y / CELL - 0.5
    if fx < 0.0:
        fx = 0.0
    elif fx > n - 1.001:
        fx = n - 1.001
    if fy < 0.0:
        fy = 0.0
    elif fy > n - 1.001:
        fy = n - 1.001
    j = int(fx); i = int(fy); tx = fx - j; ty = fy - i; k = i * n + j
    return (z[k] * (1 - tx) + z[k + 1] * tx) * (1 - ty) + (z[k + n] * (1 - tx) + z[k + n + 1] * tx) * ty


@njit(cache=True)
def _cell(n, x, y):
    j = int(math.floor(x / CELL)); i = int(math.floor(y / CELL))
    if i < 0 or i >= n or j < 0 or j >= n:
        return -1
    return i * n + j


@njit(cache=True)
def _sf(grade):
    return math.exp(-3.5 * abs(grade + 0.05)) / math.exp(-0.175)


@njit(cache=True)
def _hash(a, b):
    s = math.sin(a * 127.1 + b * 311.7) * 43758.5453
    return s - math.floor(s)


@njit(cache=True)
def _noise(seed, x, y):
    fx = x / 40 + seed; fy = y / 40 + seed * 1.7
    ix = math.floor(fx); iy = math.floor(fy); tx = fx - ix; ty = fy - iy
    sx = tx * tx * (3 - 2 * tx); sy = ty * ty * (3 - 2 * ty)
    return (_hash(ix, iy) * (1 - sx) + _hash(ix + 1, iy) * sx) * (1 - sy) + (_hash(ix, iy + 1) * (1 - sx) + _hash(ix + 1, iy + 1) * sx) * sy


@njit(cache=True)
def sep_rate(tau, peak_min, total, decay_h):
    """Idealised SEP dose rate (uGy/h, unshielded) tau seconds after onset (sim.ts sepRate)."""
    if tau <= 0:
        return 0.0
    tp = peak_min * 60.0; td = decay_h * 3600.0
    peak = total / ((tp / 2 + td) / 3600.0)
    if tau < tp:
        return peak * tau / tp
    return peak * math.exp(-(tau - tp) / td)


@njit(cache=True)
def _nearest(px, py, k0, k1, x, y):
    best = k0; bd = 1e30
    for k in range(k0, k1 + 1):
        d = (px[k] - x) ** 2 + (py[k] - y) ** 2
        if d < bd:
            bd = d; best = k
    return best


@njit(cache=True)
def _clipz(v):
    return min(3.0, max(-3.0, v))


@njit(cache=True, nogil=True)
def _walk_one(z, slope, sand, rough, sky, beta, blocked, n, px, py, cum, nxt0, nxt1, ksplit, prm, seed, stochastic, track, trk, ev):
    nv = px.shape[0]
    L = cum[nv - 1]
    st = np.zeros(NST)
    pace = prm[0]; kSand = prm[1]; metBase = prm[2]; massKg = prm[3]; gMars = prm[4]; coolW = prm[5]
    heatWarn = prm[6]; heatMax = prm[7]; fallPerKm = prm[8]; fallInjP = prm[9]; gcr = prm[10]
    sepPk = prm[11]; sepTot = prm[12]; sepDec = prm[13]; shieldK = prm[14]; slopeMax = prm[15]; alpha = prm[16]
    bandActive = prm[17] > 0.5; terrErr = prm[18]; navDecay = prm[19]; sigCool = prm[20]; sigEff = prm[21]
    sigNav = prm[22]; sigPace = prm[23]; qG = prm[24]; qS = prm[25]; sep0 = prm[26]; heat = prm[27]; o2 = prm[28]
    look_m = prm[29]; tMax = prm[30]; deadline = prm[31]
    dtS = DT / SUB
    tanHard = math.tan((slopeMax + 6.0) * math.pi / 180.0)
    nev = 0
    if stochastic:
        np.random.seed(seed)
        zc = _clipz(np.random.standard_normal()); ze = _clipz(np.random.standard_normal())
        znx = _clipz(np.random.standard_normal()); zny = _clipz(np.random.standard_normal())
        tseed = np.random.random() * 1000.0
    else:
        zc = 0.0; ze = 0.0; znx = 0.0; zny = 0.0; tseed = 0.0
    cool = max(0.65, 1.0 - sigCool * zc)
    eff = math.exp(sigEff * ze)
    offx = sigNav * znx; offy = sigNav * zny
    logp = -0.5 * (zc * zc + ze * ze + znx * znx + zny * zny)
    if track and stochastic:
        ev[0, 0] = 0.0; ev[0, 1] = 0; ev[0, 2] = cool; ev[0, 3] = -0.5 * zc * zc
        ev[1, 0] = 0.0; ev[1, 1] = 1; ev[1, 2] = eff; ev[1, 3] = -0.5 * ze * ze
        ev[2, 0] = 0.0; ev[2, 1] = 2; ev[2, 2] = math.hypot(offx, offy); ev[2, 3] = -0.5 * (znx * znx + zny * zny)
        nev = 3
    x = px[0]; y = py[0]; t = 0.0
    dose_u = 0.0; dose_m = 0.0; falls = 0; band_s = 0.0; dist = 0.0; heat_peak = heat
    fall_timer = 0.0; blocked_run = 0; status = WALKING; kb = 0; onfield = False
    exp_falls = 0.0; p_noincap = 1.0
    dl_x = np.nan; dl_y = np.nan
    hdg = 0.0
    if nv >= 2:
        hdg = (math.degrees(math.atan2(px[1] - px[0], -(py[1] - py[0]))) + 360.0) % 360.0
    steps = 0
    max_steps = int(math.ceil(tMax / DT))
    if track:
        trk[0, 0] = 0.0; trk[0, 1] = x; trk[0, 2] = y; trk[0, 3] = hdg; trk[0, 4] = C_WALK
        trk[0, 5] = heat; trk[0, 6] = o2; trk[0, 7] = 0.0; trk[0, 8] = 0.0
    if nv < 2:
        status = ARRIVED
    while status == WALKING:
        impaired = heat >= heatWarn
        Msum = 0.0; pNoFall = 1.0; lastV = 0.0; downhill = False; was_blocked = False
        if fall_timer > 0:
            fall_timer -= DT
            Msum = 250.0 * eff * SUB
        else:
            sx0 = x; sy0 = y
            drift = math.exp(sigPace * _clipz(np.random.standard_normal())) if stochastic else 1.0
            vcmd = pace * drift * (0.6 if impaired else 1.0)
            for s in range(SUB):
                nxt = nxt0 if kb < ksplit else nxt1
                c = _cell(n, x, y)
                if onfield:
                    kn = _nearest(px, py, max(0, kb - 10), min(nv - 1, kb + 80), x, y)
                    if math.hypot(px[kn] - x, py[kn] - y) < 8.0:
                        onfield = False
                        kb = max(kb, kn)
                if onfield and c >= 0 and nxt[c] >= 0:
                    # off the drawn line: follow the planner's own next cells toward the goal
                    h1 = nxt[c]
                    h2 = nxt[h1] if nxt[h1] >= 0 else h1
                    ti = h2 // n; tj = h2 - ti * n
                    dx = (tj + 0.5) * CELL - x; dy = (ti + 0.5) * CELL - y
                    dl = math.hypot(dx, dy)
                    f = 0.0
                else:
                    f = 1.0
                    if navDecay > 0:
                        f = min(1.0, (L - cum[kb]) / navDecay)
                    bx = x + offx * f; by = y + offy * f
                    kb = _nearest(px, py, max(0, kb - 3), min(nv - 1, kb + 25), bx, by)
                    if navDecay > 0:
                        f = min(1.0, (L - cum[kb]) / navDecay)
                    kt = kb
                    while kt < nv - 1 and cum[kt] - cum[kb] < look_m:
                        kt += 1
                    ax = px[kt] - offx * f; ay = py[kt] - offy * f
                    dx = ax - x; dy = ay - y
                    dl = math.hypot(dx, dy)
                if dl < 1e-6:
                    dx = px[nv - 1] - x; dy = py[nv - 1] - y; dl = math.hypot(dx, dy)
                    if dl < 1e-6:
                        dx = 1.0; dy = 0.0; dl = 1.0
                dx /= dl; dy /= dl
                sd = sand[c] if c >= 0 else 0.0
                r = min(1.0, max(0.0, rough[c] - 0.15)) if c >= 0 else 0.0
                v = 0.0; grade = 0.0
                if vcmd > 0:
                    look = max(vcmd * dtS, SIM_MOVE_LOOK)
                    grade = (_zat(z, n, x + dx * look, y + dy * look) - _zat(z, n, x, y)) / look
                    soil = (1 + kSand * sd) * (1 + 0.6 * r)
                    err = 1.0 - terrErr * _noise(tseed, x, y)
                    v = vcmd * _sf(grade) / soil * err
                    stp = min(v * dtS, dl)
                    nx = x + dx * stp; ny = y + dy * stp
                    nc = _cell(n, nx, ny)
                    if nc < 0 or blocked[nc] or abs(grade) > tanHard:
                        # impassable ahead: the crew re-localises (navigation offset cleared) and falls back
                        # to the planner's next cell (always a legal move), then to a fan of headings
                        was_blocked = True
                        v = 0.0
                        offx = 0.0; offy = 0.0
                        if c >= 0 and nxt[c] >= 0:
                            ti = nxt[c] // n; tj = nxt[c] - ti * n
                            lx = (tj + 0.5) * CELL - x; ly = (ti + 0.5) * CELL - y
                            onfield = True
                        else:
                            kn = _nearest(px, py, max(0, kb - 40), min(nv - 1, kb + 40), x, y)
                            tg = min(nv - 1, kn + 2)
                            lx = px[tg] - x; ly = py[tg] - y
                        ll = math.hypot(lx, ly)
                        if ll > 0.01:
                            lx /= ll; ly /= ll
                        else:
                            lx = dx; ly = dy
                        for q in range(7):
                            ang = 0.0 if q == 0 else (45.0 * ((q + 1) // 2)) * (1.0 if q % 2 == 1 else -1.0)
                            ca = math.cos(ang * math.pi / 180.0); sa = math.sin(ang * math.pi / 180.0)
                            ex = lx * ca - ly * sa; ey = lx * sa + ly * ca
                            g2 = (_zat(z, n, x + ex * look, y + ey * look) - _zat(z, n, x, y)) / look
                            v2 = vcmd * _sf(g2) / soil * err
                            stp = v2 * dtS
                            if q == 0:
                                stp = min(stp, max(ll, 0.5))
                            nx = x + ex * stp; ny = y + ey * stp
                            nc = _cell(n, nx, ny)
                            if nc >= 0 and blocked[nc] == 0 and abs(g2) <= tanHard:
                                x = nx; y = ny; v = v2; grade = g2; dx = ex; dy = ey
                                break
                    else:
                        x = nx; y = ny
                if v > 0:
                    hdg = (math.degrees(math.atan2(dx, -dy)) + 360.0) % 360.0
                    M = (metBase + 240.0 * v + 110.0 * v * v) * (1 + 1.1 * sd + 0.6 * r)
                    w = massKg * gMars * v
                    if grade > 0:
                        M += w * grade / 0.25
                    else:
                        M += w * (-grade) * 0.3
                    M *= eff
                    sl = slope[c] / 12.0 if c >= 0 else 0.0
                    vr = v / 0.65
                    lam = fallPerKm / 1000.0 * (1 + sl * sl) * (1 + 2 * r) * vr * vr * (1.6 if grade < -0.12 else 1.0) * (2.0 if impaired else 1.0)
                    pNoFall *= math.exp(-lam * v * dtS)
                    dist += v * dtS
                    lastV = v; downhill = grade < -0.12
                else:
                    M = 110.0 * eff
                Msum += M
            if was_blocked and (lastV == 0.0 or math.hypot(x - sx0, y - sy0) < 1.0):
                blocked_run += 1
            else:
                blocked_run = 0
            pFall = 1.0 - pNoFall
            pInj = min(0.3, fallInjP * (1 + lastV / 0.65) * (1.5 if downhill else 1.0))
            exp_falls += pFall
            p_noincap *= (1.0 - pFall * pInj)
            if stochastic and pFall > 0:
                u1 = np.random.random()
                if u1 < pFall:
                    falls += 1
                    fall_timer = 20.0 + np.random.random() * 40.0
                    lp = math.log(pFall)
                    logp += lp
                    if track and nev < MAX_EV:
                        ev[nev, 0] = t; ev[nev, 1] = 3; ev[nev, 2] = 1.0; ev[nev, 3] = lp; nev += 1
                    if np.random.random() < pInj:
                        status = INCAP
                        lp2 = math.log(pInj)
                        logp += lp2
                        if track and nev < MAX_EV:
                            ev[nev, 0] = t; ev[nev, 1] = 4; ev[nev, 2] = 1.0; ev[nev, 3] = lp2; nev += 1
                    else:
                        logp += math.log1p(-pInj)
                else:
                    logp += math.log1p(-pFall)
        Mavg = Msum / SUB
        heat = max(0.0, heat + (Mavg - cool * coolW) * DT / 1000.0)
        if heat > heat_peak:
            heat_peak = heat
        o2 -= Mavg * DT * 7.11e-8
        c1 = _cell(n, x, y)
        shield = min(0.95, shieldK * sky[c1]) if c1 >= 0 else 0.0
        sr = sep_rate(sep0 + t + DT / 2, sepPk, sepTot, sepDec) if sep0 >= 0 else 0.0
        dose_u += (gcr + sr) * (1 - shield) * DT / 3600.0
        dose_m += (gcr * qG + sr * qS) * (1 - shield) * DT / 3600.0 / 1000.0
        if bandActive and c1 >= 0 and beta[c1] >= alpha:
            band_s += DT
        t += DT
        if t >= deadline and math.isnan(dl_x):
            dl_x = x; dl_y = y
        if status == WALKING:
            dg = math.hypot(px[nv - 1] - x, py[nv - 1] - y)
            final_leg = ksplit > nv or kb >= ksplit
            at_goal_cell = final_leg and c1 >= 0 and nxt1[c1] < 0 and blocked[c1] == 0 and dg <= 20.0
            if (dg <= 12.0 and (L - cum[kb] <= 40.0 or (onfield and final_leg))) or at_goal_cell:
                status = ARRIVED
            elif heat >= heatMax:
                status = HEAT
            elif o2 <= 0:
                status = O2
            elif blocked_run >= 18:
                status = STUCK
            elif t >= tMax or steps + 1 >= max_steps:
                status = TIMEOUT
        steps += 1
        if track:
            code = C_WALK
            if status == ARRIVED:
                code = C_ARRIVED if t <= deadline else C_LATE
            elif status == INCAP:
                code = C_INCAP
            elif status == HEAT:
                code = C_HEAT
            elif status == O2:
                code = C_O2
            elif status == TIMEOUT:
                code = C_LATE
            elif status == STUCK:
                code = C_IDLE
            elif fall_timer > 0:
                code = C_STUMBLE
            trk[steps, 0] = t; trk[steps, 1] = x; trk[steps, 2] = y; trk[steps, 3] = hdg; trk[steps, 4] = code
            trk[steps, 5] = heat; trk[steps, 6] = o2; trk[steps, 7] = dose_m; trk[steps, 8] = lastV
    st[0] = status; st[1] = t; st[2] = heat; st[3] = heat_peak; st[4] = o2; st[5] = dose_u; st[6] = dose_m
    st[7] = falls; st[8] = band_s; st[9] = dist; st[10] = logp; st[11] = steps; st[12] = x; st[13] = y
    st[14] = dl_x; st[15] = dl_y; st[16] = exp_falls; st[17] = 1.0 - p_noincap; st[18] = nev
    return st



@njit(cache=True, nogil=True)
def _monte_carlo(z, slope, sand, rough, sky, beta, blocked, n, px, py, cum, nxt0, nxt1, ksplit, prm, seeds, out):
    trk = np.zeros((1, NTR)); ev = np.zeros((1, 4))
    for i in range(seeds.shape[0]):
        out[i, :] = _walk_one(z, slope, sand, rough, sky, beta, blocked, n, px, py, cum, nxt0, nxt1, ksplit, prm, seeds[i], True, False, trk, ev)


# ---------------------------------------------------------------------------------------------- python API
def make_params(pace, sep_elapsed0=-1.0, deadline=math.inf, band_active=False, heat0=None, o2_frac=None, **over):
    p = dict(PARAMS)
    p.update(pace=pace, bandActive=1.0 if band_active else 0.0, sepElapsed0=float(sep_elapsed0),
             heat0=PARAMS["heat0KJ"] if heat0 is None else heat0,
             o2kg=(PARAMS["o2Start"] if o2_frac is None else o2_frac) * SIM["O2_TANK_KG"],
             look=15.0, tMax=SIM["T_MAX"], deadline=float(deadline))
    p.update(over)
    return np.array([float(p[k]) for k in PK], np.float64)


def _poly(poly_xy):
    pts = np.asarray(poly_xy, np.float64)
    px = np.ascontiguousarray(pts[:, 0]); py = np.ascontiguousarray(pts[:, 1])
    seg = np.hypot(np.diff(px), np.diff(py))
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    return px, py, cum


def _args(site, poly_xy, legs):
    """legs: list of (field next array, number of polyline vertices on that leg); one entry for a one-way route."""
    px, py, cum = _poly(poly_xy)
    nxt0 = np.ascontiguousarray(legs[0][0], dtype=np.int32)
    nxt1 = np.ascontiguousarray(legs[-1][0], dtype=np.int32)
    ksplit = int(legs[0][1]) if len(legs) > 1 else len(px) + 1
    return (site.z, site.slope, site.sand, site.rough, site.sky, site.beta, site.blocked, site.n, px, py, cum, nxt0, nxt1, ksplit)


def walk(site, poly_xy, legs, prm, seed=0, stochastic=False):
    """One walker with a track. Returns (stats dict, track array [steps+1, 9], events list)."""
    a = _args(site, poly_xy, legs)
    max_steps = int(math.ceil(prm[PI["tMax"]] / DT)) + 2
    trk = np.zeros((max_steps + 1, NTR)); ev = np.zeros((MAX_EV, 4))
    st = _walk_one(*a, prm, int(seed), bool(stochastic), True, trk, ev)
    steps = int(st[ST["steps"]])
    stats = {k: float(st[i]) for k, i in ST.items()}
    events = [dict(t=float(e[0]), channel=CHANNELS[int(e[1])], value=round(float(e[2]), 3), log_p=round(float(e[3]), 3))
              for e in ev[:int(st[ST["n_events"]])]]
    return stats, trk[:steps + 1].copy(), events


def monte_carlo(site, poly_xy, legs, prm, n, seed0=1):
    a = _args(site, poly_xy, legs)
    seeds = (np.arange(n, dtype=np.int64) * 7919 + int(seed0) * 104729 + 17) % (2 ** 31 - 1)
    out = np.zeros((n, NST))
    _monte_carlo(*a, prm, seeds, out)
    return out, seeds


def stats_row(row):
    return {k: float(row[i]) for k, i in ST.items()}
