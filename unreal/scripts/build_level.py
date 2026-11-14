"""Create the empty Melas level: Mars sun, sky, haze, exposure, a start camera.

Headless (editor closed):
  "<UE>/Engine/Binaries/Mac/UnrealEditor-Cmd" <repo>/unreal/MelasSim/MelasSim.uproject \
      -run=pythonscript -script=<repo>/unreal/scripts/build_level.py -unattended -nosplash

The Landscape itself cannot be created from a script in UE 5.8: import it by hand into this level
(unreal/README.md). The script therefore refuses to overwrite an existing /Game/Maps/Melas.

Sky values are a physically motivated starting point (dust optical depth 0.5, scale height 11 km,
single-scattering albedo falling toward blue). They are a look, not a measurement: tune by eye.
Sun direction is JPL Horizons for the site on 2026-11-15 07:00 UT (az 297.68, el 50.05); the engine
overrides it at run time through /clock.
"""
import json
import os

import unreal

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MAP = "/Game/Maps/Melas"
REPORT = os.path.join(unreal.Paths.project_saved_dir(), "build_level_report.json")

SUN_AZ, SUN_EL = 297.68, 50.05          # degrees; azimuth clockwise from north
ATMOSPHERE_BASE_Z = -150000.0           # cm; below the lowest terrain vertex (about -1440 m)
FOG_BASE_Z = -53000.0                   # cm; canyon floor inside the core box

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

    # ---- sun: light travels away from the sun, so yaw = (az + 180) - 90
    sun = spawn(unreal.DirectionalLight, "Sun", loc=(365000.0, 860000.0, 100000.0), rot=(-SUN_EL, SUN_AZ + 90.0 - 360.0, 0.0))
    c = sun.get_component_by_class(unreal.DirectionalLightComponent)
    setp(c, "mobility", unreal.ComponentMobility.MOVABLE)
    setp(c, "intensity", 10.0)
    setp(c, "light_color", unreal.Color(r=255, g=244, b=232, a=255))
    setp(c, "atmosphere_sun_light", True)
    setp(c, "light_source_angle", 0.35)          # the Sun seen from Mars
    setp(c, "cast_shadows", True)

    # ---- atmosphere: thin CO2 Rayleigh term, dust as the Mie term
    atm = spawn(unreal.SkyAtmosphere, "MarsAtmosphere", loc=(0.0, 0.0, ATMOSPHERE_BASE_Z))
    a = atm.get_component_by_class(unreal.SkyAtmosphereComponent)
    setp(a, "transform_mode", unreal.SkyAtmosphereTransformMode.PLANET_TOP_AT_COMPONENT_TRANSFORM)
    setp(a, "bottom_radius", 3389.5)
    setp(a, "atmosphere_height", 100.0)
    setp(a, "ground_albedo", unreal.Color(r=64, g=40, b=28, a=255))
    setp(a, "multi_scattering_factor", 1.0)
    setp(a, "rayleigh_scattering_scale", 0.0003)
    setp(a, "rayleigh_exponential_distribution", 11.0)
    setp(a, "mie_scattering_scale", 0.045)
    setp(a, "mie_scattering", unreal.LinearColor(0.94, 0.85, 0.65, 1.0))
    setp(a, "mie_absorption_scale", 0.016)
    setp(a, "mie_absorption", unreal.LinearColor(0.17, 0.43, 1.0, 1.0))
    setp(a, "mie_anisotropy", 0.76)
    setp(a, "mie_exponential_distribution", 11.0)
    setp(a, "other_absorption_scale", 0.0)

    # ---- sky light from the live sky
    sky = spawn(unreal.SkyLight, "SkyLight", loc=(365000.0, 860000.0, 100000.0))
    s = sky.get_component_by_class(unreal.SkyLightComponent)
    setp(s, "mobility", unreal.ComponentMobility.MOVABLE)
    setp(s, "real_time_capture", True)
    setp(s, "intensity", 2.5)                      # dusty sky: shadows on Mars are filled by scattered light

    # ---- height fog: almost off; the dust incident raises it at run time
    fog = spawn(unreal.ExponentialHeightFog, "DustHaze", loc=(365000.0, 860000.0, FOG_BASE_Z))
    f = fog.get_component_by_class(unreal.ExponentialHeightFogComponent)
    setp(f, "fog_density", 0.0005)
    setp(f, "fog_height_falloff", 0.02)
    setp(f, "fog_inscattering_luminance", unreal.LinearColor(0.0, 0.0, 0.0, 1.0))

    # ---- exposure and grade, whole level
    ppv = spawn(unreal.PostProcessVolume, "GlobalPost", loc=(365000.0, 860000.0, 0.0))
    setp(ppv, "unbound", True)
    st = ppv.get_editor_property("settings")
    for name, value in (
        ("auto_exposure_method", unreal.AutoExposureMethod.AEM_HISTOGRAM),
        ("auto_exposure_bias", 0.3),
        ("auto_exposure_min_brightness", -1.0),
        ("auto_exposure_max_brightness", 6.0),
        ("auto_exposure_speed_up", 6.0),
        ("auto_exposure_speed_down", 6.0),
        ("bloom_intensity", 0.25),
        ("vignette_intensity", 0.25),
        ("motion_blur_amount", 0.0),
    ):
        try:
            st.set_editor_property("override_" + name, True)
            st.set_editor_property(name, value)
            report["set"].append("PostProcessSettings." + name)
        except Exception as e:
            report["failed"].append({"prop": "PostProcessSettings." + name, "error": repr(e)[:200]})
    setp(ppv, "settings", st)

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
