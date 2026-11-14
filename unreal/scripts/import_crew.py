"""Import the rigged crew suit (unreal_import/crew/z2_suit_rigged.glb) as a skeletal mesh with its animation clips.

Run inside the editor (Tools > Execute Python Script, or `py "<path>"` in the console) after import_assets.py.
The file is made by tools/make_crew_rig.py: the NASA Z-2 suit bound to the Universal Animation Library skeleton
(Quaternius, CC0) with the clips Idle, IdleTalk, Walk, Stumble, Collapse, Kneel, Crouch and Work.
The suit keeps the material of the static suit model, because the rigged file carries no textures.
The two suit textures made by tools/make_suit_texture.py (no insignia, no mission emblem) replace the ones of the model.
Writes Saved/import_crew_report.json.
"""
import json
import os
import traceback

import unreal

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE = os.path.join(ROOT, "unreal_import", "crew", "z2_suit_rigged.glb")
DEST = "/Game/Props/CrewRig"
STATIC_SUIT = "/Game/Props/Suit/z2_spacesuit"
SUIT_DIR = "/Game/Props/Suit"
SUIT_TEXTURES = ("z2_Color_s", "z2_spec_color_s")          # unreal_import/crew/<name>.jpg, same names as the assets
REPORT = os.path.join(unreal.Paths.project_saved_dir(), "import_crew_report.json")

report = {"source": SOURCE, "dest": DEST, "assets": {}, "clips": {}, "notes": []}


def import_textures():
    """Bring in the suit textures without the insignia, over the ones that came with the model."""
    tasks = []
    for name in SUIT_TEXTURES:
        path = os.path.join(os.path.dirname(SOURCE), name + ".jpg")
        if not os.path.exists(path):
            report["notes"].append(f"{name}.jpg not found: run tools/make_suit_texture.py")
            continue
        task = unreal.AssetImportTask()
        task.set_editor_property("filename", path)
        task.set_editor_property("destination_path", SUIT_DIR)
        task.set_editor_property("destination_name", name)
        task.set_editor_property("automated", True)
        task.set_editor_property("replace_existing", True)
        task.set_editor_property("save", True)
        tasks.append(task)
    if tasks:
        unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks(tasks)
    report["textures"] = {}
    for name in SUIT_TEXTURES:
        tex = unreal.load_asset(f"{SUIT_DIR}/{name}")
        if tex is not None:
            report["textures"][name] = {"class": tex.get_class().get_name(), "size": [tex.blueprint_get_size_x(), tex.blueprint_get_size_y()],
                                        "srgb": bool(tex.get_editor_property("srgb"))}


def main():
    if not os.path.exists(SOURCE):
        raise FileNotFoundError(SOURCE)
    import_textures()
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", SOURCE)
    task.set_editor_property("destination_path", DEST)
    task.set_editor_property("automated", True)
    task.set_editor_property("replace_existing", True)
    task.set_editor_property("save", True)
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    report["imported"] = [str(p) for p in task.get_editor_property("imported_object_paths")]

    reg = unreal.AssetRegistryHelpers.get_asset_registry()
    reg.scan_paths_synchronous([DEST], True)
    mesh = None
    for ad in reg.get_assets_by_path(DEST, recursive=True):
        kind = str(ad.asset_class_path.asset_name)
        path = str(ad.package_name)
        report["assets"].setdefault(kind, []).append(path)
        if kind == "SkeletalMesh":
            mesh = ad.get_asset()
        elif kind == "AnimSequence":
            seq = ad.get_asset()
            report["clips"][str(ad.asset_name)] = {"path": path, "length_s": round(seq.get_play_length(), 4)}
    if mesh is None:
        raise RuntimeError("no skeletal mesh came out of the import")

    # the suit's own material: same UVs as the static model, so its material fits as it is
    static = unreal.load_asset(STATIC_SUIT)
    suit_mat = static.get_material(0) if static is not None else None
    if suit_mat is not None:
        base = suit_mat.get_base_material()
        if not base.get_editor_property("used_with_skeletal_mesh"):   # compile the suit material for skinned meshes too
            base.set_editor_property("used_with_skeletal_mesh", True)
            unreal.MaterialEditingLibrary.recompile_material(base)
            unreal.EditorAssetLibrary.save_loaded_asset(base)
        mats = []
        for m in mesh.get_editor_property("materials"):       # the array hands out copies: build a new one and set it back
            m.set_editor_property("material_interface", suit_mat)
            mats.append(m)
        mesh.set_editor_property("materials", mats)
        report["material"] = [m.get_editor_property("material_interface").get_path_name() for m in mesh.get_editor_property("materials")]
    else:
        report["notes"].append("static suit not found: the rigged suit keeps its untextured import material")
    unreal.EditorAssetLibrary.save_loaded_asset(mesh)

    b = mesh.get_bounds()
    report["mesh"] = mesh.get_path_name()
    report["bounds_cm"] = {"origin": [round(b.origin.x, 1), round(b.origin.y, 1), round(b.origin.z, 1)],
                           "extent": [round(b.box_extent.x, 1), round(b.box_extent.y, 1), round(b.box_extent.z, 1)]}
    report["material_slots"] = len(mesh.get_editor_property("materials"))


try:
    main()
except Exception as e:
    report["exception"] = repr(e)
    report["trace"] = traceback.format_exc()[-1200:]
with open(REPORT, "w", encoding="utf8") as fh:
    json.dump(report, fh, indent=1)
unreal.log(f"import_crew: {len(report['clips'])} clips -> {REPORT}")
