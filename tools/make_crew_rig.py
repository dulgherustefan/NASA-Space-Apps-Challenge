"""Rig and animate the NASA Z-2 suit for the Unreal crew (skeletal mesh + animation sequences in one glTF).

    uv run --no-project --with numpy --with scipy --with DracoPy python -I tools/make_crew_rig.py

Reads (parsed as plain data, nothing in them is executed):
  assets_src/nasa_z2_spacesuit/z2_spacesuit.glb  static suit, Draco-compressed mesh, 1 material "Baked"
  assets_src/quaternius_universal_animation_library/extracted/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb
                                                 65-joint UE-style skeleton and its animation clips
Writes:
  unreal_import/crew/z2_suit_rigged.glb          suit mesh (positions, normals and UVs as decoded), JOINTS_0/WEIGHTS_0,
                                                 one skin (joint rest pose == bind pose), 8 clips at 30 fps
  unreal_import/crew/z2_suit_rigged.json         clip list, durations, walk distance per cycle, joint positions

What it does:
  1. Decodes both files. The suit's node rotation (Z-up to Y-up) is baked into positions and normals; this is an
     exact axis swap, so the values are unchanged apart from order and sign. The suit stays where it is: feet at
     the origin, 1.93 m tall, facing +Z (glTF), left side on +X.
  2. Measures the suit's joint centres from its geometry (limb cylinder axes from the face normals of the sleeve
     and forearm parts, leg cross-section centroids, crotch height) and builds the library skeleton there.
     Thighs, calves, upper arms and forearms are aimed at the suit's limbs; pelvis, spine, clavicles and feet keep
     the library's neutral orientation, so a flat library foot means a flat boot and an upright spine an upright suit.
  3. Skin weights come from the suit's own parts: helmet, hard upper torso and backpack are rigid to spine_03,
     gloves rigid to the hands, boots to the feet (toe cap to the ball); the soft joints blend over a few
     centimetres across planes through the joint centres, then a short smoothing over the welded mesh.
  4. Clips: rotations from the library clips (world orientation of every bone is reproduced), bone lengths from
     the suit, pelvis translation scaled by the leg-length ratio. Suit adjustments: arms abducted away from the
     torso, reduced arm swing, stiffer clavicles, no finger animation, and every frame lifted or lowered so the
     lowest point of the suit touches the ground (y = 0). Loops are closed exactly.

Credits: Z-2 suit model NASA/LaRC/Advanced Concepts Lab (NASA 3D Resources).
         Animations "Universal Animation Library by Quaternius (CC0)".
"""
import json
import os
import struct

import DracoPy
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUIT = os.path.join(ROOT, "assets_src", "nasa_z2_spacesuit", "z2_spacesuit.glb")
LIB = os.path.join(ROOT, "assets_src", "quaternius_universal_animation_library", "extracted",
                   "Universal Animation Library[Standard]", "Unreal-Godot", "UAL1_Standard.glb")
OUT_DIR = os.path.join(ROOT, "unreal_import", "crew")
OUT = os.path.join(OUT_DIR, "z2_suit_rigged.glb")
OUT_INFO = os.path.join(OUT_DIR, "z2_suit_rigged.json")

FPS = 30
# output name, library clip, loops
CLIPS = [("Idle", "Idle_Loop", True), ("IdleTalk", "Idle_Talking_Loop", True), ("Walk", "Walk_Loop", True),
         ("Stumble", "Hit_Chest", False), ("Collapse", "Death01", False), ("Kneel", "Fixing_Kneeling", False),
         ("Crouch", "Crouch_Idle_Loop", True), ("Work", "Interact", False)]
ARM_ABDUCT_DEG = 12.0      # extra outward angle of the upper arms (pressurised sleeves stand off the torso)
WALK_ARM_SWING = 0.55      # fraction of the library arm swing kept in Walk
CLAVICLE_KEEP = 0.4        # fraction of clavicle motion kept (the shoulders sit in a hard torso)
SPINE_KEEP = 0.7          # fraction of spine bending kept
CHEST_PITCH_DEG = 17.0     # forward pitch of the library's upper spine in its idle and walk, relative to its T-pose

# ----------------------------------------------------------------------------------------------- glTF reading

CTYPE = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path):
    data = open(path, "rb").read()
    magic, version, _ = struct.unpack("<4sII", data[:12])
    assert magic == b"glTF" and version == 2, path
    jlen = struct.unpack("<I", data[12:16])[0]
    doc = json.loads(data[20:20 + jlen])
    off = 20 + jlen
    blen = struct.unpack("<I", data[off:off + 4])[0]
    return doc, data[off + 8:off + 8 + blen]


def accessor(doc, binc, i):
    a = doc["accessors"][i]
    v = doc["bufferViews"][a["bufferView"]]
    dt = np.dtype(CTYPE[a["componentType"]])
    n = NCOMP[a["type"]]
    off = v.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = v.get("byteStride", dt.itemsize * n)
    rows = [np.frombuffer(binc, dt, n, off + k * stride) for k in range(a["count"])] if stride != dt.itemsize * n \
        else [np.frombuffer(binc, dt, n * a["count"], off)]
    arr = np.concatenate(rows).reshape(a["count"], n)
    if a.get("normalized"):
        arr = arr.astype(np.float64) / np.iinfo(dt).max
    return arr


# ----------------------------------------------------------------------------------------------- rotations


