"""Editor start-up hook of the MelasSim project.

Does nothing unless SOLWAY_AUTOSTART=1 is set in the environment of the editor (unreal/start_sim.bat sets it).
With it, the live director (unreal/scripts/director.py) starts by itself once the Melas level is open, so the
simulation window comes up without typing anything in the editor. SOLWAY_PLAY=1 then also starts Play.
"""
import os

import unreal

if os.environ.get("SOLWAY_AUTOSTART") == "1":
    _project = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
    _script = os.path.normpath(os.path.join(_project, "..", "scripts", "director.py"))
    _state = {"t": 0.0, "handle": None}

    def _tick(dt):
        _state["t"] += dt
        if _state["t"] < 8.0:                          # let the editor finish opening the level
            return
        world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
        if world is None or not world.get_path_name().startswith("/Game/Maps/Melas"):
            return
        unreal.unregister_slate_post_tick_callback(_state["handle"])
        try:
            with open(_script, encoding="utf8") as f:
                exec(compile(f.read(), _script, "exec"), {"__file__": _script, "__name__": "__main__"})
        except Exception as e:
            unreal.log_error(f"autostart: {e!r}")

    _state["handle"] = unreal.register_slate_post_tick_callback(_tick)
    unreal.log(f"autostart: the director starts when the Melas level is open ({_script})")
