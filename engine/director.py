"""Incident director: for each scripted incident a state machine detect -> assess -> simulate -> respond -> idle.

It owns the mission clock and the crew, emits the WebSocket messages of docs/CONTRACT.md section 6 in order,
sends the OSC stream of section 3, and runs the heavy work (planning, stress tests) through an executor so the
10 Hz snapshot loop never waits for it. `tick(wall_dt)` is the only entry point that moves time.
"""
import logging
import math
from concurrent.futures import Future

import numpy as np

from . import PRODUCT, VERSION
from . import maplayers
from . import routes as R
from . import stress as S
from .climate import load_weather
from .clock import MissionClock, parse_utc
from .hazards import LABELS, overlay_file, write_png
from .params import PARAMS, SIM
from .walk import TR, make_params, sep_rate

log = logging.getLogger("engine.director")

C_WALK, C_IDLE, C_ARRIVED, C_LATE = 0, 1, 6, 7
O2_TANK = SIM["O2_TANK_KG"]


class SyncExecutor:
    """Runs jobs immediately (used by --check and the tests)."""

    def submit(self, fn, *args, **kw):
        f = Future()
        try:
            f.set_result(fn(*args, **kw))
        except Exception as e:  # surfaced by the caller through f.result()
            f.set_exception(e)
        return f

    def shutdown(self, wait=True):
        pass


class CrewMember:
    def __init__(self, spec):
        self.id = int(spec["id"])
        self.name = spec["name"]
        self.delay = float(spec.get("follow_delay_s", 0.0))
        self.lateral = float(spec.get("lateral_m", 0.0))


