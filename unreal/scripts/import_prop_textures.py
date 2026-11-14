"""Replace the habitat, lander and helicopter textures that carry logos with the ones made by tools/make_prop_textures.py.

Run inside the editor (Tools > Execute Python Script, or `py "<path>"` in the console) once the habitat, InSight and
Ingenuity models are in /Game/Props. Each file is imported over the texture of the model it was made from. The settings of that
texture (colour space, compression, green channel) are put back as they were, so a normal map stays a normal map.
Writes Saved/import_prop_textures_report.json.
"""
import json
import os
import traceback

import unreal

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE = os.path.join(ROOT, "unreal_import", "props")
# file -> the textures it replaces (the helicopter colour was imported twice, once per material)
TEXTURES = {
    "habitat_hdu_01.png": ["/Game/Props/Habitat/Habitat_Demonstration_Unit_part1/Textures/HDU_01"],
    "insight_tex_02.png": ["/Game/Props/InSight/InSIGHT_tex_02_jpg_001"],
    "ingenuity_blade.png": ["/Game/Props/Ingenuity/blade", "/Game/Props/Ingenuity/blade1"],
    "ingenuity_chopper_sp_r2.png": ["/Game/Props/Ingenuity/chopper_sp_r2"],
    "ingenuity_chopper_sp_n2.png": ["/Game/Props/Ingenuity/chopper_sp_n2"],
}
KEEP = ("srgb", "compression_settings", "flip_green_channel")
REPORT = os.path.join(unreal.Paths.project_saved_dir(), "import_prop_textures_report.json")

report = {"source": SOURCE, "textures": {}, "notes": []}


def main():
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    for name, assets in TEXTURES.items():
        path = os.path.join(SOURCE, name)
        if not os.path.exists(path):
            report["notes"].append(f"{name} not found: run tools/make_prop_textures.py")
            continue
        for asset in assets:
            old = unreal.load_asset(asset)
            if old is None or not isinstance(old, unreal.Texture2D):
                report["notes"].append(f"{asset} is not in the project: import the model first")
                continue
            kept = {k: old.get_editor_property(k) for k in KEEP}
            folder, short = asset.rsplit("/", 1)
            task = unreal.AssetImportTask()
            task.set_editor_property("filename", path)
            task.set_editor_property("destination_path", folder)
            task.set_editor_property("destination_name", short)
            task.set_editor_property("automated", True)
            task.set_editor_property("replace_existing", True)
            task.set_editor_property("save", True)
            tools.import_asset_tasks([task])
            tex = unreal.load_asset(asset)
            changed = [k for k, v in kept.items() if tex.get_editor_property(k) != v]
            for k in changed:
                tex.set_editor_property(k, kept[k])
            if changed:
                unreal.EditorAssetLibrary.save_loaded_asset(tex)
            report["textures"][asset] = {"file": name, "size": [tex.blueprint_get_size_x(), tex.blueprint_get_size_y()],
                                         "srgb": bool(tex.get_editor_property("srgb")),
                                         "compression": str(tex.get_editor_property("compression_settings")),
                                         "flip_green": bool(tex.get_editor_property("flip_green_channel")),
                                         "settings_put_back": changed}


try:
    main()
except Exception as e:
    report["exception"] = repr(e)
    report["trace"] = traceback.format_exc()[-1200:]
with open(REPORT, "w", encoding="utf8") as fh:
    json.dump(report, fh, indent=1)
unreal.log(f"import_prop_textures: {len(report['textures'])} textures -> {REPORT}")
