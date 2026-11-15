"""Candidate routes with rl/planner.py (goal-rooted Dijkstra on the 5 m grid), their nominal walk metrics,
and runtime/routes.json.
"""
import json
import math
import os

import numpy as np

from . import RUNTIME, rel, write_atomic
from .params import PARAMS, SIM
from .site import rl_planner
from .walk import ARRIVED, make_params, walk

O2_W = SIM["O2_NOMINAL_W"] * SIM["O2_KG_PER_J"]       # kg/s at 300 W


def plan_field(site, goal_xy, band_active, alpha=PARAMS["alphaDeg"]):
    """Same calls as the reference: build_cell_costs + cost_to_go to the free cells within 10 m of the goal."""
    tm, rm = rl_planner.build_cell_costs(site.g, band_active, alpha)
    goals = rl_planner.goal_cells(site.g, site.blocked, goal_xy[0], goal_xy[1])
    return rl_planner.cost_to_go(site.g, site.blocked, tm, rm, goals)


def _start_cell(site, field, x, y, radius=40.0):
    """The start cell, or the nearest reachable free cell within `radius` metres."""
    n = site.n
    c = site.cell_index(x, y)
    if not site.blocked[c] and math.isfinite(field["cost"][c]):
        return c
    ci, cj = site.cell_ij(x, y)
    r = int(math.ceil(radius / site.cell))
    best, bd = -1, 1e18
    for di in range(-r, r + 1):
        for dj in range(-r, r + 1):
            i, j = ci + di, cj + dj
            if 0 <= i < n and 0 <= j < n:
                k = i * n + j
                if not site.blocked[k] and math.isfinite(field["cost"][k]):
                    d = di * di + dj * dj
                    if d < bd:
                        bd, best = d, k
    return best


def trace(site, field, start_xy, goal_xy):
    """Polyline (core metres) from start to goal along the planner's next-cell pointers, or None."""
    n = site.n
    c = _start_cell(site, field, *start_xy)
    if c < 0:
        return None
    pts = []
    if not site.is_blocked(*start_xy):
        pts.append((float(start_xy[0]), float(start_xy[1])))
    seen = 0
    while c >= 0 and seen < n * n:
        i, j = divmod(int(c), n)
        pts.append(site.cell_center(i, j))
        c = int(field["next"][c])
        seen += 1
    # the polyline ends on the planner's goal cell (a free cell within 10 m of the shelter)
    # drop consecutive duplicates
    out = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > 0.5:
            out.append(p)
    return out


def geometry(site, poly, alpha=PARAMS["alphaDeg"]):
    pts = np.asarray(poly, np.float64)
    zs = np.array([site.z_at_core(x, y) for x, y in pts])
    seg = np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1]))
    length = float(seg.sum())
    dz = np.diff(zs)
    ascent = float(dz[dz > 0].sum())
    descent = float(-dz[dz < 0].sum())
    mids = (pts[1:] + pts[:-1]) / 2
    cells = np.array([site.cell_index(x, y) for x, y in pts])
    mcells = np.array([site.cell_index(x, y) for x, y in mids]) if len(mids) else np.zeros(0, int)
    band_m = float(seg[site.beta[mcells] >= alpha].sum()) if len(mids) else 0.0
    steep_m = float(seg[site.slope[mcells] > 15.0].sum()) if len(mids) else 0.0
    sand_m = float(seg[site.sand[mcells] > 0.5].sum()) if len(mids) else 0.0
    open_sky_m = float(seg[site.sky[mcells] < 0.15].sum()) if len(mids) else 0.0
    return dict(zs=zs, length_m=length, ascent_m=ascent, descent_m=descent, max_slope=float(site.slope[cells].max()),
                band_m=band_m, steep_m=steep_m, sand_m=sand_m, open_sky_m=open_sky_m,
                on_blocked=int(site.blocked[cells].sum()))