def q2m(q):
    q = np.asarray(q, np.float64)
    x, y, z, w = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    m = np.empty(q.shape[:-1] + (3, 3))
    m[..., 0, 0] = 1 - 2 * (y * y + z * z); m[..., 0, 1] = 2 * (x * y - z * w); m[..., 0, 2] = 2 * (x * z + y * w)
    m[..., 1, 0] = 2 * (x * y + z * w); m[..., 1, 1] = 1 - 2 * (x * x + z * z); m[..., 1, 2] = 2 * (y * z - x * w)
    m[..., 2, 0] = 2 * (x * z - y * w); m[..., 2, 1] = 2 * (y * z + x * w); m[..., 2, 2] = 1 - 2 * (x * x + y * y)
    return m


def m2q(m):
    m = np.asarray(m, np.float64)
    shp = m.shape[:-2]
    m = m.reshape(-1, 3, 3)
    q = np.empty((len(m), 4))
    tr = m[:, 0, 0] + m[:, 1, 1] + m[:, 2, 2]
    for i in range(len(m)):
        a = m[i]
        if tr[i] > 0:
            s = np.sqrt(tr[i] + 1.0) * 2
            q[i] = [(a[2, 1] - a[1, 2]) / s, (a[0, 2] - a[2, 0]) / s, (a[1, 0] - a[0, 1]) / s, 0.25 * s]
        elif a[0, 0] > a[1, 1] and a[0, 0] > a[2, 2]:
            s = np.sqrt(1.0 + a[0, 0] - a[1, 1] - a[2, 2]) * 2
            q[i] = [0.25 * s, (a[0, 1] + a[1, 0]) / s, (a[0, 2] + a[2, 0]) / s, (a[2, 1] - a[1, 2]) / s]
        elif a[1, 1] > a[2, 2]:
            s = np.sqrt(1.0 + a[1, 1] - a[0, 0] - a[2, 2]) * 2
            q[i] = [(a[0, 1] + a[1, 0]) / s, 0.25 * s, (a[1, 2] + a[2, 1]) / s, (a[0, 2] - a[2, 0]) / s]
        else:
            s = np.sqrt(1.0 + a[2, 2] - a[0, 0] - a[1, 1]) * 2
            q[i] = [(a[0, 2] + a[2, 0]) / s, (a[1, 2] + a[2, 1]) / s, 0.25 * s, (a[1, 0] - a[0, 1]) / s]
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    return q.reshape(shp + (4,))


def axis_angle(axis, ang):
    axis = np.asarray(axis, np.float64) / np.linalg.norm(axis)
    x, y, z = axis
    c, s = np.cos(ang), np.sin(ang)
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])


def rot_between(a, b):
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    ax = np.cross(a, b)
    s = np.linalg.norm(ax)
    if s < 1e-9:
        return np.eye(3)
    return axis_angle(ax, np.arctan2(s, float(a @ b)))


def slerp(q0, q1, t):
    """Batched slerp along the last axis; t broadcasts."""
    q0 = np.asarray(q0, np.float64)
    q1 = np.asarray(q1, np.float64)
    d = np.sum(q0 * q1, -1, keepdims=True)
    q1 = np.where(d < 0, -q1, q1)
    d = np.abs(d)
    t = np.asarray(t, np.float64)
    if t.ndim:
        t = t[..., None] if t.shape != d.shape else t
    th = np.arccos(np.clip(d, -1, 1))
    st = np.sin(th)
    small = st < 1e-6
    w0 = np.where(small, 1 - t, np.sin((1 - t) * th) / np.where(small, 1, st))
    w1 = np.where(small, t, np.sin(t * th) / np.where(small, 1, st))
    q = w0 * q0 + w1 * q1
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def unit(v):
    v = np.asarray(v, np.float64)
    return v / np.linalg.norm(v)


# ----------------------------------------------------------------------------------------------- suit


def load_suit():
    doc, binc = read_glb(SUIT)
    prim = doc["meshes"][0]["primitives"][0]
    ext = prim["extensions"]["KHR_draco_mesh_compression"]
    view = doc["bufferViews"][ext["bufferView"]]
    off = view.get("byteOffset", 0)
    mesh = DracoPy.decode(binc[off:off + view["byteLength"]])
    attr = {a["unique_id"]: np.asarray(a["data"]) for a in mesh.attributes}
    pos = attr[ext["attributes"]["POSITION"]].astype(np.float32)
    nrm = attr[ext["attributes"]["NORMAL"]].astype(np.float32)
    uv = attr[ext["attributes"]["TEXCOORD_0"]].astype(np.float32)
    faces = np.asarray(mesh.faces).astype(np.int64)
    node = doc["nodes"][0]
    q = node.get("rotation", [0, 0, 0, 1])
    # the node turns the Z-up data into Y-up with +90 degrees about X: (x, y, z) -> (x, -z, y); exact in float32
    assert np.allclose(q, [np.sqrt(0.5), 0, 0, np.sqrt(0.5)], atol=1e-6) and "translation" not in node \
        and "scale" not in node, node
    pos = np.stack([pos[:, 0], -pos[:, 2], pos[:, 1]], 1)
    nrm = np.stack([nrm[:, 0], -nrm[:, 2], nrm[:, 1]], 1)
    return pos, nrm, uv, faces


