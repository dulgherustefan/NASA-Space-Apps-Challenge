"""Build the Melas scene on top of the imported assets: terrain, markers, props, crew, cameras.

Run in the open editor with /Game/Maps/Melas loaded (Output Log, Cmd box):
  py "<repo>/unreal/scripts/build_scene.py"
Safe to re-run: materials are rebuilt in place and the actors the script owns are replaced.
SCENE_STAGES=terrain,props limits what is rebuilt (default: both). Writes Saved/build_scene_report.json.
Positions come from unreal_import/scene_layout.json (tools/make_scene_layout.py).

Terrain material (M_Terrain), one instance per tier:
  base colour   orthoimage through UV0 (0..1 across the tier), or a flat colour for the far tier
  detail        tiling ground textures by world position at three scales (pebbly soil 3 m, cracked ground 14 m, sand 90 m):
                contrast and part of the hue changes on top of the orthoimage, with normals, occlusion and roughness,
                each faded out with distance
  slope tint    darker, rockier on steep faces
  Overlay       RGBA texture over UV0 with OverlayOpacity (hazard, slope, dose ... layers sent by the engine)
  Overlay2      a second slot of the same kind, so two layers can show at once
  Routes        texture over UV0 with RoutesOpacity (route lines drawn at run time; anything not black is a line)
Colours are a look, not a measurement: the orthoimage is greyscale with a tint.
"""
import json
import os
import traceback

import unreal

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IMP = os.path.join(ROOT, "unreal_import")
REPORT = os.path.join(unreal.Paths.project_saved_dir(), "build_scene_report.json")
MAP = "/Game/Maps/Melas"
TERRAIN = "/Game/Terrain"

EAL = unreal.EditorAssetLibrary
MEL = unreal.MaterialEditingLibrary
ME = unreal  # expression classes live at module level
report = {"material": {}, "links_failed": [], "props_failed": [], "terrain_actors": [], "errors": []}

# per tier: orthoimage, tint, slope tint strength
TIERS = {
    "core": {"ortho": "T_CoreOrtho", "use_ortho": 1.0, "tint": (0.60, 0.60, 0.60), "slope": 0.45},
    "region": {"ortho": "T_RegionOrtho", "use_ortho": 1.0, "tint": (0.50, 0.49, 0.48), "slope": 0.45},
    "far": {"ortho": None, "use_ortho": 0.0, "tint": (1.0, 1.0, 1.0), "slope": 1.0},
}
FLAT_COLOUR = (0.235, 0.108, 0.052)      # linear; mean of the tinted region orthoimage
DETAIL_ORIGIN = (365000.0, 860000.0)     # cm; centre of the core box, keeps tiling UVs small
GROUND_MEAN = {                          # mean linear colour of each tiling ground texture (2k albedo maps)
    "red_laterite_soil_stones": (0.1329, 0.0503, 0.0284),
    "sandy_gravel_02": (0.3263, 0.1755, 0.0879),
    "dry_ground_rocks": (0.3191, 0.1877, 0.0878),
}


def asset_tools():
    return unreal.AssetToolsHelpers.get_asset_tools()


def get_or_create(name, path, cls, factory):
    full = f"{path}/{name}"
    if EAL.does_asset_exist(full):
        return unreal.load_asset(full)
    return asset_tools().create_asset(name, path, cls, factory)


# ---------------------------------------------------------------- material graph helpers
class Graph:
    def __init__(self, material):
        self.m = material

    def node(self, cls, x, y, **props):
        e = MEL.create_material_expression(self.m, cls, x, y)
        for k, v in props.items():
            try:
                e.set_editor_property(k, v)
            except Exception as ex:
                report["props_failed"].append(f"{cls.__name__}.{k}: {repr(ex)[:120]}")
        return e

    def link(self, a, out, b, inp):
        if not MEL.connect_material_expressions(a, out, b, inp):
            report["links_failed"].append(f"{a.get_name()}[{out}] -> {b.get_name()}[{inp}]")

    def out(self, a, out, prop):
        if not MEL.connect_material_property(a, out, prop):
            report["links_failed"].append(f"{a.get_name()}[{out}] -> {prop}")

    def scalar(self, name, value, x, y):
        return self.node(ME.MaterialExpressionScalarParameter, x, y, parameter_name=name, default_value=value)

    def vector(self, name, rgb, x, y):
        return self.node(ME.MaterialExpressionVectorParameter, x, y, parameter_name=name,
                         default_value=unreal.LinearColor(rgb[0], rgb[1], rgb[2], 1.0))

    def binary(self, cls, a, b, x, y, a_out="", b_out=""):
        e = self.node(cls, x, y)
        self.link(a, a_out, e, "A")
        self.link(b, b_out, e, "B")
        return e

    def mul(self, a, b, x, y, a_out="", b_out=""):
        return self.binary(ME.MaterialExpressionMultiply, a, b, x, y, a_out, b_out)

    def lerp(self, a, b, alpha, x, y, a_out="", b_out="", alpha_out=""):
        e = self.node(ME.MaterialExpressionLinearInterpolate, x, y)
        self.link(a, a_out, e, "A")
        self.link(b, b_out, e, "B")
        self.link(alpha, alpha_out, e, "Alpha")
        return e

    def unary(self, cls, src, x, y, src_out="", **props):
        e = self.node(cls, x, y, **props)
        self.link(src, src_out, e, "")
        return e


