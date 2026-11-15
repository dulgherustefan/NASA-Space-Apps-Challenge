"""Capture a "view on arrival" still for every destination: what the crew sees from eye height just before it gets there.

Run in the open editor with /Game/Maps/Melas loaded, Play stopped and the director not driving the editor world
(Output Log, Cmd box):

    py "<repo>/unreal/scripts/capture_pov.py"

Writes data/site/pov/<id>.jpg (1280 x 720) for the places A, C, R, H and B, and data/site/pov/pov.json with the camera of
each still in local metres (docs/CONTRACT.md) and its caption. The stills take about a minute; the log says when they are done.
Run it again after a change of look so the stills match the scene. The level is not saved.

Each camera stands 40 to 60 m short of the place, 1.7 m above the ground, on the side the routes come from, and looks at
the place. If the ground hides the place from there, the script tries other distances and then other directions and
records which one it used. Crew, markers, route lines, overlays, the helicopter and the dust are not in the stills; the
rover and the habitat are, since they are destinations. The Sun is where it is at mission start (look.py).

The stills are renders of the terrain model, not photographs: the shape comes from the HiRISE elevation model, the colour
is approximate, and ground detail and rocks are set dressing.
"""
import array
import gzip
import json
import math
import os
import sys

import unreal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import look  # noqa: E402

MAP = "/Game/Maps/Melas"
SITE = os.path.join(ROOT, "data", "site")
OUT = os.path.join(SITE, "pov")
LAYOUT = os.path.join(ROOT, "unreal_import", "scene_layout.json")
SIZE = (1280, 720)
FOV = 65.0                     # degrees, horizontal
EYE_M = 1.7
CAPTION = "Rendered from the HiRISE elevation model. Colour is approximate; ground detail and rocks are set dressing."
# place id -> where the crew comes from: another place id, or a compass bearing in degrees from the place to the camera
APPROACH = {"A": "S", "C": "S", "B": "R", "R": 45.0, "H": 45.0}
DISTANCES = (50.0, 45.0, 55.0, 40.0, 60.0)
TURNS = (0.0, 15.0, -15.0, 30.0, -30.0, 45.0, -45.0, 60.0, -60.0, 90.0, -90.0)
HIDE_FOLDERS = ("Crew", "Markers", "Agents", "FX", "Rockfall")
HIDE_TAGS = ("helicopter", "rotor")
WARM_UP_S = 30.0               # after hiding actors and turning the Sun the shadows show dark patches for about 20 s: wait them out
SETTLE_S = 3.5                 # between moving the camera and the still, so shadows, lighting and exposure settle
WRITE_S = 1.5


class Heights:
    """The 2.5 m render grid of the core box (the heights the terrain meshes are built from)."""

    def __init__(self):
        with open(os.path.join(SITE, "meta.json"), encoding="utf8") as f:
            core = json.load(f)["core"]
        self.n = int(core["n"])
        self.e0, self.s0, self.size = float(core["e0"]), float(core["s0"]), float(core["size"])
        self.zmin = float(core["zMin"])
        self.k = (float(core["zMax"]) - self.zmin) / 65535.0
        self.step = self.size / (self.n - 1)
        with gzip.open(os.path.join(SITE, "core_h.bin.gz"), "rb") as f:
            q = array.array("H")
            q.frombytes(f.read())
        if sys.byteorder == "big":
            q.byteswap()
        self.q = q

    def z(self, e, s):
        n = self.n
        x, y = (e - self.e0) / self.step, (s - self.s0) / self.step
        if not (0.0 <= x <= n - 1 and 0.0 <= y <= n - 1):
            return None
        j, i = min(int(x), n - 2), min(int(y), n - 2)
        tx, ty = x - j, y - i
        q, b = self.q, i * n + j
        v = (q[b] * (1 - tx) + q[b + 1] * tx) * (1 - ty) + (q[b + n] * (1 - tx) + q[b + n + 1] * tx) * ty
        return self.zmin + v * self.k


def plan(h, lay):
    """Camera and target of every still, in local metres."""
    places = lay["places"]
    props = lay.get("props", {})
    spot = {}
    for pid, p in places.items():
        spot[pid] = (p["ue"][0] / 100.0, p["ue"][1] / 100.0)
    for pid, key in (("R", "rover"), ("H", "habitat")):          # the model stands on flat ground next to the scenario point
        if key in props:
            spot[pid] = (props[key]["ue"][0] / 100.0, props[key]["ue"][1] / 100.0)
    shots = []
    for pid, src in APPROACH.items():
        e, s = spot[pid]
        zt = h.z(e, s)
        if zt is None:
            continue
        lift = 2.0 if pid in ("R", "H") else 1.0
        if isinstance(src, str):
            bearing = math.degrees(math.atan2(spot[src][0] - e, -(spot[src][1] - s)))
        else:
            bearing = float(src)
        chosen = None
        distances = sorted(DISTANCES) if pid in ("R", "H") else DISTANCES      # a vehicle or a module is small at 50 m: go closer
        for turn in TURNS:
            for dist in distances:
                a = math.radians(bearing + turn)
                ce, cs = e + math.sin(a) * dist, s - math.cos(a) * dist
                zc = h.z(ce, cs)
                if zc is None:
                    continue
                zc += EYE_M
                clear = True
                for i in range(1, 40):
                    t = i / 40.0
                    g = h.z(ce + (e - ce) * t, cs + (s - cs) * t)
                    if g is None or g + 0.35 > zc + (zt + lift - zc) * t:
                        clear = False
                        break
                if clear:
                    chosen = (ce, cs, zc, dist, turn)
                    break
            if chosen:
                break
        if chosen is None:
            shots.append({"id": pid, "name": places[pid]["name"], "skipped": "the ground hides the place from every position tried"})
            continue
        ce, cs, zc, dist, turn = chosen
        heading = math.degrees(math.atan2(e - ce, -(s - cs))) % 360.0
        shots.append({"id": pid, "name": places[pid]["name"], "file": f"{pid}.jpg", "camera": {"e": round(ce, 1), "s": round(cs, 1), "z": round(zc, 1)},
                      "heading": round(heading, 1), "fov_deg": FOV, "distance_m": dist, "turned_deg": turn, "caption": CAPTION,
                      "target": (e, s, zt + lift)})
    return shots