def mesh_parts(pos, faces):
    """Weld coincident vertices, return weld index, welded adjacency edges and connected component per vertex."""
    key = np.round(pos.astype(np.float64) / 1e-5).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.ravel()
    n = weld.max() + 1
    e = weld[np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])]
    e = e[e[:, 0] != e[:, 1]]
    e = np.unique(np.sort(e, 1), axis=0)
    adj = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n))
    _, lab = connected_components(adj, directed=False)
    return weld, e, lab


def cylinder_axis(pos, faces, fmask):
    """Axis of a roughly cylindrical part: the direction least represented in its area-weighted face normals."""
    a, b, c = (pos[faces[fmask, k]].astype(np.float64) for k in range(3))
    n = np.cross(b - a, c - a)
    w = np.linalg.norm(n, axis=1)
    ok = w > 1e-12
    n, w, cen3 = n[ok] / w[ok, None], w[ok], ((a + b + c) / 3)[ok]
    cov = (n * w[:, None]).T @ n
    ev, evec = np.linalg.eigh(cov)
    centre = (cen3 * w[:, None]).sum(0) / w.sum()
    return centre, evec[:, 0]


def suit_landmarks(pos, faces, comp_v):
    """Joint centres of the suit, measured from its geometry. Returns a dict of name -> xyz (left side on +X)."""
    P = pos.astype(np.float64)
    comp_f = comp_v[faces[:, 0]]
    ncomp = comp_v.max() + 1
    cen = np.array([P[comp_v == c].mean(0) for c in range(ncomp)])
    lo = np.array([P[comp_v == c].min(0) for c in range(ncomp)])
    hi = np.array([P[comp_v == c].max(0) for c in range(ncomp)])
    cnt = np.bincount(comp_v, minlength=ncomp)
    L = {}
    for side, sg in (("l", 1.0), ("r", -1.0)):
        # sleeve parts: off to the side, between hip and shoulder height, in front of the torso
        arm = [c for c in range(ncomp) if sg * cen[c, 0] > 0.2 and 1.1 < cen[c, 1] < 1.45 and cen[c, 2] > 0.15
               and cnt[c] > 500]
        arm.sort(key=lambda c: cen[c, 2])
        upper, fore = arm[0], arm[-1]
        uc, ua = cylinder_axis(P, faces, comp_f == upper)
        fc, fa = cylinder_axis(P, faces, comp_f == fore)
        if ua[1] > 0:
            ua = -ua          # point down the arm
        if fa[1] > 0:
            fa = -fa
        # forearm part = forearm sleeve + glove; elbow at its upper end, wrist at the narrowest section above the glove
        Q = P[comp_v == fore] - fc
        t = Q @ fa
        r = np.linalg.norm(Q - np.outer(t, fa), axis=1)
        elbow = fc + fa * t.min()
        bins = np.arange(t.min(), t.max(), 0.02)
        rmax = np.array([r[(t >= b0) & (t < b0 + 0.02)].max() if np.any((t >= b0) & (t < b0 + 0.02)) else 9
                         for b0 in bins])
        sel = (bins > 0.0) & (bins < t.max() - 0.08)        # below the forearm centre, above the finger tips
        tw = bins[sel][np.argmin(rmax[sel])] + 0.01
        wrist = fc + fa * tw
        glove = P[comp_v == fore][t > tw]
        hand_dir = unit(glove.mean(0) - wrist)
        # shoulder pivot: up the sleeve axis from the elbow, by the sleeve length measured to the shoulder cap
        shoulder = elbow - ua * 0.32
        L["upperarm_" + side] = shoulder
        L["lowerarm_" + side] = elbow
        L["hand_" + side] = wrist
        L["handdir_" + side] = hand_dir
        # legs: cross-section centres of this side
        def centre_at(y, h=0.012):
            m = (np.abs(P[:, 1] - y) < h) & (sg * P[:, 0] > 0.0)
            return (P[m].min(0) + P[m].max(0)) / 2
        boot = [c for c in range(ncomp) if lo[c, 1] < 0.0 and sg * cen[c, 0] > 0]
        boot = max(boot, key=lambda c: cnt[c])
        bp = P[comp_v == boot]
        shaft = centre_at(0.16)
        ankle = np.array([shaft[0], 0.11, shaft[2] - 0.01])
        knee_c = centre_at(0.53, 0.02)
        L["foot_" + side] = ankle
        L["toe_" + side] = np.array([ankle[0], 0.0, bp[:, 2].max()])
        L["kneec_" + side] = knee_c
    # crotch: lowest point of the brief between the legs; hip joints sit about 0.13 m above it
    mid = (np.abs(P[:, 0]) < 0.02) & (P[:, 1] > 0.5) & (P[:, 1] < 1.1)
    crotch = P[mid][:, 1].min()
    hip_y = crotch + 0.13
    for side, sg in (("l", 1.0), ("r", -1.0)):
        ankle, kc = L["foot_" + side], L["kneec_" + side]
        knee_y = ankle[1] + 0.517 * (hip_y - ankle[1])      # knee at the library's thigh/shin proportion
        d = unit(kc - ankle)
        knee = ankle + d * (knee_y - ankle[1]) / d[1]
        knee[2] -= 0.01
        hip = knee + d * (hip_y - knee[1]) / d[1]
        hip[0] = sg * min(abs(hip[0]), 0.14)
        hip[2] = 0.01
        L["thigh_" + side] = hip
        L["calf_" + side] = knee
    L["crotch_y"] = crotch
    return L


# ----------------------------------------------------------------------------------------------- library


