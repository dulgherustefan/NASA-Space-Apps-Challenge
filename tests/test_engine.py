"""Engine tests: coordinates, overlays, routes, contract field names, file-server path checks."""
import asyncio
import json
import math
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import RUNTIME, schema  # noqa: E402
from engine.director import Director  # noqa: E402
from engine.hazards import LAYERS, Hazards, png_bytes  # noqa: E402
from engine.osc import Osc  # noqa: E402
from engine.routes import plan_candidates  # noqa: E402
from engine.scenario import Scenario  # noqa: E402
from engine.server import Hub, safe_path  # noqa: E402
from engine.site import get_site, heading_deg  # noqa: E402


@pytest.fixture(scope="module")
def site():
    return get_site()


@pytest.fixture(scope="module")
def scen(site):
    return Scenario(site)


@pytest.fixture(scope="module")
def demo_run(site, scen):
    """The whole demo played without sockets (small Monte Carlo to keep the test quick)."""
    d = Director(site, Hazards(site), scen, Osc(enabled=False), n_walkers=200)
    d.command({"cmd": "demo"})
    msgs, snaps, wall = [], [], 0.0
    while d.program is not None and wall < 900:
        d.tick(0.05)
        wall += 0.05
        msgs.extend(d.drain())
        snaps.append(d.snapshot())
    msgs.extend(d.drain())
    return d, msgs, snaps


# ------------------------------------------------------------------------------ coordinates
def test_core_local_round_trip(site):
    for x, y in [(0, 0), (2800, 1500), (3999.9, 3999.9), (1234.5, 678.9)]:
        e, s = site.core_to_local(x, y)
        assert (e, s) == pytest.approx((1650 + x, 6600 + y))
        assert site.local_to_core(e, s) == pytest.approx((x, y))


def test_cell_centre_round_trip(site):
    for i, j in [(0, 0), (300, 560), (799, 799)]:
        x, y = site.cell_center(i, j)
        assert site.cell_ij(x, y) == (i, j)
        e, s = site.cell_center_local(i, j)
        assert e == pytest.approx(1650 + (j + 0.5) * 5)
        assert s == pytest.approx(6600 + (i + 0.5) * 5)


def test_unreal_and_heading(site):
    X, Y, Z = site.to_unreal(4450.0, 8100.0, site.z_ref + 10.0)
    assert (X, Y, Z) == pytest.approx((445000.0, 810000.0, 1000.0))
    assert heading_deg(0, -1) == pytest.approx(0.0)     # north
    assert heading_deg(1, 0) == pytest.approx(90.0)     # east
    assert heading_deg(0, 1) == pytest.approx(180.0)    # south
    assert heading_deg(-1, 0) == pytest.approx(270.0)   # west


# ------------------------------------------------------------------------------ overlays
def test_overlays_size_and_format(site):
    from PIL import Image
    hz = Hazards(site)
    hz.write_static()
    for layer in LAYERS:
        p = os.path.join(RUNTIME, "overlay_%s.png" % layer)
        assert os.path.exists(p), layer
        with Image.open(p) as im:
            assert im.size == (800, 800)
            assert im.mode == "RGBA"
    img = hz.img_rockfall()
    assert img.shape == (800, 800, 4) and img.dtype == np.uint8
    # transparent where nothing: outside the runout band alpha is zero
    assert (img[..., 3][~hz.band] == 0).all()
    assert png_bytes(img)[:8] == b"\x89PNG\r\n\x1a\n"


def test_overlay_orientation(site):
    """Row 0 is the north edge (s0) and column 0 the west edge (e0): a cell's pixel is (row=i, col=j)."""
    hz = Hazards(site)
    img = hz.img_slope()
    i, j = np.unravel_index(int(np.argmax(site.slope)), (800, 800))
    assert img[i, j, 3] > 0
    x, y = site.cell_center(i, j)
    assert site.layer_at("slope", x, y) == pytest.approx(float(site.slope.max()))