class Capture:
    def __init__(self):
        ues = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
        self.world = ues.get_editor_world()
        if self.world.get_path_name().split(".")[0] != MAP:
            raise RuntimeError(f"open {MAP} first")
        if ues.get_game_world() is not None:
            raise RuntimeError("stop Play first")
        self.ues = ues
        self.les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
        with open(LAYOUT, encoding="utf8") as f:
            lay = json.load(f)
        self.z_ref = float(lay["z_ref_m"])
        self.shots = plan(Heights(), lay)
        os.makedirs(OUT, exist_ok=True)
        # hide what does not belong in the stills, remember what was visible
        self.hidden = []
        for a in unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors():
            tags = [str(t) for t in a.tags]
            if str(a.get_folder_path()) in HIDE_FOLDERS or any(t in tags for t in HIDE_TAGS):
                if not a.is_temporarily_hidden_in_editor():
                    a.set_is_temporarily_hidden_in_editor(True)
                    self.hidden.append(a)
        # the Sun of mission start
        suns = list(unreal.GameplayStatics.get_all_actors_of_class(self.world, unreal.DirectionalLight))
        self.sun = suns[0] if suns else None
        self.sun_home = self.sun.get_actor_rotation() if self.sun else None
        if self.sun:
            self.sun.set_actor_rotation(unreal.Rotator(roll=0.0, pitch=-look.SUN_EL, yaw=look.SUN_AZ + 90.0), False)
        self.key = self.les.get_active_viewport_config_key()
        self.fov_home = self.les.get_level_viewport_fov(self.key)
        self.cam_home = ues.get_level_viewport_camera_info()
        self.i = -1
        self.wait = WARM_UP_S
        self.stage = "next"
        self.handle = unreal.register_slate_post_tick_callback(self.tick)
        unreal.log(f"capture_pov: {len(self.shots)} stills to {OUT}")

    def ue(self, e, s, z):
        return unreal.Vector(e * 100.0, s * 100.0, (z - self.z_ref) * 100.0)

    def tick(self, dt):
        try:
            if self.wait > 0.0:
                self.wait -= dt
                return
            if self.stage == "next":
                self.i += 1
                while self.i < len(self.shots) and "skipped" in self.shots[self.i]:
                    self.i += 1
                if self.i >= len(self.shots):
                    self.finish()
                    return
                shot = self.shots[self.i]
                c = shot["camera"]
                loc = self.ue(c["e"], c["s"], c["z"])
                rot = unreal.MathLibrary.find_look_at_rotation(loc, self.ue(*shot["target"]))
                self.ues.set_level_viewport_camera_info(loc, rot)
                self.les.set_level_viewport_fov(FOV, self.key)
                self.stage, self.wait = "shoot", SETTLE_S
            elif self.stage == "shoot":
                path = os.path.join(OUT, self.shots[self.i]["file"])
                if os.path.exists(path):
                    os.remove(path)
                unreal.AutomationLibrary.take_high_res_screenshot(SIZE[0], SIZE[1], path)
                self.stage, self.wait = "next", WRITE_S
        except Exception as e:
            unreal.log_error(f"capture_pov: {e!r}")
            self.finish()

    def finish(self):
        unreal.unregister_slate_post_tick_callback(self.handle)
        for a in self.hidden:
            a.set_is_temporarily_hidden_in_editor(False)
        if self.sun:
            self.sun.set_actor_rotation(self.sun_home, False)
        self.les.set_level_viewport_fov(float(self.fov_home), self.key)
        if self.cam_home:
            self.ues.set_level_viewport_camera_info(self.cam_home[0], self.cam_home[1])
        out = {"note": "Views on arrival, rendered in the 3D scene (unreal/scripts/capture_pov.py). Positions are local metres, "
                       "heading is degrees clockwise from north.",
               "size": list(SIZE), "sun": {"azimuth_deg": look.SUN_AZ, "elevation_deg": look.SUN_EL, "when": "2026-11-15 07:00 UT"},
               "views": {}}
        for shot in self.shots:
            entry = {k: v for k, v in shot.items() if k not in ("id", "target")}
            if "file" in entry and not os.path.exists(os.path.join(OUT, entry["file"])):
                entry = {"name": shot["name"], "skipped": "the still was not written"}
            out["views"][shot["id"]] = entry
        with open(os.path.join(OUT, "pov.json"), "w", encoding="utf8") as f:
            json.dump(out, f, indent=1)
        unreal.log(f"capture_pov: done, {sum(1 for v in out['views'].values() if 'file' in v)} stills in {OUT}")


if __name__ == "__main__":
    Capture()