class Director:
    def __init__(self, site, hazards, scenario, osc, executor=None, n_walkers=None):
        self.site = site
        self.hz = hazards
        self.sc = scenario
        self.osc = osc
        self.ex = executor or SyncExecutor()
        self.n_walkers = n_walkers
        m = scenario.mission
        self.clock = MissionClock(parse_utc(m["start_utc"]), m["site_east_lon"], m["site_lat"], speed=1.0)
        self.crew = [CrewMember(c) for c in m["crew"]]
        self.weather = load_weather()
        self.comm_job = self.ex.submit(maplayers.ensure, site, self._comm_sources())
        self.pace = dict(nominal=PARAMS["paceNominal"], storm=PARAMS["paceStorm"])
        self.outbox = []
        self.reset(emit=False)

    def _comm_sources(self):
        """Radio antennas a walker can talk to directly: habitat and rover (core metres, height above ground)."""
        out = []
        for p in self.sc.places.values():
            if p["kind"] == "habitat":
                out.append((p["x"], p["y"], PARAMS["antHabitatM"]))
            elif p["kind"] == "rover":
                out.append((p["x"], p["y"], PARAMS["antRoverM"]))
        return out

    def _comm_seen(self):
        """Line-of-sight mask once it is ready; None while it is still being computed or if it failed."""
        job = self.comm_job
        if isinstance(job, Future):
            if not job.done() or job.exception() is not None:
                return None
            return job.result()
        return job

    # ------------------------------------------------------------------------------------ state
    def reset(self, emit=True):
        self.clock.reset()
        self.wall = 0.0
        self.phase = "idle"
        self.incident_id = None
        self.incident = None
        self.demo = False
        self.program = None
        self.done = False
        self.sep_t0 = None
        self.quake_t0 = None
        self.inc_t0 = None                   # mission time the current incident was detected (its alert)
        self.routes = []
        self.results = {}
        self.decision = None
        self.history = {}
        self.agents = []
        self.replay = None
        self.overlays = {}
        self.route_state = {}
        self.osc_acc = 0.0
        self.clock_acc = 0.0
        self.error = None
        s = self.sc.place("S")
        self._park(s["x"], s["y"], status=C_IDLE)
        self.dose_base = 0.0
        self.walk = None                     # dict(track, t0, route, incident_id)
        if emit:
            self.log("Mission reset to t = 0", "info")
            self.osc.incident("none", "idle", 0.0, 0.0, 0.0)
            self._set_overlays({})

    def _park(self, x, y, status=C_IDLE, heading=0.0, heat_kj=None, o2_kg=None, dose=0.0):
        self.parked = dict(x=float(x), y=float(y), heading=float(heading), status=status,
                           heat=PARAMS["heat0KJ"] if heat_kj is None else heat_kj,
                           o2=PARAMS["o2Start"] * O2_TANK if o2_kg is None else o2_kg, dose=dose)

    # ------------------------------------------------------------------------------------ messages
    def emit(self, msg):
        msg = dict(msg)
        msg.setdefault("t", round(self.clock.t, 1))
        out = {"type": msg.pop("type"), "t": msg.pop("t")}
        out.update(msg)
        self.outbox.append(out)
        return out

    def drain(self):
        out, self.outbox = self.outbox, []
        return out

    def log(self, text, level="info", source="engine"):
        log.info(text)
        return self.emit(dict(type="log", level=level, text=text, source=source))

    def hello(self):
        return dict(type="hello", t=round(self.clock.t, 1), product=PRODUCT, version=VERSION, site=self.site.hello_site(),
                    places=self.sc.hello_places(), scenario=self.sc.hello_scenario(),
                    crew=[dict(id=c.id, name=c.name) for c in self.crew],
                    params_file="runtime/params.json", ast=S.ast_present(),
                    weather=self.weather)

    # ------------------------------------------------------------------------------------ crew
    def walk_elapsed(self):
        if not self.walk:
            return 0.0
        return max(0.0, self.clock.t - self.walk["t0"])

    def walk_done(self):
        if not self.walk:
            return True
        end = self.walk["track"][-1, TR["t"]]
        return self.walk_elapsed() >= end + max(c.delay for c in self.crew)

    def crew_state(self, c):
        """Position and consumables of one crew member at the current mission time (core metres)."""
        p = self.parked
        if not self.walk:
            x, y, h, st, heat, o2, dose, v = p["x"], p["y"], p["heading"], p["status"], p["heat"], p["o2"], p["dose"], 0.0
        else:
            trk = self.walk["track"]
            tt = trk[:, TR["t"]]
            tau = self.walk_elapsed() - c.delay
            tau = min(max(tau, 0.0), tt[-1])
            k = int(np.searchsorted(tt, tau, side="right")) - 1
            k = min(max(k, 0), len(tt) - 1)
            if k < len(tt) - 1:
                w = (tau - tt[k]) / max(tt[k + 1] - tt[k], 1e-9)
                row = trk[k] * (1 - w) + trk[k + 1] * w
            else:
                row = trk[k]
            x, y = row[TR["x"]], row[TR["y"]]
            h = trk[min(k + 1, len(tt) - 1), TR["heading"]]
            heat, o2, v = row[TR["heat"]], row[TR["o2"]], row[TR["v"]]
            dose = self.dose_base + row[TR["dose"]]
            if self.walk_elapsed() - c.delay <= 0:
                st, v = C_IDLE, 0.0
            elif tau >= tt[-1]:
                st, v = int(trk[-1, TR["status"]]), 0.0
            else:
                st = int(trk[min(k + 1, len(tt) - 1), TR["status"]])
        if c.lateral:
            hr = math.radians(h)
            x += c.lateral * math.cos(hr)
            y += c.lateral * math.sin(hr)
        return dict(x=float(x), y=float(y), heading=float(h) % 360.0, status=int(st), heat=float(heat), o2=float(o2),
                    dose=float(dose), v=float(v))

    def crew_public(self):
        out = []
        for c in self.crew:
            s = self.crew_state(c)
            e, sl = self.site.core_to_local(s["x"], s["y"])
            out.append(dict(id=c.id, name=c.name, e=round(e, 1), s=round(sl, 1), z=round(self.site.z_at_core(s["x"], s["y"]), 1),
                            heading=round(s["heading"], 1), pace=round(s["v"], 2),
                            o2=round(max(0.0, s["o2"]) / O2_TANK, 3), heat=round(s["heat"] / PARAMS["heatMaxKJ"], 3),
                            dose=round(s["dose"], 4), status=s["status"]))
        return out

    def _freeze_crew(self, status=C_IDLE):
        """Stop the crew where it is (keeps consumables)."""
        lead = self.crew_state(self.crew[0])
        self._park(lead["x"], lead["y"], status=status, heading=lead["heading"], heat_kj=lead["heat"], o2_kg=lead["o2"],
                   dose=lead["dose"])
        self.dose_base = lead["dose"]
        self.walk = None

    # ------------------------------------------------------------------------------------ sensors
    def sensors(self):
        lead = self.crew_state(self.crew[0])
        dr = PARAMS["gcrRate"]
        if self.sep_t0 is not None and self.clock.t >= self.sep_t0:
            dr += sep_rate(self.clock.t - self.sep_t0, PARAMS["sepPeakMin"], PARAMS["sepTotal"], PARAMS["sepDecayH"])
        shield = min(0.95, PARAMS["shieldK"] * self.site.layer_at("sky", lead["x"], lead["y"]))
        if lead["status"] in (C_ARRIVED, C_LATE) and self.walk and self.walk.get("shield") is not None:
            shield = max(shield, self.walk["shield"])
        seis = 0.0
        if self.quake_t0 is not None and self.clock.t >= self.quake_t0:
            inc = self.sc.incidents["quake-1"]
            seis = inc.get("seismic_peak", 0.05) * math.exp(-(self.clock.t - self.quake_t0) / inc.get("seismic_decay_s", 45))
        return dict(dose_rate=round(dr * (1 - shield), 2), seismic=round(seis, 4), tau=PARAMS["tau"],
                    dose_rate_open=round(dr, 2))

    def env(self, cs):
        """Light at the site now, computed from the Sun position: daylight left, Sun height, season."""
        return dict(daylight_s=cs["daylight_s"], sun_el=cs["sun_el"], sun_source=cs["sun_source"], ls=cs["ls"],
                    mars_year=cs["mars_year"])

    def snapshot(self):
        cs = self.clock.state()
        clock = {k: cs[k] for k in ("t", "sol", "lmst", "ltst", "utc", "speed", "paused", "sun_az", "sun_el")}
        msg = dict(type="snapshot", t=cs["t"], clock=clock, phase=self.phase, incident_id=self.incident_id,
                   crew=self.crew_public(), sensors=self.sensors(), light_time_s=cs["light_time_s"], env=self.env(cs))
        if self.agents:
            msg["agents"] = self.agents
        if self.walk:
            msg["walk"] = dict(route_id=self.walk["route"]["id"], incident_id=self.walk["incident_id"],
                               elapsed_s=round(self.walk_elapsed(), 1), time_s=self.walk["route"]["time_s"])
        return msg

    # ------------------------------------------------------------------------------------ OSC helpers
    def _set_overlays(self, wanted):
        for layer in ("hazard", "slope", "rockfall", "sand", "sky", "dose", "failures"):
            op = float(wanted.get(layer, 0.0))
            if self.overlays.get(layer) != op:
                self.overlays[layer] = op
                self.osc.overlay(layer, op)

    def _route_osc(self, rid, state):
        if self.route_state.get(rid) != state:
            self.route_state[rid] = state
            self.osc.route(rid, state)

    def _incident_osc(self, phase, intensity=1.0):
        inc = self.incident
        e, s = self.sc.incident_position(inc)
        if e is None:
            lead = self.crew_state(self.crew[0])
            e, s = self.site.core_to_local(lead["x"], lead["y"])
        self.osc.incident(inc["kind"], phase, intensity, e, s)

    def _phase(self, phase, intensity=1.0):
        self.phase = phase
        if self.incident:
            self._incident_osc(phase, intensity)

    # ------------------------------------------------------------------------------------ commands
    def command(self, cmd):
        """Dashboard command dict. Returns a short status string; never raises."""
        try:
            name = cmd.get("cmd")
            if name == "start":
                if self.program is None:
                    self.program = self._program()
                self.clock.paused = False
                self.log("Mission clock running")
            elif name == "pause":
                self.clock.paused = True
                self.log("Paused")
            elif name == "resume":
                self.clock.paused = False
                self.log("Resumed")
            elif name == "reset":
                self.reset()
            elif name == "speed":
                v = float(cmd.get("value", 1))
                if not math.isfinite(v) or v <= 0 or v > 10000:
                    raise ValueError("speed must be in (0, 10000]")
                self.clock.speed = v
                self.log("Clock speed x%g" % v)
            elif name == "trigger":
                iid = cmd.get("id")
                if iid not in self.sc.incidents:
                    raise ValueError("unknown incident %r" % iid)
                self.program = self._program(start_at=iid)
                self.clock.hold_at = None
                self.clock.paused = False
                self.log("Incident %s triggered by the operator" % iid)
            elif name == "choose":
                self._choose_manual(int(cmd.get("route_id")))
            elif name == "cue":
                self.osc.cue(str(cmd.get("name", "overview")), float(cmd.get("duration", 4.0)))
            elif name == "demo":
                self.reset()
                self.demo = True
                self.program = self._program()
                self.clock.paused = False
                self.clock.speed = self.sc.demo["lead_in_speed"]
                self.log("Demo: three incidents back to back")
            else:
                raise ValueError("unknown command %r" % name)
            return "ok"
        except Exception as e:
            self.log("Command rejected: %s" % e, "warn")
            return "error: %s" % e

    # ------------------------------------------------------------------------------------ main tick
    def tick(self, wall_dt):
        self.wall += wall_dt
        self.clock.advance(wall_dt)
        if self.program is not None:
            try:
                next(self.program)
            except StopIteration:
                self.program = None
                self.done = True
            except Exception as e:  # keep serving; report it
                log.exception("director program failed")
                self.error = repr(e)
                self.program = None
                self.phase = "idle"
                self.log("Engine error: %s" % e, "error")
        self._update_agents()
        # OSC streams
        self.osc_acc += wall_dt
        self.clock_acc += wall_dt
        if self.osc_acc >= 0.05 - 1e-9:
            self.osc_acc = 0.0
            for cp in self.crew_public():
                self.osc.crew(cp["id"], cp["e"], cp["s"], cp["z"], cp["heading"], cp["pace"], cp["status"])
            if self.phase == "simulate":
                for a in self.agents:
                    self.osc.agent(a["route"], a["id"], a["e"], a["s"], a["z"], a["heading"], a["status"])
        if self.clock_acc >= 0.5 - 1e-9:
            self.clock_acc = 0.0
            cs = self.clock.state()
            self.osc.clock(cs["t"], cs["speed"], cs["sun_az"], cs["sun_el"])

    # ------------------------------------------------------------------------------------ waits (generator helpers)
    def _hold(self, key):
        return float(self.sc.demo[key])

    def _wait_wall(self, seconds):
        end = self.wall + seconds
        while self.wall < end - 1e-9:
            yield

    def _await(self, fut):
        while not fut.done():
            yield
        return fut.result()

    def _speed(self, v):
        if self.demo:
            self.clock.speed = float(v)

    # ------------------------------------------------------------------------------------ program
    def _program(self, start_at=None):
        order = self.sc.order
        k0 = order.index(start_at) if start_at else 0
        for iid in order[k0:]:
            inc = self.sc.incidents[iid]
            trig = inc["trigger"]
            if iid == start_at:
                pass                                           # operator trigger: fire now
            elif trig["type"] == "time":
                self.clock.hold_at = trig["at_s"]              # fire at at_s exactly, not one fast tick later
                while self.clock.t < trig["at_s"]:
                    yield
            elif trig["type"] == "walk":
                while self.walk and self.walk_elapsed() < trig["after_walk_s"] and not self.walk_done():
                    self.clock.hold_at = self.walk["t0"] + trig["after_walk_s"]
                    yield
            elif trig["type"] == "sol":
                while not self.walk_done():
                    yield
                self.phase = "idle"
                yield from self._wait_wall(self._hold("idle_between_s"))
            self.clock.hold_at = None
            yield from self._incident(iid)
        while not self.walk_done():
            yield
        self.phase = "idle"
        self._speed(1)
        self.log("All scripted incidents played", "info")
        self.osc.cue("overview", 6.0)

    def _ctx(self, inc):
        """Planning context for an incident, counted from its alert (inc_t0).

        The crew starts walking reactS after the alert (t_walk), whatever the demo pacing of the
        Assess and Simulate phases; _start_walk holds the crew until then, so the dose, the shelter
        rule and the scripted walk trigger of the next incident all use the same start time.
        """
        t = self.inc_t0 if self.inc_t0 is not None else self.clock.t
        kind = inc["kind"]
        rule = PARAMS["shelterRuleMin"] * 60.0
        peak = PARAMS["sepPeakMin"] * 60.0
        react = PARAMS["reactS"]
        lead = self.crew_state(self.crew[0])
        if inc.get("start") == "crew":
            start = (lead["x"], lead["y"])
            heat0, o2f = lead["heat"], max(0.0, lead["o2"]) / O2_TANK
        else:
            p = self.sc.place(inc["start"])
            start = (p["x"], p["y"])
            heat0, o2f = None, None
        if inc.get("sep") == "onset":
            sep0, deadline, dl_peak = react, rule - react, peak - react
        elif inc.get("sep") == "continues" and self.sep_t0 is not None:
            el = t - self.sep_t0
            sep0, deadline, dl_peak = el + react, rule - el - react, peak - el - react
        else:
            sep0, deadline, dl_peak = -1.0, math.inf, math.inf
        # a new EVA (science sortie) has no alert: the crew walks as soon as the route is chosen
        t_walk = t + react if math.isfinite(deadline) else None
        return dict(start_xy=start, band_active=bool(inc.get("band_active")), alpha=PARAMS["alphaDeg"],
                    pace=self.pace[inc.get("pace", "nominal")], sep_elapsed0=sep0, deadline_walk=deadline,
                    deadline_peak=dl_peak, t_walk=t_walk, heat0=heat0, o2_frac=o2f, kind=kind)

    def _plan(self, inc, ctx, shelters):
        if inc["kind"] == "science":
            home = self.sc.place(inc["home"])
            target = self.sc.place(inc["target"])
            variants = [(v["label"], v["band_weights"] == "active") for v in inc["variants"]]
            return R.plan_round_trip(self.site, ctx, home, target, variants)
        return R.plan_candidates(self.site, ctx, shelters)

    def _stress(self, iid, route, ast):
        local = S.run_local(self.site, self.hz, iid, route, n=self.n_walkers)
        try:
            ast_res = S.from_ast(ast, self.site, iid, route) if ast else None
        except Exception:                    # data/ast comes from another machine: an odd file must not stop the demo
            log.exception("data/ast result for %s route %d unusable; using the local preview", iid, route["id"])
            ast_res = None
        return local, ast_res

    def _incident(self, iid):
        inc = self.sc.incidents[iid]
        dm = self.sc.demo
        self.incident, self.incident_id = inc, iid
        self.routes, self.results, self.decision = [], {}, None
        self.route_state = {}
        # ---------------------------------------------------------------- detect
        if inc.get("trigger", {}).get("type") == "sol" or inc.get("new_eva"):
            if self.walk:
                self._freeze_crew()
            target_t = (self.sep_t0 + inc["trigger"]["after_sep_s"]) if self.sep_t0 is not None else inc["at_s"]
            self.clock.jump_to(max(self.clock.t, target_t))
            p = self.sc.place(inc["start"])
            self._park(p["x"], p["y"], status=C_IDLE)
            self.dose_base = 0.0
            self.log("One sol later: new EVA from the %s" % p["name"].lower())
        elif self.walk:
            self._freeze_crew()
        self.inc_t0 = self.clock.t
        if inc["kind"] == "sep":
            self.sep_t0 = self.clock.t
        if inc["kind"] == "quake":
            self.quake_t0 = self.clock.t
        self._speed(dm["phase_speed"])
        self._phase("detect", 1.0)
        e, s = self.sc.incident_position(inc)
        self.emit(dict(type="incident", id=iid, kind=inc["kind"], title=inc["title"], summary=inc["summary"],
                       source=inc["source"], scenario=True, e=e, s=s, params=self.sc.params_for(inc)))
        self.log("%s: %s" % (inc["title"], inc["summary"]), "warn" if inc["kind"] != "science" else "info", "scenario")
        self.osc.cue("wall" if inc["kind"] == "quake" else "overview", 4.0)
        yield from self._wait_wall(dm["hold_detect_s"])
        # ---------------------------------------------------------------- assess
        self._phase("assess", 0.8)
        ctx = self._ctx(inc)
        shelters = self.sc.shelters(inc, ctx["band_active"])
        plan_job = self.ex.submit(self._plan, inc, ctx, shelters)
        files = {}
        if inc["kind"] == "quake":
            files["hazard"] = write_png("overlay_hazard.png", self.hz.img_hazard(True))
        elif "hazard" in inc.get("overlays", []):
            files["hazard"] = write_png("overlay_hazard.png", self.hz.img_hazard(False))
        if "dose" in inc.get("overlays", []):
            files["dose"] = write_png("overlay_dose.png", self.hz.img_dose(None))
        if files:
            self.osc.reload("overlay")
        overlays = [dict(layer=l, file=overlay_file(l), label=LABELS[l]) for l in inc.get("overlays", [])]
        self._set_overlays({l: (0.7 if i == 0 else 0.45) for i, l in enumerate(inc.get("overlays", []))})
        sh_pub = [dict(id=s_["id"], name=s_["name"], e=s_["e"], s=s_["s"], open=s_["open"], reason=s_["reason"],
                       shield=s_["shield"]) for s_ in shelters]
        if inc["kind"] == "science":
            home, target = self.sc.place(inc["home"]), self.sc.place(inc["target"])
            sh_pub = [dict(id=target["id"], name=target["name"], e=round(target["e"], 1), s=round(target["s"], 1), open=True,
                           reason="Science target (inside the rockfall runout band)"),
                      dict(id=home["id"], name=home["name"], e=round(home["e"], 1), s=round(home["s"], 1), open=True,
                           reason="Start and end of the sortie")]
        limits = dict(shelter_s=round(ctx["deadline_walk"], 1) if math.isfinite(ctx["deadline_walk"]) else None,
                      peak_s=round(ctx["deadline_peak"], 1) if math.isfinite(ctx["deadline_peak"]) else None)
        self.emit(dict(type="assessment", incident_id=iid, changes=self.sc.assessment_changes(inc, ctx), overlays=overlays,
                       shelters=sh_pub, limits=limits))
        closed = [s_ for s_ in shelters if not s_["open"]]
        for s_ in closed:
            self.log("%s closed: %s" % (s_["name"], s_["reason"]), "warn")
        yield from self._wait_wall(dm["hold_assess_s"])
        routes = yield from self._await(plan_job)
        self.routes = routes
        if not routes:
            self.log("No route found to any open shelter", "error")
            self._phase("idle", 0.0)
            return
        seen = self._comm_seen()
        if seen is not None:
            for r in routes:
                r["nolos_m"] = round(maplayers.metres_without_sight(self.site, seen, r["points"]), 0)
        rfile = R.write_routes_json(iid, routes)
        self.osc.reload("routes")
        for r in routes:
            self._route_osc(r["id"], "candidate")
        self._emit_routes()
        self.log("%d candidate routes planned" % len(routes))
        # ---------------------------------------------------------------- simulate
        self._phase("simulate", 0.6)
        ast = S.load_ast()
        jobs = []
        for r in routes:
            if r["status"] == "candidate":
                r["status"] = "testing"
                self._route_osc(r["id"], "testing")
            jobs.append((r, self.ex.submit(self._stress, iid, r, ast)))
        self._emit_routes()
        self.log("Stress test: %s" % ("results from data/ast with local replays" if ast else
                                      "local preview, %d walkers per route" % int(self.n_walkers or PARAMS["mcWalkers"])))
        local_results = []
        for r, fut in jobs:
            local, ast_res = yield from self._await(fut)
            res = ast_res or local
            local_results.append(local)
            self.results[r["id"]] = res
            r["robustness_nats"] = res.get("robustness_nats")
            r["mc_fail_rate"] = res.get("mc_fail_rate")
            r["stress_source"] = res["source"]
            r["fail_ci"] = res.get("mc_ci")
            if r["status"] == "testing":
                r["status"] = "tested"
            self.emit(dict(type="stress", **S.public(res)))
            yield from self._wait_wall(dm["stress_spacing_s"])
        S.write_trajectories(iid, local_results)
        self.osc.reload("trajectories")
        dens = sum(res["_density"] for res in local_results)
        write_png("overlay_failures.png", self.hz.img_failures(dens))
        self.osc.reload("overlay")
        self._set_overlays({**{l: 0.35 for l in inc.get("overlays", [])[:1]}, "failures": 0.8})
        self._emit_routes()
        self.replay = dict(runs=[run for res in local_results for run in res["_runs"]], t0=self.wall,
                           dur=dm["replay_s"])
        self.osc.cue("failure", dm["replay_s"])
        yield from self._wait_wall(dm["replay_s"])
        self.replay = None
        self.agents = []
        # ---------------------------------------------------------------- respond
        self._phase("respond", 0.4)
        chosen, reasons, avoided = self._choose(inc, shelters)
        self._decide(chosen, True, reasons, avoided)
        self.osc.cue("shelter", 3.0)
        yield from self._wait_wall(dm["hold_respond_s"])
        self._start_walk(self.decision["route"])
        self.osc.cue("follow", 8.0)
        self._phase("idle", 0.2)
        r = self.decision["route"]
        if self.demo:
            span = r["time_s"]
            nxt = self._next_incident(iid)
            if nxt and self.sc.incidents[nxt]["trigger"]["type"] == "walk":
                span = min(span, self.sc.incidents[nxt]["trigger"]["after_walk_s"])
            self.clock.speed = max(dm["walk_speed_min"], span / dm["walk_wall_max_s"])

    def _next_incident(self, iid):
        k = self.sc.order.index(iid)
        return self.sc.order[k + 1] if k + 1 < len(self.sc.order) else None

    # ------------------------------------------------------------------------------------ routes & decision
    def _emit_routes(self):
        self.emit(dict(type="routes", incident_id=self.incident_id, file="runtime/routes.json",
                       routes=[R.public_route(r) for r in self.routes]))

    def _choose(self, inc, shelters):
        rs = [r for r in self.routes if r["status"] != "infeasible"]
        ok = [r for r in rs if r["rule_ok"]]
        pool = ok or rs or self.routes
        have_rob = [r for r in pool if r.get("robustness_nats") is not None]

        def fr(r):
            return r["mc_fail_rate"] if r.get("mc_fail_rate") is not None else 1.0

        def fr_not_late(r):
            cl = self.results.get(r["id"], {}).get("classes")
            if isinstance(cl, dict):
                return sum(v for c, v in cl.items() if c != "late" and isinstance(v, (int, float)))
            return fr(r)

        by_peak = bool(pool) and pool[0]["ctx"].get("late_basis") == "peak"
        if not ok and by_peak:
            # the rule is out of reach for every route; lateness is counted against the storm peak
            # (routes.plan_candidates), so the failure rate tells the routes apart again
            chosen = min(pool, key=lambda r: (round(fr(r), 3), r["time_s"]))
        elif not ok:
            # nothing meets the rules: get under cover as fast as possible
            chosen = min(pool, key=lambda r: (r["time_s"], fr_not_late(r)))
        elif have_rob:
            chosen = max(have_rob, key=lambda r: (r["robustness_nats"], -fr(r)))
        else:
            chosen = min(pool, key=lambda r: (round(fr(r), 3), r.get("band_m", 0), r["time_s"]))
        reasons = []
        res = self.results.get(chosen["id"], {})
        rule_txt = "the %d-minute rule" % PARAMS["shelterRuleMin"] if math.isfinite(chosen["ctx"]["deadline_walk"]) else "the rules"
        if ok:
            if have_rob:
                reasons.append("Highest robustness (%.1f nats) of the routes that meet %s" % (chosen["robustness_nats"], rule_txt))
            else:
                reasons.append("Lowest failure rate of the routes that meet %s: %.1f%% (95%% CI %.1f-%.1f%%, %s, n=%s)" % (
                    rule_txt, 100 * fr(chosen), 100 * (res.get("mc_ci") or [0, 0])[0], 100 * (res.get("mc_ci") or [0, 0])[1],
                    res.get("source", "local preview"), res.get("n")))
        elif by_peak:
            reasons.append("No open shelter can meet the %d-minute rule any more; routes ranked by failures against the expected "
                           "dose-rate peak (%d min after the storm alert)" % (PARAMS["shelterRuleMin"], PARAMS["sepPeakMin"]))
            for why in chosen["rule_reasons"]:
                reasons.append("Chosen route %s" % why)
            reasons.append("Lowest failure rate: %.1f%% (95%% CI %.1f-%.1f%%, %s, n=%s), of which %.1f%% arrive after the peak" % (
                100 * fr(chosen), 100 * (res.get("mc_ci") or [0, 0])[0], 100 * (res.get("mc_ci") or [0, 0])[1],
                res.get("source", "local preview"), res.get("n"), 100 * (fr(chosen) - fr_not_late(chosen))))
        else:
            reasons.append("No open shelter meets every rule; the fastest reachable one cuts the time in the open")
            for why in chosen["rule_reasons"]:
                reasons.append("Chosen route %s" % why)
            reasons.append("Failures other than lateness: %.1f%% (%s, n=%s)" % (
                100 * fr_not_late(chosen), res.get("source", "local preview"), res.get("n")))
        dl = chosen["ctx"]["deadline_walk"]
        if by_peak:
            reasons.append("Nominal walk %.1f min with %.1f min available under the shelter rule and %.1f min before the expected peak" % (
                chosen["time_s"] / 60, dl / 60, chosen["ctx"]["deadline_peak"] / 60))
        elif math.isfinite(dl):
            reasons.append("Nominal walk %.1f min with %.1f min available under the shelter rule" % (chosen["time_s"] / 60, dl / 60))
        else:
            reasons.append("Nominal walk %.1f min" % (chosen["time_s"] / 60))
        if chosen.get("band_m", 0) < 1 and any(r.get("band_m", 0) >= 1 for r in self.routes):
            reasons.append("Stays out of the rockfall runout band")
        elif chosen.get("band_m", 0) >= 1:
            reasons.append("Crosses %.0f m of the rockfall runout band" % chosen["band_m"])
        reasons.append("O2 on arrival %.0f min of use (reserve %d min)" % (chosen["o2_min"], PARAMS["o2ReserveMin"]))
        avoided = []
        for s_ in shelters:
            if not s_["open"]:
                avoided.append(dict(label=s_["name"], detail="Closed: " + s_["reason"]))
        for r in self.routes:
            if r is chosen:
                continue
            parts = list(r["rule_reasons"])
            if r.get("mc_fail_rate") is not None:
                parts.append("fails in %.1f%% of %s walkers (chosen %.1f%%)" % (
                    100 * r["mc_fail_rate"], self.results.get(r["id"], {}).get("source", "local preview"), 100 * fr(chosen)))
            if r.get("band_m", 0) >= 1:
                parts.append("crosses %.0f m of the rockfall runout band" % r["band_m"])
            if r["time_s"] > chosen["time_s"] + 30:
                parts.append("%.1f min slower" % ((r["time_s"] - chosen["time_s"]) / 60))
            avoided.append(dict(label="Route %d (%s)" % (r["id"], r["label"]), detail="; ".join(parts) or "lower ranked"))
        return chosen, reasons, avoided

    def _decide(self, chosen, auto, reasons, avoided):
        for r in self.routes:
            if r is chosen:
                r["status"] = "chosen"
                self._route_osc(r["id"], "chosen")
            elif r["status"] == "infeasible":
                self._route_osc(r["id"], "failed")
            else:
                r["status"] = "rejected"
                self._route_osc(r["id"], "failed" if not r["rule_ok"] else "hidden")
        self._emit_routes()
        dose_open = self._open_dose_msv(chosen)
        dose_margin = max(0.0, 1.0 - chosen["dose"] / dose_open) if dose_open > 0 else 1.0
        msg = self.emit(dict(type="decision", incident_id=self.incident_id, route_id=chosen["id"], shelter=chosen["shelter"],
                             auto=auto, reasons=reasons, avoided=avoided, time_to_shelter_s=chosen["time_s"],
                             margins=dict(o2=chosen["o2_margin"], heat=chosen["heat_margin"], dose=round(dose_margin, 3)),
                             dose_msv=chosen["dose"], label=chosen["label"]))
        self.decision = dict(route=chosen, msg=msg)
        self.history[self.incident_id] = dict(routes=self.routes, results=self.results, decision=msg)
        self.log("Crew %s moving to %s along route %d" % (" and ".join(c.name for c in self.crew), chosen["label"], chosen["id"]))

    def _open_dose_msv(self, route):
        """Dose (mSv) the crew would take standing in the open for the same time: the reference for margins.dose."""
        ctx = route["ctx"]
        if ctx["sep_elapsed0"] < 0:
            t = route["time_s"]
            return PARAMS["gcrRate"] * PARAMS["qGcr"] * t / 3600.0 / 1000.0
        dt = 10.0
        tot = 0.0
        for k in range(int(math.ceil(route["time_s"] / dt))):
            sr = sep_rate(ctx["sep_elapsed0"] + (k + 0.5) * dt, PARAMS["sepPeakMin"], PARAMS["sepTotal"], PARAMS["sepDecayH"])
            tot += (PARAMS["gcrRate"] * PARAMS["qGcr"] + sr * PARAMS["qSep"]) * dt / 3600.0 / 1000.0
        return tot

    def _choose_manual(self, rid):
        if not self.routes or self.decision is None and self.phase not in ("simulate", "respond"):
            raise ValueError("no routes to choose from")
        match = [r for r in self.routes if r["id"] == rid]
        if not match:
            raise ValueError("unknown route %d" % rid)
        r = match[0]
        if r["status"] == "infeasible":
            raise ValueError("route %d does not reach its goal" % rid)
        reasons = ["Chosen by the operator"]
        if not r["rule_ok"]:
            reasons += ["Warning: route %s" % why for why in r["rule_reasons"]]
        if r.get("mc_fail_rate") is not None:
            reasons.append("Failure rate %.1f%% (%s)" % (100 * r["mc_fail_rate"], self.results.get(r["id"], {}).get("source", "local preview")))
        prev = self.decision["route"] if self.decision else None
        avoided = []
        if prev is not None and prev is not r:
            avoided.append(dict(label="Route %d (%s)" % (prev["id"], prev["label"]), detail="Automatic choice, overridden"))
        walking = self.walk is not None and self.walk.get("incident_id") == self.incident_id
        self._decide(r, False, reasons, avoided)
        if walking:
            self._start_walk(r)
            self.log("Crew restarted from the start of route %d (operator override)" % rid, "warn")

    def _start_walk(self, route):
        trk = route["nominal"]["track"]
        shield = None
        end_place = self.incident.get("home") if self.incident and self.incident["kind"] == "science" else route["shelter"]
        try:
            shield = self.sc.shield(end_place)
        except KeyError:
            pass
        # first step at alert + reactS, as the plan assumed (see _ctx); the crew waits in place until then
        t0 = max(self.clock.t, route["ctx"].get("t_walk") or self.clock.t)
        self.walk = dict(track=trk, t0=t0, route=route, incident_id=self.incident_id, shield=shield)

    # ------------------------------------------------------------------------------------ replay agents
    def _update_agents(self):
        rp = self.replay
        if not rp or not rp["runs"]:
            self.agents = []
            return
        span = max(len(run["samples"]) * run.get("dt", SIM["DT"]) for run in rp["runs"])
        tau = min(1.0, (self.wall - rp["t0"]) / max(rp["dur"], 1e-6)) * span
        out = []
        for run in rp["runs"]:
            smp = run["samples"]
            dt = run.get("dt", SIM["DT"])
            f = tau / dt
            k = int(f)
            if k >= len(smp) - 1:
                p = smp[-1]
                e, s, z, h, st = p[0], p[1], p[2], p[3], p[4]
            else:
                w = f - k
                a, b = smp[k], smp[k + 1]
                e = a[0] + (b[0] - a[0]) * w
                s = a[1] + (b[1] - a[1]) * w
                z = a[2] + (b[2] - a[2]) * w
                h, st = b[3], b[4]
            out.append(dict(route=run["route"], id=run["id"], e=round(e, 1), s=round(s, 1), z=round(z, 1),
                            heading=round(h, 1), status=int(st), outcome=run["outcome"]))
        self.agents = out
