"""The look of the Melas level: Sun, sky, haze, sky light, exposure and grade.

Run in the open editor with /Game/Maps/Melas loaded (Output Log, Cmd box):

    py "<repo>/unreal/scripts/look.py"

It finds the lighting actors that build_level.py created (by class), sets their values and saves the level.
Safe to re-run. LOOK_SAVE=0 applies the values without saving (for trying things out).
build_level.py calls apply() on a new level, so both scripts share one set of values.
Writes Saved/look_report.json.

Everything here is a look, not a measurement. The sky starts from a dusty Mars atmosphere (dust optical depth
about 0.5, scale height 11 km, dust that absorbs blue) and is then tuned by eye: a tan sky that stays readable
away from the Sun, haze that separates the canyon wall from the floor, and shadows filled by sky light.
The Sun direction is not set here at run time: the engine sends it through /clock and the director turns the light.
"""
import json
import os

import unreal

MAP = "/Game/Maps/Melas"
SUN_AZ, SUN_EL = 297.68, 50.05          # degrees; JPL Horizons, site, 2026-11-15 07:00 UT (start value only)
ATMOSPHERE_BASE_Z = -150000.0           # cm; below the lowest terrain vertex (about -1440 m)
FOG_BASE_Z = -53000.0                   # cm; canyon floor inside the core box
CENTRE = (365000.0, 860000.0)           # cm; centre of the core box

SUN = {
    "intensity": 10.0,
    "light_color": unreal.Color(r=255, g=240, b=222, a=255),
    "atmosphere_sun_light": True,
    "light_source_angle": 0.9,               # the Sun is 0.35 degrees from Mars; dust widens it, and edges get softer
    "light_source_soft_angle": 0.6,
    "cast_shadows": True,
    "contact_shadow_length": 0.025,          # grounds small stones and boots
    "per_pixel_atmosphere_transmittance": True,
    "atmosphere_sun_disk_color_scale": unreal.LinearColor(1.0, 1.0, 1.0, 1.0),
    "volumetric_scattering_intensity": 1.0,
    "cast_volumetric_shadow": True,
    "enable_light_shaft_bloom": True,        # a faint cool glow around the Sun when it is in view
    "bloom_scale": 0.12,
    "bloom_threshold": 0.0,
    "bloom_max_brightness": 4.0,
    "bloom_tint": unreal.Color(r=170, g=200, b=255, a=255),
}

ATMOSPHERE = {
    "transform_mode": unreal.SkyAtmosphereTransformMode.PLANET_TOP_AT_COMPONENT_TRANSFORM,
    "bottom_radius": 3389.5,                 # km, Mars
    "atmosphere_height": 100.0,
    "ground_albedo": unreal.Color(r=96, g=62, b=42, a=255),
    "multi_scattering_factor": 2.2,          # dust scatters many times: the sky stays bright away from the Sun
    "rayleigh_scattering_scale": 0.0006,     # thin CO2: almost nothing
    "rayleigh_exponential_distribution": 11.0,
    "mie_scattering_scale": 0.042,           # dust
    "mie_scattering": unreal.LinearColor(0.95, 0.80, 0.58, 1.0),
    "mie_absorption_scale": 0.014,
    "mie_absorption": unreal.LinearColor(0.12, 0.42, 1.0, 1.0),
    "mie_anisotropy": 0.64,
    "mie_exponential_distribution": 11.0,
    "other_absorption_scale": 0.0,
    "aerial_pespective_view_distance_scale": 1.6,   # (engine spelling) more haze between the camera and far ground
    "aerial_perspective_start_depth": 0.1,
    "height_fog_contribution": 1.0,
}

SKY_LIGHT = {
    "real_time_capture": True,
    "intensity": 1.6,                        # sky light fills the shadows, as scattered light does on Mars
    "lower_hemisphere_is_black": False,
}

FOG = {
    "fog_density": 0.0022,
    "fog_height_falloff": 0.012,
    "fog_max_opacity": 0.55,
    "start_distance": 6000.0,
    "fog_inscattering_luminance": unreal.LinearColor(0.0, 0.0, 0.0, 1.0),          # colour comes from the sky atmosphere
    "sky_atmosphere_ambient_contribution_color_scale": unreal.LinearColor(1.0, 0.92, 0.82, 1.0),
    "directional_inscattering_luminance": unreal.LinearColor(0.0, 0.0, 0.0, 1.0),
    "enable_volumetric_fog": True,           # dust in the air near the camera takes light and shadow
    "volumetric_fog_scattering_distribution": 0.55,
    "volumetric_fog_albedo": unreal.Color(r=235, g=196, b=150, a=255),
    "volumetric_fog_extinction_scale": 1.4,
    "volumetric_fog_distance": 90000.0,
    "volumetric_fog_near_fade_in_distance": 800.0,
}

