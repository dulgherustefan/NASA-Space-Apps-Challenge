"""Cinematic shots for the 30-second video (v7): builds a Level Sequence on /Game/Maps/Melas and renders it with Movie
Render Queue, then closes the editor.

Run from a command line (the editor opens, builds, renders, quits):

    UnrealEditor.exe unreal/MelasSim/MelasSim.uproject -ExecCmds="py <repo>/unreal/scripts/v7_cinematic.py"

Environment: SOLWAY_V7_OUT = output folder for the PNG frames (default <repo>/renders/v7). SOLWAY_V7_NORENDER=1 builds
the sequence and stops (for a look in the editor). The level is not saved; the sequence is created in memory.

Shots (30 fps): 1 establishing push-in on the canyon wall (3.0 s), 2 the crew walking on the canyon floor (3.5 s),
3 close on a helmet as the crew stops (2.5 s), 4 the crew reaching the pressurized rover (4.0 s).
Terrain shape: HiRISE elevation model. Colour is approximate; rocks and dust are set dressing.
"""
import json
import math
import os
import sys
import time

import unreal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from capture_pov import Heights  # noqa: E402

OUT = os.environ.get("SOLWAY_V7_OUT", os.path.join(ROOT, "renders", "v7"))
NORENDER = os.environ.get("SOLWAY_V7_NORENDER") == "1"
FPS = 30
LAYOUT = json.load(open(os.path.join(ROOT, "unreal_import", "scene_layout.json"), encoding="utf8"))
ZREF = float(LAYOUT["z_ref_m"])
H = Heights()
LOG = []


def log(*a):
    msg = " ".join(str(x) for x in a)
    LOG.append(msg)
    unreal.log_warning("[v7] " + msg)


def ue(e, s, lift_m=0.0):
    z = H.z(e, s)
    z = ZREF if z is None else z
    return unreal.Vector(e * 100.0, s * 100.0, (z + lift_m - ZREF) * 100.0)


def look_rot(src, dst):
    d = dst - src
    yaw = math.degrees(math.atan2(d.y, d.x))
    pitch = math.degrees(math.atan2(d.z, math.hypot(d.x, d.y)))
    return unreal.Rotator(roll=0.0, pitch=pitch, yaw=yaw)


def heading_deg(a, b):
    """Compass heading (clockwise from north) from local point a to b; x east, y south."""
    return math.degrees(math.atan2(b[0] - a[0], -(b[1] - a[1]))) % 360.0


# ------------------------------------------------------------------------------------------------ places
P = LAYOUT["places"]
S = (P["S"]["ue"][0] / 100.0, P["S"]["ue"][1] / 100.0)
A = (P["A"]["ue"][0] / 100.0, P["A"]["ue"][1] / 100.0)
RV = (LAYOUT["props"]["rover"]["ue"][0] / 100.0, LAYOUT["props"]["rover"]["ue"][1] / 100.0)
WALK = 1.0                  # m/s, suited walk pace in the shots

# ------------------------------------------------------------------------------------------------ scene
world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()

# a re-run in the same editor session: remove what the previous run spawned
for a in actors:
    lab = a.get_actor_label()
    if lab.startswith("HQ_") or lab.startswith("CAM_") or lab == "CIN_Rim" or lab.startswith("AR_") or lab.startswith("RK_"):
        unreal.get_editor_subsystem(unreal.EditorActorSubsystem).destroy_actor(a)
actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()

HIDE = ("Markers", "Agents", "Rockfall", "Cameras")
crew = []
rover = None
for a in actors:
    folder = str(a.get_folder_path())
    tags = [str(t) for t in a.tags]
    label = a.get_actor_label().lower()
    markerish = any(k in label for k in ("beam", "marker", "ring", "label", "disc", "crumb", "flag", "pin"))
    if folder in HIDE or markerish or "helicopter" in tags or "rotor" in tags or isinstance(a, unreal.TextRenderActor):
        a.set_actor_hidden_in_game(True)
        a.set_is_temporarily_hidden_in_editor(True)
    if isinstance(a, unreal.SkeletalMeshActor) and folder == "Crew":
        crew.append(a)
    if "Rover" in a.get_actor_label() or "rover" in tags:
        rover = rover or a