# ------------------------------------------------------------------------------ routes
def test_routes_on_free_cells_and_end_at_shelter(site, scen):
    inc = scen.incidents["sep-1"]
    shelters = scen.shelters(inc, False)
    p = scen.place("S")
    ctx = dict(start_xy=(p["x"], p["y"]), band_active=False, alpha=27.8, pace=0.95, sep_elapsed0=60.0,
               deadline_walk=1740.0, heat0=None, o2_frac=None)
    routes = plan_candidates(site, ctx, shelters)
    assert len(routes) == len([s for s in shelters if s["open"]]) >= 2
    for r in routes:
        for x, y in r["poly"][1:]:                       # the first point is the crew position itself
            assert not site.is_blocked(x, y), (r["id"], x, y)
        sh = scen.place(r["shelter"])
        end = r["points"][-1]
        assert math.hypot(end[0] - sh["e"], end[1] - sh["s"]) <= 15.0
        assert r["length_m"] > 0 and r["time_s"] > 0


def test_closed_shelters_in_band(scen):
    sh = scen.shelters(scen.incidents["quake-1"], True)
    closed = {s["id"] for s in sh if not s["open"]}
    assert {"A", "C"} <= closed
    assert all(s["reason"] for s in sh if not s["open"])


# ------------------------------------------------------------------------------ messages
def test_demo_messages_match_contract(demo_run):
    d, msgs, snaps = demo_run
    assert d.error is None
    hello = json.loads(json.dumps(d.hello()))
    assert hello["product"] == "Solway"
    assert schema.validate(hello) == []
    for m in msgs + snaps[::20]:
        m = json.loads(json.dumps(m))
        assert schema.validate(m) == [], m["type"]
    for iid in ("sep-1", "quake-1", "sci-1"):
        types = [m["type"] for m in msgs if m.get("incident_id") == iid or (m["type"] == "incident" and m.get("id") == iid)]
        for t in ("incident", "assessment", "routes", "stress", "decision"):
            assert t in types, (iid, t)
        order = [types.index(t) for t in ("incident", "assessment", "routes", "stress", "decision")]
        assert order == sorted(order), iid


def test_stress_is_labelled_local_preview(demo_run):
    _, msgs, _ = demo_run
    st = [m for m in msgs if m["type"] == "stress"]
    assert st
    for m in st:
        if m["source"] == "local preview":
            assert m["method"] == "mc" and m["robustness_nats"] is None


def test_runtime_files_well_formed(demo_run):
    for name in ("routes.json", "trajectories.json"):
        with open(os.path.join(RUNTIME, name)) as f:
            doc = json.load(f)
        assert doc["incident_id"] == "sci-1"
    with open(os.path.join(RUNTIME, "trajectories.json")) as f:
        tr = json.load(f)
    assert tr["runs"] and all(len(s) == 5 for r in tr["runs"] for s in r["samples"])


# ------------------------------------------------------------------------------ file server
@pytest.mark.parametrize("bad", ["../pyproject.toml", "runtime/../pyproject.toml", "runtime/../../etc/passwd", "/etc/passwd",
                                 "rl/planner.py", "data/scenario/sep-1.json", "runtime\\..\\x", "runtime/./routes.json",
                                 "runtime//routes.json", "", "data/site", "runtime/\x00"])
def test_path_traversal_rejected(bad):
    assert safe_path(bad) is None


def test_allowed_paths(site):
    assert safe_path("data/site/core_ortho.webp") is not None
    os.makedirs(RUNTIME, exist_ok=True)
    assert safe_path("runtime/overlay_slope.png") is not None or not os.path.exists(os.path.join(RUNTIME, "overlay_slope.png"))


# ------------------------------------------------------------------------------ scenario timing and story
def _incident_msg(msgs, iid):
    return [m for m in msgs if m["type"] == "incident" and m["id"] == iid][0]


def test_late_client_gets_every_incident_since_reset():
    async def run():
        hub = Hub(None)
        for m in (dict(type="incident", t=60.0, id="sep-1"), dict(type="decision", t=72.0, incident_id="sep-1", route_id=0),
                  dict(type="incident", t=420.0, id="quake-1"), dict(type="log", t=421.0, text="not kept"),
                  dict(type="incident", t=500.0, id="sep-1"), dict(type="decision", t=512.0, incident_id="sep-1", route_id=1)):
            hub._publish(m)
        return hub.sticky
    kept = asyncio.run(run())
    assert [(m["type"], m["t"]) for m in kept] == [("incident", 420.0), ("incident", 500.0), ("decision", 512.0)]