def load_library():
    doc, binc = read_glb(LIB)
    nodes = doc["nodes"]
    skin = doc["skins"][0]
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i
    joints = list(skin["joints"])
    jset = set(joints)
    root = [j for j in joints if parent.get(j) not in jset]
    assert len(root) == 1
    # output order: depth-first from the root, children in file order
    order = []
    stack = [root[0]]
    while stack:
        j = stack.pop()
        order.append(j)
        stack.extend(reversed([c for c in nodes[j].get("children", []) if c in jset]))
    names = [nodes[j]["name"] for j in order]
    idx = {j: k for k, j in enumerate(order)}
    par = np.array([idx[parent[j]] if parent.get(j) in jset else -1 for j in order])
    rest_q = np.array([nodes[j].get("rotation", [0, 0, 0, 1]) for j in order], np.float64)
    rest_t = np.array([nodes[j].get("translation", [0, 0, 0]) for j in order], np.float64)
    # parents above the root joint (the "Armature" node) are identity in this file
    p = parent.get(root[0])
    while p is not None:
        n = nodes[p]
        assert not any(k in n for k in ("rotation", "translation", "scale", "matrix")), n
        p = parent.get(p)
    # clips
    clips = {}
    for an in doc["animations"]:
        ch = {}
        for c in an["channels"]:
            node = c["target"]["node"]
            if node not in idx:
                continue
            s = an["samplers"][c["sampler"]]
            interp = s.get("interpolation", "LINEAR")
            assert interp in ("LINEAR", "STEP"), interp
            ch[(idx[node], c["target"]["path"])] = (accessor(doc, binc, s["input"]).ravel().astype(np.float64),
                                                    accessor(doc, binc, s["output"]).astype(np.float64), interp)
        clips[an["name"]] = ch
    return names, par, rest_q, rest_t, clips


def sample(times, values, interp, t, rot):
    t = np.clip(t, times[0], times[-1])
    i = np.clip(np.searchsorted(times, t, side="right") - 1, 0, len(times) - 1)
    i1 = np.minimum(i + 1, len(times) - 1)
    span = np.where(i1 > i, times[i1] - times[i], 1.0)
    u = np.where(i1 > i, (t - times[i]) / span, 0.0)
    if interp == "STEP":
        u = u * 0
    if rot:
        return slerp(values[i], values[i1], u)
    return values[i] * (1 - u[:, None]) + values[i1] * u[:, None]


def fk(par, R, T):
    """World rotations and positions. R: (..., J, 3, 3), T: (..., J, 3)."""
    W = np.empty_like(R)
    P = np.empty_like(T)
    for j in range(len(par)):
        p = par[j]
        if p < 0:
            W[..., j, :, :] = R[..., j, :, :]
            P[..., j, :] = T[..., j, :]
        else:
            W[..., j, :, :] = W[..., p, :, :] @ R[..., j, :, :]
            P[..., j, :] = P[..., p, :] + (W[..., p, :, :] @ T[..., j, :, None])[..., 0]
    return W, P


# ----------------------------------------------------------------------------------------------- skeleton fit


def fit_skeleton(names, par, rest_q, rest_t, clips, L):
    J = len(names)
    ix = {n: k for k, n in enumerate(names)}
    Rl_src = q2m(rest_q)
    Wsrc, Psrc = fk(par, Rl_src, rest_t)
    # reference pose for the arms: first frame of the idle clip (arms down, palms in)
    idle = clips["Idle_Loop"]
    Rl_idle = np.array([q2m(idle[(j, "rotation")][1][0]) if (j, "rotation") in idle else Rl_src[j] for j in range(J)])
    T_idle = np.array([idle[(j, "translation")][1][0] if (j, "translation") in idle else rest_t[j] for j in range(J)])
    Widle, _ = fk(par, Rl_idle, T_idle)

    Wb = np.zeros((J, 3, 3))
    Pb = np.zeros((J, 3))
    fixed = {}
    # spine and head: library proportions, stretched to the suit's hip-to-shoulder height
    hip_y = L["thigh_l"][1]
    sh_y = (L["upperarm_l"][1] + L["upperarm_r"][1]) / 2
    src_hip = Psrc[ix["thigh_l"], 1]
    src_sh = Psrc[ix["upperarm_l"], 1]
    k_sp = (sh_y - hip_y) / (src_sh - src_hip)
    for n in ("pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head"):
        p = Psrc[ix[n]].copy()
        fixed[n] = np.array([0.0, hip_y + (p[1] - src_hip) * k_sp, p[2] + 0.03])
    for s, sg in (("l", 1), ("r", -1)):
        c = Psrc[ix["clavicle_" + s]]
        fixed["clavicle_" + s] = np.array([c[0], hip_y + (c[1] - src_hip) * k_sp, c[2] + 0.03])
        for n in ("upperarm", "lowerarm", "hand", "thigh", "calf", "foot"):
            fixed[n + "_" + s] = L[n + "_" + s]
    # the library's T-pose chest leans back: every clip carries the upper spine about 17 degrees forward of it.
    # The suit's upright hard torso corresponds to that carried pose, so the chest bind is pitched to match.
    chest_pitch = axis_angle([1.0, 0.0, 0.0], np.radians(CHEST_PITCH_DEG))
    aim_arm = {"upperarm": "lowerarm", "lowerarm": "hand"}
    aim_leg = {"thigh": "calf", "calf": "foot"}
    leg_scale = (hip_y - 0.0) / (Psrc[ix["thigh_l"], 1] - 0.0)
    for j in range(J):
        n = names[j]
        p = par[j]
        base = n[:-2] if n[-2:] in ("_l", "_r") else n
        side = n[-1]
        if p < 0:
            Wb[j] = np.eye(3)           # root: identity at the origin (the library's Z-up root rotation is folded in)
            Pb[j] = 0
            continue
        if base in aim_arm:
            child = ix[aim_arm[base] + "_" + side]
            cur = Widle[j] @ rest_t[child]
            Wb[j] = rot_between(cur, fixed[aim_arm[base] + "_" + side] - fixed[n]) @ Widle[j]
        elif base in aim_leg:
            child = ix[aim_leg[base] + "_" + side]
            cur = Wsrc[j] @ rest_t[child]
            Wb[j] = rot_between(cur, fixed[aim_leg[base] + "_" + side] - fixed[n]) @ Wsrc[j]
        elif base == "hand":
            # glove continues the forearm like the idle wrist does, then aimed down the glove
            Wb[j] = Wb[p] @ (Widle[p].T @ Widle[j])
            mid = ix["middle_01_" + side]
            Wb[j] = rot_between(Wb[j] @ rest_t[mid], L["handdir_" + side]) @ Wb[j]
        elif n in ("spine_03", "neck_01", "Head") or base == "clavicle":
            Wb[j] = chest_pitch @ Wsrc[j]
        elif n in fixed or base in ("foot",):
            Wb[j] = Wsrc[j]             # neutral library orientation (upright spine, flat foot)
        else:
            Wb[j] = Wb[p] @ Rl_src[j]   # fingers, toes, leaves: rigid with the parent as in the library
        if n in fixed:
            Pb[j] = fixed[n]
        else:
            Pb[j] = Pb[p] + Wb[p] @ rest_t[j]
    Rl = np.zeros((J, 3, 3))
    Tl = np.zeros((J, 3))
    for j in range(J):
        p = par[j]
        if p < 0:
            Rl[j] = np.eye(3)
            Tl[j] = Pb[j]
        else:
            Rl[j] = Wb[p].T @ Wb[j]
            Tl[j] = Wb[p].T @ (Pb[j] - Pb[p])
    # re-orthonormalise through quaternions so the stored rest pose is exactly what FK uses
    Ql = m2q(Rl)
    Wb2, Pb2 = fk(par, q2m(Ql), Tl)
    return Ql, Tl, Wb2, Pb2, Wsrc, Psrc, leg_scale