def build_material():
    mat = get_or_create("M_Terrain", TERRAIN, unreal.Material, unreal.MaterialFactoryNew())
    MEL.delete_all_material_expressions(mat)
    for name, value in (("two_sided", False), ("used_with_nanite", True)):
        try:
            mat.set_editor_property(name, value)
        except Exception as ex:
            report["props_failed"].append(f"Material.{name}: {repr(ex)[:120]}")
    g = Graph(mat)
    tex = lambda p: unreal.load_asset(p)
    ST = unreal.MaterialSamplerType
    blank = tex("/Engine/EngineResources/Black") or tex("/Engine/EngineResources/DefaultTexture")
    report["material"]["blank_texture"] = blank.get_path_name() if blank else None

    # ---- base colour: orthoimage through UV0, or the flat colour
    uv0 = g.node(ME.MaterialExpressionTextureCoordinate, -2600, -400, coordinate_index=0)
    ortho = g.node(ME.MaterialExpressionTextureSampleParameter2D, -2300, -400, parameter_name="Ortho",
                   texture=tex(f"{TERRAIN}/Textures/T_CoreOrtho"), sampler_type=ST.SAMPLERTYPE_COLOR)
    g.link(uv0, "", ortho, "UVs")
    flat = g.vector("FlatColor", FLAT_COLOUR, -2300, -150)
    use_ortho = g.scalar("UseOrtho", 1.0, -2300, 50)
    base = g.lerp(flat, ortho, use_ortho, -1950, -300, b_out="RGB")
    tint = g.vector("Tint", (0.6, 0.6, 0.6), -1950, -100)
    base = g.mul(base, tint, -1700, -300)

    # ---- tiling ground detail by world position, at three scales, each faded out with distance
    wp = g.node(ME.MaterialExpressionWorldPosition, -3200, 400)
    wpxy = g.unary(ME.MaterialExpressionComponentMask, wp, -3000, 400, r=True, g=True, b=False, a=False)
    origin = g.node(ME.MaterialExpressionConstant2Vector, -3000, 550, r=DETAIL_ORIGIN[0], g=DETAIL_ORIGIN[1])
    rel = g.binary(ME.MaterialExpressionSubtract, wpxy, origin, -2800, 400)
    depth = g.node(ME.MaterialExpressionPixelDepth, -2800, 1300)
    one = g.node(ME.MaterialExpressionConstant, -2000, 150, r=1.0)
    WRAP = unreal.SamplerSourceMode.SSM_WRAP_WORLD_GROUP_SETTINGS

    def detail(prefix, name, size_cm, fade_cm, y, strength_default, colour):
        """A ground texture as a factor around 1: its contrast, and `colour` of its hue changes, on top of the orthoimage."""
        size = g.scalar(f"{prefix}Size", size_cm, -2800, y + 150)
        uv = g.binary(ME.MaterialExpressionDivide, rel, size, -2550, y)
        smp = g.node(ME.MaterialExpressionTextureSample, -2300, y, texture=tex(f"{TERRAIN}/Ground/T_{name}_D"),
                     sampler_type=ST.SAMPLERTYPE_COLOR, sampler_source=WRAP)
        g.link(uv, "", smp, "UVs")
        m = GROUND_MEAN[name]
        gain = g.node(ME.MaterialExpressionConstant3Vector, -2300, y + 250, constant=unreal.LinearColor(1.0 / m[0], 1.0 / m[1], 1.0 / m[2], 0))
        ratio = g.mul(smp, gain, -2050, y, a_out="RGB")
        grey = g.unary(ME.MaterialExpressionDesaturation, ratio, -1900, y)
        g.link(g.scalar(f"{prefix}Grey", 1.0 - colour, -2050, y + 150), "", grey, "Fraction")
        fade_d = g.scalar(f"{prefix}Fade", fade_cm, -2550, y + 350)
        fade = g.binary(ME.MaterialExpressionDivide, depth, fade_d, -2300, y + 400)
        keep = g.unary(ME.MaterialExpressionOneMinus, g.unary(ME.MaterialExpressionSaturate, fade, -2100, y + 400), -1900, y + 400)
        strength = g.scalar(f"{prefix}Strength", strength_default, -2100, y + 550)
        return g.lerp(one, grey, g.mul(keep, strength, -1750, y + 400), -1500, y), uv, keep

    near, uv_near, keep_near = detail("DetailNear", "red_laterite_soil_stones", 320.0, 14000.0, 300, 0.9, 0.6)
    close, uv_close, keep_close = detail("DetailClose", "dry_ground_rocks", 1400.0, 70000.0, 1100, 0.5, 0.4)
    mid, _, _ = detail("DetailMid", "sandy_gravel_02", 9000.0, 300000.0, 1900, 0.5, 0.0)
    base = g.mul(base, near, -1250, -300)
    base = g.mul(base, close, -1150, -300)
    base = g.mul(base, mid, -1050, -300)

    # ---- occlusion and roughness of the near texture (packed AO, roughness, metal)
    arm = g.node(ME.MaterialExpressionTextureSample, -2300, 2700, texture=tex(f"{TERRAIN}/Ground/T_red_laterite_soil_stones_ARM"),
                 sampler_type=ST.SAMPLERTYPE_MASKS, sampler_source=WRAP)
    g.link(uv_near, "", arm, "UVs")
    ao = g.unary(ME.MaterialExpressionSaturate, g.unary(ME.MaterialExpressionMultiply, arm, -2050, 2700, src_out="R", const_b=1.45), -1900, 2700)
    ao = g.lerp(one, ao, g.mul(keep_near, g.scalar("DetailAO", 0.7, -2050, 2900), -1900, 2900), -1700, 2700)
    base = g.mul(base, ao, -950, -300)

    # ---- slope tint from the vertex normal (far tier)
    vn = g.node(ME.MaterialExpressionVertexNormalWS, -1700, 1900)
    nz = g.unary(ME.MaterialExpressionComponentMask, vn, -1500, 1900, r=False, g=False, b=True, a=False)
    start = g.scalar("SlopeStart", 0.93, -1500, 2050)
    drop = g.binary(ME.MaterialExpressionSubtract, start, nz, -1300, 1900)
    rng = g.scalar("SlopeRange", 0.30, -1300, 2050)
    steep = g.unary(ME.MaterialExpressionSaturate, g.binary(ME.MaterialExpressionDivide, drop, rng, -1100, 1900), -950, 1900)
    slope_strength = g.scalar("SlopeTintStrength", 0.0, -950, 2050)
    steep = g.mul(steep, slope_strength, -800, 1900)
    rock = g.vector("RockTint", (0.55, 0.50, 0.50), -1050, 100)
    rocky = g.mul(base, rock, -850, -100)
    base = g.lerp(base, rocky, steep, -650, -300)

    # ---- overlay and routes over UV0
    def layer(name, base_in, glow_default, y, mask_from_rgb=False):
        smp = g.node(ME.MaterialExpressionTextureSampleParameter2D, -700, y, parameter_name=name, texture=blank,
                     sampler_type=ST.SAMPLERTYPE_COLOR)
        g.link(uv0, "", smp, "UVs")
        opacity = g.scalar(f"{name}Opacity", 0.0, -700, y + 250)
        if mask_from_rgb:                     # lines drawn into a render target: black means nothing there
            w = g.node(ME.MaterialExpressionConstant3Vector, -700, y + 400, constant=unreal.LinearColor(3.0, 3.0, 3.0, 0))
            cover = g.node(ME.MaterialExpressionDotProduct, -550, y + 100)
            g.link(smp, "RGB", cover, "A")
            g.link(w, "", cover, "B")
            cover = g.unary(ME.MaterialExpressionSaturate, cover, -470, y + 100)
            alpha = g.mul(cover, opacity, -400, y + 100)
        else:
            alpha = g.mul(smp, opacity, -400, y + 100, a_out="A")
        mixed = g.lerp(base_in, smp, alpha, -200, y - 100, b_out="RGB")
        glow = g.scalar(f"{name}Glow", glow_default, -400, y + 300)
        emis = g.mul(g.mul(smp, alpha, -200, y + 150, a_out="RGB"), glow, 0, y + 150)
        return mixed, emis

    base, emis_overlay = layer("Overlay", base, 0.35, 500)
    base, emis_overlay2 = layer("Overlay2", base, 0.35, 2300)
    base, emis_routes = layer("Routes", base, 2.0, 1100, mask_from_rgb=True)
    emissive = g.binary(ME.MaterialExpressionAdd, emis_overlay, emis_overlay2, 250, 700)
    emissive = g.binary(ME.MaterialExpressionAdd, emissive, emis_routes, 400, 800)

    # ---- detail normals: the two close textures added in tangent space, flat far away
    def bump(name, uv, keep, strength_name, strength, y):
        smp = g.node(ME.MaterialExpressionTextureSample, -700, y, texture=tex(f"{TERRAIN}/Ground/T_{name}_N"),
                     sampler_type=ST.SAMPLERTYPE_NORMAL, sampler_source=WRAP)
        g.link(uv, "", smp, "UVs")
        xy = g.unary(ME.MaterialExpressionComponentMask, smp, -450, y, src_out="RGB", r=True, g=True, b=False, a=False)
        return g.mul(xy, g.mul(keep, g.scalar(strength_name, strength, -700, y + 250), -450, y + 200), -250, y)

    nxy = g.binary(ME.MaterialExpressionAdd, bump("red_laterite_soil_stones", uv_near, keep_near, "BumpNear", 1.5, 3200),
                   bump("dry_ground_rocks", uv_close, keep_close, "BumpClose", 1.1, 3600), -50, 3400)
    normal = g.unary(ME.MaterialExpressionNormalize, g.binary(ME.MaterialExpressionAppendVector, nxy, one, 100, 3400), 250, 3400)

    rough = g.lerp(g.scalar("Roughness", 0.93, 0, 200), arm, g.mul(keep_near, g.scalar("DetailRough", 0.7, -200, 350), 0, 350), 250, 200,
                   b_out="G")
    spec = g.scalar("Specular", 0.2, 250, 300)
    MP = unreal.MaterialProperty
    g.out(base, "", MP.MP_BASE_COLOR)
    g.out(emissive, "", MP.MP_EMISSIVE_COLOR)
    g.out(normal, "", MP.MP_NORMAL)
    g.out(rough, "", MP.MP_ROUGHNESS)
    g.out(spec, "", MP.MP_SPECULAR)

    MEL.recompile_material(mat)
    EAL.save_loaded_asset(mat, only_if_is_dirty=False)
    report["material"]["expressions"] = MEL.get_num_material_expressions(mat)

    instances = {}
    for tier, cfg in TIERS.items():
        mi = get_or_create(f"MI_Terrain_{tier.capitalize()}", TERRAIN, unreal.MaterialInstanceConstant,
                           unreal.MaterialInstanceConstantFactoryNew())
        MEL.set_material_instance_parent(mi, mat)
        if cfg["ortho"]:
            MEL.set_material_instance_texture_parameter_value(mi, "Ortho", tex(f"{TERRAIN}/Textures/{cfg['ortho']}"))
        MEL.set_material_instance_scalar_parameter_value(mi, "UseOrtho", cfg["use_ortho"])
        MEL.set_material_instance_scalar_parameter_value(mi, "SlopeTintStrength", cfg["slope"])
        t = cfg["tint"]
        MEL.set_material_instance_vector_parameter_value(mi, "Tint", unreal.LinearColor(t[0], t[1], t[2], 1.0))
        MEL.update_material_instance(mi)
        EAL.save_loaded_asset(mi, only_if_is_dirty=False)
        instances[tier] = mi
    report["material"]["instances"] = [m.get_path_name() for m in instances.values()]
    return instances


