"""Optional heavy-job server for the live web mode.

The public web app plans and runs its Monte Carlo in the browser and never needs this server. When one is
configured, the app can hand it the jobs too large for a phone or laptop tab: stress tests with thousands of
walkers on the bundled HiRISE site, run by the authoritative Python engine (engine/freeplan.py on
engine/routes.py, engine/stress.py and the numba walk model in engine/walk.py).

    GET  /health   {ok, site, version, ...}
    POST /stress   {start: [x, y], goal: [x, y], n?: int, incident?: "storm" | "quake" | null}

Points are core metres (docs/CONTRACT.md): x east and y south of the corner of the 4 x 4 km walk area.

Run:  .venv\\Scripts\\python.exe -m uvicorn server.app:app --port 8790
"""
import asyncio
import math
import os
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import List, Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from engine import PRODUCT, VERSION  # noqa: E402
from engine import freeplan as FP  # noqa: E402
from engine import hazards as HZ  # noqa: E402
from engine.params import PARAMS  # noqa: E402

SERVER_VERSION = "1"
N_DEFAULT = 2000
N_MAX = 20000
MAX_POLY_POINTS = 400
MIN_DISTANCE_M = 15.0                 # same threshold as the engine's own plan requests
WARM_START, WARM_GOAL = (2200.0, 1400.0), (2050.0, 1650.0)   # walkable points (core metres) for the start-up plan

# A server job must never touch the files the desktop engine serves from runtime/ (it may run on the same
# machine): the plan files go to a private temporary folder and the failure heatmap PNG is not written.
_SCRATCH = tempfile.mkdtemp(prefix="solway-server-")
FP.ROUTES_FILE = os.path.join(_SCRATCH, "plan_routes.json")
FP.TRAJ_FILE = os.path.join(_SCRATCH, "plan_trajectories.json")
HZ.write_png = lambda name, img, directory=None: None

STATE = {"site": None, "hazards": None, "ready": False, "warm_s": None, "error": None, "jobs": 0}
_JOB_LOCK = threading.Lock()          # one heavy job at a time: the walk kernels already use the CPU fully
_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stress")


def _load():
    """Load the site and hazard layers once and compile (or load from cache) the numba kernels."""
    t0 = time.perf_counter()
    try:
        from engine.__main__ import warm
        from engine.hazards import Hazards
        from engine.site import get_site
        site = get_site()
        STATE["site"], STATE["hazards"] = site, Hazards(site)
        warm(site)
        # one small plan compiles the planner kernels too, so the first real request does not pay for it
        FP.plan(site, STATE["hazards"], "server-warm", WARM_START, WARM_GOAL, _ctx(WARM_START, None), n_walkers=8)
        STATE["ready"] = True
    except Exception as e:            # report it on /health rather than refuse to start
        STATE["error"] = "%s: %s" % (type(e).__name__, e)
    STATE["warm_s"] = round(time.perf_counter() - t0, 2)


@asynccontextmanager
async def lifespan(app):
    await asyncio.get_running_loop().run_in_executor(_EXECUTOR, _load)
    yield


app = FastAPI(title=PRODUCT + " heavy-job server", version=SERVER_VERSION, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])


@app.exception_handler(RequestValidationError)
async def bad_request(request: Request, exc: RequestValidationError):
    """A malformed body is a 400 with the reasons, not FastAPI's default 422 (kept for 'no route found')."""
    reasons = ["%s: %s" % (".".join(str(p) for p in e.get("loc", ())[1:]) or "body", e.get("msg")) for e in exc.errors()]
    return JSONResponse(status_code=400, content={"detail": "; ".join(reasons)})


class StressRequest(BaseModel):
    start: List[float] = Field(..., min_length=2, max_length=2, description="core metres [x east, y south]")
    goal: List[float] = Field(..., min_length=2, max_length=2, description="core metres [x east, y south]")
    n: int = Field(N_DEFAULT, ge=1, le=N_MAX, description="Monte Carlo walkers per candidate route")
    incident: Optional[Literal["storm", "quake"]] = None


def _ctx(start, incident):
    """Planning context, as engine/director.py builds it for a plan or an incident.

    none   nominal pace, no storm, rockfall runout band standing
    storm  solar storm at onset (as sep-1): brisk pace, the 30-minute shelter rule counted from the alert,
           first step reactS after it, dose accumulated from the onset
    quake  rockfall runout band active (as quake-1): brisk pace, no storm deadline
    """
    react = PARAMS["reactS"]
    ctx = dict(start_xy=start, band_active=False, alpha=PARAMS["alphaDeg"], pace=PARAMS["paceNominal"],
               sep_elapsed0=-1.0, deadline_walk=math.inf, deadline_peak=math.inf, t_walk=None,
               heat0=None, o2_frac=None, kind="plan")
    if incident == "storm":
        ctx.update(pace=PARAMS["paceStorm"], sep_elapsed0=float(react),
                   deadline_walk=PARAMS["shelterRuleMin"] * 60.0 - react,
                   deadline_peak=PARAMS["sepPeakMin"] * 60.0 - react)
    elif incident == "quake":
        ctx.update(pace=PARAMS["paceStorm"], band_active=True)
    return ctx


