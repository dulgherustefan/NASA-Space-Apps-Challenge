"""OSC over UDP to the 3D window (contract section 3). Fire and forget: nobody listening is normal."""
import logging

log = logging.getLogger("engine.osc")

ADDRESSES = ["/clock", "/crew", "/agent", "/incident", "/overlay", "/reload", "/cue", "/route"]


class Osc:
    def __init__(self, host="127.0.0.1", port=9000, enabled=True):
        self.enabled = enabled
        self.client = None
        self.sent = 0
        self.errors = 0
        self.last = {}
        if enabled:
            try:
                from pythonosc.udp_client import SimpleUDPClient
                self.client = SimpleUDPClient(host, port)
                self.client._sock.setblocking(False)
            except Exception as e:  # pragma: no cover - socket creation failure
                log.warning("OSC disabled: %s", e)
                self.client = None

    def send(self, address, *args):
        self.last[address] = args
        if self.client is None:
            return
        try:
            self.client.send_message(address, list(args))
            self.sent += 1
        except Exception:
            # nothing listening, buffer full, network down: never block or crash the engine
            self.errors += 1

    # typed helpers ---------------------------------------------------------------------------
    def clock(self, t, speed, sun_az, sun_el):
        self.send("/clock", float(t), float(speed), float(sun_az), float(sun_el))

    def crew(self, cid, e, s, z, heading, pace, status):
        self.send("/crew", int(cid), float(e), float(s), float(z), float(heading), float(pace), int(status))

    def agent(self, route, aid, e, s, z, heading, status):
        self.send("/agent", int(route), int(aid), float(e), float(s), float(z), float(heading), int(status))

    def incident(self, kind, phase, intensity, e, s):
        self.send("/incident", str(kind), str(phase), float(intensity), float(e if e is not None else 0.0), float(s if s is not None else 0.0))

    def overlay(self, layer, opacity):
        self.send("/overlay", str(layer), float(opacity))

    def reload(self, what):
        self.send("/reload", str(what))

    def cue(self, name, duration=4.0):
        self.send("/cue", str(name), float(duration))

    def route(self, rid, state):
        self.send("/route", int(rid), str(state))
