"""Live director for the Melas scene: listens to the engine's OSC stream and drives the level.

Run in the open editor with /Game/Maps/Melas loaded (Output Log, Cmd box):

    py "<repo>/unreal/scripts/director.py"

then press Play. Running the script again replaces the previous instance. To stop it:

    py import builtins; builtins.solway_director.stop()

Environment (set before running, optional):
  SOLWAY_PLAY=1          start Play In Editor right away
  SOLWAY_EDITOR_WORLD=1  also drive the editor world when Play is not running (for look checks; do not save the level after)
  SOLWAY_OSC_PORT        UDP port, default 9000

What it does, per docs/CONTRACT.md section 3:
  /crew      moves the crew (actors tagged crew:<id>); heights come from the 2.5 m render grid so feet stay on the mesh
  /agent     moves a pool of markers (tag agent) during stress-test replays, coloured by status
  /clock     turns the sun
  /incident  marsquake: epicentre beam, falling rocks along the tracks of scene_layout.json, camera shake
  /overlay   runtime/overlay_<layer>.png on the core terrain (two layers at a time)
  /reload    routes | overlay | trajectories
  /route     draws the candidate routes on the terrain, coloured by state
  /cue       camera: overview, follow, wall, shelter, failure

On its own it keeps the scene moving: every camera swings slowly around its subject, dust rises from the crew's steps
and from falling rocks, wind-blown dust and a dust devil drift across the view, and the scout helicopter circles the
crew. The dust and the helicopter are set dressing, not simulation output.

State for debugging is written once a second to <project>/Saved/director_state.json.
"""
import array
import builtins
import gzip
import json
import math
import os
import random
import socket
import struct
import sys
import time
import traceback

import unreal

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNTIME = os.path.join(ROOT, "runtime")
SITE = os.path.join(ROOT, "data", "site")
LAYOUT = os.path.join(ROOT, "unreal_import", "scene_layout.json")
STATE_FILE = os.path.join(unreal.Paths.project_saved_dir(), "director_state.json")
PORT = int(os.environ.get("SOLWAY_OSC_PORT", "9000"))
EDITOR_WORLD = os.environ.get("SOLWAY_EDITOR_WORLD") == "1"

GS = unreal.GameplayStatics
ML = unreal.MathLibrary
RL = unreal.RenderingLibrary

STATUS_RGB = {0: (0.95, 0.95, 0.95), 1: (0.70, 0.70, 0.70), 2: (1.00, 0.60, 0.10), 3: (1.00, 0.10, 0.08),
              4: (1.00, 0.35, 0.10), 5: (0.30, 0.60, 1.00), 6: (0.20, 1.00, 0.40), 7: (1.00, 0.90, 0.20)}
# route state -> colour drawn on the terrain, width relative to the base line width
ROUTE_STYLE = {"failed": ((0.62, 0.03, 0.02), 0.8), "candidate": ((0.42, 0.42, 0.42), 0.8),
               "testing": ((0.62, 0.36, 0.02), 1.0), "chosen": ((0.03, 0.62, 0.20), 1.25)}
ROUTE_ORDER = ("failed", "candidate", "testing", "chosen")
ROUTE_RT = 8192                # about 0.5 m per pixel over the core box
ROUTE_GLOW = 0.10              # low: a bright line lights the ground and the suits around it
OVERLAY_GLOW = 0.12
OVERLAY_SCALE = {"follow": 0.12, "shelter": 0.4}     # data layers step back when the camera is close to the crew
LABEL_REF_CM = 250000.0        # labels keep the size they have when seen from this far
MIN_SUN_EL = 14.0              # keep the scene readable when the mission clock puts the sun low
CLIPS = ("idle", "idletalk", "walk", "stumble", "collapse", "kneel", "crouch", "work")   # clips of the rigged suit, by the end of their name
CLIP_FOR = {2: "kneel", 3: "collapse", 4: "crouch", 5: "crouch", 6: "crouch"}   # crew status -> clip when not walking; idle otherwise
CLIP_ONCE = ("collapse", "stumble")                                               # played once, then held on the last frame
STRIDE_M = 1.20                # ground covered by one cycle of the walk clip (unreal_import/crew/z2_suit_rigged.json)
MAX_CADENCE = 1.7              # walk cycles per second at most: at high mission speed the feet slide rather than blur
ROUTE_OPACITY = {"follow": 0.0, "shelter": 0.3}      # next to the crew the ground markers carry the route, the line steps back
CRUMB_STEP = 3.5               # metres between the ground markers of the chosen route
CRUMB_SIZE = 0.42              # metres across

# dust sprites (set dressing): a tan veil, DUST_LIGHT times as bright as the ground behind it
DUST_RGB = (1.38, 0.89, 0.58)
DUST_LIGHT = 1.7
WIND = (-0.80, 0.60)           # unit vector the dust drifts along (east, south)
N_WISPS = 26                   # wind-blown dust kept in the air around what the camera looks at
N_DEVIL = 22                   # sprites of the dust devil
ATLAS = ((0.0, 0.0), (0.5, 0.0), (0.0, 0.5), (0.5, 0.5))
# camera: swing in degrees around the subject, period in seconds, push-in as a share of the distance
ORBIT = {"overview": (5.0, 110.0, 0.05), "wall": (7.0, 84.0, 0.06), "failure": (8.0, 72.0, 0.05), "shelter": (12.0, 64.0, 0.06)}


# ---------------------------------------------------------------------------------------------- OSC
def parse_osc(data, out):
    """Append (address, [args]) for every message in a datagram; bundles are unpacked."""
    if data[:8] == b"#bundle\0":
        i = 16
        while i + 4 <= len(data):
            n = struct.unpack(">i", data[i:i + 4])[0]
            i += 4
            parse_osc(data[i:i + n], out)
            i += n
        return
    end = data.find(b"\0")
    if end <= 0:
        return
    addr = data[:end].decode("ascii", "replace")
    i = (end + 4) & ~3
    args = []
    if i < len(data) and data[i:i + 1] == b",":
        end = data.find(b"\0", i)
        tags = data[i + 1:end].decode("ascii", "replace")
        i = (end + 4) & ~3
        for t in tags:
            if t == "i":
                args.append(struct.unpack(">i", data[i:i + 4])[0])
                i += 4
            elif t == "f":
                args.append(struct.unpack(">f", data[i:i + 4])[0])
                i += 4
            elif t == "s":
                end = data.find(b"\0", i)
                args.append(data[i:end].decode("utf8", "replace"))
                i = (end + 4) & ~3
            elif t == "d":
                args.append(struct.unpack(">d", data[i:i + 8])[0])
                i += 8
            elif t == "h":
                args.append(struct.unpack(">q", data[i:i + 8])[0])
                i += 8
            elif t == "T":
                args.append(True)
            elif t == "F":
                args.append(False)
            else:
                break
    out.append((addr, args))


# ------------------------------------------------------------------------------------------ terrain
class Heights:
    """The 2.5 m render grid of the core box: the same heights the terrain meshes are built from."""

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
        """Height in metres at local (east, south) metres, or None outside the core box."""
        n = self.n
        x, y = (e - self.e0) / self.step, (s - self.s0) / self.step
        if not (0.0 <= x <= n - 1 and 0.0 <= y <= n - 1):
            return None
        j, i = min(int(x), n - 2), min(int(y), n - 2)
        tx, ty = x - j, y - i
        q, b = self.q, i * n + j
        v = (q[b] * (1 - tx) + q[b + 1] * tx) * (1 - ty) + (q[b + n] * (1 - tx) + q[b + n + 1] * tx) * ty
        return self.zmin + v * self.k


def round_path(pts, passes=2, spacing=5.0):
    """Corner cutting takes the staircase out of a grid route; then points closer than `spacing` are dropped."""
    for _ in range(passes):
        if len(pts) < 3:
            break
        out = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            out.append((0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]))
            out.append((0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]))
        out.append(pts[-1])
        pts = out
    kept = [pts[0]]
    for q in pts[1:-1]:
        if math.dist(q, kept[-1]) >= spacing:
            kept.append(q)
    if len(pts) > 1:
        kept.append(pts[-1])
    return kept