def late_deadline(ctx):
    """Walk time (s) after which an arrival counts as late: the shelter rule, or the storm peak (see plan_candidates)."""
    return ctx["deadline_peak"] if ctx.get("late_basis") == "peak" else ctx["deadline_walk"]


def nominal_metrics(site, poly, legs, ctx):
    """Deterministic walker (no disturbance) along the polyline."""
    prm = make_params(ctx["pace"], sep_elapsed0=ctx["sep_elapsed0"], deadline=late_deadline(ctx),
                      band_active=ctx["band_active"], heat0=ctx["heat0"], o2_frac=ctx["o2_frac"])
    st, trk, _ = walk(site, poly, legs, prm, seed=0, stochastic=False)
    arrived = int(st["status"]) == ARRIVED
    o2_min = st["o2_end"] / O2_W / 60.0
    return dict(stats=st, track=trk, prm=prm, arrived=arrived, time_s=st["t_end"],
                o2_margin=max(0.0, st["o2_end"] / SIM["O2_TANK_KG"]), o2_min=o2_min,
                heat_margin=max(0.0, 1.0 - st["heat_peak"] / PARAMS["heatMaxKJ"]),
                dose=st["dose_msv"], dose_ugy=st["dose_ugy"], exp_falls=st["exp_falls"], p_incap=st["p_incap"])


def build_route(site, rid, shelter, label, poly, legs, ctx):
    geo = geometry(site, poly, ctx.get("alpha", PARAMS["alphaDeg"]))
    nom = nominal_metrics(site, poly, legs, ctx)
    pts_local = [[round(site.e0 + x, 2), round(site.s0 + y, 2), round(float(z), 2)] for (x, y), z in zip(poly, geo["zs"])]
    reasons = []
    if not nom["arrived"]:
        reasons.append("nominal walker does not arrive")
    if math.isfinite(ctx["deadline_walk"]) and nom["time_s"] > ctx["deadline_walk"]:
        reasons.append("misses the %d-minute shelter rule by %.1f min" % (PARAMS["shelterRuleMin"], (nom["time_s"] - ctx["deadline_walk"]) / 60))
    if nom["o2_min"] < PARAMS["o2ReserveMin"]:
        reasons.append("O2 reserve below %d min on arrival" % PARAMS["o2ReserveMin"])
    if nom["heat_margin"] <= 0:
        reasons.append("heat limit reached")
    status = "infeasible" if not nom["arrived"] else "candidate"
    return dict(id=rid, shelter=shelter["id"], label=label, shelter_name=shelter["name"], poly=[tuple(p) for p in poly],
                points=pts_local, length_m=round(geo["length_m"], 1), time_s=round(nom["time_s"], 1),
                ascent_m=round(geo["ascent_m"], 1), max_slope=round(geo["max_slope"], 1),
                o2_margin=round(nom["o2_margin"], 3), heat_margin=round(nom["heat_margin"], 3), dose=round(nom["dose"], 4),
                robustness_nats=None, mc_fail_rate=None, status=status,
                band_m=round(geo["band_m"], 1), steep_m=round(geo["steep_m"], 1), sand_m=round(geo["sand_m"], 1),
                open_sky_m=round(geo["open_sky_m"], 1), on_blocked=geo["on_blocked"],
                o2_min=round(nom["o2_min"], 1), dose_ugy=round(nom["dose_ugy"], 1),
                exp_falls=round(nom["exp_falls"], 4), p_incap=nom["p_incap"],
                plan_time_s=None, rule_ok=not reasons, rule_reasons=reasons,
                nominal=nom, ctx=ctx, legs=legs)


