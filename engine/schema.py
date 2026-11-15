"""Field names of the WebSocket messages, taken from docs/CONTRACT.md section 6 (normative examples).
Used by `--check` and the tests to verify every emitted message."""
import math

KINDS = {"measured", "model", "requirement", "assumption", "scenario"}
PHASES = {"detect", "assess", "simulate", "respond", "idle"}
ROUTE_STATUS = {"candidate", "testing", "tested", "rejected", "chosen", "infeasible"}
METHODS = {"ppo-ast", "cem", "mc"}
FAIL_CLASSES = {"fall", "heat", "oxygen", "late", "stuck"}

REQUIRED = {
    "hello": ["type", "t", "product", "version", "site", "places", "scenario"],
    "snapshot": ["type", "t", "clock", "phase", "incident_id", "crew", "sensors", "light_time_s"],
    "incident": ["type", "t", "id", "kind", "title", "summary", "source", "scenario", "e", "s", "params"],
    "assessment": ["type", "t", "incident_id", "changes", "overlays", "shelters"],
    "routes": ["type", "t", "incident_id", "file", "routes"],
    "stress": ["type", "t", "incident_id", "route_id", "method", "source", "robustness_nats", "mc_fail_rate", "mc_ci", "n",
               "failures", "heatmap"],
    "decision": ["type", "t", "incident_id", "route_id", "shelter", "auto", "reasons", "avoided", "time_to_shelter_s", "margins"],
    "log": ["type", "t", "level", "text", "source"],
    "plan": ["type", "t", "id", "ok"],
}
PLAN_OK = ["from", "to", "file", "trajectories", "routes", "stress", "recommended", "conditions", "note"]
NESTED = {
    ("hello", "site"): ["name", "lat", "lon", "core", "z_ref", "ortho"],
    ("hello", "site.core"): ["e0", "s0", "size"],
    ("hello", "places[]"): ["id", "name", "kind", "e", "s", "z"],
    ("hello", "scenario[]"): ["id", "kind", "title", "at_s"],
    ("snapshot", "clock"): ["t", "sol", "lmst", "utc", "speed", "paused"],
    ("snapshot", "crew[]"): ["id", "name", "e", "s", "z", "heading", "pace", "o2", "heat", "dose", "status"],
    ("snapshot", "sensors"): ["dose_rate", "seismic", "tau"],
    ("incident", "params[]"): ["label", "value", "unit", "kind", "source"],
    ("assessment", "changes[]"): ["label", "value", "unit", "kind", "source"],
    ("assessment", "overlays[]"): ["layer", "file", "label"],
    ("assessment", "shelters[]"): ["id", "name", "e", "s", "open", "reason"],
    ("routes", "routes[]"): ["id", "shelter", "label", "length_m", "time_s", "ascent_m", "max_slope", "o2_margin", "heat_margin",
                             "dose", "robustness_nats", "mc_fail_rate", "status"],
    ("stress", "failures[]"): ["class", "e", "s", "t", "log_p", "summary", "events"],
    ("stress", "failures[].events[]"): ["t", "channel", "value", "log_p"],
    ("decision", "avoided[]"): ["label", "detail"],
    ("decision", "margins"): ["o2", "heat", "dose"],
}


def _get(obj, path):
    """Yield every object at a dotted path; a trailing [] iterates a list."""
    objs = [obj]
    for part in path.split("."):
        nxt = []
        many = part.endswith("[]")
        key = part[:-2] if many else part
        for o in objs:
            if not isinstance(o, dict) or key not in o:
                continue
            v = o[key]
            if many:
                if isinstance(v, list):
                    nxt.extend(v)
            else:
                nxt.append(v)
        objs = nxt
    return objs


def _finite(v):
    if isinstance(v, float):
        return math.isfinite(v)
    if isinstance(v, dict):
        return all(_finite(x) for x in v.values())
    if isinstance(v, list):
        return all(_finite(x) for x in v)
    return True


def validate(msg):
    errs = []
    typ = msg.get("type")
    if typ not in REQUIRED:
        return ["unknown type %r" % typ]
    for k in REQUIRED[typ]:
        if k not in msg:
            errs.append("%s: missing %s" % (typ, k))
    for (t, path), keys in NESTED.items():
        if t != typ:
            continue
        for o in _get(msg, path):
            if not isinstance(o, dict):
                errs.append("%s.%s: not an object" % (typ, path))
                continue
            for k in keys:
                if k not in o:
                    errs.append("%s.%s: missing %s" % (typ, path, k))
    if not _finite(msg):
        errs.append("%s: non-finite number" % typ)
    # enumerations
    for path in ("params[]", "changes[]"):
        for o in _get(msg, path):
            if isinstance(o, dict) and o.get("kind") not in KINDS:
                errs.append("%s.%s: bad kind %r" % (typ, path, o.get("kind")))
    if typ == "snapshot" and msg.get("phase") not in PHASES:
        errs.append("snapshot: bad phase %r" % msg.get("phase"))
    if typ == "routes":
        for r in msg.get("routes", []):
            if r.get("status") not in ROUTE_STATUS:
                errs.append("routes: bad status %r" % r.get("status"))
    if typ == "stress":
        if msg.get("method") not in METHODS:
            errs.append("stress: bad method %r" % msg.get("method"))
        if msg.get("source") not in ("data/ast", "local preview"):
            errs.append("stress: bad source %r" % msg.get("source"))
        for f in msg.get("failures", []):
            if f.get("class") not in FAIL_CLASSES:
                errs.append("stress: bad failure class %r" % f.get("class"))
    if typ == "plan":
        if msg.get("ok") is True:
            for k in PLAN_OK:
                if k not in msg:
                    errs.append("plan: missing %s" % k)
            for r in msg.get("routes", []):
                if r.get("status") not in ROUTE_STATUS:
                    errs.append("plan: bad status %r" % r.get("status"))
            for st in msg.get("stress", []):
                if st.get("source") != "local preview" or st.get("method") != "mc":
                    errs.append("plan: the stress test of a plan is the local Monte Carlo preview only")
        elif not msg.get("reason"):
            errs.append("plan: a refused plan needs a reason")
    if typ == "incident" and msg.get("scenario") is not True:
        errs.append("incident: scripted incidents must carry scenario: true")
    return errs