def _check_point(site, raw, what):
    x, y = float(raw[0]), float(raw[1])
    if not (math.isfinite(x) and math.isfinite(y)):
        raise HTTPException(400, "%s must be two finite numbers [x, y] in core metres" % what)
    if not site.inside_core(x, y):
        raise HTTPException(400, "%s (%.1f, %.1f) is outside the walk area: x and y must be in 0..%d core metres"
                            % (what, x, y, int(site.size)))
    if site.is_blocked(x, y):
        slope = site.layer_at("slope", x, y)
        why = "a slope of %.0f degrees" % slope if slope > PARAMS["slopeHardDeg"] else "a keep-out cell"
        raise HTTPException(400, "%s is on ground the planner cannot enter (%s). Pick a point nearby" % (what, why))
    return x, y


def _decimate(site, poly, max_points=MAX_POLY_POINTS):
    """Route polyline in core metres [x, y, z], at most max_points points, first and last kept."""
    m = len(poly)
    if m <= max_points:
        idx = list(range(m))
    else:
        idx = sorted({round(k * (m - 1) / (max_points - 1)) for k in range(max_points)})
    return [[round(float(poly[k][0]), 1), round(float(poly[k][1]), 1), round(site.z_at_core(poly[k][0], poly[k][1]), 1)]
            for k in idx]


def _num(v, nd=4):
    if v is None:
        return None
    v = float(v)
    return round(v, nd) if math.isfinite(v) else None


def _run(start, goal, n, incident):
    site, hz = STATE["site"], STATE["hazards"]
    ctx = _ctx(start, incident)
    t0 = time.perf_counter()
    with _JOB_LOCK:
        STATE["jobs"] += 1
        routes, results = FP.plan(site, hz, "server-%d" % STATE["jobs"], start, goal, ctx, seen=None, n_walkers=n)
    ms = (time.perf_counter() - t0) * 1000.0
    by_id = {res["route_id"]: res for res in results}
    out = []
    for r in routes:
        res = by_id.get(r["id"])
        out.append(dict(
            id=r["id"], label=r["label"], status=r["status"],
            time_s=_num(r["time_s"], 1), length_m=_num(r["length_m"], 1), ascent_m=_num(r.get("ascent_m"), 1),
            max_slope_deg=_num(r.get("max_slope"), 1),
            o2_margin=_num(r.get("o2_margin"), 3), heat_margin=_num(r.get("heat_margin"), 3), dose_msv=_num(r.get("dose"), 4),
            rule_ok=r.get("rule_ok"), rule_reasons=r.get("rule_reasons", []),
            fail_rate=_num(res["mc_fail_rate"]) if res else None,
            ci95=[_num(v) for v in res["mc_ci"]] if res else None,
            n=res["n"] if res else 0,
            classes=res["classes"] if res else None,
            arrival_s=res["arrival_s"] if res else None,
            failures=[dict(cls=f["class"], x=round(f["e"] - site.e0, 1), y=round(f["s"] - site.s0, 1), t=f["t"],
                           summary=f["summary"]) for f in res["failures"]] if res else [],
            polyline=_decimate(site, r["poly"]),
        ))
    rec = FP.recommended(routes) if routes else None
    return dict(ok=True, engine="python", engine_version=VERSION, method="mc", frame="core metres x east, y south, z MOLA",
                incident=incident, n=n, start=list(start), goal=list(goal), recommended=rec, routes=out,
                compute_ms=round(ms, 1))


@app.get("/health")
async def health():
    site = STATE["site"]
    return dict(ok=STATE["ready"], site="NE Melas Chasma (HiRISE DTM, 4 x 4 km core)" if site else None,
                version="%s engine %s, server %s" % (PRODUCT, VERSION, SERVER_VERSION),
                warm_s=STATE["warm_s"], n_max=N_MAX, jobs=STATE["jobs"], error=STATE["error"])


@app.post("/stress")
async def stress(req: StressRequest):
    if not STATE["ready"]:
        raise HTTPException(503, "The engine is not ready: %s" % (STATE["error"] or "still loading the site"))
    site = STATE["site"]
    start = _check_point(site, req.start, "start")
    goal = _check_point(site, req.goal, "goal")
    if math.hypot(goal[0] - start[0], goal[1] - start[1]) < MIN_DISTANCE_M:
        raise HTTPException(400, "start and goal are less than %.0f m apart" % MIN_DISTANCE_M)
    try:
        return await asyncio.get_running_loop().run_in_executor(_EXECUTOR, _run, start, goal, req.n, req.incident)
    except FP.PlanError as e:
        raise HTTPException(422, str(e)) from None