def plan_candidates(site, ctx, shelters):
    """One route per open shelter. ctx: start_xy, band_active, alpha, pace, sep_elapsed0, deadline_walk, heat0, o2_frac."""
    routes = []
    for sh in shelters:
        if not sh["open"]:
            continue
        goal = (sh["x"], sh["y"])
        field = plan_field(site, goal, ctx["band_active"], ctx.get("alpha", PARAMS["alphaDeg"]))
        poly = trace(site, field, ctx["start_xy"], goal)
        if poly is None or len(poly) < 2:
            continue
        r = build_route(site, len(routes), sh, sh["name"], poly, [(field["next"], len(poly))], ctx)
        c0 = _start_cell(site, field, *ctx["start_xy"])
        r["plan_time_s"] = round(float(field["time"][c0]), 1) if c0 >= 0 else None
        routes.append(r)
    # The 30-minute rule is a margin whose purpose is to be under cover before the dose rate peaks
    # (sepPeakMin after onset; the dose model in walk.sep_rate peaks there). When an event has already
    # made the rule unreachable for every open shelter (the marsquake closes the terrain shelters while
    # the crew walks), every walker of every route is late against it by construction, so "late" no
    # longer tells the routes apart. The rule breach stays in rule_reasons; lateness in the stress test
    # and in the crew status is then counted against the peak, the physical limit the rule protects.
    dl, dl_peak = ctx["deadline_walk"], ctx.get("deadline_peak", math.inf)
    reach = [r for r in routes if r["status"] != "infeasible"]
    if reach and math.isfinite(dl) and math.isfinite(dl_peak) and dl_peak > dl and all(r["time_s"] > dl for r in reach):
        ctx["late_basis"] = "peak"
        for r in routes:
            r["nominal"] = nominal_metrics(site, r["poly"], r["legs"], ctx)
            if r["time_s"] > dl_peak:
                r["rule_reasons"].append("arrives %.1f min after the expected dose-rate peak" % ((r["time_s"] - dl_peak) / 60))
    return routes


def plan_round_trip(site, ctx, home, target, variants):
    """Out-and-back routes (science sortie). variants: list of (label, band_active_weights)."""
    routes, seen = [], []
    for label, band_w in variants:
        f_out = plan_field(site, (target["x"], target["y"]), band_w, ctx.get("alpha", PARAMS["alphaDeg"]))
        f_back = plan_field(site, (home["x"], home["y"]), band_w, ctx.get("alpha", PARAMS["alphaDeg"]))
        out = trace(site, f_out, (home["x"], home["y"]), (target["x"], target["y"]))
        back = trace(site, f_back, (target["x"], target["y"]), (home["x"], home["y"]))
        if out is None or back is None:
            continue
        poly = out + back[1:]
        key = tuple(np.round(np.asarray(poly).ravel(), 0))
        if key in seen:
            continue
        seen.append(key)
        sh = dict(id=target["id"], name=target["name"])
        r = build_route(site, len(routes), sh, label, poly, [(f_out["next"], len(out)), (f_back["next"], len(back))], ctx)
        c0 = _start_cell(site, f_out, home["x"], home["y"])
        c1 = _start_cell(site, f_back, target["x"], target["y"])
        r["plan_time_s"] = round(float(f_out["time"][c0] + f_back["time"][c1]), 1)
        routes.append(r)
    return routes


def public_route(r):
    keys = ["id", "shelter", "label", "length_m", "time_s", "ascent_m", "max_slope", "o2_margin", "heat_margin", "dose",
            "robustness_nats", "mc_fail_rate", "status", "band_m", "steep_m", "sand_m", "plan_time_s", "rule_ok", "rule_reasons"]
    out = {k: r[k] for k in keys}
    if "nolos_m" in r:                       # metres without radio line of sight to the habitat or the rover
        out["nolos_m"] = r["nolos_m"]
    return out


def write_routes_json(incident_id, routes, path=None):
    path = path or os.path.join(RUNTIME, "routes.json")
    doc = {"incident_id": incident_id, "frame": "local metres e, s and elevation z (MOLA datum)",
           "routes": [dict(id=r["id"], shelter=r["shelter"], label=r["label"], points=r["points"], time_s=r["time_s"],
                           length_m=r["length_m"], status=r["status"]) for r in routes]}
    write_atomic(path, json.dumps(doc).encode())
    return rel(path)
