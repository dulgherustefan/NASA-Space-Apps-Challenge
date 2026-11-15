"""Free planning: a walking route between two points, asked for by the operator before a walk.

No incident is involved. The route comes from the same planner and hazard layers as the incident routes
(engine/routes.py on rl/planner.py), with the same walk model for its figures, and the stress test is the
engine's small Monte Carlo run, labelled "local preview". A plan never moves the crew and never replaces the
routes of an incident: it is written to its own files in runtime/.

    runtime/plan_routes.json         same layout as routes.json
    runtime/plan_trajectories.json   same layout as trajectories.json
"""
import math
import os

import numpy as np

from . import RUNTIME, maplayers
from . import routes as R
from . import stress as S
from .params import PARAMS

ROUTES_FILE = os.path.join(RUNTIME, "plan_routes.json")
TRAJ_FILE = os.path.join(RUNTIME, "plan_trajectories.json")
NEAR_PLACE_M = 40.0          # a point this close to a named place takes its name
PLAN_WALKERS = 1000          # Monte Carlo walkers per planned route (the incident preview uses mcWalkers)


class PlanError(ValueError):
    """A plan request that cannot be answered. The message is shown to the operator as it is."""


def point(site, raw, what):
    """Core metres (x, y) of a request point {"e", "s"} in local metres, or PlanError with the reason."""
    if not isinstance(raw, dict):
        raise PlanError("The %s needs a point {e, s} in local metres" % what)
    try:
        e, s = float(raw.get("e")), float(raw.get("s"))
    except (TypeError, ValueError):
        raise PlanError("The %s needs numbers for e and s, in local metres" % what) from None
    if not (math.isfinite(e) and math.isfinite(s)):
        raise PlanError("The %s needs finite numbers for e and s" % what)
    x, y = site.local_to_core(e, s)
    if not site.inside_core(x, y):
        raise PlanError("The %s is outside the %d x %d km walk area covered by the 1 m elevation model" % (
            what, round(site.size / 1000), round(site.size / 1000)))
    if site.is_blocked(x, y):
        slope = site.layer_at("slope", x, y)
        why = "a slope of %.0f degrees" % slope if slope > PARAMS["slopeHardDeg"] else "a keep-out cell"
        raise PlanError("The %s is on ground the planner cannot enter (%s). Pick a point nearby" % (what, why))
    return x, y


def place_name(scenario, x, y):
    """Name of the scenario place within NEAR_PLACE_M of a point, or None."""
    best, bd = None, NEAR_PLACE_M
    for p in scenario.places.values():
        if p.get("kind") == "epicentre":
            continue
        d = math.hypot(p["x"] - x, p["y"] - y)
        if d <= bd:
            best, bd = p["name"], d
    return best


def public_point(site, x, y, label):
    e, s = site.core_to_local(x, y)
    return dict(e=round(e, 1), s=round(s, 1), z=round(site.z_at_core(x, y), 1), label=label)


def plan(site, hazards, plan_id, start_xy, goal_xy, ctx, seen=None, n_walkers=None):
    """Routes from start to goal with their local stress test. Returns (routes, results); raises PlanError.

    Two planner settings are tried, as for the science sortie: the hazard weights as they stand, and the weights
    with the rockfall band treated as active. The second is kept only when it gives a different path.
    """
    goal = dict(id="P", name="Destination", x=goal_xy[0], y=goal_xy[1], open=True)
    variants = [("Direct", ctx["band_active"])]
    if not ctx["band_active"]:
        variants.append(("Clear of the rockfall band", True))
    routes, seen_paths = [], []
    for label, band_w in variants:
        field = R.plan_field(site, goal_xy, band_w, ctx.get("alpha", PARAMS["alphaDeg"]))
        poly = R.trace(site, field, start_xy, goal_xy)
        if poly is None or len(poly) < 2:
            continue
        key = tuple(np.round(np.asarray(poly).ravel(), 0))
        if key in seen_paths:
            continue
        seen_paths.append(key)
        r = R.build_route(site, len(routes), goal, label, poly, [(field["next"], len(poly))], dict(ctx))
        c0 = R._start_cell(site, field, *start_xy)
        r["plan_time_s"] = round(float(field["time"][c0]), 1) if c0 >= 0 else None
        if seen is not None:
            r["nolos_m"] = round(maplayers.metres_without_sight(site, seen, r["points"]), 0)
        routes.append(r)
    if not routes:
        raise PlanError("No walkable route between these two points on the 5 m grid: steep or keep-out ground lies in between")
    results = []
    for r in routes:
        if r["status"] == "infeasible":
            continue
        res = S.run_local(site, hazards, plan_id, r, n=n_walkers or PLAN_WALKERS)
        r["mc_fail_rate"] = res["mc_fail_rate"]
        r["status"] = "tested"
        results.append(res)
    R.write_routes_json(plan_id, routes, path=ROUTES_FILE)
    S.write_trajectories(plan_id, results, path=TRAJ_FILE)
    return routes, results


def recommended(routes):
    """The route shown first: lowest failure rate among the walkable ones, then the shorter walk."""
    ok = [r for r in routes if r["status"] != "infeasible"] or routes
    return min(ok, key=lambda r: (r["mc_fail_rate"] if r["mc_fail_rate"] is not None else 1.0, r["time_s"]))["id"]