# ----------------------------------------------------------------------------------------------- skin weights


def skin_weights(names, P, faces, weld, edges, comp_v, Pb, Wb, L):
    ix = {n: k for k, n in enumerate(names)}
    nw = weld.max() + 1
    X = np.zeros((nw, 3))
    X[weld] = P.astype(np.float64)
    comp_w = np.zeros(nw, np.int64)
    comp_w[weld] = comp_v
    ncomp = comp_v.max() + 1
    lo = np.array([X[comp_w == c].min(0) for c in range(ncomp)])
    hi = np.array([X[comp_w == c].max(0) for c in range(ncomp)])
    cen = np.array([X[comp_w == c].mean(0) for c in range(ncomp)])
    cnt = np.bincount(comp_w, minlength=ncomp)
    W = np.zeros((nw, len(names)))
    sp3 = ix["spine_03"]
    pel = ix["pelvis"]
    # hard upper torso: the large part spanning both shoulders and reaching the neck ring
    hut = max((c for c in range(ncomp) if hi[c, 0] - lo[c, 0] > 0.6 and hi[c, 1] > 1.7 and lo[c, 1] < 1.1),
              key=lambda c: cnt[c])
    upper_only = lo[comp_w, 1] > 0.97               # helmet, backpack, chest box, lights, sleeves
    arm_comp = (np.abs(cen[comp_w, 0]) > 0.2) & (cen[comp_w, 1] > 1.1) & (cen[comp_w, 1] < 1.45) & \
               (cen[comp_w, 2] > 0.1)
    rigid = np.zeros(nw, bool)
    arm_any = np.zeros(nw, bool)
    for s, sg in (("l", 1.0), ("r", -1.0)):
        sh, el, wr = Pb[ix["upperarm_" + s]], Pb[ix["lowerarm_" + s]], Pb[ix["hand_" + s]]
        d_ua, d_fa = unit(el - sh), unit(wr - el)
        d_h = L["handdir_" + s]
        a = (X - sh) @ d_ua
        lat = sg * X[:, 0]
        r = np.linalg.norm((X - sh) - np.outer(a, d_ua), axis=1)
        in_arm = (arm_comp & (sg * X[:, 0] > 0)) | ((comp_w == hut) & (lat > 0.17) & (a > -0.06) & (r < 0.15))
        w_up = smoothstep(-0.04, 0.07, a)
        w_fa = smoothstep(-0.05, 0.05, (X - el) @ unit(d_ua + d_fa))
        w_h = smoothstep(-0.015, 0.015, (X - wr) @ unit(d_fa + d_h))
        m = in_arm
        W[m, sp3] += 1 - w_up[m]
        W[m, ix["upperarm_" + s]] += w_up[m] * (1 - w_fa[m])
        W[m, ix["lowerarm_" + s]] += w_up[m] * w_fa[m] * (1 - w_h[m])
        W[m, ix["hand_" + s]] += w_up[m] * w_fa[m] * w_h[m]
        rigid |= m & (w_h > 0.999)                    # glove
        arm_any |= m
    torso = ~arm_any & (upper_only | (comp_w == hut))
    W[torso, sp3] = 1
    rigid |= torso
    lower = ~arm_any & ~torso
    # lower body: waist (pelvis <-> torso) and the leg chains
    y = X[:, 1]
    w_waist = smoothstep(0.95, 1.07, y)
    for s, sg in (("l", 1.0), ("r", -1.0)):
        hp, kn, an, ba = (Pb[ix[n + "_" + s]] for n in ("thigh", "calf", "foot", "ball"))
        d_th, d_cf = unit(kn - hp), unit(an - kn)
        side = (sg * X[:, 0] >= 0) & lower
        w_th = smoothstep(-0.02, 0.10, (X - hp) @ d_th) * smoothstep(0.015, 0.07, sg * X[:, 0])
        w_cf = smoothstep(-0.06, 0.06, (X - kn) @ unit(d_th + d_cf))
        w_ft = smoothstep(-0.03, 0.03, an[1] + 0.07 - y)
        w_ba = smoothstep(-0.02, 0.02, (X[:, 2] - ba[2])) * (y < 0.09)
        m = side
        base = 1 - w_th
        W[m, sp3] += base[m] * w_waist[m]
        W[m, pel] += base[m] * (1 - w_waist[m])
        W[m, ix["thigh_" + s]] += w_th[m] * (1 - w_cf[m])
        W[m, ix["calf_" + s]] += w_th[m] * w_cf[m] * (1 - w_ft[m])
        W[m, ix["foot_" + s]] += w_th[m] * w_cf[m] * w_ft[m] * (1 - w_ba[m])
        W[m, ix["ball_" + s]] += w_th[m] * w_cf[m] * w_ft[m] * w_ba[m]
    # short smoothing over the welded mesh, only where the weights are not meant to be rigid
    deg = np.bincount(edges.ravel(), minlength=nw).astype(np.float64)
    A = coo_matrix((np.ones(2 * len(edges)), (np.r_[edges[:, 0], edges[:, 1]], np.r_[edges[:, 1], edges[:, 0]])),
                   shape=(nw, nw)).tocsr()
    soft = ~rigid & (deg > 0)
    for _ in range(4):
        avg = (A @ W) / np.maximum(deg, 1)[:, None]
        W[soft] = 0.5 * W[soft] + 0.5 * avg[soft]
    # four influences, normalised
    order = np.argsort(-W, axis=1, kind="stable")[:, :4]
    top = np.take_along_axis(W, order, 1)
    top[top < 1e-3] = 0
    top /= top.sum(1, keepdims=True)
    jo = np.where(top > 0, order, 0)
    return jo[weld], top[weld]


