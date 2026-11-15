"""Mission clock: speed, pause, reset, sol jumps; Mars time (port of reference/ts_engine/mars24.ts);
Sun azimuth/elevation interpolated from a JPL Horizons table; Earth-Mars one-way light time.
"""
import math
from datetime import datetime, timedelta, timezone

SOL_S = 88775.244
D2R = math.pi / 180

# JPL Horizons, Sun seen from the site (COMMAND='10', CENTER='coord@499', SITE_COORD='-290.03,-10.0,-3.0',
# QUANTITIES='4'), 2026-11-15 UTC: (hour, azimuth deg, elevation deg). docs/research/U3 section 2.4.
HORIZONS_SUN = [(6, 312.56, 61.90), (7, 297.68, 50.05), (8, 289.65, 36.85), (9, 284.65, 23.09),
                (10, 281.18, 9.07), (11, 278.55, -5.10), (12, 276.42, -19.36)]
HORIZONS_DAY = datetime(2026, 11, 15, tzinfo=timezone.utc)
# Earth-Mars distance (AU) from Horizons (CENTER='500@499', COMMAND='399', QUANTITIES='20')
HORIZONS_DELTA = [(datetime(2026, 11, 15, tzinfo=timezone.utc), 1.31605362), (datetime(2026, 11, 16, tzinfo=timezone.utc), 1.30752318)]
AU_LIGHT_S = 499.004784
SUN_SOURCE = "JPL Horizons (Sun az/el at the site, 15 Nov 2026)"
SUN_SOURCE_MODEL = "Mars24 algorithm (Allison & McEwen 2000)"


def _mod(a, n):
    return ((a % n) + n) % n