crew.sort(key=lambda a: a.get_actor_label())
log("crew actors:", [c.get_actor_label() for c in crew], "rover:", rover.get_actor_label() if rover else None)


def facing(a):
    for t in a.tags:
        t = str(t)
        if t.startswith("yaw:"):
            return float(t[4:])
    return 0.0


# ------------------------------------------------------------------------------------------------ cinematic light
# lower, warmer sun for long shadows and rim light; thinner, darker dust haze so the far canyon wall does not glow
for a in actors:
    try:
        if isinstance(a, unreal.DirectionalLight):
            r = a.get_actor_rotation()
            lc = a.get_component_by_class(unreal.DirectionalLightComponent)
            lc.set_editor_property("light_color", unreal.Color(r=255, g=232, b=205, a=255))   # look.py value, a touch warmer
            log("sun kept, pitch", r.pitch, "yaw", r.yaw)
        if isinstance(a, unreal.ExponentialHeightFog):
            fc = a.get_component_by_class(unreal.ExponentialHeightFogComponent)
            fc.set_editor_property("fog_density", 0.0037)
            log("fog set 0.0037")
    except Exception as e:  # noqa: BLE001
        log("light/fog", e)

# animation clips on the Z-2 rig
ANIM = {}
for key, path in (("walk", "/Game/Props/CrewRig/z2_suit_rigged/SkeletalMeshes/z2_suit_riggedWalk"),
                  ("idle", "/Game/Props/CrewRig/z2_suit_rigged/SkeletalMeshes/z2_suit_riggedIdle"),
                  ("talk", "/Game/Props/CrewRig/z2_suit_rigged/SkeletalMeshes/z2_suit_riggedIdleTalk")):
    asset = unreal.load_asset(path)
    if asset is None:
        # the clip may be a sub-asset with another name: search the folder
        for d in unreal.AssetRegistryHelpers.get_asset_registry().get_assets_by_path("/Game/Props/CrewRig", recursive=True):
            if str(d.asset_class_path.asset_name) == "AnimSequence" and key in str(d.asset_name).lower():
                asset = d.get_asset()
                break
    ANIM[key] = asset
log("anims:", {k: (v.get_name() if v else None) for k, v in ANIM.items()})

