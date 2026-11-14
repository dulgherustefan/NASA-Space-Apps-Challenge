"""FastAPI server on 127.0.0.1:8765: WebSocket /ws (hello, 10 Hz snapshots, events, commands), read-only /files,
/health. One asyncio task ticks the director at 20 Hz; heavy work runs in a worker thread."""
import asyncio
import json
import logging
import math
import os
import time

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import PRODUCT, ROOT, VERSION

log = logging.getLogger("engine.server")

ALLOWED_DIRS = ("runtime", "data/site", "data/ast")
TICK_HZ = 20
SNAPSHOT_EVERY = 2                   # 20 Hz / 2 = 10 Hz
CORS_REGEX = r"^(https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|file://.*|app://.*|null)$"
STICKY = {"incident", "assessment", "routes", "stress", "decision"}


def safe_path(rel_path, root=ROOT):
    """Absolute path of a file under one of the allowed directories, or None. Rejects traversal and symlink escapes."""
    if not rel_path or "\x00" in rel_path or "\\" in rel_path:
        return None
    if rel_path.startswith("/") or os.path.isabs(rel_path):
        return None
    parts = rel_path.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return None
    norm = "/".join(parts)
    if not any(norm.startswith(d + "/") for d in ALLOWED_DIRS):
        return None
    full = os.path.realpath(os.path.join(root, *parts))
    for d in ALLOWED_DIRS:
        base = os.path.realpath(os.path.join(root, d))
        if full.startswith(base + os.sep):
            return full
    return None


def _json(msg):
    return json.dumps(msg, allow_nan=False, default=_default)


def _default(o):
    try:
        import numpy as np
        if isinstance(o, np.generic):
            return o.item()
    except ImportError:
        pass
    raise TypeError(type(o).__name__)


def _clean(v):
    """Replace non-finite floats with null so the JSON stays valid."""
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    return v


class Hub:
    def __init__(self, director):
        self.d = director
        self.clients = set()
        self.sticky = []
        self.snapshots = 0
        self.started = time.time()
        self.first_snapshot_at = None
        self.cmd_queue = asyncio.Queue()
        self.task = None

    def _publish(self, msg):
        msg = _clean(msg)
        if msg["type"] == "incident":
            self.sticky = [msg]
        elif msg["type"] in STICKY:
            self.sticky.append(msg)
        text = _json(msg)
        for q in list(self.clients):
            if q.qsize() > 400:          # slow client: drop its backlog of snapshots rather than grow without bound
                continue
            q.put_nowait(text)

    async def run(self):
        period = 1.0 / TICK_HZ
        last = time.perf_counter()
        n = 0
        while True:
            now = time.perf_counter()
            dt = min(now - last, 0.5)
            last = now
            while not self.cmd_queue.empty():
                cmd = self.cmd_queue.get_nowait()
                self.d.command(cmd)
                if cmd.get("cmd") in ("reset", "demo"):
                    self.sticky = []
            try:
                self.d.tick(dt)
            except Exception:
                log.exception("tick failed")
            for msg in self.d.drain():
                self._publish(msg)
            n += 1
            if n % SNAPSHOT_EVERY == 0:
                try:
                    self._publish(self.d.snapshot())
                    self.snapshots += 1
                    if self.first_snapshot_at is None:
                        self.first_snapshot_at = time.time()
                except Exception:
                    log.exception("snapshot failed")
            await asyncio.sleep(max(0.0, period - (time.perf_counter() - now)))


def create_app(director, startup_t0=None):
    hub_box = {}

    async def lifespan(app):
        hub = Hub(director)
        hub_box["hub"] = hub
        hub.task = asyncio.create_task(hub.run())
        if startup_t0 is not None:
            async def report():
                while hub.first_snapshot_at is None:
                    await asyncio.sleep(0.02)
                log.warning("first snapshot %.2f s after start", hub.first_snapshot_at - startup_t0)
            asyncio.create_task(report())
        yield
        hub.task.cancel()

    app = FastAPI(title=PRODUCT + " engine", version=VERSION, lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origin_regex=CORS_REGEX, allow_methods=["GET"], allow_headers=["*"])

    @app.get("/health")
    async def health():
        hub = hub_box.get("hub")
        d = director
        return JSONResponse(dict(ok=d.error is None, product=PRODUCT, version=VERSION, t=round(d.clock.t, 1), phase=d.phase,
                                 incident_id=d.incident_id, clients=len(hub.clients) if hub else 0,
                                 snapshots=hub.snapshots if hub else 0, osc_sent=d.osc.sent, osc_errors=d.osc.errors,
                                 error=d.error))

    @app.get("/files/{path:path}")
    async def files(path: str):
        full = safe_path(path)
        if full is None:
            raise HTTPException(status_code=403, detail="path not allowed")
        if not os.path.isfile(full):
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(full, headers={"Cache-Control": "no-store"})

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        hub = hub_box["hub"]
        q = asyncio.Queue()
        await sock.send_text(_json(_clean(director.hello())))
        for msg in hub.sticky:
            await sock.send_text(_json(msg))
        hub.clients.add(q)

        async def sender():
            while True:
                text = await q.get()
                await sock.send_text(text)

        send_task = asyncio.create_task(sender())
        try:
            while True:
                raw = await sock.receive_text()
                try:
                    cmd = json.loads(raw)
                    if not isinstance(cmd, dict) or "cmd" not in cmd:
                        raise ValueError("expected {\"cmd\": ...}")
                except ValueError as e:
                    await sock.send_text(_json(dict(type="log", t=round(director.clock.t, 1), level="warn",
                                                    text="Bad command: %s" % e, source="engine")))
                    continue
                await hub.cmd_queue.put(cmd)
        except WebSocketDisconnect:
            pass
        except Exception:
            log.debug("socket closed", exc_info=True)
        finally:
            hub.clients.discard(q)
            send_task.cancel()

    return app