# ----------------------------------------------------------------------------------------------- clips


def resample_clip(ch, J, rest_q, rest_t, n_out, dur_src):
    t = np.linspace(0.0, dur_src, n_out)
    Q = np.zeros((n_out, J, 4))
    T = np.zeros((n_out, J, 3))
    for j in range(J):
        if (j, "rotation") in ch:
            tt, vv, it = ch[(j, "rotation")]
            Q[:, j] = sample(tt, vv / np.linalg.norm(vv, axis=1, keepdims=True), it, t, True)
        else:
            Q[:, j] = rest_q[j]
        if (j, "translation") in ch:
            tt, vv, it = ch[(j, "translation")]
            T[:, j] = sample(tt, vv, it, t, False)
        else:
            T[:, j] = rest_t[j]
    return Q, T


def skin_points(Wanim, Panim, IB, vj, vw, V):
    """CPU linear blend skinning of V for each frame. Wanim: (F,J,3,3), Panim: (F,J,3)."""
    M = np.zeros(Wanim.shape[:2] + (3, 4))
    M[..., :3] = Wanim
    M[..., 3] = Panim
    M = M @ IB[None]                       # (F,J,3,4) @ (J,4,4)
    Vh = np.c_[V, np.ones(len(V))]
    out = np.zeros((len(M), len(V), 3))
    for k in range(4):
        Mk = M[:, vj[:, k]]                # (F,N,3,4)
        out += vw[None, :, k, None] * np.einsum("fnij,nj->fni", Mk, Vh)
    return out


