"""Import terrain textures, ground textures and prop models into the Unreal project.

Headless (editor closed):
  "<UE>/Engine/Binaries/Mac/UnrealEditor-Cmd" <repo>/unreal/MelasSim/MelasSim.uproject \
      -run=pythonscript -script=<repo>/unreal/scripts/import_assets.py -unattended -nosplash
  (Windows: <UE>\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe)

Sources: unreal_import/ (made by tools/make_unreal_terrain.py) and assets_src/ (CC0 and NASA files, see ASSETS.md).
Writes Saved/import_report.json. Safe to re-run: existing assets are replaced.
"""
import json
import os
import traceback

import unreal

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IMP = os.path.join(ROOT, "unreal_import")
SRC = os.path.join(ROOT, "assets_src")
REPORT = os.path.join(unreal.Paths.project_saved_dir(), "import_report.json")

TC = unreal.TextureCompressionSettings
report = {"textures": [], "models": [], "errors": []}


def run_task(filename, dest, name=None):
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", filename)
    task.set_editor_property("destination_path", dest)
    if name:
        task.set_editor_property("destination_name", name)
    task.set_editor_property("automated", True)
    task.set_editor_property("replace_existing", True)
    task.set_editor_property("save", True)
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    return [str(p) for p in task.get_editor_property("imported_object_paths")]


def texture(filename, dest, name, srgb=True, compression=None, flip_green=False):
    try:
        if not os.path.exists(filename):
            raise FileNotFoundError(filename)
        paths = run_task(filename, dest, name)
        tex = unreal.load_asset(f"{dest}/{name}")
        if tex is None:
            raise RuntimeError(f"not imported: {paths}")
        tex.set_editor_property("srgb", srgb)
        if compression is not None:
            tex.set_editor_property("compression_settings", compression)
        if flip_green:
            tex.set_editor_property("flip_green_channel", True)
        unreal.EditorAssetLibrary.save_loaded_asset(tex)
        report["textures"].append({"asset": f"{dest}/{name}", "size": [tex.blueprint_get_size_x(), tex.blueprint_get_size_y()]})
    except Exception as e:  # keep going, report at the end
        report["errors"].append({"file": filename, "error": repr(e), "trace": traceback.format_exc()[-600:]})


def model(filename, dest):
    try:
        if not os.path.exists(filename):
            raise FileNotFoundError(filename)
        paths = run_task(filename, dest)
        if not paths:
            raise RuntimeError("nothing imported")
        report["models"].append({"file": os.path.relpath(filename, ROOT), "dest": dest, "assets": paths})
    except Exception as e:
        report["errors"].append({"file": filename, "error": repr(e), "trace": traceback.format_exc()[-600:]})


def main():
    # ---- terrain drapes
    texture(os.path.join(IMP, "core_lum_4096.png"), "/Game/Terrain/Textures", "T_CoreLum", srgb=True, compression=TC.TC_GRAYSCALE)
    texture(os.path.join(IMP, "core_ortho_4096.png"), "/Game/Terrain/Textures", "T_CoreOrtho", srgb=True, compression=TC.TC_BC7)
    texture(os.path.join(IMP, "region_lum_2048x8192.png"), "/Game/Terrain/Textures", "T_RegionLum", srgb=True, compression=TC.TC_GRAYSCALE)
    texture(os.path.join(IMP, "region_ortho_2048x8192.png"), "/Game/Terrain/Textures", "T_RegionOrtho", srgb=True, compression=TC.TC_BC7)

    # ---- tiling ground detail (Poly Haven, CC0)
    for mat in ("red_laterite_soil_stones", "sandy_gravel_02", "dry_ground_rocks"):
        d = os.path.join(SRC, "polyhaven_ground_textures", mat)
        dest = "/Game/Terrain/Ground"
        texture(os.path.join(d, f"{mat}_diff_2k.jpg"), dest, f"T_{mat}_D", srgb=True)
        texture(os.path.join(d, f"{mat}_nor_gl_2k.jpg"), dest, f"T_{mat}_N", srgb=False, compression=TC.TC_NORMALMAP, flip_green=True)
        texture(os.path.join(d, f"{mat}_arm_2k.jpg"), dest, f"T_{mat}_ARM", srgb=False, compression=TC.TC_MASKS)

    # ---- props
    model(os.path.join(SRC, "polypizza_astronauts", "quaternius_astronaut_3hC2i0CTuO.glb"), "/Game/Props/Astronaut")
    model(os.path.join(SRC, "nasa_habitat_demonstration_unit", "Habitat_Demonstration_Unit_part1.glb"), "/Game/Props/Habitat")
    model(os.path.join(SRC, "nasa_habitat_demonstration_unit", "Habitat_Demonstration_Unit_part2.glb"), "/Game/Props/Habitat")
    model(os.path.join(SRC, "nasa_space_exploration_vehicle", "Space_Exploration_Vehicle.glb"), "/Game/Props/Rover")
    for rock in ("moon_rock_01", "moon_rock_02", "moon_rock_03", "moon_rock_04", "rock_09", "namaqualand_boulder_03"):
        model(os.path.join(SRC, "polyhaven_rocks", rock, f"{rock}_1k.gltf"), f"/Game/Props/Rocks/{rock}")

    with open(REPORT, "w", encoding="utf8") as f:
        json.dump(report, f, indent=1)
    unreal.log(f"import_assets: {len(report['textures'])} textures, {len(report['models'])} models, {len(report['errors'])} errors -> {REPORT}")


main()