def mars24(dt_utc, east_lon, lat):
    jd_ut = 2440587.5 + dt_utc.timestamp() / 86400.0
    jd_tt = jd_ut + 69.184 / 86400.0
    d = jd_tt - 2451545.0
    M = _mod(19.3871 + 0.52402073 * d, 360)
    a_fms = _mod(270.3871 + 0.524038496 * d, 360)
    A = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.0020, 0.0018]
    T = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493]
    P = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095]
    pbs = sum(A[i] * math.cos(D2R * ((0.985626 * d / T[i]) + P[i])) for i in range(7))

    def s(x):
        return math.sin(D2R * x)
    nu_m = (10.691 + 3.0e-7 * d) * s(M) + 0.623 * s(2 * M) + 0.050 * s(3 * M) + 0.005 * s(4 * M) + 0.0005 * s(5 * M) + pbs
    ls = _mod(a_fms + nu_m, 360)
    eot = 2.861 * s(2 * ls) - 0.071 * s(4 * ls) + 0.002 * s(6 * ls) - nu_m
    msd = (jd_tt - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626
    mtc = _mod(24 * msd, 24)
    lmst = _mod(mtc + east_lon / 15, 24)
    ltst = _mod(lmst + eot / 15, 24)
    sub_solar_east = _mod(-(mtc * 15 + eot + 180), 360)
    dec = math.asin(0.42565 * s(ls)) / D2R + 0.25 * s(ls)
    H = _mod(east_lon - sub_solar_east + 180, 360) - 180
    phi, de, h = lat * D2R, dec * D2R, H * D2R
    elev = math.asin(math.sin(phi) * math.sin(de) + math.cos(phi) * math.cos(de) * math.cos(h)) / D2R
    az = _mod(math.atan2(-math.sin(h) * math.cos(de), math.cos(phi) * math.sin(de) - math.sin(phi) * math.cos(de) * math.cos(h)) / D2R, 360)
    return dict(MSD=msd, MTC=mtc, Ls=ls, LMST=lmst, LTST=ltst, sun_el=elev, sun_az=az,
                mars_year=math.floor((msd - 28892.2) / 668.5921) + 1)


def fmt_hms(hours):
    hh = int(math.floor(hours))
    mm = int(math.floor((hours - hh) * 60))
    ss = int(math.floor(((hours - hh) * 60 - mm) * 60))
    return "%02d:%02d:%02d" % (hh, mm, ss)


def light_time_formula_s(dt_utc):
    jd = 2440587.5 + dt_utc.timestamp() / 86400.0
    T = (jd - 2451545.0) / 36525

    def pos(a, e, L0, Ld, w0, wd):
        L = (L0 + Ld * T) * D2R; w = (w0 + wd * T) * D2R
        Mn = L - w; E = Mn
        for _ in range(6):
            E = Mn + e * math.sin(E)
        x = a * (math.cos(E) - e); y = a * math.sqrt(1 - e * e) * math.sin(E)
        return x * math.cos(w) - y * math.sin(w), x * math.sin(w) + y * math.cos(w)
    ex, ey = pos(1.00000261, 0.01671123, 100.46457166, 35999.37244981, 102.93768193, 0.32327364)
    mx, my = pos(1.52371034, 0.09339410, -4.55343205, 19140.30268499, -23.94362959, 0.44441088)
    return math.hypot(ex - mx, ey - my) * AU_LIGHT_S


def light_time_s(dt_utc):
    (t0, d0), (t1, d1) = HORIZONS_DELTA
    if t0 <= dt_utc <= t1 + timedelta(days=1):
        f = (dt_utc - t0).total_seconds() / (t1 - t0).total_seconds()
        return (d0 + (d1 - d0) * f) * AU_LIGHT_S
    return light_time_formula_s(dt_utc)


def sun_az_el(dt_utc, east_lon, lat):
    """(azimuth, elevation, source): Horizons table when inside it, Mars24 otherwise."""
    h = (dt_utc - HORIZONS_DAY).total_seconds() / 3600.0
    tab = HORIZONS_SUN
    if tab[0][0] <= h <= tab[-1][0]:
        for (h0, a0, e0), (h1, a1, e1) in zip(tab, tab[1:]):
            if h0 <= h <= h1:
                f = (h - h0) / (h1 - h0)
                return a0 + (a1 - a0) * f, e0 + (e1 - e0) * f, SUN_SOURCE
    m = mars24(dt_utc, east_lon, lat)
    return m["sun_az"], m["sun_el"], SUN_SOURCE_MODEL


def sunset_after(dt_utc, east_lon, lat):
    """UTC time of the next sunset (Sun elevation crossing zero downwards), or None if the Sun is down.

    Same Sun position as the rest of the engine: the Horizons table when inside it, Mars24 otherwise.
    Geometric elevation of the Sun's centre over a flat horizon; terrain and refraction are not included.
    """
    def el(t):
        return sun_az_el(t, east_lon, lat)[1]
    if el(dt_utc) <= 0:
        return None
    step = timedelta(minutes=5)
    a = dt_utc
    for _ in range(int(SOL_S / 300) + 2):
        b = a + step
        if el(b) <= 0:
            for _ in range(12):                      # bisect to about a tenth of a second
                mid = a + (b - a) / 2
                if el(mid) > 0:
                    a = mid
                else:
                    b = mid
            return b
        a = b
    return None


class MissionClock:
    def __init__(self, start_utc, east_lon, lat, speed=1.0):
        self.start_utc = start_utc
        self.east_lon = east_lon
        self.lat = lat
        self.default_speed = speed
        self._sunset = None
        self.reset()

    def daylight_s(self, dt=None):
        """Seconds until sunset; 0 when the Sun is down. The sunset time is kept until it has passed."""
        dt = dt or self.utc()
        ss = self._sunset
        if ss is None or dt >= ss or (ss - dt).total_seconds() > SOL_S:
            ss = self._sunset = sunset_after(dt, self.east_lon, self.lat)
        return 0.0 if ss is None else max(0.0, (ss - dt).total_seconds())

    def reset(self):
        self.t = 0.0
        self.speed = self.default_speed
        self.paused = True
        self.hold_at = None                  # the clock does not run past this mission time (scripted trigger)

    def advance(self, wall_dt):
        if not self.paused:
            t = self.t + wall_dt * self.speed
            if self.hold_at is not None and self.t <= self.hold_at:
                t = min(t, self.hold_at)
            self.t = t
        return self.t

    def jump_to(self, t):
        self.t = float(t)

    def utc(self, t=None):
        return self.start_utc + timedelta(seconds=self.t if t is None else t)

    def sol(self, t=None):
        return 1 + int((self.t if t is None else t) // SOL_S)

    def state(self):
        dt = self.utc()
        m = mars24(dt, self.east_lon, self.lat)
        az, el, src = sun_az_el(dt, self.east_lon, self.lat)
        return dict(t=round(self.t, 2), sol=self.sol(), lmst=fmt_hms(m["LMST"]), ltst=fmt_hms(m["LTST"]),
                    utc=dt.strftime("%Y-%m-%dT%H:%M:%SZ"), speed=self.speed, paused=self.paused,
                    sun_az=round(az, 2), sun_el=round(el, 2), sun_source=src, ls=round(m["Ls"], 2),
                    mars_year=m["mars_year"], light_time_s=round(light_time_s(dt), 1),
                    ltst_h=m["LTST"], daylight_s=round(self.daylight_s(dt), 0))


def parse_utc(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
