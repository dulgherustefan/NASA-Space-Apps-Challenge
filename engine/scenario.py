"""Incident scripts (data/scenario/*.json). Every incident is scripted (scenario: true); every number it
carries has label, value, unit, kind and source.
"""
import json
import math
import os

from . import SCENARIO_DIR
from .params import PARAMS, cite


class Scenario:
    def __init__(self, site, directory=SCENARIO_DIR):
        self.site = site
        with open(os.path.join(directory, "mission.json"), encoding="utf8") as f:
            self.mission = json.load(f)
        self.incidents = {}
        for iid in self.mission["incidents"]:
            with open(os.path.join(directory, iid + ".json"), encoding="utf8") as f:
                self.incidents[iid] = json.load(f)
        self.places = {}
        for p in self.mission["places"]:
            q = dict(p)
            q["e"], q["s"] = site.core_to_local(p["x"], p["y"])
            q["z"] = site.z_at_local(q["e"], q["s"])
            self.places[p["id"]] = q
        self.order = list(self.mission["incidents"])
        self.demo = self.mission["demo"]

    def place(self, pid):
        return self.places[pid]

    def hello_places(self):
        return [dict(id=p["id"], name=p["name"], kind=p["kind"], e=round(p["e"], 1), s=round(p["s"], 1), z=round(p["z"], 1))
                for p in self.places.values()]

    def hello_scenario(self):
        return [dict(id=i["id"], kind=i["kind"], title=i["title"], at_s=i["at_s"], trigger=i["trigger"], scenario=True)
                for i in (self.incidents[k] for k in self.order)]

    def shield(self, pid):
        """Fraction of dose removed at a place (terrain shelters: shieldK x blocked-sky fraction)."""
        p = self.places[pid]
        sp = p.get("shield_param")
        if sp == "terrain" or sp is None:
            return min(0.95, PARAMS["shieldK"] * self.site.layer_at("sky", p["x"], p["y"]))
        return PARAMS[sp]

    def shelters(self, inc, band_active):
        """Candidate shelters with open/closed state and reason."""
        out = []
        alpha = PARAMS["alphaDeg"]
        for pid in inc.get("candidates", []):
            p = self.places[pid]
            beta = self.site.layer_at("beta", p["x"], p["y"])
            open_, reason = True, ""
            if band_active and inc.get("close_in_band") and beta >= alpha:
                open_ = False
                reason = "Inside the rockfall runout band (reach angle at the shelter %.1f deg >= %.1f deg); post-quake hold %d h" % (
                    beta, alpha, PARAMS["holdHours"])
            out.append(dict(id=pid, name=p["name"], e=round(p["e"], 1), s=round(p["s"], 1), x=p["x"], y=p["y"], open=open_,
                            reason=reason, shield=round(self.shield(pid), 3), kind=p["kind"]))
        return out

    def params_for(self, inc):
        return [dict(label=q["label"], value=q["value"], unit=q["unit"], kind=q["kind"], source=q["source"]) for q in inc["params"]]

    def incident_position(self, inc):
        q = inc.get("epicentre") or inc.get("target")
        if q:
            p = self.places[q]
            return round(p["e"], 1), round(p["s"], 1)
        return None, None

    def assessment_changes(self, inc, ctx):
        kind = inc["kind"]
        ch = []
        if kind == "sep":
            ch.append(cite("shelterRuleMin", "Shelter rule"))
            ch.append(cite("sepPeakMin", "Time to peak dose rate"))
            ch.append(dict(label="Time left under the rule when walking starts", value=round(ctx["deadline_walk"] / 60, 1), unit="min",
                           kind="model", source="Shelter rule minus alert-to-first-step time (team assumption, 60 s)"))
            ch.append(cite("shieldK", "Terrain shielding per blocked sky"))
            ch.append(cite("shieldRover", "Rover shielding"))
            ch.append(cite("shieldHabitat", "Habitat shielding"))
        elif kind == "quake":
            ch.append(dict(label="Rockfall runout band", value="active", unit="", kind="scenario", source="Marsquake (scripted)"))
            ch.append(cite("alphaDeg", "Rockfall reach angle"))
            ch.append(cite("quakeRateX", "Post-quake rockfall rate vs. background"))
            ch.append(cite("holdHours", "Hold on the runout band"))
            ch.append(dict(label="Time left under the solar-storm rule", value=round(ctx["deadline_walk"] / 60, 1), unit="min",
                           kind="model", source="30-minute rule counted from the storm alert"))
            if math.isfinite(ctx.get("deadline_peak", math.inf)):
                ch.append(dict(label="Time left before the expected dose-rate peak", value=round(ctx["deadline_peak"] / 60, 1),
                               unit="min", kind="model", source="Storm onset to peak (53 min, RAD 20 May 2024) minus elapsed time"))
        elif kind == "science":
            ch.append(dict(label="Solar storm", value="over", unit="", kind="scenario", source="Scripted: one sol later"))
            ch.append(dict(label="Runout band hold", value="expired", unit="", kind="assumption", source="Team design rule, 24 h"))
            ch.append(cite("alphaDeg", "Rockfall reach angle"))
            ch.append(cite("o2ReserveMin", "O2 reserve required on arrival"))
        return ch


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])
