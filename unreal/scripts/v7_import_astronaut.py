"""Imports the textured, rigged astronaut (public/models/astronaut.glb; "Astronaut" by Javi_DaviYT, CC-BY 4.0, see ASSETS.md)
into /Game/Props/AstroHQ for the video shots. Run with -ExecutePythonScript (the editor quits when it is done)."""
import os
import unreal

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "assets_src", "v7", "astronaut", "astronaut_ue.glb")
task = unreal.AssetImportTask()
task.filename = SRC
task.destination_path = "/Game/Props/AstroHQ"
task.automated = True
task.save = True
task.replace_existing = True
unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
reg = unreal.AssetRegistryHelpers.get_asset_registry()
lines = []
for d in reg.get_assets_by_path("/Game/Props/AstroHQ", recursive=True):
    lines.append("%s %s" % (d.asset_class_path.asset_name, d.package_name))
open(os.path.join(ROOT, "renders", "astro_import.txt"), "w").write("\n".join(lines))
unreal.log_warning("[astro] imported %d assets" % len(lines))
