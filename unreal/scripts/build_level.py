"""Create the empty Melas level: Mars sun, sky, haze, exposure, a start camera.

Headless (editor closed):
  "<UE>/Engine/Binaries/Mac/UnrealEditor-Cmd" <repo>/unreal/MelasSim/MelasSim.uproject \
      -run=pythonscript -script=<repo>/unreal/scripts/build_level.py -unattended -nosplash

The Landscape itself cannot be created from a script in UE 5.8: import it by hand into this level
(unreal/README.md). The script therefore refuses to overwrite an existing /Game/Maps/Melas.

The lighting and post-process values are in look.py (same folder), which can also be run on its own to
re-apply them to an existing level. They are a look, not a measurement.
Sun direction is JPL Horizons for the site on 2026-11-15 07:00 UT (az 297.68, el 50.05); the engine
overrides it at run time through /clock.
"""
import json
import os
import sys

import unreal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import look  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MAP = "/Game/Maps/Melas"
REPORT = os.path.join(unreal.Paths.project_saved_dir(), "build_level_report.json")


report = {"map": MAP, "set": [], "failed": [], "actors": []}


def setp(obj, name, value):
    try:
        obj.set_editor_property(name, value)
        report["set"].append(f"{obj.get_class().get_name()}.{name}")
    except Exception as e:  # keep going, list what did not apply
        report["failed"].append({"prop": f"{obj.get_class().get_name()}.{name}", "error": repr(e)[:200]})


def spawn(cls, label, loc=(0.0, 0.0, 0.0), rot=(0.0, 0.0, 0.0), folder="Lighting"):
    sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    actor = sub.spawn_actor_from_class(cls, unreal.Vector(*loc), unreal.Rotator(roll=rot[2], pitch=rot[0], yaw=rot[1]))
    actor.set_actor_label(label)
    actor.set_folder_path(folder)
    report["actors"].append(label)
    return actor


def main():
    if unreal.EditorAssetLibrary.does_asset_exist(MAP):
        report["skipped"] = "map exists; delete it in the editor first if you really want a fresh one"
        unreal.log_warning(f"build_level: {MAP} already exists, nothing done")
        return

    world = unreal.EditorLoadingAndSavingUtils.new_blank_map(False)

    # ---- Sun, atmosphere, sky light, haze, exposure and grade: the values live in look.py
    look.apply(world, report)

    # ---- where a play session and the first camera start: south of the habitat, looking north at the wall
    spawn(unreal.PlayerStart, "PlayerStart", loc=(340000.0, 1120000.0, 60000.0), rot=(-18.0, -90.0, 0.0), folder="Cameras")
    cam = spawn(unreal.CameraActor, "Cam_Overview", loc=(340000.0, 1120000.0, 60000.0), rot=(-18.0, -90.0, 0.0), folder="Cameras")
    cc = cam.get_component_by_class(unreal.CameraComponent)
    setp(cc, "field_of_view", 55.0)

    ok = unreal.EditorLoadingAndSavingUtils.save_map(world, MAP)
    report["saved"] = bool(ok)
    unreal.log(f"build_level: saved={ok} actors={len(report['actors'])} failed={len(report['failed'])}")


try:
    main()
except Exception as e:
    report["exception"] = repr(e)
    unreal.log_error(f"build_level: {e!r}")
with open(REPORT, "w", encoding="utf8") as fh:
    json.dump(report, fh, indent=1)
