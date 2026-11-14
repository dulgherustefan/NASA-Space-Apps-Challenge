"""Solway engine: hazard layers, route planning, stress tests, mission clock, incident director.

The engine is the authority of the three-process product (engine, dashboard, 3D window).
Interfaces are fixed by docs/CONTRACT.md.
"""
import os

PRODUCT = "Solway"
VERSION = "0.2"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
DATA = os.path.join(ROOT, "data")
SITE_DIR = os.path.join(DATA, "site")
AST_DIR = os.path.join(DATA, "ast")
SCENARIO_DIR = os.path.join(DATA, "scenario")
RL_DIR = os.path.join(ROOT, "rl")


def rel(path: str) -> str:
    """Repo-relative path with forward slashes (what the contract calls a file)."""
    return os.path.relpath(path, ROOT).replace(os.sep, "/")


def write_atomic(path: str, data: bytes) -> None:
    """Write via a temporary file so readers never see a half-written file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
