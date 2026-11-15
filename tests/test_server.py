"""Smoke test of the optional heavy-job server (server/app.py), without an HTTP client: the handlers are called
directly, so the test needs only the engine's own dependencies."""
import asyncio
import math

import pytest

app = pytest.importorskip("server.app")


@pytest.fixture(scope="module")
def ready():
    app._load()
    assert app.STATE["ready"], app.STATE["error"]


def call(**body):
    return asyncio.run(app.stress(app.StressRequest(**body)))


def test_health(ready):
    h = asyncio.run(app.health())
    assert h["ok"] and h["site"] and h["version"]


def test_stress_shape(ready):
    out = call(start=[2200, 1400], goal=[1700, 2600], n=200)
    assert out["ok"] and out["n"] == 200 and out["compute_ms"] > 0
    assert out["routes"] and out["recommended"] in [r["id"] for r in out["routes"]]
    r = out["routes"][0]
    assert r["n"] == 200 and 0.0 <= r["fail_rate"] <= 1.0
    lo, hi = r["ci95"]
    assert lo <= r["fail_rate"] <= hi
    assert r["time_s"] > 0 and r["length_m"] > 0
    assert 2 <= len(r["polyline"]) <= app.MAX_POLY_POINTS
    assert math.hypot(r["polyline"][0][0] - 2200, r["polyline"][0][1] - 1400) < 10


@pytest.mark.parametrize("body", [
    dict(start=[2200, 1400], goal=[1700, 4001]),
    dict(start=[float("nan"), 1400], goal=[1700, 2600]),
    dict(start=[2200, 1400], goal=[2205, 1400]),
    dict(start=[10, 10], goal=[1700, 2600]),
])
def test_bad_points(ready, body):
    with pytest.raises(app.HTTPException) as e:
        call(**body)
    assert e.value.status_code == 400
