"""Record the three-incident demo so the dashboard can play it without an engine.

Runs the engine's demo without sockets, exactly as the engine would run it (same planner, same stress tests,
same pacing), and writes:

    <out>/demo.json        hello, then every message with the wall-clock second it was sent at
    <out>/files/<hash>.*   the files the dashboard fetches (routes, trajectories, overlays, parameters, base image)

A `_files` entry in the message list tells the player which stored file stands for which engine path from then on,
because the engine rewrites runtime/routes.json and the overlays for each incident.

The dashboard plays the recording when it is built with VITE_REPLAY=1 or opened with ?replay (see dashboard/src/lib/replay.ts).
The recording is model output from the scripted scenario, like the live demo.

Usage (from the repository root):
    python tools/record_demo.py                       # writes dashboard/public/replay
    python tools/record_demo.py --out some/dir --walkers 2000
"""
import argparse
import hashlib
import json
import math
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from engine import AST_DIR, ROOT as ENGINE_ROOT, RUNTIME, SITE_DIR, rel  # noqa: E402
from engine.__main__ import build, warm  # noqa: E402

TICK_S = 0.05            # the server ticks at 20 Hz
SNAPSHOT_EVERY = 4       # recorded snapshots: 5 per second (the live engine sends 10)
TAIL_S = 4.0             # keep recording a little after the last incident


def clean(v):
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    return v


class Files:
    """Copies every new version of a watched file into <out>/files under its content hash."""

    def __init__(self, out):
        self.dir = os.path.join(out, "files")
        os.makedirs(self.dir, exist_ok=True)
        self.seen = {}       # repo path -> (mtime, size)
        self.bytes = 0

    def watched(self):
        paths = [os.path.join(RUNTIME, n) for n in sorted(os.listdir(RUNTIME)) if n.endswith((".json", ".png"))]
        paths.append(os.path.join(SITE_DIR, "core_ortho.webp"))
        if os.path.isdir(AST_DIR):
            paths.append(os.path.join(AST_DIR, "ast_training.json"))
        return [p for p in paths if os.path.isfile(p)]

    def changes(self):
        out = {}
        for p in self.watched():
            st = os.stat(p)
            key = (st.st_mtime_ns, st.st_size)
            if self.seen.get(p) == key:
                continue
            self.seen[p] = key
            with open(p, "rb") as f:
                data = f.read()
            name = hashlib.sha1(data).hexdigest()[:12] + os.path.splitext(p)[1]
            dst = os.path.join(self.dir, name)
            if not os.path.exists(dst):
                with open(dst, "wb") as f:
                    f.write(data)
                self.bytes += len(data)
            out[rel(p)] = "files/" + name
        return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=os.path.join(ROOT, "dashboard", "public", "replay"))
    ap.add_argument("--walkers", type=int, default=None, help="Monte Carlo walkers per route (default from the engine parameters)")
    args = ap.parse_args()

    for name in os.listdir(RUNTIME) if os.path.isdir(RUNTIME) else []:
        if name.endswith((".json", ".png")):          # start from a clean runtime so nothing stale is recorded
            os.remove(os.path.join(RUNTIME, name))
    d = build(False, n_walkers=args.walkers)
    d.hz.write_static()
    warm(d.site)

    if os.path.isdir(args.out):
        shutil.rmtree(args.out)
    files = Files(args.out)
    frames = []

    def push(wall, msg):
        frames.append([round(wall, 2), clean(msg)])

    hello = clean(d.hello())
    push(0.0, {"type": "_files", "map": files.changes()})
    push(0.0, d.snapshot())
    d.command({"cmd": "demo"})
    wall, n, tail = 0.0, 0, None
    while wall < 900:
        d.tick(TICK_S)
        wall += TICK_S
        n += 1
        msgs = d.drain()
        if msgs:
            ch = files.changes()
            if ch:
                push(wall, {"type": "_files", "map": ch})
            for m in msgs:
                push(wall, m)
        if n % SNAPSHOT_EVERY == 0:
            push(wall, d.snapshot())
        if d.program is None:
            tail = wall if tail is None else tail
            if wall - tail >= TAIL_S:
                break
    ch = files.changes()
    if ch:
        push(wall, {"type": "_files", "map": ch})

    doc = dict(note="Recorded run of the scripted demo. Model output; incidents are scenarios.", engine=hello["version"],
               duration_s=round(wall, 2), walkers=args.walkers, hello=hello, frames=frames)
    path = os.path.join(args.out, "demo.json")
    with open(path, "w", encoding="utf8", newline="\n") as f:
        json.dump(doc, f, separators=(",", ":"))
    kinds = {}
    for _, m in frames:
        kinds[m["type"]] = kinds.get(m["type"], 0) + 1
    print("recorded %.1f s: %s" % (wall, ", ".join("%d %s" % (v, k) for k, v in sorted(kinds.items()))))
    print("wrote %s (%.0f kB) and %d files (%.1f MB) from engine root %s" % (
        os.path.relpath(path, ROOT), os.path.getsize(path) / 1e3, len(os.listdir(files.dir)), files.bytes / 1e6, ENGINE_ROOT))


if __name__ == "__main__":
    main()