# ---------------------------------------------------------------- terrain actors
def place_terrain(instances):
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    for a in actors.get_all_level_actors():
        if str(a.get_folder_path()) == "Terrain":
            actors.destroy_actor(a)
    with open(os.path.join(IMP, "terrain_meshes.json"), encoding="utf8") as f:
        manifest = json.load(f)
    for entry in manifest["meshes"]:
        mesh = unreal.load_asset(f"{TERRAIN}/Meshes/{entry['name']}")
        if mesh is None:
            report["errors"].append(f"missing mesh {entry['name']}")
            continue
        actor = actors.spawn_actor_from_object(mesh, unreal.Vector(0, 0, 0), unreal.Rotator(0, 0, 0))
        actor.set_actor_label(entry["name"])
        actor.set_folder_path("Terrain")
        actor.tags = [unreal.Name("terrain"), unreal.Name(entry["tier"])]
        smc = actor.static_mesh_component
        smc.set_mobility(unreal.ComponentMobility.STATIC)
        smc.set_material(0, instances[entry["tier"]])
        smc.set_editor_property("cast_shadow", True)
        report["terrain_actors"].append(entry["name"])


# ---------------------------------------------------------------- markers
MARKERS = "/Game/Markers"
COLOURS = {                                   # linear RGB
    "habitat": (0.20, 0.55, 1.00), "rover": (0.10, 0.90, 0.95), "shelter": (0.20, 1.00, 0.35),
    "site": (1.00, 1.00, 1.00), "science": (1.00, 0.55, 0.10), "epicentre": (1.00, 0.12, 0.08),
    "crew": (1.00, 0.92, 0.30), "agent": (0.95, 0.95, 0.95),
}


