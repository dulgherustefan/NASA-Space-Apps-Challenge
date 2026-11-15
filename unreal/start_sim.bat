@echo off
rem Opens the simulation window on Windows: Unreal Editor with the Melas level, the director running, Play started.
rem Start the engine first, in the repository root:  uv run python -m engine
rem UE_ROOT is the Unreal Engine 5.8 folder. SOLWAY_PLAY=0 opens the editor and the director without starting Play.
setlocal
if "%UE_ROOT%"=="" set "UE_ROOT=C:\Program Files\Epic Games\UE_5.8"
if not exist "%UE_ROOT%\Engine\Binaries\Win64\UnrealEditor.exe" (
  echo Unreal Engine 5.8 not found in "%UE_ROOT%". Set UE_ROOT to its folder.
  exit /b 1
)
set SOLWAY_AUTOSTART=1
if "%SOLWAY_PLAY%"=="" set SOLWAY_PLAY=1
start "" "%UE_ROOT%\Engine\Binaries\Win64\UnrealEditor.exe" "%~dp0MelasSim\MelasSim.uproject"