def test_incidents_fire_at_scenario_time(demo_run, scen):
    """at_s in the scenario files is when the incident really fires (demo pacing does not shift it)."""
    _, msgs, _ = demo_run
    for iid in ("sep-1", "quake-1"):
        assert _incident_msg(msgs, iid)["t"] == pytest.approx(scen.incidents[iid]["at_s"], abs=0.1), iid
    sep, quake = scen.incidents["sep-1"], scen.incidents["quake-1"]
    from engine.params import PARAMS
    assert quake["at_s"] == pytest.approx(sep["at_s"] + PARAMS["reactS"] + quake["trigger"]["after_walk_s"])


def test_crew_starts_walking_react_after_alert(demo_run, scen):
    from engine.params import PARAMS
    _, _, snaps = demo_run
    walking = [s["t"] for s in snaps if s["incident_id"] == "sep-1" and s["crew"][0]["status"] == 0]
    assert walking
    assert min(walking) >= scen.incidents["sep-1"]["at_s"] + PARAMS["reactS"] - 1e-6


def test_quake_recommended_route_is_not_all_late(demo_run):
    """After the quake no open shelter can meet the 30-minute rule; lateness is then judged against the
    storm peak, so the recommended route (the rover, out of the runout band) is not 100 % late."""
    d, _, _ = demo_run
    h = d.history["quake-1"]
    dec = h["decision"]
    chosen = [r for r in h["routes"] if r["id"] == dec["route_id"]][0]
    assert chosen["shelter"] == "R"
    assert not chosen["rule_ok"] and any("30-minute" in w for w in chosen["rule_reasons"])
    assert chosen["ctx"]["late_basis"] == "peak"
    assert chosen["time_s"] < chosen["ctx"]["deadline_peak"]
    res = h["results"][chosen["id"]]
    assert res["classes"]["late"] < 0.5 and res["mc_fail_rate"] < 0.5
    assert all(r["mc_fail_rate"] >= chosen["mc_fail_rate"] for r in h["routes"])
    assert any("expected dose-rate peak" in t for t in dec["reasons"])


def test_sep_keeps_the_30_minute_rule(demo_run):
    d, _, _ = demo_run
    h = d.history["sep-1"]
    chosen = [r for r in h["routes"] if r["id"] == h["decision"]["route_id"]][0]
    assert chosen["rule_ok"] and chosen["ctx"].get("late_basis") is None


# ------------------------------------------------------------------------------ provenance
def test_sep_total_dose_is_not_labelled_measured(demo_run):
    from engine.params import param
    assert param("sepTotal")["kind"] == "model"
    _, msgs, _ = demo_run
    for p in _incident_msg(msgs, "sep-1")["params"]:
        if p["value"] == 8100:
            assert p["kind"] == "model", p


def test_measured_params_cite_a_source():
    """A number labelled measured never comes from the team itself."""
    from engine.params import PARAM_DEFS
    for d in PARAM_DEFS:
        if d["kind"] == "measured":
            assert d["source"] and not d["source"].lower().startswith("team"), d["key"]


# ------------------------------------------------------------------------------ optional files
def _files_endpoint(app):
    return [r for r in app.routes if getattr(r, "path", "") == "/files/{path:path}"][0].endpoint


@pytest.mark.parametrize("missing", ["runtime/params.json", "data/ast/ast_training.json", "data/ast/ast_results.json",
                                     "data/ast/ast_heatmap_sep-1_0.png"])
def test_missing_optional_files_give_404(tmp_path, monkeypatch, site, scen, missing):
    """runtime/params.json and data/ast/* may not exist (data/ast is produced on another machine)."""
    import functools

    from fastapi import HTTPException

    import engine.server as srv
    (tmp_path / "runtime").mkdir()                        # data/ast does not exist at all under this root
    monkeypatch.setattr(srv, "safe_path", functools.partial(safe_path, root=str(tmp_path)))
    d = Director(site, Hazards(site), scen, Osc(enabled=False), n_walkers=50)
    files = _files_endpoint(srv.create_app(d))
    with pytest.raises(HTTPException) as e:
        asyncio.run(files(path=missing))
    assert e.value.status_code == 404


