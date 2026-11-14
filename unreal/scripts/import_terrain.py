"""Import the terrain meshes (unreal_import/meshes/*.glb) as Nanite static meshes.

Make the files first:  uv run python tools/make_terrain_meshes.py
Then run this in the editor (Output Log, Cmd box):  py "<repo>/unreal/scripts/import_terrain.py"
or headless, editor closed:
  "<UE>/Engine/Binaries/Mac/UnrealEditor-Cmd" <repo>/unreal/MelasSim/MelasSim.uproject \
      -run=pythonscript -script=<repo>/unreal/scripts/import_terrain.py -unattended -nosplash

Result: /Game/Terrain/Meshes/SM_Core_00 .. SM_Core_33, SM_Region_0 .. 3, SM_Far_0.
Existing meshes are kept; set TERRAIN_FORCE=1 to import again. Writes Saved/import_terrain_report.json.
"""
import json
import os
import time
import traceback

import unreal

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IMP = os.path.join(ROOT, "unreal_import")
DEST = "/Game/Terrain/Meshes"
STAGE = "/Game/Terrain/_Import"
REPORT = os.path.join(unreal.Paths.project_saved_dir(), "import_terrain_report.json")
FORCE = os.environ.get("TERRAIN_FORCE") == "1"
ONLY = [s for s in os.environ.get("TERRAIN_ONLY", "").split(",") if s]
FALLBACK = {"core": 0.08, "region": 0.12, "far": 0.12}   # share of triangles kept in the Nanite fallback mesh

report = {"meshes": [], "skipped": [], "errors": [], "options_failed": []}
EAL = unreal.EditorAssetLibrary


def opt(obj, name, value):
    try:
        obj.set_editor_property(name, value)
    except Exception as e:
        report["options_failed"].append(f"{obj.get_class().get_name()}.{name}: {repr(e)[:120]}")


def make_pipeline():
    p = unreal.InterchangeGenericAssetsPipeline()
    opt(p, "use_source_name_for_asset", True)
    mesh = p.get_editor_property("mesh_pipeline")
    for name, value in (
        ("import_static_meshes", True), ("import_skeletal_meshes", False), ("build_nanite", True),
        ("generate_lightmap_u_vs", False), ("collision", False),
    ):
        opt(mesh, name, value)
    common = p.get_editor_property("common_meshes_properties")
    for name, value in (("recompute_normals", False), ("recompute_tangents", True), ("use_mikk_t_space", False),
                        ("compute_weighted_normals", False), ("use_full_precision_u_vs", True),
                        ("remove_degenerates", False)):
        opt(common, name, value)
    mat = p.get_editor_property("material_pipeline")
    opt(mat, "import_materials", False)
    tex = mat.get_editor_property("texture_pipeline")
    opt(tex, "import_textures", False)
    opt(p.get_editor_property("animation_pipeline"), "import_animations", False)
    return p


def import_mesh(entry):
    name = entry["name"]
    target = f"{DEST}/{name}"
    if EAL.does_asset_exist(target) and not FORCE:
        report["skipped"].append(name)
        return
    t0 = time.time()
    src = os.path.join(IMP, entry["file"])
    if not os.path.exists(src):
        raise FileNotFoundError(src)
    over = unreal.InterchangePipelineStackOverride()
    over.add_pipeline(make_pipeline())
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", src)
    task.set_editor_property("destination_path", STAGE)
    task.set_editor_property("options", over)
    task.set_editor_property("automated", True)
    task.set_editor_property("replace_existing", True)
    task.set_editor_property("save", False)
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    paths = [str(p) for p in task.get_editor_property("imported_object_paths")]
    mesh = None
    for p in paths:
        a = unreal.load_asset(p)
        if isinstance(a, unreal.StaticMesh):
            mesh = a
    if mesh is None:
        raise RuntimeError(f"no static mesh in {paths}")
    if EAL.does_asset_exist(target):
        EAL.delete_asset(target)
    old = mesh.get_path_name().split(".")[0]
    if not EAL.rename_asset(old, target):
        raise RuntimeError(f"rename {old} -> {target} failed")
    mesh = unreal.load_asset(target)
    # the fallback mesh feeds Lumen and ray tracing: keep a tenth of the triangles instead of the automatic few hundred
    ns = mesh.get_editor_property("nanite_settings")
    ns.set_editor_property("enabled", True)
    try:
        ns.set_editor_property("fallback_target", unreal.NaniteFallbackTarget.PERCENT_TRIANGLES)
        ns.set_editor_property("fallback_percent_triangles", FALLBACK.get(entry["tier"], 0.1))
        unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem).set_nanite_settings(mesh, ns, True)
    except Exception as e:
        report["options_failed"].append(f"nanite fallback: {repr(e)[:160]}")
    b = mesh.get_bounding_box()
    nanite = mesh.get_editor_property("nanite_settings").get_editor_property("enabled")
    EAL.save_asset(target, only_if_is_dirty=False)
    report["meshes"].append({
        "asset": target, "seconds": round(time.time() - t0, 1), "nanite": bool(nanite),
        "triangles_lod0": mesh.get_num_triangles(0),
        "min_cm": [round(b.min.x), round(b.min.y), round(b.min.z)], "max_cm": [round(b.max.x), round(b.max.y), round(b.max.z)],
    })


def main():
    with open(os.path.join(IMP, "terrain_meshes.json"), encoding="utf8") as f:
        manifest = json.load(f)
    for entry in manifest["meshes"]:
        if ONLY and entry["name"] not in ONLY:
            continue
        try:
            import_mesh(entry)
        except Exception as e:
            report["errors"].append({"mesh": entry["name"], "error": repr(e), "trace": traceback.format_exc()[-500:]})
    if EAL.does_directory_exist(STAGE):
        EAL.delete_directory(STAGE)
    report["options_failed"] = sorted(set(report["options_failed"]))


try:
    main()
except Exception as e:
    report["exception"] = repr(e)
    report["trace"] = traceback.format_exc()[-800:]
with open(REPORT, "w", encoding="utf8") as fh:
    json.dump(report, fh, indent=1)
unreal.log(f"import_terrain: {len(report['meshes'])} meshes, {len(report['skipped'])} kept, {len(report['errors'])} errors -> {REPORT}")