def smooth(u):
    u = max(0.0, min(1.0, u))
    return u * u * (3.0 - 2.0 * u)


def lerp(a, b, t):
    return a + (b - a) * t


def lerp_angle(a, b, t):
    return a + ((b - a + 180.0) % 360.0 - 180.0) * t


def tags_of(actor):
    return [str(t) for t in actor.tags]


def tag_value(tags, prefix, default=None):
    for t in tags:
        if t.startswith(prefix):
            return t[len(prefix):]
    return default


# ----------------------------------------------------------------------------------------- director
class Director:
    def __init__(self):
        self.h = Heights()
        with open(LAYOUT, encoding="utf8") as f:
            self.layout = json.load(f)
        self.z_ref = float(self.layout["z_ref_m"])
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
        except OSError:
            pass
        self.sock.bind(("127.0.0.1", PORT))
        self.sock.setblocking(False)

        # what the engine asked for; survives Play starting and stopping
        self.crew_in = {}                 # id -> dict(e, s, z, heading, pace, status, t)
        self.agent_in = {}                # (route, id) -> dict(e, s, z, heading, status, t)
        self.overlay_want = {}            # layer -> opacity
        self.routes = []                  # from runtime/routes.json
        self.route_state = {}             # id -> state
        self.incident = ("none", "idle", 0.0, 0.0, 0.0)
        self.quake_t0 = None
        self.cue = "overview"
        self.cue_t0 = time.time()
        self.cue_blend = 0.01
        self.sun = None                   # (az, el)
        self.clock = (0.0, 1.0)

        self.world = None
        self.key = None
        self.game = False
        self.errors = []
        self.err_total = 0
        self.counts = {}
        self.last_msg = {}
        self.last_dump = 0.0
        self.last_tick = time.time()
        self.fps = 0.0
        self.cam_now = None
        self.cam_from = None
        self.follow = None
        self.round_joints = True
        self.bound = False
        self.rng = random.Random(20261115)
        self.dust = []
        self.dust_next = 0
        self.devil = None
        self.devil_at = time.time() + 4.0
        self.wisp_cue = None
        self.heli = None
        self.crumbs = []
        keep = getattr(builtins, "solway_keep", None)             # what the engine last said, when this script is run again
        if isinstance(keep, dict):
            for k, v in keep.items():
                setattr(self, k, v)
            self.cue_t0 = time.time()
        self._unthrottle()
        self.handle = unreal.register_slate_post_tick_callback(self._tick)
        unreal.log(f"director: listening on udp 127.0.0.1:{PORT}")

    # ------------------------------------------------------------------------------- housekeeping
    def stop(self):
        try:
            unreal.unregister_slate_post_tick_callback(self.handle)
        except Exception:
            pass
        builtins.solway_keep = {k: getattr(self, k) for k in ("crew_in", "overlay_want", "routes", "route_state", "incident", "cue", "sun", "clock")}
        try:
            self.sock.close()
        except Exception:
            pass
        try:
            self._unbind()
        except Exception:
            pass
        unreal.log("director: stopped")

    def _unthrottle(self):
        """The 3D window keeps running while the dashboard has the focus."""
        try:
            cdo = unreal.find_object(None, "/Script/UnrealEd.Default__EditorPerformanceSettings")
            if cdo is not None and cdo.get_editor_property("bThrottleCPUWhenNotForeground"):
                cdo.set_editor_property("bThrottleCPUWhenNotForeground", False)
        except Exception as e:
            self._err("unthrottle", e)

    def _err(self, where, e):
        self.err_total += 1
        self.errors.append(f"{where}: {repr(e)[:300]}")
        del self.errors[:-12]

    def ue(self, e, s, z=None, lift_m=0.0):
        """Local metres to Unreal centimetres; height from the render grid when inside the core box."""
        zz = self.h.z(e, s)
        if zz is None:
            zz = z if z is not None else self.z_ref
        return (e * 100.0, s * 100.0, (zz + lift_m - self.z_ref) * 100.0)

    def ground_cm(self, x_cm, y_cm):
        zz = self.h.z(x_cm / 100.0, y_cm / 100.0)
        return None if zz is None else (zz - self.z_ref) * 100.0

    def show(self, actor, visible):
        actor.set_actor_hidden_in_game(not visible)
        if not self.game:
            actor.set_is_temporarily_hidden_in_editor(not visible)

    # ------------------------------------------------------------------------------ world binding
    def _pick_world(self):
        ues = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
        w = ues.get_game_world()
        if w is not None:
            return w, True
        if EDITOR_WORLD:
            return ues.get_editor_world(), False
        return None, False

    def _unbind(self):
        if self.world is not None and not self.game:
            for comp, base, _mid in getattr(self, "core", []):
                comp.set_material(0, base)
            for ag in getattr(self, "agents", []):
                ag["comp"].set_material(0, ag["base"])
                self.show(ag["actor"], False)
            for d in self.dust:
                d["comp"].set_material(0, d["base"])
                d["actor"].set_actor_transform(self.park, False, True)
            if self.heli is not None:
                for actor, (loc, rot) in zip(self.heli["actors"], self.heli["home"]):
                    actor.set_actor_location_and_rotation(loc, rot, False, True)
            for c in self.crumbs:
                c["actor"].set_actor_transform(self.park, False, True)
        home = getattr(self, "vp_fov_home", None)
        if home is not None and home[1] is not None:      # give the editor viewport its own field of view back
            try:
                unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).set_level_viewport_fov(float(home[1]), home[0])
            except Exception:
                pass
        self.vp_fov = None
        self.vp_fov_home = None
        self.bound = False
        self.dust = []
        self.crumbs = []
        self.devil = None
        self.heli = None
        self.world = None
        self.key = None

    def _bind(self, w, game):
        self.bound = False
        self.world, self.game = w, game
        self.vp_fov = None
        self.vp_fov_home = None
        tagged = lambda tag: list(GS.get_all_actors_with_tag(w, tag))
        # crew
        beams = {int(tag_value(tags_of(a), "crew:", "-1")): a for a in tagged("crewbeam")}
        self.crew = {}
        for a in tagged("crew"):
            tg = tags_of(a)
            cid = int(tag_value(tg, "crew:", "-1"))
            c = dict(actor=a, beam=beams.get(cid), facing=float(tag_value(tg, "yaw:", "0")), pos=None, heading=None,
                     skeletal=isinstance(a, unreal.SkeletalMeshActor), anims={}, playing=None, phase=0.0, clip_t=0.0, cid=cid)
            if c["skeletal"]:
                comp = a.skeletal_mesh_component
                c["comp"] = comp
                try:
                    folder = comp.get_skeletal_mesh_asset().get_path_name().rsplit("/", 1)[0]
                    reg = unreal.AssetRegistryHelpers.get_asset_registry()
                    for ad in reg.get_assets_by_path(folder, recursive=True):
                        if str(ad.asset_class_path.asset_name) != "AnimSequence":
                            continue
                        n = str(ad.asset_name).lower()
                        for key in CLIPS:
                            if n.endswith(key):
                                seq = ad.get_asset()
                                c["anims"][key] = (seq, float(seq.get_play_length()))
                    comp.set_animation_mode(unreal.AnimationMode.ANIMATION_SINGLE_NODE)
                    comp.set_update_animation_in_editor(True)      # the editor world does not tick poses on its own
                    comp.set_editor_property("visibility_based_anim_tick_option", unreal.VisibilityBasedAnimTickOption.ALWAYS_TICK_POSE_AND_REFRESH_BONES)
                except Exception as e:
                    self._err("crew anims", e)
            self.crew[cid] = c
        # stress-test markers
        self.agents = []
        for a in tagged("agent"):
            comp = a.static_mesh_component
            base = comp.get_material(0)
            mid = comp.create_dynamic_material_instance(0, base)
            self.agents.append(dict(actor=a, comp=comp, base=base, mid=mid, status=None, visible=False, pos=None))
            self.show(a, False)
        self.agent_slot = {}
        # markers
        self.labels = [(a, a.get_actor_location()) for a in tagged("label")]
        self.quake_beams = tagged("quake")
        self.beacons = [(a, a.get_actor_location(), a.get_actor_scale3d()) for a in tagged("beacon") if "quake" not in tags_of(a)]
        self.rocks = []
        paths = self.layout.get("rockfall_paths", [])
        for a in tagged("rockfall"):
            k = int(tag_value(tags_of(a), "track:", "-1"))
            if 0 <= k < len(paths):
                pts = paths[k]["points"]
                cum = [0.0]
                for p, q in zip(pts, pts[1:]):
                    cum.append(cum[-1] + math.dist(p, q))
                self.rocks.append(dict(actor=a, pts=pts, cum=cum, delay=float(paths[k]["delay_s"]), size=float(paths[k]["size_m"]),
                                       state=None))
        # cameras: the actors tagged cue:<name> are poses; the one tagged cue:follow is the live camera
        self.cams = {}
        self.cam_target = {name: tuple(c["target"]) for name, c in self.layout.get("cameras", {}).items()}
        self.live_cam = None
        for a in tagged("camera"):
            name = tag_value(tags_of(a), "cue:")
            if name == "follow":
                self.live_cam = a
                continue
            loc, rot = a.get_actor_location(), a.get_actor_rotation()
            self.cams[name] = (loc.x, loc.y, loc.z, rot.pitch, rot.yaw, float(a.camera_component.field_of_view))
        self.view_set = False
        # terrain: dynamic material instances on the core tiles carry the overlays and the routes
        self.core = []
        for a in tagged("core"):
            comp = a.static_mesh_component
            base = comp.get_material(0)
            self.core.append((comp, base, comp.create_dynamic_material_instance(0, base)))
        self.rt = None
        try:
            fmt = getattr(unreal.TextureRenderTargetFormat, "RTF_RGBA8_SRGB", unreal.TextureRenderTargetFormat.RTF_RGBA8)
            self.rt = RL.create_render_target2d(w, ROUTE_RT, ROUTE_RT, fmt, unreal.LinearColor(0.0, 0.0, 0.0, 0.0), False)
            for _c, _b, mid in self.core:
                mid.set_texture_parameter_value("Routes", self.rt)
                mid.set_scalar_parameter_value("RoutesGlow", ROUTE_GLOW)
                mid.set_scalar_parameter_value("OverlayGlow", OVERLAY_GLOW)
                mid.set_scalar_parameter_value("Overlay2Glow", OVERLAY_GLOW)
        except Exception as e:
            self._err("route target", e)
        self.tex = {}                     # layer -> (mtime, texture)
        self.slots = [dict(param="Overlay", layer=None, op=0.0, want=0.0), dict(param="Overlay2", layer=None, op=0.0, want=0.0)]
        self.routes_dirty = True
        self.route_w = None
        self.route_drawn_at = 0.0
        self.overlays_dirty = True
        suns = list(GS.get_all_actors_of_class(w, unreal.DirectionalLight))
        self.sun_actor = suns[0] if suns else None
        self.sun_applied = None
        if game:
            try:
                unreal.SystemLibrary.execute_console_command(w, "DisableAllScreenMessages")
            except Exception as e:
                self._err("console", e)
        # dust sprites: a pool of camera-facing planes, parked under the terrain until used
        self.dust = []
        self.devil = None
        for a in tagged("dust"):
            comp = a.static_mesh_component
            base = comp.get_material(0)
            mid = comp.create_dynamic_material_instance(0, base)
            mid.set_scalar_parameter_value("Alpha", 0.0)
            mid.set_vector_parameter_value("Color", unreal.LinearColor(DUST_RGB[0], DUST_RGB[1], DUST_RGB[2], 1.0))
            mid.set_scalar_parameter_value("Light", DUST_LIGHT)
            self.dust.append(dict(actor=a, comp=comp, base=base, mid=mid, alive=False, born=0.0, shown=0.0, kind=None))
        home = self.layout["places"]["S"]["ue"]
        self.park = unreal.Transform(unreal.Vector(home[0], home[1], home[2] - 6000.0), unreal.Rotator(0.0, 0.0, 0.0),
                                     unreal.Vector(0.01, 0.01, 0.01))
        # ground markers of the chosen route
        self.crumbs = [dict(actor=a, j=None, k=0.0) for a in tagged("crumb")]
        self.crumb_key = None
        self.crumb_pts = []
        self.crumb_i0 = 0
        # scout helicopter and its rotor disc
        self.heli = None
        body = tagged("helicopter")
        if body:
            actors = body[:1] + tagged("rotor")[:1]
            loc = body[0].get_actor_location()
            self.heli = dict(actors=actors, home=[(a.get_actor_location(), a.get_actor_rotation()) for a in actors],
                             c=[loc.x, loc.y], z=loc.z, up=[a.get_actor_location().z - loc.z for a in actors])
        self._apply_incident(reset_only=True)
        self.cam_now = self.cam_now or self.cams.get("overview")
        self.cam_from = self.cam_now
        self.routes_op = None
        self.routes_visible = False
        self.bound = True
        unreal.log(f"director: bound to {'game' if game else 'editor'} world, {len(self.crew)} crew, {len(self.agents)} markers, "
                   f"{len(self.core)} core tiles, {len(self.rocks)} rock tracks, {len(self.dust)} dust sprites")

    # ------------------------------------------------------------------------------------- tick
    def _tick(self, _dt):
        now = time.time()
        dt = min(0.25, max(0.0, now - self.last_tick))
        self.last_tick = now
        if dt > 0:
            self.fps = lerp(self.fps, 1.0 / dt, 0.05)
        try:
            self._receive(now)
        except Exception as e:
            self._err("receive", e)
        try:
            w, game = self._pick_world()
            key = None if w is None else (w.get_path_name(), game)
            if key != self.key:
                if self.world is not None:
                    try:
                        self._unbind()
                    except Exception as e:
                        self._err("unbind", e)
                self.key = key
                if w is not None:
                    self._bind(w, game)
            if self.world is not None and self.bound:             # a blocked bind lets ticks nest: wait until it is done
                self._update(now, dt)
        except Exception as e:
            self._err("tick", e)
            if "trace" not in self.counts:
                self.counts["trace"] = traceback.format_exc()[-900:]
        if now - self.last_dump > 1.0:
            self.last_dump = now
            self._dump(now)

    def _receive(self, now):
        msgs = []
        for _ in range(600):
            try:
                data = self.sock.recv(65535)
            except (BlockingIOError, OSError):
                break
            parse_osc(data, msgs)
        for addr, a in msgs:
            self.counts[addr] = self.counts.get(addr, 0) + 1
            try:
                if addr == "/crew" and len(a) >= 7:
                    self.crew_in[int(a[0])] = dict(e=a[1], s=a[2], z=a[3], heading=a[4], pace=a[5], status=int(a[6]), t=now)
                elif addr == "/agent" and len(a) >= 7:
                    self.agent_in[(int(a[0]), int(a[1]))] = dict(e=a[2], s=a[3], z=a[4], heading=a[5], status=int(a[6]), t=now)
                elif addr == "/clock" and len(a) >= 4:
                    self.clock = (a[0], a[1])
                    self.sun = (a[2], a[3])
                elif addr == "/incident" and len(a) >= 5:
                    self.last_msg[addr] = a
                    prev = self.incident
                    self.incident = (str(a[0]), str(a[1]), float(a[2]), float(a[3]), float(a[4]))
                    if self.incident[0] == "quake" and self.incident[1] == "detect" and prev[:2] != ("quake", "detect"):
                        self.quake_t0 = now
                    if self.incident[0] == "none":
                        self.quake_t0 = None
                    if self.world is not None:
                        self._apply_incident()
                elif addr == "/overlay" and len(a) >= 2:
                    self.overlay_want[str(a[0])] = float(a[1])
                    self.overlays_dirty = True
                elif addr == "/reload" and a:
                    self.last_msg[addr] = a
                    if a[0] == "routes":
                        self._load_routes()
                    elif a[0] == "overlay":
                        if self.world is not None:
                            self.tex = {}
                            for s in self.slots:
                                s["layer"] = None
                        self.overlays_dirty = True
                elif addr == "/route" and len(a) >= 2:
                    self.route_state[int(a[0])] = str(a[1])
                    self.routes_dirty = True
                elif addr == "/cue" and a:
                    self.last_msg[addr] = a
                    self._cue(str(a[0]), float(a[1]) if len(a) > 1 else 4.0, now)
            except Exception as e:
                self._err(addr, e)

    def _update(self, now, dt):
        if self.game and not self.view_set and self.live_cam is not None:
            pc = GS.get_player_controller(self.world, 0)
            if pc is not None:
                pc.set_view_target_with_blend(self.live_cam, 0.0)
                self.view_set = True
        self._move_crew(now, dt)
        self._move_agents(now, dt)
        self._move_rocks(now, dt)
        self._camera(now, dt)
        self._move_heli(now, dt)
        self._update_dust(now, dt)
        self._update_crumbs(now)
        w = self._route_width_m()
        if self.routes_dirty or (self.route_w and abs(w / self.route_w - 1.0) > 0.12 and now - self.route_drawn_at > 0.2):
            self.routes_dirty = False
            self.route_w = w
            self.route_drawn_at = now
            self._draw_routes()
        op = (ROUTE_OPACITY.get(self.cue, 1.0) if self.routes_visible else 0.0)
        if self.routes_op is None or abs(op - self.routes_op) > 0.004:
            self.routes_op = op if self.routes_op is None else lerp(self.routes_op, op, min(1.0, dt * 2.5))
            for _c, _b, mid in self.core:
                mid.set_scalar_parameter_value("RoutesOpacity", self.routes_op)
                mid.set_scalar_parameter_value("RoutesGlow", ROUTE_GLOW * self.routes_op)
        self._update_overlays(dt)
        self._update_sun()
        self._face_labels()

    # ------------------------------------------------------------------------------------- crew
    def _move_crew(self, now, dt):
        for cid, c in self.crew.items():
            m = self.crew_in.get(cid)
            if m is None:
                continue
            tx, ty, tz = self.ue(m["e"], m["s"], m["z"])
            if c["pos"] is None or math.dist(c["pos"], (tx, ty, tz)) > 3000.0:
                c["pos"] = [tx, ty, tz]
                c["heading"] = m["heading"]
            k = 1.0 - math.exp(-dt / 0.09)
            p = c["pos"]
            was = (p[0], p[1])
            p[0], p[1], p[2] = lerp(p[0], tx, k), lerp(p[1], ty, k), lerp(p[2], tz, k)
            moved_m = math.hypot(p[0] - was[0], p[1] - was[1]) / 100.0
            c["heading"] = lerp_angle(c["heading"], m["heading"], 1.0 - math.exp(-dt / 0.25))
            status = m["status"] if now - m["t"] < 2.0 else 1
            walking = status == 0 and m["pace"] > 0.02
            self._crew_dust(now, c, p, status, walking)
            h = math.radians(c["heading"])
            fwd = unreal.Vector(math.sin(h), -math.cos(h), 0.0)
            right = unreal.Vector(math.cos(h), math.sin(h), 0.0)
            lean, sway, lift, twist = 0.0, 0.0, 0.0, 0.0
            if c["skeletal"]:
                pass                                              # the clips carry the body motion
            elif status == 3:
                lean, lift = 84.0, 28.0
            elif status == 2:
                lean = 32.0
            elif walking:
                c["phase"] += dt * 1.7 * max(0.5, min(1.6, m["pace"]))
                lean = 5.0
                sway = 2.6 * math.sin(math.pi * c["phase"])
                lift = 3.2 * abs(math.sin(math.pi * c["phase"]))
                twist = 4.5 * math.sin(math.pi * c["phase"] + 0.6)
            rot = unreal.Rotator(roll=0.0, pitch=0.0, yaw=c["heading"] - 90.0 - c["facing"] + twist)
            if lean:
                rot = ML.compose_rotators(rot, ML.rotator_from_axis_and_angle(right, lean))
            if sway:
                rot = ML.compose_rotators(rot, ML.rotator_from_axis_and_angle(fwd, sway))
            c["actor"].set_actor_location_and_rotation(unreal.Vector(p[0], p[1], p[2] + lift), rot, False, True)
            if c["beam"] is not None:                             # a pointer for wide shots; gone when the camera is close
                d = math.dist(p, self.cam_now[:3]) / 100.0 if self.cam_now else 1000.0
                near = d < 90.0
                if near != c.get("beam_hidden"):
                    c["beam_hidden"] = near
                    self.show(c["beam"], not near)
                if not near:
                    w = max(0.1, min(8.0, d * 0.0024))
                    c["beam"].set_actor_scale3d(unreal.Vector(w, w, 45.0))
                    c["beam"].set_actor_location(unreal.Vector(p[0], p[1], p[2] + 2550.0), False, True)
            if c["skeletal"]:
                self._animate(c, status, walking, moved_m, dt)

    def _animate(self, c, status, walking, moved_m, dt):
        """Pose the rigged suit: the walk clip advances with the ground covered, the other clips with time."""
        want = "walk" if walking else CLIP_FOR.get(status, "idletalk" if c["cid"] % 2 else "idle")
        if want not in c["anims"]:
            want = "idle"
        clip = c["anims"].get(want)
        if clip is None:
            return
        seq, length = clip
        if want != c["playing"]:
            c["playing"] = want
            c["comp"].set_animation(seq)
            c["comp"].set_play_rate(0.0)                          # the position is set by hand every tick
            if want != "walk":
                c["clip_t"] = 0.0
        if want == "walk":
            c["phase"] = (c["phase"] + min(moved_m / STRIDE_M, MAX_CADENCE * dt)) % 1.0
            t = c["phase"] * length
        else:
            c["clip_t"] += dt
            t = min(c["clip_t"], length - 0.04) if want in CLIP_ONCE else c["clip_t"] % length
        c["comp"].set_position(t, False)

    # ----------------------------------------------------------------------------------- agents
    def _move_agents(self, now, dt):
        if not self.agents:
            return
        live = {k: m for k, m in self.agent_in.items() if now - m["t"] < 0.7}
        if not live:
            if self.agent_slot:
                for ag in self.agents:
                    if ag["visible"]:
                        self.show(ag["actor"], False)
                        ag["visible"] = False
                self.agent_slot = {}
                self.agent_in = {}
            return
        for k in list(self.agent_slot):
            if k not in live:
                ag = self.agents[self.agent_slot.pop(k)]
                self.show(ag["actor"], False)
                ag["visible"] = False
        free = [i for i in range(len(self.agents)) if i not in self.agent_slot.values()]
        cam = self.cam_now
        for k, m in live.items():
            if k not in self.agent_slot:
                if not free:
                    continue
                self.agent_slot[k] = free.pop()
                self.agents[self.agent_slot[k]]["pos"] = None
            ag = self.agents[self.agent_slot[k]]
            tx, ty, tz = self.ue(m["e"], m["s"], m["z"], 1.4)
            if ag["pos"] is None:
                ag["pos"] = [tx, ty, tz]
            p = ag["pos"]
            a = 1.0 - math.exp(-dt / 0.09)
            p[0], p[1], p[2] = lerp(p[0], tx, a), lerp(p[1], ty, a), lerp(p[2], tz, a)
            ag["actor"].set_actor_location(unreal.Vector(p[0], p[1], p[2]), False, True)
            if cam is not None:                                   # keep the marker a few pixels wide from far away
                d = math.dist(p, cam[:3])
                s = max(2.2, d * 0.00007)
                ag["actor"].set_actor_scale3d(unreal.Vector(s, s, s))
            if m["status"] != ag["status"]:
                ag["status"] = m["status"]
                r, g, b = STATUS_RGB.get(m["status"], STATUS_RGB[0])
                ag["mid"].set_vector_parameter_value("Color", unreal.LinearColor(r, g, b, 1.0))
            if not ag["visible"]:
                self.show(ag["actor"], True)
                ag["visible"] = True

    # ---------------------------------------------------------------------------------- incident
    def _apply_incident(self, reset_only=False):
        kind = self.incident[0]
        quake = kind == "quake" and self.quake_t0 is not None
        for a in self.quake_beams:
            self.show(a, quake)
        if not quake:
            for r in self.rocks:
                if r["state"] != "parked":
                    r["state"] = "parked"
                    p = r["pts"][0]
                    r["actor"].set_actor_location(unreal.Vector(p[0], p[1], p[2]), False, True)
                    self.show(r["actor"], False)

    def _move_rocks(self, now, dt):
        if self.quake_t0 is None:
            return
        for r in self.rocks:
            if r["state"] == "rest":
                continue
            t = now - self.quake_t0 - 1.0 - r["delay"] * 0.7
            if t < 0.0:
                continue
            if r["state"] != "moving":
                r["state"] = "moving"
                r["puff_at"] = 0.0
                self.show(r["actor"], True)
            total = r["cum"][-1]
            dur = max(6.0, total / 3200.0)                        # about 32 m/s once it is going
            u = min(1.0, t / dur)
            d = total * (1.0 - (1.0 - u) ** 1.8) if u > 0.25 else total * (u * u) * (1.0 - 0.75 ** 1.8) / 0.0625
            d = min(total, d)
            cum, pts = r["cum"], r["pts"]
            i = 1
            while i < len(cum) - 1 and cum[i] < d:
                i += 1
            f = (d - cum[i - 1]) / max(1e-6, cum[i] - cum[i - 1])
            p, q = pts[i - 1], pts[i]
            hop = abs(math.sin(d / (r["size"] * 900.0))) * r["size"] * 70.0 * (1.0 - u)
            loc = unreal.Vector(lerp(p[0], q[0], f), lerp(p[1], q[1], f), lerp(p[2], q[2], f) + hop)
            spin = math.degrees(d / (r["size"] * 50.0))
            yaw = math.degrees(math.atan2(q[1] - p[1], q[0] - p[0]))
            r["actor"].set_actor_location_and_rotation(loc, unreal.Rotator(roll=0.0, pitch=-spin, yaw=yaw), False, True)
            if now >= r.get("puff_at", 0.0) or u >= 1.0:          # a dust trail, and a last cloud where the rock stops
                r["puff_at"] = now + 0.9
                sz = r["size"] * 100.0
                for _ in range(3 if u >= 1.0 else 1):                # a rockfall on a dry slope raises clouds far bigger than the rock
                    self._puff(now, (loc.x, loc.y, loc.z + sz), (WIND[0] * 260.0, WIND[1] * 260.0, 220.0), sz * 6.0, sz * 22.0,
                               self.rng.uniform(6.0, 7.5), 0.5, "rock", jitter=sz * 2.0, gain=1.15)
            if u >= 1.0:
                r["state"] = "rest"

    # ------------------------------------------------------------------------------------ routes
    def _load_routes(self):
        try:
            with open(os.path.join(RUNTIME, "routes.json"), encoding="utf8") as f:
                self.routes = json.load(f).get("routes", [])
        except Exception as e:
            self.routes = []
            self._err("routes.json", e)
        k = ROUTE_RT / self.h.size
        for r in self.routes:
            r["px"] = [(x * k, y * k) for x, y in
                       round_path([(p[0] - self.h.e0, p[1] - self.h.s0) for p in r.get("points", [])])]
        self.route_state = {}
        self.routes_dirty = True

    def _route_width_m(self):
        """Base line width in metres: a few pixels on screen from the overview, narrow next to the crew."""
        cam = self.cam_now
        if cam is None:
            return 8.0
        g = self.ground_cm(cam[0], cam[1])
        height_m = (cam[2] - g) / 100.0 if g is not None else 1200.0
        return max(0.9, min(14.0, height_m * 0.011))

    def _draw_routes(self):
        if self.rt is None:
            return
        RL.clear_render_target2d(self.world, self.rt, unreal.LinearColor(0.0, 0.0, 0.0, 0.0))
        visible = [r for r in self.routes if self.route_state.get(r["id"], "hidden") in ROUTE_STYLE and len(r.get("px", ())) > 1]
        if visible:
            canvas, _size, ctx = RL.begin_draw_canvas_to_render_target(self.world, self.rt)
            base_px = (self.route_w or 8.0) * ROUTE_RT / self.h.size
            for state in ROUTE_ORDER:
                (cr, cg, cb), rel = ROUTE_STYLE[state]
                width = max(1.6, base_px * rel)
                # from far away a dark, wider pass under the line gives it an edge on bright ground
                passes = [(unreal.LinearColor(cr, cg, cb, 1.0), width)]
                if base_px >= 5.0:
                    passes.insert(0, (unreal.LinearColor(cr * 0.16, cg * 0.16, cb * 0.16, 1.0), width * 1.9))
                for colour, w in passes:
                    radius = unreal.Vector2D(w * 0.5, w * 0.5)
                    for r in visible:
                        if self.route_state.get(r["id"]) != state:
                            continue
                        pts = r["px"]
                        for a, b in zip(pts, pts[1:]):
                            canvas.draw_line(unreal.Vector2D(a[0], a[1]), unreal.Vector2D(b[0], b[1]), w, colour)
                        if w >= 3.0 and self.round_joints:            # round the joints of a thick line
                            try:
                                for a in pts:
                                    canvas.draw_polygon(None, unreal.Vector2D(a[0], a[1]), radius, 10, colour)
                            except Exception as e:
                                self.round_joints = False
                                self._err("route joints", e)
            RL.end_draw_canvas_to_render_target(self.world, ctx)
        self.routes_visible = bool(visible)

    def chosen_end(self):
        """Unreal position of the end of the chosen route (the shelter the crew is sent to), or None."""
        for r in self.routes:
            if self.route_state.get(r["id"]) == "chosen" and r.get("points"):
                p = r["points"][-1]
                return self.ue(p[0], p[1], p[2] if len(p) > 2 else None)
        return None

    # ---------------------------------------------------------------------------------- overlays
    def _texture(self, layer):
        path = os.path.join(RUNTIME, f"overlay_{layer}.png")
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return None
        hit = self.tex.get(layer)
        if hit is None or hit[0] != mtime:
            tex = RL.import_file_as_texture2d(self.world, path)
            if tex is None:
                return None
            self.tex[layer] = (mtime, tex)
        return self.tex[layer][1]

    def _update_overlays(self, dt):
        if self.overlays_dirty:
            self.overlays_dirty = False
            want = sorted(((op, layer) for layer, op in self.overlay_want.items() if op > 0.01))[-2:]   # the two strongest
            names = [layer for _op, layer in want]
            for s in self.slots:                                  # keep a layer in its slot if it is still wanted
                if s["layer"] in names:
                    s["want"] = self.overlay_want[s["layer"]]
                    names.remove(s["layer"])
                else:
                    s["want"] = 0.0
                    s["next"] = None
            for s in self.slots:
                if s["want"] == 0.0 and names:
                    s["next"] = names.pop()                       # swapped in once the old layer has faded out
        scale = OVERLAY_SCALE.get(self.cue, 1.0)
        for s in self.slots:
            nxt = s.get("next")
            if nxt and s["op"] <= 0.02:
                tex = self._texture(nxt)
                s["next"] = None
                if tex is not None:
                    s["layer"], s["want"] = nxt, self.overlay_want.get(nxt, 0.0)
                    for _c, _b, mid in self.core:
                        mid.set_texture_parameter_value(s["param"], tex)
            want = s["want"] * scale
            if abs(s["op"] - want) > 0.002:
                s["op"] = lerp(s["op"], want, min(1.0, dt * 4.0))
                if abs(s["op"] - want) <= 0.002:
                    s["op"] = want
                for _c, _b, mid in self.core:
                    mid.set_scalar_parameter_value(s["param"] + "Opacity", s["op"])

    # --------------------------------------------------------------------------------------- sun
    def _update_sun(self):
        if self.sun is None or self.sun_actor is None:
            return
        az, el = self.sun[0], max(MIN_SUN_EL, self.sun[1])
        if self.sun_applied is not None and abs(az - self.sun_applied[0]) < 0.15 and abs(el - self.sun_applied[1]) < 0.15:
            return
        self.sun_applied = (az, el)
        # azimuth is clockwise from north (north = -Y, east = +X); the light points from the sun to the ground
        self.sun_actor.set_actor_rotation(unreal.Rotator(roll=0.0, pitch=-el, yaw=az + 90.0), False)

    # ------------------------------------------------------------------------------------ camera
    def _cue(self, name, duration, now):
        self.cam_from = self.cam_now
        self.cue = name
        self.cue_t0 = now
        self.cue_blend = max(1.2, min(3.0, duration * 0.5))

    def _look(self, loc, target, fov):
        r = ML.find_look_at_rotation(unreal.Vector(*loc), unreal.Vector(*target))
        return (loc[0], loc[1], loc[2], r.pitch, r.yaw, fov)

    def _orbit(self, loc, target, fov, tau, swing, period, push):
        """A slow swing around the subject and a slight push-in: a held shot never stands still."""
        a = math.radians(swing) * math.sin(2.0 * math.pi * tau / period)
        k = 1.0 - push * (0.5 - 0.5 * math.cos(2.0 * math.pi * tau / (period * 0.73)))
        dx, dy, dz = loc[0] - target[0], loc[1] - target[1], loc[2] - target[2]
        ca, sa = math.cos(a), math.sin(a)
        return self._look((target[0] + (dx * ca - dy * sa) * k, target[1] + (dx * sa + dy * ca) * k, target[2] + dz * k), target, fov)

    def _lead(self):
        lead = self.crew.get(0) or next(iter(self.crew.values()), None)
        return lead if lead is not None and lead["pos"] is not None else None

    def _pose(self, name, now):
        tau = now - self.cue_t0
        if name == "follow":
            lead = self._lead()
            if lead is not None:
                p = lead["pos"]
                # behind and to the side, drifting slowly around the walker
                a = math.radians(lead["heading"] + 180.0 + 32.0 + 22.0 * math.sin(2.0 * math.pi * tau / 48.0))
                dist = 950.0 + 180.0 * math.sin(2.0 * math.pi * tau / 31.0)
                want = [p[0] + math.sin(a) * dist, p[1] - math.cos(a) * dist, p[2] + 340.0 + 70.0 * math.sin(2.0 * math.pi * tau / 37.0)]
                if self.follow is None or math.dist(self.follow, want) > 20000.0:
                    self.follow = want
                k = 0.035
                self.follow = [lerp(self.follow[i], want[i], k) for i in range(3)]
                g = self.ground_cm(self.follow[0], self.follow[1])
                loc = (self.follow[0], self.follow[1], max(self.follow[2], (g if g is not None else -1e9) + 190.0))
                return self._look(loc, (p[0], p[1], p[2] + 130.0), 55.0)
            name = "overview"
        if name == "shelter":
            end = self.chosen_end()
            if end is not None:
                loc = [end[0] - 9000.0, end[1] + 12000.0, end[2] + 4200.0]
                g = self.ground_cm(loc[0], loc[1])
                if g is not None:
                    loc[2] = max(loc[2], g + 1500.0)
                return self._orbit(loc, (end[0], end[1], end[2] + 300.0), 45.0, tau, *ORBIT["shelter"])
        if name not in self.cams:
            name = "overview"
        pose = self.cams.get(name)
        if pose is None:
            return self.cam_now
        if name in self.cam_target:
            return self._orbit(pose[:3], self.cam_target[name], pose[5], tau, *ORBIT.get(name, ORBIT["overview"]))
        t = now * 0.11
        return (pose[0], pose[1], pose[2], pose[3] + 0.25 * math.sin(t * 1.3), pose[4] + 0.6 * math.sin(t), pose[5])

    def _camera(self, now, dt):
        target = self._pose(self.cue, now)
        if target is None:
            return
        src = self.cam_from or target
        u = smooth((now - self.cue_t0) / self.cue_blend)
        pose = [lerp(src[0], target[0], u), lerp(src[1], target[1], u), lerp(src[2], target[2], u),
                lerp_angle(src[3], target[3], u), lerp_angle(src[4], target[4], u), lerp(src[5], target[5], u)]
        g = self.ground_cm(pose[0], pose[1])
        if g is not None:
            pose[2] = max(pose[2], g + 220.0)
        self.cam_now = tuple(pose)
        pitch, yaw, roll = pose[3], pose[4], 0.0
        if self.quake_t0 is not None:
            q = now - self.quake_t0
            amp = 0.9 * math.exp(-q / 2.6) if q < 14.0 else 0.0
            if amp > 0.01:
                pitch += amp * (math.sin(q * 37.0) + 0.6 * math.sin(q * 61.7 + 1.3)) * 0.6
                yaw += amp * (math.sin(q * 29.3 + 0.7) + 0.6 * math.sin(q * 53.1)) * 0.6
                roll = amp * math.sin(q * 23.9 + 2.1) * 0.5
        loc, rot = unreal.Vector(pose[0], pose[1], pose[2]), unreal.Rotator(roll=roll, pitch=pitch, yaw=yaw)
        if self.game:
            if self.live_cam is not None:
                self.live_cam.set_actor_location_and_rotation(loc, rot, False, True)
                self.live_cam.camera_component.set_field_of_view(pose[5])
        else:
            unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).set_level_viewport_camera_info(loc, rot)
            self._viewport_fov(pose[5])

    def _viewport_fov(self, fov):
        """The editor viewport takes the field of view of the shot, as the game camera does."""
        if self.vp_fov is not None and abs(self.vp_fov - fov) < 0.05:
            return
        try:
            les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
            key = les.get_active_viewport_config_key()
            if self.vp_fov_home is None:
                self.vp_fov_home = (key, les.get_level_viewport_fov(key))
            les.set_level_viewport_fov(fov, key)
            self.vp_fov = fov
        except Exception as e:
            self._err("viewport fov", e)
            self.vp_fov = fov

    def _face_labels(self):
        cam = self.cam_now
        if cam is None:
            return
        c = unreal.Vector(cam[0], cam[1], cam[2])
        for a, loc in self.labels:
            d = math.dist((loc.x, loc.y, loc.z), cam[:3])
            s = max(0.03, min(4.0, d / LABEL_REF_CM))
            a.set_actor_rotation(ML.find_look_at_rotation(loc, c), False)
            a.set_actor_scale3d(unreal.Vector(s, s, s))
        for a, loc, scale in self.beacons:                        # beams thin out as the camera comes close
            k = max(0.05, min(1.0, math.dist((loc.x, loc.y, loc.z), cam[:3]) / 150000.0))
            a.set_actor_scale3d(unreal.Vector(scale.x * k, scale.y * k, scale.z))

    # -------------------------------------------------------------------------------- helicopter
    def _move_heli(self, now, dt):
        """The scout helicopter circles the lead crew member (its landing spot until the crew moves)."""
        h = self.heli
        if h is None:
            return
        lead = self._lead()
        want = lead["pos"][:2] if lead is not None else [h["home"][0][0].x, h["home"][0][0].y]
        dx, dy = want[0] - h["c"][0], want[1] - h["c"][1]
        far = math.hypot(dx, dy)
        if far > 1.0:
            step = min(far, max(1400.0, min(9000.0, far * 0.3)) * dt)   # 14 m/s beside the crew, faster to catch up
            h["c"][0] += dx / far * step
            h["c"][1] += dy / far * step
        ang = now * 2.0 * math.pi / 38.0
        x, y = h["c"][0] + 2600.0 * math.cos(ang), h["c"][1] + 2600.0 * math.sin(ang)
        g = self.ground_cm(x, y)
        z = (g if g is not None else h["z"]) + 950.0 + 90.0 * math.sin(now * 0.7)
        h["z"] = lerp(h["z"], z, 1.0 - math.exp(-dt / 1.2))
        rot = unreal.Rotator(roll=-9.0, pitch=-5.0, yaw=math.degrees(ang) + 90.0)
        for actor, up in zip(h["actors"], h["up"]):
            actor.set_actor_location_and_rotation(unreal.Vector(x, y, h["z"] + up), rot, False, True)

    # ----------------------------------------------------------------------------- route markers
    def _update_crumbs(self, now):
        """Small glowing discs on the ground along the chosen route, ahead of the crew, with a pulse running towards the goal."""
        pool = self.crumbs
        if not pool:
            return
        chosen = next((r for r in self.routes if self.route_state.get(r["id"]) == "chosen" and len(r.get("points", ())) > 1), None)
        key = None if chosen is None else (chosen["id"], len(chosen["points"]), tuple(chosen["points"][-1][:2]))
        if key != self.crumb_key:
            self.crumb_key = key
            self.crumb_pts = []
            self.crumb_i0 = 0
            if chosen is not None:
                line = round_path([(p[0], p[1]) for p in chosen["points"]], spacing=2.0)
                z, carry = self.h.z, 0.0
                for a, b in zip(line, line[1:]):
                    seg = math.dist(a, b)
                    t = carry
                    while t < seg:
                        e, s = lerp(a[0], b[0], t / seg), lerp(a[1], b[1], t / seg)
                        t += CRUMB_STEP
                        zc = z(e, s)
                        if zc is None:
                            continue
                        nx = ((z(e - 1.0, s) or zc) - (z(e + 1.0, s) or zc)) * 0.5      # the disc lies flat on the slope
                        ny = ((z(e, s - 1.0) or zc) - (z(e, s + 1.0) or zc)) * 0.5
                        self.crumb_pts.append((unreal.Vector(e * 100.0, s * 100.0, (zc - self.z_ref) * 100.0 + 7.0),
                                               ML.make_rot_from_z(unreal.Vector(nx, ny, 1.0))))
                    carry = t - seg
        pts, n = self.crumb_pts, len(pool)
        lead = self._lead()
        if pts and lead is not None:                              # markers the crew has passed are gone
            p = lead["pos"]
            i0 = self.crumb_i0
            best, bd = i0, 1e18
            for j in range(max(0, i0 - 2), min(len(pts), i0 + 30)):
                d = (pts[j][0].x - p[0]) ** 2 + (pts[j][0].y - p[1]) ** 2
                if d < bd:
                    best, bd = j, d
            if bd < 2500.0 ** 2:
                self.crumb_i0 = best + 1
        i0 = self.crumb_i0
        wave = i0 + (now * 13.0) % (n + 10.0) - 4.0
        for k, c in enumerate(pool):
            j = i0 + (k - i0) % n                                 # each actor keeps its place until the window has passed it
            if j >= len(pts):
                if c["j"] is not None:
                    c["j"] = None
                    c["actor"].set_actor_transform(self.park, False, True)
                continue
            size = CRUMB_SIZE * (1.0 + 0.9 * math.exp(-((j - wave) / 2.2) ** 2))
            if c["j"] != j:
                c["j"], c["k"] = j, size
                c["actor"].set_actor_transform(unreal.Transform(pts[j][0], pts[j][1], unreal.Vector(size, size, 0.02)), False, True)
            elif abs(size - c["k"]) > 0.012:
                c["k"] = size
                c["actor"].set_actor_scale3d(unreal.Vector(size, size, 0.02))

    # -------------------------------------------------------------------------------------- dust
    def _puff(self, now, pos, vel, size0, size1, life, alpha, kind, jitter=0.0, wide=1.0, fade_in=0.12, gain=1.0):
        """Start one dust sprite (cm, cm/s, cm across, seconds); the oldest one is reused when the pool is full."""
        pool = self.dust
        if not pool:
            return None
        d = None
        for _ in range(len(pool)):
            self.dust_next = (self.dust_next + 1) % len(pool)
            if not pool[self.dust_next]["alive"]:
                d = pool[self.dust_next]
                break
        if d is None:
            d = min((c for c in pool if c["kind"] != "devil"), key=lambda c: c["born"], default=None)
            if d is None:
                return None
        r = self.rng
        j = jitter
        d.update(alive=True, born=now, life=life, kind=kind, a=alpha, s0=size0, s1=size1, fade_in=fade_in,
                 p=[pos[0] + r.uniform(-j, j), pos[1] + r.uniform(-j, j), pos[2] + r.uniform(0.0, j * 0.5)],
                 v=[vel[0] * r.uniform(0.7, 1.3), vel[1] * r.uniform(0.7, 1.3), vel[2] * r.uniform(0.7, 1.3)],
                 flip=r.choice((-1.0, 1.0)), wide=wide, off=None, gain=gain)
        if gain != d.get("gain_set", 1.0):
            d["gain_set"] = gain
            d["mid"].set_scalar_parameter_value("Light", DUST_LIGHT * gain)
        cell = r.choice(ATLAS)
        d["mid"].set_vector_parameter_value("Cell", unreal.LinearColor(cell[0], cell[1], 0.0, 0.0))
        d["mid"].set_scalar_parameter_value("Soft", max(12.0, min(4000.0, size1 * 0.25)))
        return d

    def _kill(self, d):
        d["alive"] = False
        d["kind"] = None
        d["actor"].set_actor_transform(self.park, False, True)
        if d["shown"]:
            d["shown"] = 0.0
            d["mid"].set_scalar_parameter_value("Alpha", 0.0)

    def _crew_dust(self, now, c, p, status, walking):
        """Dust kicked up by each step, and a cloud where someone goes down."""
        cam = self.cam_now
        if not self.dust or cam is None or math.dist(p, cam[:3]) > 45000.0:
            c["step_at"] = None
            return
        if status in (2, 3) and c.get("status_seen") not in (2, 3):
            for _ in range(5):
                self._puff(now, (p[0], p[1], p[2] + 20.0), (WIND[0] * 40.0, WIND[1] * 40.0, 45.0), 70.0, 260.0, 3.2, 0.5, "step", jitter=45.0)
        c["status_seen"] = status
        last = c.get("step_at")
        if last is None:
            c["step_at"] = (p[0], p[1], now)
            return
        if walking and math.hypot(p[0] - last[0], p[1] - last[1]) > 55.0 and now - last[2] > 0.2:
            c["step_at"] = (p[0], p[1], now)
            h = math.radians(c["heading"])
            back = (-math.sin(h) * 35.0 + WIND[0] * 40.0, math.cos(h) * 35.0 + WIND[1] * 40.0, 32.0)
            self._puff(now, (p[0], p[1], p[2] + 14.0), back, 45.0, 190.0, self.rng.uniform(2.0, 2.8), 0.62, "step", jitter=14.0)

    def _focus(self):
        """Where the camera looks on the ground (cm) and how far away that is (m); None when it looks off the map."""
        cam = self.cam_now
        if self.cue == "follow":
            lead = self._lead()
            if lead is not None:
                p = lead["pos"]
                return (p[0], p[1], p[2]), max(8.0, math.dist(p, cam[:3]) / 100.0)
        pr, yr = math.radians(cam[3]), math.radians(cam[4])
        fx, fy, fz = math.cos(pr) * math.cos(yr), math.cos(pr) * math.sin(yr), math.sin(pr)
        d, seen = 1000.0, None
        for _ in range(48):
            x, y, z = cam[0] + fx * d, cam[1] + fy * d, cam[2] + fz * d
            g = self.ground_cm(x, y)
            if g is not None:
                seen = ((x, y, g), d / 100.0)
                if z <= g:
                    return seen
            elif seen is not None:
                return seen
            d *= 1.2
        return seen

    def _wisps(self, now, alive):
        """Wind-blown dust near the ground, sized and paced for how far the camera is from what it looks at."""
        blending = now - self.cue_t0 < self.cue_blend
        if self.cue != self.wisp_cue:                             # the shot changed: the old ones were sized for another distance
            self.wisp_cue = self.cue
            for d in alive:
                if d["kind"] == "wisp":
                    left = d["life"] - (now - d["born"])
                    if left > 1.2:
                        d["born"] -= left - 1.2
        if blending or sum(1 for d in alive if d["kind"] == "wisp") >= N_WISPS:
            return
        hit = self._focus()
        if hit is None:
            return
        (fx, fy, _fz), dist = hit
        dist = max(12.0, min(3000.0, dist))
        r = self.rng
        reach = max(1400.0, dist * 55.0)                           # cm: half-width of the patch of ground in view
        ang, rad = r.uniform(0.0, 2.0 * math.pi), reach * math.sqrt(r.random())
        speed = max(200.0, min(3000.0, dist * 1.2))               # cm/s
        life = r.uniform(9.0, 15.0)
        x = fx + rad * math.cos(ang) - WIND[0] * speed * life * 0.4      # start upwind: it crosses the view as it lives
        y = fy + rad * math.sin(ang) - WIND[1] * speed * life * 0.4
        g = self.ground_cm(x, y)
        if g is None:
            return
        size = max(150.0, min(18000.0, dist * r.uniform(5.0, 11.0)))
        d = self._puff(now, (x, y, g + size * 0.3), (WIND[0] * speed, WIND[1] * speed, 0.0), size, size * 1.7, life,
                       r.uniform(0.2, 0.34) + (0.05 if dist > 400.0 else 0.0), "wisp", wide=r.uniform(1.8, 2.8), fade_in=0.25)
        if d is not None:
            d["off"] = size * 0.3                                 # it hugs the ground as it drifts

    def _devil(self, now, dt):
        """One dust devil at a time: a leaning column of sprites that swirls, drifts with the wind and dies out."""
        dv = self.devil
        cam = self.cam_now
        if dv is None:
            if now < self.devil_at or now - self.cue_t0 < self.cue_blend:
                return
            hit = self._focus()
            if hit is None:
                return
            (fx, fy, _fz), dist = hit
            dist = max(12.0, min(3000.0, dist))
            r = self.rng
            yaw = math.radians(cam[4] + r.uniform(-18.0, 18.0))
            away = (max(60.0, min(600.0, dist * 0.25)) + r.uniform(200.0, 450.0)) * 100.0
            x, y = fx + math.cos(yaw) * away, fy + math.sin(yaw) * away
            g = self.ground_cm(x, y)
            if g is None or any(abs((self.ground_cm(x + ox, y + oy) or 1e9) - g) > 1400.0 for ox, oy in ((4000, 0), (-4000, 0), (0, 4000), (0, -4000))):
                self.devil_at = now + 0.5                         # off the map or too steep: try another spot
                return
            dv = self.devil = dict(c=[x, y], t0=now, life=r.uniform(45.0, 70.0), height=r.uniform(11000.0, 18000.0), puffs=[])
            for k in range(N_DEVIL):
                d = self._puff(now, (x, y, g), (0.0, 0.0, 0.0), 100.0, 100.0, 1e9, 0.0, "devil")
                if d is not None:
                    d.update(hgt=dv["height"] * k / N_DEVIL, ang=r.uniform(0.0, 6.28), wob=r.uniform(0.0, 6.28))
                    dv["puffs"].append(d)
        age = now - dv["t0"]
        gone = age > dv["life"]
        if not gone and age > 10.0 and cam is not None:           # drifted out of the shot: let it die, the next one starts in view
            yaw = math.radians(cam[4])
            vx, vy = dv["c"][0] - cam[0], dv["c"][1] - cam[1]
            n = math.hypot(vx, vy)
            if n > 1.0 and (vx * math.cos(yaw) + vy * math.sin(yaw)) / n < 0.74:
                dv["life"] = min(dv["life"], age + 5.0)
        dv["c"][0] += WIND[0] * 420.0 * dt
        dv["c"][1] += WIND[1] * 420.0 * dt
        g = self.ground_cm(dv["c"][0], dv["c"][1])
        if gone or g is None:
            for d in dv["puffs"]:
                if d["alive"] and d["kind"] == "devil":
                    self._kill(d)
            self.devil = None
            self.devil_at = now + self.rng.uniform(6.0, 14.0)
            return
        env = smooth(age / 6.0) * smooth((dv["life"] - age) / 5.0)
        top = dv["height"]
        for d in dv["puffs"]:
            if not d["alive"] or d["kind"] != "devil":
                continue
            d["hgt"] += 900.0 * dt
            if d["hgt"] > top:
                d["hgt"] -= top
            u = d["hgt"] / top
            d["ang"] += dt * 1.9 / (0.5 + u)
            rad = 250.0 + d["hgt"] * 0.07 + 120.0 * math.sin(now * 0.9 + d["wob"])
            lean = d["hgt"] * 0.22
            d["p"] = [dv["c"][0] + WIND[0] * lean + rad * math.cos(d["ang"]), dv["c"][1] + WIND[1] * lean + rad * math.sin(d["ang"]),
                      g + d["hgt"] + 200.0]
            d["size"] = 900.0 + d["hgt"] * 0.16
            d["alpha"] = 0.55 * env * smooth(u / 0.06) * (1.0 - smooth((u - 0.55) / 0.45))

    def _update_dust(self, now, dt):
        cam = self.cam_now
        if not self.dust or cam is None:
            return
        alive = [d for d in self.dust if d["alive"]]
        self._wisps(now, alive)
        self._devil(now, dt)
        # every sprite faces the camera: the plane's normal along the view, its Y across the screen
        face = ML.compose_rotators(unreal.Rotator(roll=0.0, pitch=-90.0, yaw=0.0), unreal.Rotator(roll=0.0, pitch=cam[3], yaw=cam[4]))
        for d in self.dust:
            if not d["alive"]:
                continue
            if d["kind"] == "devil":
                p, size, alpha = d["p"], d.get("size", 100.0), d.get("alpha", 0.0)
            else:
                u = (now - d["born"]) / d["life"]
                if u >= 1.0:
                    self._kill(d)
                    continue
                p, v = d["p"], d["v"]
                p[0] += v[0] * dt
                p[1] += v[1] * dt
                p[2] += v[2] * dt
                size = lerp(d["s0"], d["s1"], 1.0 - (1.0 - u) * (1.0 - u))
                if d["off"] is not None:
                    g = self.ground_cm(p[0], p[1])
                    if g is None:
                        self._kill(d)
                        continue
                    p[2] = g + d["off"]
                alpha = d["a"] * min(1.0, u / d["fade_in"]) * (1.0 - smooth((u - 0.4) / 0.6))
            near = math.dist(p, cam[:3])                          # no sprite fills the screen as the camera passes through it
            alpha *= max(0.0, min(1.0, (near - size * 0.35) / (size * 0.9)))
            s = size / 100.0
            d["actor"].set_actor_transform(unreal.Transform(unreal.Vector(p[0], p[1], p[2]), face, unreal.Vector(s, s * d["wide"] * d["flip"], 1.0)),
                                           False, True)
            if abs(alpha - d["shown"]) > max(0.003, 0.03 * alpha) or (alpha == 0.0) != (d["shown"] == 0.0):
                d["shown"] = alpha
                d["mid"].set_scalar_parameter_value("Alpha", alpha)

    # ------------------------------------------------------------------------------------- state
    def _dump(self, now):
        try:
            state = dict(time=round(now, 1), world=None if self.key is None else self.key[0], game=self.game, fps=round(self.fps, 1),
                         counts=self.counts, incident=self.incident, cue=self.cue, clock=self.clock, sun=self.sun,
                         cam=None if self.cam_now is None else [round(v, 1) for v in self.cam_now],
                         crew={str(k): [round(v, 1) for v in c["pos"]] for k, c in getattr(self, "crew", {}).items() if c["pos"]},
                         agents_live=len(getattr(self, "agent_slot", {})), overlays=self.overlay_want,
                         slots=[dict(layer=s["layer"], op=round(s["op"], 2)) for s in getattr(self, "slots", [])],
                         routes={str(r["id"]): self.route_state.get(r["id"]) for r in self.routes},
                         view_set=getattr(self, "view_set", None), route_w=getattr(self, "route_w", None),
                         dust={k: sum(1 for d in self.dust if d["alive"] and d["kind"] == k) for k in ("step", "rock", "wisp", "devil")},
                         heli=None if not self.heli else [round(v) for v in self.heli["c"]] + [round(self.heli["z"])],
                         devil=None if not self.devil else [round(v) for v in self.devil["c"]],
                         last=self.last_msg, errors_total=self.err_total, errors=self.errors)
            with open(STATE_FILE, "w", encoding="utf8") as f:
                json.dump(state, f, indent=1, default=str)
        except Exception as e:
            self._err("dump", e)


old = getattr(builtins, "solway_director", None)
if old is not None:
    try:
        old.stop()
    except Exception:
        pass
builtins.solway_director = Director()
if os.environ.get("SOLWAY_PLAY") == "1":
    unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).editor_request_begin_play()