def retarget(name, src, loop, names, par, rest_q_src, rest_t_src, Ql_bind, Tl_bind, Psrc, Pb, leg_scale,
             IB, vj, vw, V, sample_idx):
    J = len(names)
    ix = {n: k for k, n in enumerate(names)}
    tt = np.unique(np.concatenate([v[0] for v in src.values()]))
    dur = float(tt[-1] - tt[0])
    n_out = int(round(dur * FPS)) + 1
    Qs, Ts = resample_clip(src, J, rest_q_src, rest_t_src, n_out, dur)
    out_dur = (n_out - 1) / FPS
    root = 0
    pel = ix["pelvis"]
    Q = np.repeat(Ql_bind[None], n_out, 0)
    T = np.repeat(Tl_bind[None], n_out, 0)
    animated = [j for j in range(J) if not any(k in names[j] for k in
                ("thumb", "index", "middle", "ring", "pinky", "leaf")) and j != root]
    for j in animated:
        Q[:, j] = Qs[:, j]
    # pelvis: the library root (Z-up turn) is folded into the pelvis; translation scaled by leg length
    Rroot = q2m(Qs[:, root])
    Q[:, pel] = m2q(Rroot @ q2m(Qs[:, pel]))
    src_pel_world = (Rroot @ Ts[:, pel, :, None])[..., 0] + Ts[:, root]
    T[:, pel] = Pb[pel] + leg_scale * (src_pel_world - Psrc[pel])
    # stiffer waist: the hard torso bends less than a body does (bind keeps the neutral chest pitch)
    for n in ("spine_01", "spine_02", "spine_03"):
        j = ix[n]
        Q[:, j] = slerp(np.repeat(Ql_bind[None, j], n_out, 0), Q[:, j], SPINE_KEEP)
    # stiffer shoulders
    for s in ("l", "r"):
        c = ix["clavicle_" + s]
        Q[:, c] = slerp(np.repeat(Ql_bind[None, c], n_out, 0), Q[:, c], CLAVICLE_KEEP)
    # reduced arm swing in the walk
    if name == "Walk":
        for s in ("l", "r"):
            for n in ("upperarm_", "lowerarm_"):
                j = ix[n + s]
                mean = Q[:, j].sum(0)
                mean /= np.linalg.norm(mean)
                Q[:, j] = slerp(np.repeat(mean[None], n_out, 0), Q[:, j], WALK_ARM_SWING)
    # arms out from the torso: rotate each upper arm about the chest's forward axis
    R = q2m(Q)
    Wd, _ = fk(par, R, T)
    sp3 = ix["spine_03"]
    Wb_sp3 = fk(par, q2m(Ql_bind), Tl_bind)[0][sp3]
    for s, sg in (("l", 1.0), ("r", -1.0)):
        j = ix["upperarm_" + s]
        p = par[j]
        for f in range(n_out):
            ax = Wd[f, sp3] @ Wb_sp3.T @ np.array([0.0, 0.0, 1.0])
            Rw = axis_angle(ax, sg * np.radians(ARM_ABDUCT_DEG)) @ Wd[f, j]
            R[f, j] = Wd[f, p].T @ Rw
    Q = m2q(R)
    # ground contact: the lowest point of the suit touches y = 0 on every frame
    Wd, Pd = fk(par, q2m(Q), T)
    pts = skin_points(Wd, Pd, IB, vj[sample_idx], vw[sample_idx], V[sample_idx])
    lift = -pts[..., 1].min(1)
    T[:, pel, 1] += lift
    # loops: last pose equals the first exactly
    if loop:
        d = Q[0] * Q[-1]
        err_q = np.abs(np.abs(d.sum(-1)) - 1).max()
        err_t = np.abs(T[0] - T[-1]).max()
        assert err_q < 1e-4 and err_t < 2e-3, (name, err_q, err_t)
        Q[-1] = Q[0]
        T[-1] = T[0]
    # sign continuity
    for f in range(1, n_out):
        flip = (Q[f] * Q[f - 1]).sum(-1) < 0
        Q[f, flip] *= -1
    return Q, T, out_dur, n_out


# ----------------------------------------------------------------------------------------------- glTF writing


class Builder:
    def __init__(self):
        self.bin = bytearray()
        self.views = []
        self.accessors = []

    def add(self, arr, ctype, typ, minmax=False, target=None):
        arr = np.ascontiguousarray(arr)
        while len(self.bin) % 4:
            self.bin.append(0)
        view = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": arr.nbytes}
        if target:
            view["target"] = target
        self.bin += arr.tobytes()
        self.views.append(view)
        acc = {"bufferView": len(self.views) - 1, "componentType": ctype, "count": int(arr.shape[0]), "type": typ}
        if minmax:
            a2 = arr.reshape(arr.shape[0], -1)
            acc["min"] = [float(v) for v in a2.min(0)]
            acc["max"] = [float(v) for v in a2.max(0)]
        self.accessors.append(acc)
        return len(self.accessors) - 1


def write_glb(path, names, par, Ql, Tl, IB, pos, nrm, uv, faces, vj, vw, anims):
    b = Builder()
    ARR, ELEM = 34962, 34963
    attrs = {"POSITION": b.add(pos.astype(np.float32), 5126, "VEC3", True, ARR),
             "NORMAL": b.add(nrm.astype(np.float32), 5126, "VEC3", False, ARR),
             "TEXCOORD_0": b.add(uv.astype(np.float32), 5126, "VEC2", False, ARR),
             "JOINTS_0": b.add(vj.astype(np.uint8), 5121, "VEC4", False, ARR),
             "WEIGHTS_0": b.add(vw.astype(np.float32), 5126, "VEC4", False, ARR)}
    ind = b.add(faces.astype(np.uint16).ravel(), 5123, "SCALAR", False, ELEM)
    ibm = b.add(IB.transpose(0, 2, 1).astype(np.float32).reshape(-1, 16), 5126, "MAT4")
    J = len(names)
    nodes = [{"name": "Z2_Suit", "mesh": 0, "skin": 0}]
    first = 1
    for j in range(J):
        n = {"name": names[j]}
        kids = [first + c for c in range(J) if par[c] == j]
        if kids:
            n["children"] = kids
        q = [float(v) for v in Ql[j]]
        t = [float(v) for v in Tl[j]]
        if q != [0.0, 0.0, 0.0, 1.0]:
            n["rotation"] = q
        if t != [0.0, 0.0, 0.0]:
            n["translation"] = t
        nodes.append(n)
    animations = []
    for name, Q, T, chans in anims:
        n_out = len(Q)
        times = (np.arange(n_out) / FPS).astype(np.float32)
        tin = b.add(times, 5126, "SCALAR", True)
        samplers, channels = [], []
        for j, path_ in chans:
            data = Q[:, j] if path_ == "rotation" else T[:, j]
            acc = b.add(data.astype(np.float32), 5126, "VEC4" if path_ == "rotation" else "VEC3")
            samplers.append({"input": tin, "output": acc, "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": first + j, "path": path_}})
        animations.append({"name": name, "samplers": samplers, "channels": channels})
    doc = {
        "asset": {"version": "2.0", "generator": "make_crew_rig.py",
                  "copyright": "Z-2 suit: NASA/LaRC/Advanced Concepts Lab. Animations: Universal Animation Library "
                               "by Quaternius (CC0)."},
        "scene": 0,
        "scenes": [{"name": "Scene", "nodes": [0, first]}],
        "nodes": nodes,
        "meshes": [{"name": "Z2_Suit", "primitives": [{"attributes": attrs, "indices": ind, "material": 0,
                                                       "mode": 4}]}],
        "materials": [{"name": "Baked", "doubleSided": True,
                       "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0,
                                                "roughnessFactor": 0.5}}],
        "skins": [{"name": "Z2_Suit_Skeleton", "inverseBindMatrices": ibm, "skeleton": first,
                   "joints": [first + j for j in range(J)]}],
        "animations": animations,
        "accessors": b.accessors,
        "bufferViews": b.views,
        "buffers": [{"byteLength": len(b.bin)}],
    }
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    while len(b.bin) % 4:
        b.bin.append(0)
    total = 12 + 8 + len(js) + 8 + len(b.bin)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(b.bin), 0x004E4942) + bytes(b.bin))