def build_marker_materials():
    """M_Beacon: unlit translucent glow for light beams. M_Marker: unlit opaque glow for small moving markers."""
    out = {}
    for name, translucent in (("M_Beacon", True), ("M_Marker", False)):
        mat = get_or_create(name, MARKERS, unreal.Material, unreal.MaterialFactoryNew())
        MEL.delete_all_material_expressions(mat)
        mat.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
        mat.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT if translucent else unreal.BlendMode.BLEND_OPAQUE)
        mat.set_editor_property("two_sided", True)
        g = Graph(mat)
        colour = g.vector("Color", (1.0, 1.0, 1.0), -600, 0)
        glow = g.scalar("Glow", 1.6 if translucent else 3.0, -600, 200)
        g.out(g.mul(colour, glow, -300, 0), "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
        if translucent:
            g.out(g.scalar("Opacity", 0.7, -300, 250), "", unreal.MaterialProperty.MP_OPACITY)
        MEL.recompile_material(mat)
        EAL.save_loaded_asset(mat, only_if_is_dirty=False)
        out[name] = mat
    inst = {}
    for kind, rgb in COLOURS.items():
        for base in ("M_Beacon", "M_Marker"):
            mi = get_or_create(f"MI_{base[2:]}_{kind}", MARKERS, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
            MEL.set_material_instance_parent(mi, out[base])
            MEL.set_material_instance_vector_parameter_value(mi, "Color", unreal.LinearColor(rgb[0], rgb[1], rgb[2], 1.0))
            MEL.update_material_instance(mi)
            EAL.save_loaded_asset(mi, only_if_is_dirty=False)
            inst[(base, kind)] = mi
    return inst


# ---------------------------------------------------------------- dust
FX = "/Game/FX"
N_DUST = 160
N_CRUMBS = 72


def build_fx(markers):
    """T_DustAtlas and M_Dust: a camera-facing dust sprite the director moves, scales and fades. MI_Rotor: rotor blur."""
    src = os.path.join(IMP, "fx", "dust_atlas.png")      # from tools/make_fx_textures.py
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", src)
    task.set_editor_property("destination_path", FX)
    task.set_editor_property("destination_name", "T_DustAtlas")
    task.set_editor_property("automated", True)
    task.set_editor_property("replace_existing", True)
    task.set_editor_property("save", True)
    asset_tools().import_asset_tasks([task])
    tex = unreal.load_asset(f"{FX}/T_DustAtlas")
    if tex is None:
        report["errors"].append(f"dust texture not imported from {src}")
        return {}
    tex.set_editor_property("srgb", False)
    EAL.save_loaded_asset(tex, only_if_is_dirty=False)

    mat = get_or_create("M_Dust", FX, unreal.Material, unreal.MaterialFactoryNew())
    MEL.delete_all_material_expressions(mat)
    mat.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    mat.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    mat.set_editor_property("two_sided", True)
    g = Graph(mat)
    # one of the four puffs of the atlas: UV * 0.5 + Cell
    uv = g.node(ME.MaterialExpressionTextureCoordinate, -1500, 0)
    half = g.unary(ME.MaterialExpressionMultiply, uv, -1300, 0, const_b=0.5)
    cell = g.unary(ME.MaterialExpressionComponentMask, g.vector("Cell", (0.0, 0.0, 0.0), -1500, 200), -1300, 200,
                   r=True, g=True, b=False, a=False)
    smp = g.node(ME.MaterialExpressionTextureSample, -900, 0, texture=tex,
                 sampler_type=unreal.MaterialSamplerType.SAMPLERTYPE_LINEAR_COLOR)
    g.link(g.binary(ME.MaterialExpressionAdd, half, cell, -1100, 100), "", smp, "UVs")
    alpha = g.mul(smp, g.scalar("Alpha", 0.3, -900, 300), -600, 150, a_out="R")
    fade = g.node(ME.MaterialExpressionDepthFade, -400, 150, fade_distance_default=60.0)    # no hard line where it meets the ground
    g.link(g.scalar("Soft", 60.0, -600, 350), "", fade, "FadeDistance")                      # cm, set per sprite from its size
    if MEL.connect_material_expressions(alpha, "", fade, "Opacity"):
        g.out(fade, "", unreal.MaterialProperty.MP_OPACITY)
    else:
        report["props_failed"].append("M_Dust: depth fade not linked, plain opacity used")
        g.out(alpha, "", unreal.MaterialProperty.MP_OPACITY)
    # brightness follows what is behind the sprite, so the dust is a lighter veil in sun and in shade alike
    behind = g.unary(ME.MaterialExpressionDesaturation, g.node(ME.MaterialExpressionSceneColor, -900, -550), -700, -550)
    tint = g.mul(g.vector("Color", (1.38, 0.89, 0.58), -900, -300), g.scalar("Light", 1.3, -900, -150), -600, -250)
    g.out(g.mul(tint, behind, -400, -400), "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    MEL.recompile_material(mat)
    EAL.save_loaded_asset(mat, only_if_is_dirty=False)

    rotor = get_or_create("MI_Rotor", FX, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
    MEL.set_material_instance_parent(rotor, markers[("M_Beacon", "site")].get_editor_property("parent"))
    MEL.set_material_instance_vector_parameter_value(rotor, "Color", unreal.LinearColor(0.42, 0.40, 0.38, 1.0))
    MEL.set_material_instance_scalar_parameter_value(rotor, "Glow", 0.5)
    MEL.set_material_instance_scalar_parameter_value(rotor, "Opacity", 0.16)
    MEL.update_material_instance(rotor)
    EAL.save_loaded_asset(rotor, only_if_is_dirty=False)
    return {"dust": mat, "rotor": rotor}


# ---------------------------------------------------------------- props, crew, cameras
SCENE_FOLDERS = ("Props", "Markers", "Crew", "Agents", "Rockfall", "Boulders", "Cameras", "FX")
PLANE = "/Engine/BasicShapes/Plane"           # 1 m square in XY
HABITAT = ("/Game/Props/Habitat/Habitat_Demonstration_Unit_part1/StaticMeshes/Habitat_Demonstration_Unit_part1",
           "/Game/Props/Habitat/Habitat_Demonstration_Unit_part2/StaticMeshes/Habitat_Demonstration_Unit_part2")
ROVER = "/Game/Props/Rover/Space_Exploration_Vehicle/StaticMeshes/Space_Exploration_Vehicle"
INSIGHT = "/Game/Props/InSight/insight_deployed_mars_team"
HELICOPTER = "/Game/Props/Ingenuity/ingenuity_v3_mars_team"
CREW_MESH = "/Game/Props/Suit/z2_spacesuit"   # NASA Z-2 surface suit: static, 1.93 m, pivot at the feet, faces +Y
ROCKS = ("/Game/Props/Rocks/namaqualand_boulder_03/namaqualand_boulder_03_1k/StaticMeshes/namaqualand_boulder_03_1k",
         "/Game/Props/Rocks/moon_rock_02/moon_rock_02_1k/StaticMeshes/moon_rock_02_1k",
         "/Game/Props/Rocks/moon_rock_01/moon_rock_01_1k/StaticMeshes/moon_rock_01_LOD0")
CYLINDER = "/Engine/BasicShapes/Cylinder"     # 1 m wide, 1 m tall, pivot in the middle
SPHERE = "/Engine/BasicShapes/Sphere"         # 1 m wide
CREW_SCALE = 1.0
CREW_ROT = (0.0, 0.0, 0.0)                    # pitch, yaw, roll that stands the mesh upright
CREW_FACING = 90.0                            # yaw of the direction the mesh looks along, in its own frame (0 = +X)
N_AGENTS = 40
MOVABLE = unreal.ComponentMobility.MOVABLE
STATIC = unreal.ComponentMobility.STATIC


def place_props(mats, fx):
    sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    for a in sub.get_all_level_actors():
        if str(a.get_folder_path()) in SCENE_FOLDERS:
            sub.destroy_actor(a)
    with open(os.path.join(IMP, "scene_layout.json"), encoding="utf8") as f:
        lay = json.load(f)
    placed = report.setdefault("placed", {})

    def note(folder):
        placed[folder] = placed.get(folder, 0) + 1

    def mesh_actor(asset, label, folder, loc, yaw=0.0, scale=(1.0, 1.0, 1.0), tags=(), mobility=STATIC, material=None,
                   shadows=True, hidden=False, lift_cm=0.0):
        mesh = unreal.load_asset(asset)
        if mesh is None:
            report["errors"].append(f"missing asset {asset}")
            return None
        a = sub.spawn_actor_from_object(mesh, unreal.Vector(loc[0], loc[1], loc[2] + lift_cm), unreal.Rotator(roll=0.0, pitch=0.0, yaw=yaw))
        a.set_actor_label(label)
        a.set_folder_path(folder)
        a.set_actor_scale3d(unreal.Vector(*scale))
        a.tags = [unreal.Name(t) for t in tags]
        c = a.static_mesh_component
        c.set_mobility(mobility)
        c.set_editor_property("cast_shadow", shadows)
        c.set_collision_enabled(unreal.CollisionEnabled.NO_COLLISION)
        if material is not None:
            for i in range(c.get_num_materials()):
                c.set_material(i, material)
        if hidden:
            a.set_actor_hidden_in_game(True)
        note(folder)
        return a

    def beam(label, loc, kind, height_m, radius_m, tags=(), mobility=STATIC, hidden=False, folder="Markers", base_m=0.0):
        return mesh_actor(CYLINDER, label, folder, loc, scale=(radius_m * 2.0, radius_m * 2.0, height_m), tags=tags, mobility=mobility,
                          material=mats[("M_Beacon", kind)], shadows=False, hidden=hidden, lift_cm=(base_m + height_m / 2.0) * 100.0)

    def label_text(label, loc, text, kind, up_m, size_cm):
        a = sub.spawn_actor_from_class(unreal.TextRenderActor, unreal.Vector(loc[0], loc[1], loc[2] + up_m * 100.0), unreal.Rotator(0.0, 0.0, 0.0))
        a.set_actor_label(label)
        a.set_folder_path("Markers")
        a.tags = [unreal.Name("label")]
        c = a.text_render
        c.set_mobility(MOVABLE)
        c.set_text(text)
        c.set_world_size(size_cm)
        c.set_horizontal_alignment(unreal.HorizTextAligment.EHTA_CENTER)
        c.set_vertical_alignment(unreal.VerticalTextAligment.EVRTA_TEXT_BOTTOM)
        rgb = COLOURS[kind]
        c.set_text_render_color(unreal.Color(r=int(255 * min(1.0, rgb[0])), g=int(255 * min(1.0, rgb[1])), b=int(255 * min(1.0, rgb[2])), a=255))
        c.set_editor_property("cast_shadow", False)
        note("Markers")
        return a

    # ---- places: beacon and name
    names = {"S": "SCIENCE SITE", "R": "ROVER", "H": "HABITAT", "A": "SHELTER A", "C": "SHELTER C", "B": "BOULDER", "Q": "EPICENTRE"}
    for pid, p in lay["places"].items():
        kind = p["kind"]
        if kind == "epicentre":
            beam(f"Beacon_{pid}", p["ue"], kind, 2500.0, 25.0, tags=("beacon", f"place:{pid}", "quake"), mobility=MOVABLE, hidden=True)
            continue
        beam(f"Beacon_{pid}", p["ue"], kind, 140.0, 1.6, tags=("beacon", f"place:{pid}"), mobility=MOVABLE, base_m=8.0)
        label_text(f"Label_{pid}", p["ue"], names.get(pid, p["name"].upper()), kind, 155.0, 5200.0)

    # ---- habitat, rover, NASA set dressing
    pr = lay["props"]
    for i, asset in enumerate(HABITAT):
        mesh_actor(asset, f"Habitat_{i + 1}", "Props", pr["habitat"]["ue"], yaw=200.0, scale=(0.01, 0.01, 0.01), tags=("habitat",))
    mesh_actor(ROVER, "Rover", "Props", pr["rover"]["ue"], yaw=35.0, tags=("rover",), lift_cm=224.0)
    mesh_actor(INSIGHT, "SeismicStation", "Props", pr["seismic_station"]["ue"], yaw=20.0, tags=("seismic",), lift_cm=66.0)
    # the helicopter flies a slow scouting circle (the director moves it); a faint disc stands in for the spinning rotor
    mesh_actor(HELICOPTER, "Helicopter", "Props", pr["helicopter"]["ue"], yaw=70.0, tags=("helicopter",), lift_cm=1.0, mobility=MOVABLE)
    if fx.get("rotor") is not None:
        mesh_actor(CYLINDER, "Helicopter_Rotor", "Props", pr["helicopter"]["ue"], scale=(1.22, 1.22, 0.012), tags=("rotor",),
                   mobility=MOVABLE, material=fx["rotor"], shadows=False, lift_cm=48.0)

    # ---- boulders in the runout band, plus the fresh one of the science incident
    widths = (270.0, 25.0, 22.0)             # cm, widest side of each rock mesh
    for k, b in enumerate(lay["boulders"]):
        s = b["size_m"] * 100.0 / widths[b["mesh"]]
        mesh_actor(ROCKS[b["mesh"]], f"Boulder_{k:02d}", "Boulders", b["ue"], yaw=b["yaw"], scale=(s, s, s * 0.85), tags=("boulder",))
    fresh = lay["places"]["B"]["ue"]
    mesh_actor(ROCKS[0], "Boulder_Fresh", "Boulders", fresh, yaw=140.0, scale=(2.4, 2.4, 2.2), tags=("boulder", "fresh"), lift_cm=-40.0)

    # ---- rocks that fall during the marsquake: parked at the top of their track, hidden until the event
    for k, path in enumerate(lay["rockfall_paths"]):
        s = path["size_m"] * 100.0 / widths[0]
        mesh_actor(ROCKS[0], f"Rockfall_{k:02d}", "Rockfall", path["points"][0], scale=(s, s, s), tags=("rockfall", f"track:{k}"),
                   mobility=MOVABLE, hidden=True)

    # ---- crew: suited figure with a thin light beam above the head; the director moves it by its tag
    crew_mesh = unreal.load_asset(CREW_MESH)
    skeletal = isinstance(crew_mesh, unreal.SkeletalMesh)
    idle = None
    if skeletal:                                # a rigged model: start on its idle clip, if the import brought one
        reg = unreal.AssetRegistryHelpers.get_asset_registry()
        for ad in reg.get_assets_by_path(CREW_MESH.rsplit("/", 1)[0], recursive=True):
            if str(ad.asset_class_path.asset_name) == "AnimSequence" and "idle" in str(ad.asset_name).lower():
                idle = idle or ad.get_asset()
    start = lay["places"]["S"]["ue"]
    for member in lay["crew"]:
        cid = member["id"]
        loc = unreal.Vector(start[0] + 250.0 * cid, start[1] + 150.0 * cid, start[2])
        a = sub.spawn_actor_from_object(crew_mesh, loc, unreal.Rotator(roll=CREW_ROT[2], pitch=CREW_ROT[0], yaw=CREW_ROT[1]))
        a.set_actor_label(f"Crew_{cid}")
        a.set_folder_path("Crew")
        a.set_actor_scale3d(unreal.Vector(CREW_SCALE, CREW_SCALE, CREW_SCALE))
        a.tags = [unreal.Name("crew"), unreal.Name(f"crew:{cid}"), unreal.Name(f"yaw:{CREW_FACING:g}")]
        if skeletal:
            c = a.skeletal_mesh_component
            c.set_mobility(MOVABLE)
            try:
                c.set_editor_property("animation_mode", unreal.AnimationMode.ANIMATION_SINGLE_NODE)
                data = c.get_editor_property("animation_data")
                data.set_editor_property("anim_to_play", idle)
                data.set_editor_property("saved_looping", True)
                data.set_editor_property("saved_playing", True)
                c.set_editor_property("animation_data", data)
            except Exception as ex:
                report["props_failed"].append(f"crew animation: {repr(ex)[:160]}")
        else:
            c = a.static_mesh_component
            c.set_mobility(MOVABLE)
            c.set_collision_enabled(unreal.CollisionEnabled.NO_COLLISION)
        note("Crew")
        beam(f"CrewBeam_{cid}", (loc.x, loc.y, loc.z), "crew", 45.0, 0.35, tags=("crewbeam", f"crew:{cid}"), mobility=MOVABLE,
             folder="Crew", base_m=3.0)

    # ---- pool of markers for the stress-test replays
    for k in range(N_AGENTS):
        mesh_actor(SPHERE, f"Agent_{k:02d}", "Agents", (start[0], start[1], start[2] - 5000.0), scale=(2.2, 2.2, 2.2), tags=("agent",),
                   mobility=MOVABLE, material=mats[("M_Marker", "agent")], shadows=False, hidden=True)

    # ---- pool of dust sprites (footsteps, rockfall, wind, dust devil); parked small and transparent until used
    if fx.get("dust") is not None:
        for k in range(N_DUST):
            mesh_actor(PLANE, f"Dust_{k:03d}", "FX", (start[0], start[1], start[2] - 6000.0), scale=(0.01, 0.01, 0.01), tags=("dust",),
                       mobility=MOVABLE, material=fx["dust"], shadows=False)

    # ---- pool of ground markers the director lays along the chosen route ahead of the crew
    for k in range(N_CRUMBS):
        mesh_actor(CYLINDER, f"Crumb_{k:02d}", "FX", (start[0], start[1], start[2] - 6500.0), scale=(0.01, 0.01, 0.01), tags=("crumb",),
                   mobility=MOVABLE, material=mats[("M_Beacon", "shelter")], shadows=False)

    # ---- cameras
    for name, cam in lay["cameras"].items():
        loc = unreal.Vector(*cam["loc"])
        rot = unreal.MathLibrary.find_look_at_rotation(loc, unreal.Vector(*cam["target"]))
        a = sub.spawn_actor_from_class(unreal.CameraActor, loc, rot)
        a.set_actor_label(f"Cam_{name.capitalize()}")
        a.set_folder_path("Cameras")
        a.tags = [unreal.Name("camera"), unreal.Name(f"cue:{name}")]
        cc = a.camera_component
        cc.set_editor_property("field_of_view", cam["fov"])
        cc.set_editor_property("constrain_aspect_ratio", False)
        note("Cameras")
        if name == "overview":
            ps = sub.spawn_actor_from_class(unreal.PlayerStart, loc, rot)
            ps.set_actor_label("PlayerStart")
            ps.set_folder_path("Cameras")
    a = sub.spawn_actor_from_class(unreal.CameraActor, unreal.Vector(start[0], start[1] + 3000.0, start[2] + 1500.0), unreal.Rotator(0.0, 0.0, 0.0))
    a.set_actor_label("Cam_Follow")
    a.set_folder_path("Cameras")
    a.tags = [unreal.Name("camera"), unreal.Name("cue:follow")]
    a.root_component.set_mobility(MOVABLE)
    a.camera_component.set_editor_property("field_of_view", 60.0)
    a.camera_component.set_editor_property("constrain_aspect_ratio", False)
    note("Cameras")

    # ---- the director turns the sun with the mission clock, so the lights must be allowed to move
    world = a.get_world()
    for cls in (unreal.DirectionalLight, unreal.SkyLight):
        for light in unreal.GameplayStatics.get_all_actors_of_class(world, cls):
            light.root_component.set_mobility(MOVABLE)
            report.setdefault("movable_lights", []).append(light.get_actor_label())


STAGES = [s for s in os.environ.get("SCENE_STAGES", "terrain,props").split(",") if s]


def main():
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    path = world.get_path_name().split(".")[0]
    report["world"] = path
    report["stages"] = STAGES
    if path != MAP:
        raise RuntimeError(f"open {MAP} first (current level is {path})")
    if "terrain" in STAGES:
        place_terrain(build_material())
    if "props" in STAGES:
        markers = build_marker_materials()
        place_props(markers, build_fx(markers))
    report["saved"] = bool(unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).save_current_level())


try:
    main()
except Exception as e:
    report["exception"] = repr(e)
    report["trace"] = traceback.format_exc()[-1200:]
with open(REPORT, "w", encoding="utf8") as fh:
    json.dump(report, fh, indent=1)
unreal.log(f"build_scene: stages {STAGES}, {len(report['links_failed'])} links failed, {len(report['errors'])} errors -> {REPORT}")