def test_engine_runs_without_ast(tmp_path):
    import engine.stress as st
    assert st.load_ast(str(tmp_path / "no_such_dir")) is None and not st.ast_present(str(tmp_path / "no_such_dir"))
    assert st.ast_extras(str(tmp_path / "no_such_dir")) == {}


def test_unusable_ast_file_falls_back_to_local(tmp_path, site, scen):
    (tmp_path / "ast_results.json").write_text(json.dumps({"sep-1": {"routes": {"0": {"mc_fail_rate": 0.1, "failures": 5}}}}))
    import engine.stress as st
    ast = st.load_ast(str(tmp_path))
    d = Director(site, Hazards(site), scen, Osc(enabled=False), n_walkers=50)
    p = scen.place("S")
    ctx = dict(start_xy=(p["x"], p["y"]), band_active=False, alpha=27.8, pace=0.95, sep_elapsed0=60.0,
               deadline_walk=1740.0, deadline_peak=3120.0, t_walk=None, heat0=None, o2_frac=None, kind="sep")
    r = plan_candidates(site, ctx, scen.shelters(scen.incidents["sep-1"], False))[0]
    local, ast_res = d._stress("sep-1", r, ast)
    assert ast_res is None and local["source"] == "local preview"


# ------------------------------------------------------------------------------ light and weather reference
def test_sunset_matches_the_horizons_table():
    from engine.clock import parse_utc, sunset_after
    # Horizons: Sun elevation +9.07 deg at 10:00 UTC and -5.10 deg at 11:00 UTC on 15 Nov 2026
    ss = sunset_after(parse_utc("2026-11-15T07:00:00Z"), 290.0373, -10.0116)
    assert parse_utc("2026-11-15T10:30:00Z") < ss < parse_utc("2026-11-15T10:45:00Z")
    assert sunset_after(parse_utc("2026-11-15T11:30:00Z"), 290.0373, -10.0116) is None


def test_snapshot_carries_daylight_and_season(demo_run):
    _, _, snaps = demo_run
    env = snaps[0]["env"]
    assert 3 * 3600 < env["daylight_s"] < 4 * 3600 and env["sun_el"] > 0
    assert env["mars_year"] == 39 and 20 < env["ls"] < 24
    assert all(s["env"]["daylight_s"] >= 0 for s in snaps)


def test_assessment_limits_follow_the_shelter_rule(demo_run):
    _, msgs, _ = demo_run
    by_id = {m["incident_id"]: m for m in msgs if m["type"] == "assessment"}
    assert by_id["sep-1"]["limits"]["shelter_s"] == pytest.approx(29 * 60, abs=1)
    assert by_id["sci-1"]["limits"] == {"shelter_s": None, "peak_s": None}


def test_weather_reference_is_labelled_as_an_analogue(demo_run):
    d, _, _ = demo_run
    w = d.hello()["weather"]
    assert w["kind"] == "measured" and w["analogue"] is True and "Gale" in w["note"]
    assert w["ground_min_c"]["median"] < w["ground_max_c"]["median"]


def test_radio_line_of_sight_layer(site, scen):
    from engine import maplayers
    from engine.params import PARAMS
    hab, rover = scen.place("H"), scen.place("R")
    seen = maplayers.ensure(site, [(rover["x"], rover["y"], PARAMS["antRoverM"]), (hab["x"], hab["y"], PARAMS["antHabitatM"])])
    assert seen.shape == (site.n, site.n)
    assert seen[site.cell_ij(hab["x"], hab["y"])] and seen[site.cell_ij(rover["x"], rover["y"])]
    assert 0.2 < seen.mean() < 0.95                      # the canyon wall hides part of the box, not all of it
    for name, size in (("overlay_comm.png", (800, 800)), ("overlay_contours.png", (1600, 1600))):
        from PIL import Image
        with Image.open(os.path.join(RUNTIME, name)) as im:
            assert im.size == size and im.mode == "RGBA"


def test_routes_report_metres_without_radio_sight(demo_run):
    _, msgs, _ = demo_run
    routes = [m for m in msgs if m["type"] == "routes"][0]["routes"]
    assert all("nolos_m" in r and 0 <= r["nolos_m"] <= r["length_m"] + 5 for r in routes)