# ----------------------------------------------------------------------------------------------- main


def main():
    pos, nrm, uv, faces = load_suit()
    weld, edges, lab = mesh_parts(pos, faces)
    comp_v = lab[weld]
    L = suit_landmarks(pos, faces, comp_v)
    names, par, rest_q, rest_t, clips = load_library()
    J = len(names)
    Ql, Tl, Wb, Pb, Wsrc, Psrc, leg_scale = fit_skeleton(names, par, rest_q, rest_t, clips, L)
    IB = np.zeros((J, 4, 4))
    for j in range(J):
        M = np.eye(4)
        M[:3, :3] = Wb[j]
        M[:3, 3] = Pb[j]
        IB[j] = np.linalg.inv(M)
    vj, vw = skin_weights(names, pos, faces, weld, edges, comp_v, Pb, Wb, L)
    # weights as stored: float32, summing to one
    vw = vw.astype(np.float32)
    vw[:, 0] += np.float32(1) - vw.sum(1, dtype=np.float32)
    # points used for ground contact: every vertex of the welded mesh, thinned
    _, first_idx = np.unique(weld, return_index=True)
    sample_idx = np.sort(first_idx)
    V = pos.astype(np.float64)
    ix = {n: k for k, n in enumerate(names)}
    anims = []
    info = {"clips": [], "facing": "+Z", "up": "+Y", "left": "+X", "units": "metres", "fps": FPS}
    for out_name, src_name, loop in CLIPS:
        Q, T, dur, n = retarget(out_name, clips[src_name], loop, names, par, rest_q, rest_t, Ql, Tl, Psrc, Pb,
                                leg_scale, IB, vj, vw, V, sample_idx)
        chans = [(j, "rotation") for j in range(J) if not np.allclose(Q[:, j], Ql[j], atol=1e-7)]
        chans.append((ix["pelvis"], "translation"))
        anims.append((out_name, Q, T, chans))
        entry = {"name": out_name, "source": src_name, "loop": loop, "duration_s": round(dur, 4), "frames": n}
        if out_name == "Walk":
            entry["distance_per_cycle_m"] = walk_stride(names, par, Q, T, IB, vj, vw, V)
        info["clips"].append(entry)
    os.makedirs(OUT_DIR, exist_ok=True)
    write_glb(OUT, names, par, Ql, Tl, IB, pos, nrm, uv, faces, vj, vw, anims)
    info["joints_bind_world"] = {names[j]: [round(float(v), 4) for v in Pb[j]] for j in range(J)}
    with open(OUT_INFO, "w") as f:
        json.dump(info, f, indent=1)
        f.write("\n")
    for c in info["clips"]:
        print(c)
    print("wrote", OUT, os.path.getsize(OUT), "bytes")


def walk_stride(names, par, Q, T, IB, vj, vw, V):
    """Ground distance per cycle for feet that do not slide: stance-boot speed relative to the body x cycle time."""
    Wd, Pd = fk(par, q2m(Q), T)
    out = []
    n = len(Q)
    dur = (n - 1) / FPS
    for s in ("l", "r"):
        j = names.index("foot_" + s)
        sole = np.nonzero((vj[:, 0] == j) & (V[:, 1] < 0.03))[0]
        b = names.index("ball_" + s)
        sole = np.r_[sole, np.nonzero((vj[:, 0] == b) & (V[:, 1] < 0.03))[0]]
        pts = skin_points(Wd, Pd, IB, vj[sole], vw[sole], V[sole])
        low = pts[..., 1].min(1)
        z = pts[..., 2].mean(1)
        vz = np.gradient(z, 1.0 / FPS)
        stance = low < 0.01
        out.append(float(-np.median(vz[stance])) * dur)
    return round(float(np.mean(out)), 3)


if __name__ == "__main__":
    main()