# Exposure is held in a narrow band so cuts between a wide shot and a close one do not pump.
POST = {
    "auto_exposure_method": unreal.AutoExposureMethod.AEM_HISTOGRAM,
    "auto_exposure_bias": 0.55,
    "auto_exposure_min_brightness": 0.45,    # EV100; the scene asks for 0.4 (close) to 0.9 (wide)
    "auto_exposure_max_brightness": 0.85,
    "auto_exposure_speed_up": 1.5,
    "auto_exposure_speed_down": 1.0,
    "auto_exposure_low_percent": 55.0,
    "auto_exposure_high_percent": 92.0,
    "local_exposure_highlight_contrast_scale": 0.85,
    "local_exposure_shadow_contrast_scale": 0.85,
    "bloom_intensity": 0.32,
    "bloom_threshold": -1.0,
    "lens_flare_intensity": 0.0,
    "vignette_intensity": 0.32,
    "scene_fringe_intensity": 0.0,
    "film_grain_intensity": 0.12,
    "motion_blur_amount": 0.0,
    "white_temp": 5700.0,                    # slightly cool: the suits read as white against the warm ground
    "sharpen": 0.55,
    # filmic curve: a little more contrast than the default, soft shoulder for the bright sky
    "film_slope": 0.92,
    "film_toe": 0.57,
    "film_shoulder": 0.24,
    # restrained grade: slightly richer midtones, a touch of cool in the shadows against the warm ground
    "color_saturation": unreal.Vector4(1.0, 1.0, 1.0, 1.0),
    "color_contrast": unreal.Vector4(1.05, 1.05, 1.05, 1.0),
    "color_gamma_shadows": unreal.Vector4(0.98, 1.0, 1.03, 1.0),
    "color_gain_highlights": unreal.Vector4(1.02, 1.0, 0.98, 1.0),
    # Lumen: quality over speed, long traces for a canyon
    "lumen_scene_lighting_quality": 2.0,
    "lumen_scene_detail": 2.0,
    "lumen_final_gather_quality": 2.0,
    "lumen_max_trace_distance": 60000.0,
    "lumen_scene_view_distance": 60000.0,
    "lumen_reflection_quality": 2.0,
}


def setp(obj, name, value, report):
    try:
        obj.set_editor_property(name, value)
        report["set"].append(f"{obj.get_class().get_name()}.{name}")
    except Exception as e:  # keep going, list what did not apply
        report["failed"].append({"prop": f"{obj.get_class().get_name()}.{name}", "error": repr(e)[:200]})


def _first(world, cls, label, loc, rot=(0.0, 0.0, 0.0)):
    """The level's actor of this class, or a new one."""
    found = list(unreal.GameplayStatics.get_all_actors_of_class(world, cls))
    if found:
        return found[0]
    sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    actor = sub.spawn_actor_from_class(cls, unreal.Vector(*loc), unreal.Rotator(roll=rot[2], pitch=rot[0], yaw=rot[1]))
    actor.set_actor_label(label)
    actor.set_folder_path("Lighting")
    return actor


def apply(world, report):
    """Set every lighting and post-process value on the level's actors, creating the ones that are missing."""
    # light travels away from the Sun, so yaw = (az + 180) - 90
    sun = _first(world, unreal.DirectionalLight, "Sun", (CENTRE[0], CENTRE[1], 100000.0), (-SUN_EL, SUN_AZ + 90.0 - 360.0, 0.0))
    c = sun.get_component_by_class(unreal.DirectionalLightComponent)
    setp(c, "mobility", unreal.ComponentMobility.MOVABLE, report)
    for k, v in SUN.items():
        setp(c, k, v, report)

    atm = _first(world, unreal.SkyAtmosphere, "MarsAtmosphere", (0.0, 0.0, ATMOSPHERE_BASE_Z))
    a = atm.get_component_by_class(unreal.SkyAtmosphereComponent)
    for k, v in ATMOSPHERE.items():
        setp(a, k, v, report)

    sky = _first(world, unreal.SkyLight, "SkyLight", (CENTRE[0], CENTRE[1], 100000.0))
    s = sky.get_component_by_class(unreal.SkyLightComponent)
    setp(s, "mobility", unreal.ComponentMobility.MOVABLE, report)
    for k, v in SKY_LIGHT.items():
        setp(s, k, v, report)

    fog = _first(world, unreal.ExponentialHeightFog, "DustHaze", (CENTRE[0], CENTRE[1], FOG_BASE_Z))
    f = fog.get_component_by_class(unreal.ExponentialHeightFogComponent)
    for k, v in FOG.items():
        setp(f, k, v, report)

    ppv = _first(world, unreal.PostProcessVolume, "GlobalPost", (CENTRE[0], CENTRE[1], 0.0))
    setp(ppv, "unbound", True, report)
    st = ppv.get_editor_property("settings")
    for name, value in POST.items():
        try:
            st.set_editor_property("override_" + name, True)
            st.set_editor_property(name, value)
            report["set"].append("PostProcessSettings." + name)
        except Exception as e:
            report["failed"].append({"prop": "PostProcessSettings." + name, "error": repr(e)[:200]})
    setp(ppv, "settings", st, report)
    return {"sun": sun, "atmosphere": atm, "sky_light": sky, "fog": fog, "post": ppv}


def main():
    report = {"map": MAP, "set": [], "failed": []}
    try:
        world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
        path = world.get_path_name().split(".")[0]
        if path != MAP:
            raise RuntimeError(f"open {MAP} first (current level is {path})")
        apply(world, report)
        if os.environ.get("LOOK_SAVE", "1") != "0":
            report["saved"] = bool(unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).save_current_level())
    except Exception as e:
        report["exception"] = repr(e)
        unreal.log_error(f"look: {e!r}")
    with open(os.path.join(unreal.Paths.project_saved_dir(), "look_report.json"), "w", encoding="utf8") as fh:
        json.dump(report, fh, indent=1)
    unreal.log(f"look: {len(report['set'])} values set, {len(report['failed'])} failed, saved={report.get('saved')}")


if __name__ == "__main__":
    main()