# ------------------------------------------------------------------------------------------------ sequence
tools = unreal.AssetToolsHelpers.get_asset_tools()
_name = "Solway_v7_%d" % int(time.time())
seq_path = "/Game/Cinematics/" + _name
seq = tools.create_asset(_name, "/Game/Cinematics", unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
seq.set_display_rate(unreal.FrameRate(FPS, 1))
seq.set_tick_resolution(unreal.FrameRate(FPS, 1))

SHOTS = [("establish", 0, 90), ("walk", 90, 195), ("visor", 195, 270), ("rover", 270, 390), ("pov", 390, 510)]
END = SHOTS[-1][2]
seq.set_playback_start(0)
seq.set_playback_end(END)


def fn(f):
    return unreal.FrameNumber(int(round(f)))


def key_transform(binding, keys, start=0, end=END, interp="linear", scale=1.0):
    """keys: list of (frame, Vector, Rotator)."""
    track = binding.add_track(unreal.MovieScene3DTransformTrack)
    sec = track.add_section()
    sec.set_range(start, end)
    ch = sec.get_all_channels()        # loc x y z, rot x(roll) y(pitch) z(yaw), scale x y z
    mode = unreal.MovieSceneKeyInterpolation.LINEAR if interp == "linear" else unreal.MovieSceneKeyInterpolation.CONSTANT
    for f, loc, rot in keys:
        vals = (loc.x, loc.y, loc.z, rot.roll, rot.pitch, rot.yaw)
        for i, v in enumerate(vals):
            ch[i].add_key(fn(f), float(v), 0.0, unreal.MovieSceneTimeUnit.DISPLAY_RATE, mode)
    for i in (6, 7, 8):
        ch[i].add_key(fn(start), float(scale))
    return sec


def anim_section(binding, clip, start, end, play_rate=1.0):
    track = None
    for t in binding.get_tracks():
        if isinstance(t, unreal.MovieSceneSkeletalAnimationTrack):
            track = t
    track = track or binding.add_track(unreal.MovieSceneSkeletalAnimationTrack)
    sec = track.add_section()
    sec.set_range(start, end)
    params = sec.get_editor_property("params")
    params.set_editor_property("animation", clip)
    sec.set_editor_property("params", params)
    try:
        sec.set_row_index(len(track.get_sections()) - 1)
    except Exception as e:  # noqa: BLE001
        log("row", e)
    return sec


# crew paths: (shot 2 + 3) on the canyon floor heading from the science site toward Terrain shelter A,
# (shot 4) the last metres to the rover hatch
d = (A[0] - S[0], A[1] - S[1]); L = math.hypot(*d); d = (d[0] / L, d[1] / L)
side = (-d[1], d[0])
hd_walk = heading_deg(S, A)
r_from = (RV[0] + 9.0, RV[1] - 12.0)
r_to = (RV[0] + 3.5, RV[1] - 4.5)
hd_rover = heading_deg(r_from, r_to)

HQ_PARTS = ["/Game/Props/AstroHQ/astronaut_ue/SkeletalMeshes/Object_%d" % i for i in (99, 100, 103, 106)]
HQ_ANIM = {k: unreal.load_asset("/Game/Props/AstroHQ/astronaut_ue/SkeletalMeshes/astronaut_ue" + k) for k in ("moon_walk", "idle", "wave")}
HQ_SCALE = 0.62
HQ_FACING = float(os.environ.get("SOLWAY_V7_HQ_FACING", "90"))
members = []
if all(unreal.load_asset(pth) for pth in HQ_PARTS) and HQ_ANIM["moon_walk"]:
    for a in crew[:2]:
        a.set_actor_hidden_in_game(True); a.set_is_temporarily_hidden_in_editor(True)
        parts = []
        for pth in HQ_PARTS:
            sa = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_class(unreal.SkeletalMeshActor, a.get_actor_location(), a.get_actor_rotation())
            comp = sa.skeletal_mesh_component
            comp.set_skinned_asset_and_update(unreal.load_asset(pth))
            sa.set_actor_scale3d(unreal.Vector(HQ_SCALE, HQ_SCALE, HQ_SCALE))
            sa.set_actor_label("HQ_" + a.get_actor_label() + "_" + pth.rsplit("_", 1)[-1])
            parts.append(sa)
        members.append(parts)
    ANIM["walk"], ANIM["talk"], ANIM["idle"] = HQ_ANIM["moon_walk"], HQ_ANIM["idle"], HQ_ANIM["idle"]
    log("HQ astronauts", len(members), "facing", HQ_FACING)
else:
    members = [[a] for a in crew[:2]]
    log("HQ astronaut assets missing; using the Z-2 rig")


def facing_of(a):
    return HQ_FACING if a.get_actor_label().startswith("HQ_") else facing(a)


for k, parts in enumerate(members):
  for a in parts:
    b = seq.add_possessable(a)
    lag, lat = (0.0, 0.0) if k == 0 else (-3.0, 2.5)
    f0, f1, f2, f3 = 90, 195, 270, 390
    p0 = (S[0] + d[0] * lag + side[0] * lat, S[1] + d[1] * lag + side[1] * lat)
    walk_m = (f1 - f0) / FPS * WALK
    p1 = (p0[0] + d[0] * walk_m, p0[1] + d[1] * walk_m)
    rot_w = unreal.Rotator(roll=0.0, pitch=0.0, yaw=hd_walk - 90.0 - facing_of(a))
    rot_turn = unreal.Rotator(roll=0.0, pitch=0.0, yaw=hd_walk - 90.0 - facing_of(a) + (35.0 if k == 0 else -25.0))
    q0 = (r_from[0] + side[0] * lat * 0.6 + d[0] * lag * 0.5, r_from[1] + side[1] * lat * 0.6 + d[1] * lag * 0.5)
    q1 = (q0[0] + (r_to[0] - r_from[0]), q0[1] + (r_to[1] - r_from[1]))
    rot_r = unreal.Rotator(roll=0.0, pitch=0.0, yaw=hd_rover - 90.0 - facing_of(a))
    keys = [(0, ue(*p0), rot_w), (f0, ue(*p0), rot_w), (f1, ue(*p1), rot_w), (f1 + 30, ue(*p1), rot_turn), (f2 - 1, ue(*p1), rot_turn),
            (f2, ue(*q0), rot_r), (f3, ue(*q1), rot_r)]
    # shot 4 starts somewhere else: hold the keys constant across the cut
    sec = key_transform(b, keys, scale=HQ_SCALE if a.get_actor_label().startswith("HQ_") else 1.0)
    if ANIM.get("walk"):
        try:
            anim_section(b, ANIM["walk"], 0, f1, 1.0)
            anim_section(b, ANIM["talk"] or ANIM["idle"] or ANIM["walk"], f1, f2, 1.0)
            anim_section(b, ANIM["walk"], f2, f3, 1.0)
        except Exception as e:  # noqa: BLE001
            log("anim failed", e)

# ------------------------------------------------------------------------------------------------ AR route
# the helmet display's route ribbon, drawn on the real terrain ahead of the crew: glowing dashes every 2.2 m
PLANE = unreal.load_asset("/Engine/BasicShapes/Plane")
AR_MAT = unreal.load_asset("/Game/Markers/MI_Beacon_shelter") or unreal.load_asset("/Game/Markers/MI_Marker_shelter")


def ar_path(p_from, p_to, step=2.0, start_m=1.5):
    dx, dy = p_to[0] - p_from[0], p_to[1] - p_from[1]
    L = math.hypot(dx, dy)
    ux, uy = dx / L, dy / L
    yaw = math.degrees(math.atan2(uy, ux))
    m, k = start_m, 0
    while m < L:
        for side_sign in (-1.0, 1.0):
            # one arm of a ">" chevron: 0.55 m long, 6 cm wide, swept back 38 degrees
            ang = math.radians(yaw + side_sign * 142.0)
            ce = p_from[0] + ux * m + math.cos(ang) * 0.42
            cs = p_from[1] + uy * m + math.sin(ang) * 0.42
            loc = ue(ce, cs, 0.08)
            a = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_class(unreal.StaticMeshActor, loc, unreal.Rotator(roll=0.0, pitch=0.0, yaw=yaw + side_sign * 142.0))
            a.static_mesh_component.set_static_mesh(PLANE)
            if AR_MAT:
                a.static_mesh_component.set_material(0, AR_MAT)
            a.static_mesh_component.set_cast_shadow(False)
            a.set_actor_scale3d(unreal.Vector(0.95, 0.16, 1.0))
            a.set_actor_label("AR_%03d" % k)
            k += 1
        # centre line between chevrons
        cl = ue(p_from[0] + ux * (m + step / 2), p_from[1] + uy * (m + step / 2), 0.07)
        a = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_class(unreal.StaticMeshActor, cl, unreal.Rotator(roll=0.0, pitch=0.0, yaw=yaw))
        a.static_mesh_component.set_static_mesh(PLANE)
        if AR_MAT:
            a.static_mesh_component.set_material(0, AR_MAT)
        a.static_mesh_component.set_cast_shadow(False)
        a.set_actor_scale3d(unreal.Vector(step * 0.8, 0.07, 1.0))
        a.set_actor_label("AR_c%03d" % k)
        k += 1
        m += step
    return k


try:
    n1 = ar_path(S, (S[0] + d[0] * 60.0, S[1] + d[1] * 60.0))
    n2 = ar_path(r_from, r_to, step=1.6, start_m=0.5)
    log("AR dashes", n1, n2, "material", AR_MAT.get_name() if AR_MAT else None)
except Exception as e:  # noqa: BLE001
    log("AR path failed", e)

# ------------------------------------------------------------------------------------------------ cameras
cams = []


def camera(label, keys, focal, aperture, focus_m, start, end, aspect=2.39):
    loc0 = keys[0][1]
    cam = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_class(unreal.CineCameraActor, loc0, keys[0][2])
    cam.set_actor_label(label)
    cc = cam.get_cine_camera_component()
    fb = cc.get_editor_property("filmback")
    fb.set_editor_property("sensor_width", 36.0); fb.set_editor_property("sensor_height", 36.0 / aspect)
    try:
        cc.set_editor_property("constrain_aspect_ratio", True)
    except Exception as e:  # noqa: BLE001
        log("aspect", e)
    cc.set_editor_property("filmback", fb)
    cc.set_editor_property("current_focal_length", focal)
    cc.set_editor_property("current_aperture", aperture)
    fs = cc.get_editor_property("focus_settings")
    fs.set_editor_property("focus_method", unreal.CameraFocusMethod.MANUAL)
    fs.set_editor_property("manual_focus_distance", focus_m * 100.0)
    cc.set_editor_property("focus_settings", fs)
    pp = cc.get_editor_property("post_process_settings")
    for name, val in (("bloom_intensity", 0.5), ("film_grain_intensity", 0.2), ("scene_fringe_intensity", 0.1),
                      ("vignette_intensity", 0.0), ("lens_flare_intensity", 0.3), ("color_saturation", unreal.Vector4(1.04, 0.98, 0.92, 1.0)),
                      ("color_contrast", unreal.Vector4(1.08, 1.08, 1.08, 1.0)), ("motion_blur_amount", 0.35),
                      ("color_gain_highlights", unreal.Vector4(0.88, 0.88, 0.88, 1.0))):
        try:
            pp.set_editor_property("override_" + name, True)
            pp.set_editor_property(name, val)
        except Exception as e:  # noqa: BLE001
            log("pp", name, e)
    cc.set_editor_property("post_process_settings", pp)
    cc.set_editor_property("post_process_blend_weight", 1.0)
    b = seq.add_possessable(cam)
    key_transform(b, keys, start, end)
    cams.append((b, start, end))
    return cam


# shot 1: establishing push-in on the canyon wall from the floor (low sun, haze)
w0 = (S[0] + 260.0, S[1] + 420.0)
tgt1 = ue(S[0] - 150.0, S[1] - 900.0, 350.0)
c1a = ue(*w0, 55.0)
c1b = ue(w0[0] - 70.0, w0[1] - 110.0, 42.0)
camera("CAM_establish", [(0, c1a, look_rot(c1a, tgt1)), (90, c1b, look_rot(c1b, tgt1))], 28.0, 5.6, 900.0, 0, 90)

# shot 2: low tracking shot beside the walking crew
m0 = ue(S[0], S[1], 1.1)
c2a = ue(S[0] + d[0] * 10.0 + side[0] * 2.2, S[1] + d[1] * 10.0 + side[1] * 2.2, 0.85)
lead2 = (S[0] + d[0] * 3.5, S[1] + d[1] * 3.5)
c2b = ue(S[0] + d[0] * 11.5 + side[0] * 1.8, S[1] + d[1] * 11.5 + side[1] * 1.8, 0.9)
t2a, t2b = ue(S[0] + d[0] * 0.5, S[1] + d[1] * 0.5, 1.2), ue(S[0] + d[0] * 3.7, S[1] + d[1] * 3.7, 1.2)
camera("CAM_walk", [(90, c2a, look_rot(c2a, t2a)), (195, c2b, look_rot(c2b, t2b))], 40.0, 2.8, 8.5, 90, 195)

# rim light: a warm, soft light behind the crew on the side away from the camera (shots 2 and 3)
try:
    rim_loc = ue(S[0] + d[0] * 5.0 - side[0] * 5.0, S[1] + d[1] * 5.0 - side[1] * 5.0, 3.2)
    rim = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_class(unreal.RectLight, rim_loc, look_rot(rim_loc, ue(S[0] + d[0] * 2.0, S[1] + d[1] * 2.0, 1.4)))
    rc = rim.get_component_by_class(unreal.RectLightComponent)
    rc.set_editor_property("intensity", 60.0)
    rc.set_editor_property("light_color", unreal.Color(r=255, g=200, b=150, a=255))
    rc.set_editor_property("attenuation_radius", 2500.0)
    rc.set_editor_property("source_width", 300.0); rc.set_editor_property("source_height", 300.0)
    rim.set_actor_label("CIN_Rim")
except Exception as e:  # noqa: BLE001
    log("rim", e)

# shot 3: close on the lead helmet as the crew stops and turns
stop = (S[0] + d[0] * 3.5, S[1] + d[1] * 3.5)
helm = ue(stop[0], stop[1], 1.62)
c3a = ue(stop[0] + d[0] * 4.2 - side[0] * 1.2, stop[1] + d[1] * 4.2 - side[1] * 1.2, 1.35)
c3b = ue(stop[0] + d[0] * 3.6 - side[0] * 0.9, stop[1] + d[1] * 3.6 - side[1] * 0.9, 1.40)
camera("CAM_visor", [(195, c3a, look_rot(c3a, helm)), (270, c3b, look_rot(c3b, helm))], 50.0, 2.0, 4.0, 195, 270)

# shot 4: behind the crew as they reach the pressurized rover
rv = ue(RV[0], RV[1], 1.8)
back = (r_from[0] - (r_to[0] - r_from[0]) * 0.5 + 1.8, r_from[1] - (r_to[1] - r_from[1]) * 0.5 - 0.6)
c4a = ue(*back, 1.0)
c4b = ue(back[0] + (r_to[0] - r_from[0]) * 0.55, back[1] + (r_to[1] - r_from[1]) * 0.55, 1.15)
camera("CAM_rover", [(270, c4a, look_rot(c4a, rv)), (390, c4b, look_rot(c4b, rv))], 32.0, 4.0, 12.0, 270, 390)

# rocks: scanned boulders and stones scattered along both walks (set dressing, not mapped rocks)
import random
random.seed(7)
ROCKS = [unreal.load_asset(p_) for p_ in (
    "/Game/Props/Rocks/moon_rock_02/moon_rock_02_1k/StaticMeshes/moon_rock_02_1k",
    "/Game/Props/Rocks/moon_rock_03/moon_rock_03_1k/StaticMeshes/moon_rock_03_1k",
    "/Game/Props/Rocks/moon_rock_04/moon_rock_04_1k/StaticMeshes/moon_rock_04_1k",
    "/Game/Props/Rocks/namaqualand_boulder_03/namaqualand_boulder_03_1k/StaticMeshes/namaqualand_boulder_03_1k",
    "/Game/Props/Rocks/namaqualand_boulder_05/namaqualand_boulder_05_2k/StaticMeshes/namaqualand_boulder_05_2k",
    "/Game/Props/Rocks/rock_07/rock_07_2k/StaticMeshes/rock_07_2k",
    "/Game/Props/Rocks/rock_09/rock_09_1k/StaticMeshes/rock_09_1k")]
ROCKS = [r_ for r_ in ROCKS if r_]


def scatter(origin, ax, n, along, across, keep_out=1.6):
    placed = 0
    for i in range(n * 3):
        if placed >= n:
            break
        u = random.uniform(-6.0, along)
        v = random.uniform(-across, across)
        if abs(v) < keep_out and u > -2.0:
            continue
        e = origin[0] + ax[0] * u + (-ax[1]) * v
        s_ = origin[1] + ax[1] * u + ax[0] * v
        size = random.choice([0.12, 0.18, 0.25, 0.35, 0.5, 0.8, 1.2]) * random.uniform(0.7, 1.3)
        loc = ue(e, s_, -0.08 * size)
        r_ = unreal.Rotator(roll=random.uniform(-25, 25), pitch=random.uniform(-25, 25), yaw=random.uniform(0, 360))
        a_ = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_class(unreal.StaticMeshActor, loc, r_)
        a_.static_mesh_component.set_static_mesh(random.choice(ROCKS))
        a_.set_actor_scale3d(unreal.Vector(size, size, size * random.uniform(0.6, 1.0)))
        a_.set_actor_label("RK_%03d" % i)
        placed += 1
    return placed


try:
    ux = (r_to[0] - r_from[0], r_to[1] - r_from[1]); ul = math.hypot(*ux); ux = (ux[0] / ul, ux[1] / ul)
    log("rocks", scatter(S, d, 170, 45.0, 22.0), scatter(r_from, ux, 70, 16.0, 14.0, 1.4), "meshes", len(ROCKS))
except Exception as e:  # noqa: BLE001
    log("rocks failed", e)

# distant mesas: scanned boulders scaled up far behind the rover and along the canyon floor, softened by the haze
try:
    bould = [r_ for r_ in ROCKS[3:]] or ROCKS
    for i in range(16):
        ang = math.radians(heading_deg(r_from, RV) - 90.0 + random.uniform(-55, 55))
        dist = random.uniform(650.0, 1500.0)
        e = RV[0] + math.cos(ang) * dist; s_ = RV[1] + math.sin(ang) * dist
        sz = random.uniform(70.0, 160.0)
        a_ = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_class(unreal.StaticMeshActor, ue(e, s_, -sz * 0.25), unreal.Rotator(roll=0.0, pitch=0.0, yaw=random.uniform(0, 360)))
        a_.static_mesh_component.set_static_mesh(random.choice(bould))
        a_.set_actor_scale3d(unreal.Vector(sz * random.uniform(1.0, 2.2), sz, sz * random.uniform(0.35, 0.6)))
        a_.set_actor_label("RK_mesa_%02d" % i)
    log("mesas placed")
except Exception as e:  # noqa: BLE001
    log("mesas failed", e)

# shot 5: first person at 1.7 m, walking the AR route (the helmet display is composited on top in the edit)
pv0 = (S[0] + d[0] * 7.0, S[1] + d[1] * 7.0)
pv1 = (S[0] + d[0] * 11.5, S[1] + d[1] * 11.5)
pkeys = []
for i in range(0, 121, 10):
    t = i / 120.0
    e = pv0[0] + (pv1[0] - pv0[0]) * t; s_ = pv0[1] + (pv1[1] - pv0[1]) * t
    eye = ue(e, s_, 1.7 + 0.025 * math.sin(t * math.pi * 6))
    tgt = ue(e + d[0] * 22.0, s_ + d[1] * 22.0, 0.4)
    pkeys.append((390 + i, eye, look_rot(eye, tgt)))
camera("CAM_pov", pkeys, 20.0, 11.0, 15.0, 390, 510, aspect=16.0 / 9.0)

# camera cuts
try:
    cut_track = seq.add_track(unreal.MovieSceneCameraCutTrack)
except Exception:  # noqa: BLE001
    cut_track = seq.add_master_track(unreal.MovieSceneCameraCutTrack)
for b, start, end in cams:
    sec = cut_track.add_section()
    sec.set_range(start, end)
    try:
        bid = unreal.MovieSceneSequenceExtensions.get_portable_binding_id(seq, seq, b)
    except Exception:  # noqa: BLE001
        bid = seq.get_binding_id(b)
    try:
        sec.set_camera_binding_id(bid)
    except Exception as e:  # noqa: BLE001
        log("camera cut binding failed", e)
unreal.EditorAssetLibrary.save_asset(seq_path)
log("sequence built:", seq_path, "frames", END)


# ------------------------------------------------------------------------------------------------ render
def render():
    os.makedirs(OUT, exist_ok=True)
    mq = unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    queue = mq.get_queue()
    queue.delete_all_jobs()
    job = queue.allocate_new_job(unreal.MoviePipelineExecutorJob)
    job.sequence = unreal.SoftObjectPath(seq_path)
    job.map = unreal.SoftObjectPath("/Game/Maps/Melas")
    job.job_name = "Solway_v7"
    cfg = job.get_configuration()
    out = cfg.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
    out.output_directory = unreal.DirectoryPath(OUT)
    out.output_resolution = unreal.IntPoint(1920, 1080)
    out.file_name_format = "v7.{frame_number}"
    out.override_existing_output = True
    cfg.find_or_add_setting_by_class(unreal.MoviePipelineDeferredPassBase)
    cfg.find_or_add_setting_by_class(unreal.MoviePipelineImageSequenceOutput_JPG)
    aa = cfg.find_or_add_setting_by_class(unreal.MoviePipelineAntiAliasingSetting)
    aa.override_anti_aliasing = True
    aa.anti_aliasing_method = unreal.AntiAliasingMethod.AAM_NONE
    aa.spatial_sample_count = 1
    aa.temporal_sample_count = 6
    aa.engine_warm_up_count = 64
    aa.render_warm_up_count = 64
    ex = mq.render_queue_with_executor(unreal.MoviePipelinePIEExecutor)

    def done(executor, success):
        log("render finished", success)
        open(os.path.join(OUT, "_done.txt"), "w").write("ok" if success else "failed")
    ex.on_executor_finished_delegate.add_callable_unique(done)
    log("render started ->", OUT)


if NORENDER:
    log("no render requested")
else:
    _t0 = [time.time()]
    _h = [None]

    def _tick(dt):
        # let shaders and streaming settle after the map opens
        if time.time() - _t0[0] < 25.0:
            return
        unreal.unregister_slate_post_tick_callback(_h[0])
        try:
            render()
        except Exception as e:  # noqa: BLE001
            log("render failed to start:", e)
            open(os.path.join(OUT, "_done.txt"), "w").write("failed: %s" % e)
    _h[0] = unreal.register_slate_post_tick_callback(_tick)
open(os.path.join(ROOT, "renders", "v7_log.txt") if os.path.isdir(os.path.join(ROOT, "renders")) else os.path.join(OUT, "..", "v7_log.txt"), "w").write("\n".join(LOG))


# ------------------------------------------------------------------------------------------------ stay open, re-run on request
TRIGGER = os.path.join(ROOT, "renders", "rerun.txt")
if not globals().get("_V7_WATCH"):
    _V7_WATCH = True
    _seen = [os.path.getmtime(TRIGGER) if os.path.exists(TRIGGER) else 0.0]

    def _watch(dt):
        try:
            m = os.path.getmtime(TRIGGER) if os.path.exists(TRIGGER) else 0.0
            if m > _seen[0]:
                _seen[0] = m
                unreal.log_warning("[v7] re-run requested")
                path = os.path.join(HERE, "v7_cinematic.py")
                g = {"__name__": "v7_rerun", "_V7_WATCH": True, "__file__": path}
                exec(compile(open(path, encoding="utf8").read(), path, "exec"), g)
        except Exception as e:  # noqa: BLE001
            unreal.log_error("[v7] re-run failed: %s" % e)
    unreal.register_slate_post_tick_callback(_watch)
