"""Vectorised PyTorch mirror of app/src/engine/sim.ts (the reference model): observe() and stepAgent()
for thousands of walkers at once on the GPU. Keep in sync with sim.ts; rl/parity_check.py verifies it.

Conventions: x east / y south in core metres, 5 m cells, cell index c = i * n + j (i = row = y).
Status codes: 0 walking, 1 arrived, 2 incapacitated, 3 heat, 4 O2, 5 timeout, 6 stuck.
"""
import math, os, re
import numpy as np
import torch

import planner as P
from terrain import ROOT

# ---- fixed model constants (app/src/engine/params.ts SIM) ------------------------------------------
CELL = 5.0
DT = 10.0
SUB = 2
PACES = [0.0, 0.4, 0.65, 0.95, 1.3]
HEADINGS = [-60.0, -30.0, 0.0, 30.0, 60.0]
MET_B, MET_C, MET_REST = 240.0, 110.0, 110.0
ETA_UP, K_DOWN = 0.25, 0.3
O2_KG_PER_J, O2_TANK_KG, O2_NOMINAL_W = 7.11e-8, 0.69, 300.0
ROUGH0, K_ROUGH, K_SAND_MET = 0.15, 0.6, 1.1
FALL_SLOPE_REF, FALL_T_MIN, FALL_T_MAX = 12.0, 20.0, 60.0
ARRIVE_R, T_MAX = 12.0, 3 * 3600.0
LOOK0, LOOK1, LOOK2 = 4.0, 7.5, 20.0
MOVE_LOOK = 5.0
STUCK_STEPS = 18
DUST_SLOW, DUST_FALL = 0.35, 1.5
N_OBS = 44

WALKING, ARRIVED, INCAPACITATED, HEAT, O2OUT, TIMEOUT, STUCK = range(7)
STATUS_LABEL = ["en route", "arrived", "fall injury", "heat casualty", "out of oxygen", "timeout", "stuck"]

_PARAM_FALLBACK = dict(slopeMaxDeg=20, slopeHardDeg=25, vPlan=0.56, shelterRuleMin=30, o2ReserveMin=60, kSand=0.8,
                       gMars=3.71, massKg=200, coolW=586, heatWarnKJ=506, heatMaxKJ=844, metBase=120, fallPerKm=0.15,
                       fallInjuryP=0.01, alphaDeg=27.8, gcrRate=8.75, sepPeakMin=53, sepTotal=8100, sepDecayH=6,
                       shieldK=0.63, skyShelterMin=0.27)


def load_params():
    """Parameter defaults, read from app/src/engine/params.ts (PARAM_DEFS) so the two cannot drift."""
    p = dict(_PARAM_FALLBACK)
    try:
        src = open(os.path.join(ROOT, "reference", "ts_engine", "params.ts"), encoding="utf8").read()
        for m in re.finditer(r"\{\s*key:\s*'(\w+)',\s*label:\s*'[^']*',\s*value:\s*([-0-9.eE]+)", src):
            p[m.group(1)] = float(m.group(2))
    except OSError:
        pass
    return p


# ---- reward (training only; rl/SPEC.md) -------------------------------------------------------------
REWARD = dict(progress=1.0 / 60, time=0.5 * DT / 60, dose=1.0 / 40, heat=0.03, fall=1.0, blocked=0.2,
              band=0.3 * DT / 60, arrive=10.0, in_rule=5.0, casualty=-15.0, timeout=-10.0, progress_clip=10.0)

# ---- scenario distribution (training / evaluation) --------------------------------------------------
SCEN = dict(p_sep=0.6, sep_elapsed_max=40 * 60.0, deadline=30 * 60.0, p_dust=0.2, dust_lo=0.2, dust_hi=1.0,
            heat_max=250.0, o2_lo=0.25, o2_hi=0.6, fall_mul=(0.6, 1.6), cool_mul=(0.85, 1.1),
            terr_err=0.25, terr_err_dust=0.35, start_spread=4.0)


class Terrain:
    def __init__(self, grid, blocked, device, dtype=torch.float32):
        self.n = int(grid["n"]); self.N = self.n * self.n
        self.device, self.dtype = device, dtype
        f = lambda a: torch.as_tensor(np.ascontiguousarray(a), device=device).to(dtype)
        n = self.n
        z = f(grid["z"])
        self.z = z
        # the four corner heights of every bilinear patch in one row -> one gather per zAt
        z2 = z.view(n, n)
        zp = torch.nn.functional.pad(z2[None, None], (0, 1, 0, 1), mode="replicate")[0, 0]
        self.zc = torch.stack([zp[:n, :n], zp[:n, 1:], zp[1:, :n], zp[1:, 1:]], -1).reshape(self.N, 4).contiguous()
        sand, rough, slope, sky, beta = f(grid["sand"]), f(grid["rough"]), f(grid["slope"]), f(grid["sky"]), f(grid["beta"])
        r = (rough - ROUGH0).clamp(0, 1)
        self.blocked = torch.as_tensor(np.ascontiguousarray(blocked).astype(bool), device=device)
        # per-cell attributes in one table: sand, r, slope, sky, beta, soil_obs, blocked
        self.attr = torch.stack([sand, r, slope, sky, beta, (sand + r).clamp(0, 1.5), self.blocked.to(dtype)], -1).contiguous()

    def z_at(self, x, y):
        n = self.n
        fx = (x / CELL - 0.5).clamp(0, n - 1.001)
        fy = (y / CELL - 0.5).clamp(0, n - 1.001)
        j = fx.long(); i = fy.long()
        tx = fx - j; ty = fy - i
        zc = self.zc[i * n + j]
        return (zc[..., 0] * (1 - tx) + zc[..., 1] * tx) * (1 - ty) + (zc[..., 2] * (1 - tx) + zc[..., 3] * tx) * ty

    def cell_at(self, x, y):
        n = self.n
        j = torch.floor(x / CELL).long(); i = torch.floor(y / CELL).long()
        ok = (i >= 0) & (i < n) & (j >= 0) & (j < n)
        return i.clamp(0, n - 1) * n + j.clamp(0, n - 1), ok


class FieldBank:
    """Planner fields on the device: cost/time (float32) and compact next / guidance codes (uint8)."""

    def __init__(self, fields, goals_xy, band_active, alpha, device, n, starts=None, names=None):
        self.F = len(fields); self.n = n; self.N = n * n
        self.device = device
        self.ct = torch.empty((self.F * self.N, 2), dtype=torch.float32, device=device)
        self.codes = torch.empty((self.F * self.N, 2), dtype=torch.uint8, device=device)
        for k, f in enumerate(fields):
            s = slice(k * self.N, (k + 1) * self.N)
            self.ct[s, 0] = torch.as_tensor(f["cost"], device=device)
            self.ct[s, 1] = torch.as_tensor(f["time"], device=device)
            self.codes[s, 0] = torch.as_tensor(f["nextk"], device=device)
            self.codes[s, 1] = torch.as_tensor(f["gcode"], device=device)
        g = np.asarray(goals_xy, np.float64).reshape(self.F, 2)
        self.goal_x = torch.as_tensor(g[:, 0].copy(), device=device)
        self.goal_y = torch.as_tensor(g[:, 1].copy(), device=device)
        self.band_active = torch.as_tensor(np.asarray(band_active, bool), device=device)
        self.alpha = torch.as_tensor(np.asarray(alpha, np.float64), device=device)
        self.starts = None if starts is None else torch.as_tensor(np.asarray(starts, np.int64), device=device)
        self.names = names
        # guidance unit vectors per code: float32-rounded like Field.gx / gy in the TS
        lx = np.zeros(169, np.float32); ly = np.zeros(169, np.float32)
        for dy in range(-6, 7):
            for dx in range(-6, 7):
                l = math.sqrt(dx * dx + dy * dy)
                if l > 0:
                    lx[(dy + 6) * 13 + dx + 6] = dx / l; ly[(dy + 6) * 13 + dx + 6] = dy / l
        self.lut = torch.as_tensor(np.stack([lx, ly], -1), device=device)        # [169, 2] float32
        self.nb_di = torch.as_tensor(np.append(P.NB[:, 0], 0), device=device)
        self.nb_dj = torch.as_tensor(np.append(P.NB[:, 1], 0), device=device)


class WalkEnv:
    """n walkers, each with its own scenario (field, hazard, storm, dust, physiology)."""

    STATE = ["x", "y", "t", "heat", "o2", "dose", "fallTimer", "falls", "blockedRun", "bandSec", "dist", "heatPeak",
             "status", "lastV"]

    def __init__(self, terrain, bank, n, seed=0, params=None, scen=None, reward=None, auto_reset=True):
        self.T, self.B, self.n = terrain, bank, n
        self.device, self.dtype = terrain.device, terrain.dtype
        self.p = dict(load_params() if params is None else params)
        self.scen = dict(SCEN if scen is None else scen)
        self.rw = dict(REWARD if reward is None else reward)
        self.auto_reset = auto_reset
        self.gen = torch.Generator(device=self.device); self.gen.manual_seed(seed)
        dev, dt = self.device, self.dtype
        self.COS = torch.tensor([math.cos(d * math.pi / 180) for d in HEADINGS], device=dev, dtype=dt)
        self.SIN = torch.tensor([math.sin(d * math.pi / 180) for d in HEADINGS], device=dev, dtype=dt)
        self.PACES = torch.tensor(PACES, device=dev, dtype=dt)
        z = lambda: torch.zeros(n, device=dev, dtype=dt)
        zl = lambda: torch.zeros(n, device=dev, dtype=torch.long)
        self.x, self.y, self.t, self.heat, self.o2, self.dose = z(), z(), z(), z(), z(), z()
        self.effM, self.cool, self.vmul, self.react, self.seed = z() + 1, z() + 1, z() + 1, z(), z()
        self.fallTimer, self.bandSec, self.dist, self.heatPeak, self.lastV = z(), z(), z(), z(), z()
        self.falls, self.blockedRun, self.status = zl(), zl(), zl()
        # scenario
        self.fidx = zl()
        self.goal_x, self.goal_y = z(), z()
        self.sep_el = z() - 1; self.deadline = z() + math.inf
        self.terr_err = z(); self.dust = z()
        self.band_active = torch.zeros(n, device=dev, dtype=torch.bool); self.alpha = z() + self.p["alphaDeg"]
        self.fallPerKm = z() + self.p["fallPerKm"]; self.coolW = z() + self.p["coolW"]
        self.plan_time0 = z()
        # episode accounting
        self.ep_ret = z(); self.ep_len = z()
        self.acc_names = ["episodes", "ret", "len", "arrived", "incap", "heat", "o2", "timeout", "stuck", "sep_eps",
                          "sep_in_rule", "falls", "t_arrived", "dose", "band_s", "plan_time"]
        self.acc = torch.zeros(len(self.acc_names), device=dev, dtype=torch.float64)
        self.round32 = (lambda v: v.float().to(dt)) if dt == torch.float64 else (lambda v: v)
        if auto_reset and bank.starts is not None:
            self.reset()

    # ------------------------------------------------------------------ helpers
    def sep_rate(self, tau):
        p = self.p
        tp = p["sepPeakMin"] * 60.0; td = p["sepDecayH"] * 3600.0
        peak = p["sepTotal"] / ((tp / 2 + td) / 3600.0)
        rate = torch.where(tau < tp, peak * tau / tp, peak * torch.exp(-(tau - tp).clamp_min(0) / td))
        return torch.where(tau <= 0, torch.zeros_like(tau), rate)

    def sep_peak(self):
        p = self.p
        return p["sepTotal"] / ((p["sepPeakMin"] * 60.0 / 2 + p["sepDecayH"] * 3600.0) / 3600.0)

    @staticmethod
    def speed_factor(grade):
        return torch.exp(-3.5 * (grade + 0.05).abs()) / math.exp(-0.175)

    @staticmethod
    def terrain_noise(seed, x, y):
        # smooth value noise, ~40 m wavelength, per-agent offset -> 0..1 (same function as sim.ts; double precision)
        seed = seed.double(); x = x.double(); y = y.double()
        fx = x / 40 + seed; fy = y / 40 + seed * 1.7
        ix = torch.floor(fx); iy = torch.floor(fy); tx = fx - ix; ty = fy - iy

        def h(a, b):
            s = torch.sin(a * 127.1 + b * 311.7) * 43758.5453
            return s - torch.floor(s)
        sx = tx * tx * (3 - 2 * tx); sy = ty * ty * (3 - 2 * ty)
        return (h(ix, iy) * (1 - sx) + h(ix + 1, iy) * sx) * (1 - sy) + (h(ix, iy + 1) * (1 - sx) + h(ix + 1, iy + 1) * sx) * sy

    def _guidance(self, x, y, c, ok, base):
        code = self.B.codes[base + c, 1].long()
        g = self.B.lut[code].to(self.dtype)
        gx = torch.where(ok, g[:, 0], torch.zeros_like(x)); gy = torch.where(ok, g[:, 1], torch.zeros_like(x))
        zero = (gx == 0) & (gy == 0)
        dx = self.goal_x - x; dy = self.goal_y - y
        l = torch.hypot(dx, dy); l = torch.where(l == 0, torch.ones_like(l), l)
        return torch.where(zero, dx / l, gx), torch.where(zero, dy / l, gy)

    # ------------------------------------------------------------------ observation (44 floats)
    def observe(self):
        T, B, p = self.T, self.B, self.p
        x, y = self.x, self.y
        dt = self.dtype
        base = self.fidx * T.N
        c0, ok0 = T.cell_at(x, y)
        gx, gy = self._guidance(x, y, c0, ok0, base)
        dx = gx[:, None] * self.COS - gy[:, None] * self.SIN          # [n, 5]
        dy = gx[:, None] * self.SIN + gy[:, None] * self.COS
        x_, y_ = x[:, None], y[:, None]
        px = torch.cat([x_, x_ + dx * LOOK1, x_ + dx * LOOK2], 1)
        py = torch.cat([y_, y_ + dy * LOOK1, y_ + dy * LOOK2], 1)
        zz = T.z_at(px, py)
        z0 = zz[:, :1]
        o = torch.empty((self.n, N_OBS), device=self.device, dtype=dt)
        o[:, 0:5] = ((zz[:, 1:6] - z0) / LOOK1).clamp(-0.6, 0.6) / 0.6
        o[:, 5:10] = ((zz[:, 6:11] - z0) / LOOK2).clamp(-0.6, 0.6) / 0.6
        c1, ok1 = T.cell_at(px[:, 1:6], py[:, 1:6])
        cn, okn = T.cell_at(x_ + dx * LOOK0, y_ + dy * LOOK0)
        a1 = T.attr[c1]                                               # [n, 5, 7]
        imp = (~ok1) | (~okn) | (a1[..., 6] > 0) | T.blocked[cn]
        ct0 = B.ct[base + c0]
        T0 = torch.where(ok0, ct0[:, 0].to(dt), torch.full_like(x, math.inf))
        T1 = B.ct[base[:, None] + c1, 0].to(dt)
        fin = torch.isfinite(T1) & torch.isfinite(T0)[:, None]
        prog = torch.where(fin, (torch.nan_to_num(T0[:, None] - T1, nan=0.0, posinf=0.0, neginf=0.0) / (LOOK1 / p["vPlan"])).clamp(-2, 2) / 2,
                           torch.full_like(T1, -1.0))
        active = torch.where(self.band_active, 1.0, 0.3).to(dt)
        band = torch.where(a1[..., 4] >= self.alpha[:, None], active[:, None], torch.zeros_like(T1))
        zero5 = torch.zeros_like(T1)
        o[:, 10:15] = imp.to(dt)
        o[:, 15:20] = torch.where(imp, torch.full_like(T1, -1.0), prog)
        o[:, 20:25] = torch.where(imp, zero5, a1[..., 5])
        o[:, 25:30] = torch.where(imp, zero5, band)
        a0 = T.attr[c0]
        sep_on = self.sep_el >= 0
        o[:, 30] = (self.heat / p["heatWarnKJ"]).clamp(0, 2)
        o[:, 31] = (self.effM - 1) * 4
        o[:, 32] = (self.cool - 1) * 4
        o[:, 33] = (self.vmul - 1) * 4
        tt = ct0[:, 1].to(dt)
        tt = torch.where(ok0 & torch.isfinite(tt), tt, torch.full_like(tt, 7200.0))
        o[:, 34] = (tt / 1800).clamp(0, 4) / 4
        o[:, 35] = ((self.deadline - self.t) / 1800).clamp(-1, 3) / 3          # deadline = inf -> 1
        o[:, 36] = sep_on.to(dt)
        o[:, 37] = torch.where(sep_on, self.sep_rate(self.sep_el + self.t) / self.sep_peak(), torch.zeros_like(x))
        o[:, 38] = torch.where(ok0, (a0[:, 3] / 0.35).clamp(0, 1.5), torch.zeros_like(x))
        o[:, 39] = (self.o2 / O2_TANK_KG).clamp(0, 1)
        o[:, 40] = (self.heat >= p["heatWarnKJ"]).to(dt)
        o[:, 41] = torch.where(ok0, (a0[:, 2] / 25).clamp(0, 1.5), torch.zeros_like(x))
        o[:, 42] = self.blockedRun.clamp(max=4).to(dt) / 4
        o[:, 43] = self.dust
        return o.float()

    # ------------------------------------------------------------------ one decision step (stepAgent)
    def step_dynamics(self, hk, pk, u1, u2, u3, active=None):
        """Advance every walker by one decision. `active` (bool mask) freezes the others."""
        T, B, p = self.T, self.B, self.p
        dt = self.dtype
        n_ = T.n
        dtS = DT / SUB
        x, y = self.x, self.y
        base = self.fidx * T.N
        inf = torch.full_like(x, math.inf)
        c00, ok00 = T.cell_at(x, y)
        ct00 = B.ct[base + c00]
        T00 = torch.where(ok00, ct00[:, 0].to(dt), inf)
        impaired = self.heat >= p["heatWarnKJ"]
        in_fall = self.fallTimer > 0
        in_react = (~in_fall) & (self.t < self.react)
        moving = ~(in_fall | in_react)
        fallTimer = torch.where(in_fall, self.fallTimer - DT, self.fallTimer)
        tanHard = math.tan((p["slopeMaxDeg"] + 6) * math.pi / 180)

        gx, gy = self._guidance(x, y, c00, ok00, base)
        ch, sh = self.COS[hk], self.SIN[hk]
        dx = gx * ch - gy * sh; dy = gx * sh + gy * ch
        one = torch.ones_like(x); zero = torch.zeros_like(x)
        vcmd = self.PACES[pk] * self.vmul * torch.where(impaired, 0.6 * one, one)
        go = moving & (vcmd > 0)
        look = (vcmd * dtS).clamp_min(MOVE_LOOK)
        Msum = zero; hazard = zero; lastV = zero
        downhill = torch.zeros_like(go); wasBlocked = torch.zeros_like(go)
        dustf = 1 - DUST_SLOW * self.dust
        fall_k = self.fallPerKm / 1000 * torch.where(impaired, 2 * one, one) * (1 + DUST_FALL * self.dust)
        dist = self.dist
        rest = MET_REST * self.effM
        for s in range(SUB):
            c, okc = (c00, ok00) if s == 0 else T.cell_at(x, y)
            a = T.attr[c]
            okf = okc.to(dt)
            sand = a[:, 0] * okf; r = a[:, 1] * okf
            soil = (1 + p["kSand"] * sand) * (1 + K_ROUGH * r)
            err = (1 - self.terr_err * self.terrain_noise(self.seed, x, y).to(dt)) * dustf
            # fallback direction: toward the planner's next cell
            k = B.codes[base + c, 0].long()
            has = okc & (k != P.NEXT_NONE)
            kk = torch.where(has, k, torch.full_like(k, 16))
            ti = torch.div(c, n_, rounding_mode="floor") + B.nb_di[kk]
            tj = c % n_ + B.nb_dj[kk]
            ex = (tj.to(dt) + 0.5) * CELL - x; ey = (ti.to(dt) + 0.5) * CELL - y
            el = torch.hypot(ex, ey); okel = el > 0.01
            els = torch.where(okel, el, one)
            ex = ex / els; ey = ey / els
            zz = T.z_at(torch.stack([x, x + dx * look, x + ex * look], 1), torch.stack([y, y + dy * look, y + ey * look], 1))
            grade = (zz[:, 1] - zz[:, 0]) / look
            g2 = (zz[:, 2] - zz[:, 0]) / look
            v = vcmd * self.speed_factor(grade) / soil * err
            v2 = vcmd * self.speed_factor(g2) / soil * err
            nx = x + dx * v * dtS; ny = y + dy * v * dtS
            nx2 = x + ex * v2 * dtS; ny2 = y + ey * v2 * dtS
            ncs, oks = T.cell_at(torch.stack([nx, nx2], 1), torch.stack([ny, ny2], 1))
            blk = T.blocked[ncs]
            bad1 = (~oks[:, 0]) | blk[:, 0] | (grade.abs() > tanHard)
            ok2 = has & okel & oks[:, 1] & (~blk[:, 1]) & (g2.abs() <= tanHard)
            m1 = go & ~bad1
            m2 = go & bad1 & ok2
            mv = m1 | m2
            wasBlocked = wasBlocked | (go & bad1)
            veff = torch.where(m1, v, torch.where(m2, v2, zero))
            geff = torch.where(m2, g2, grade)
            x = torch.where(m1, nx, torch.where(m2, nx2, x))
            y = torch.where(m1, ny, torch.where(m2, ny2, y))
            Mm = (p["metBase"] + MET_B * veff + MET_C * veff * veff) * (1 + K_SAND_MET * sand + K_ROUGH * r)
            w = p["massKg"] * p["gMars"] * veff
            Mm = Mm + torch.where(geff > 0, w * geff / ETA_UP, w * (-geff) * K_DOWN)
            Mm = Mm * self.effM
            sl = a[:, 2] * okf / FALL_SLOPE_REF
            vr = veff / 0.65
            dh = geff < -0.12
            lam = fall_k * (1 + sl * sl) * (1 + 2 * r) * vr * vr * torch.where(dh, 1.6 * one, one)
            hazard = hazard + lam * veff * dtS                       # pNoFall *= exp(-lam v dt)
            dist = dist + veff * dtS
            lastV = torch.where(mv, veff, lastV)
            downhill = torch.where(mv, dh, downhill)
            Msum = Msum + torch.where(mv, Mm, rest)
        blockedRun = torch.where(moving, torch.where(wasBlocked & (lastV == 0), self.blockedRun + 1, torch.zeros_like(self.blockedRun)),
                                 self.blockedRun)
        # falls
        pFall = -torch.expm1(-hazard)
        fell = moving & (u1 < pFall)
        falls = self.falls + fell.long()
        fallTimer = torch.where(fell, FALL_T_MIN + u3 * (FALL_T_MAX - FALL_T_MIN), fallTimer)
        pInj = (p["fallInjuryP"] * (1 + lastV / 0.65) * torch.where(downhill, 1.5 * one, one)).clamp(max=0.3)
        incap = fell & (u2 < pInj)
        Msum = torch.where(in_fall, 250 * self.effM * SUB, torch.where(in_react, rest * SUB, Msum))
        Mavg = Msum / SUB
        r32 = self.round32
        # heat, oxygen
        heat = r32((self.heat + (Mavg - self.cool * self.coolW) * DT / 1000).clamp_min(0))
        heatPeak = torch.maximum(self.heatPeak, heat)
        o2 = r32(self.o2 - Mavg * DT * O2_KG_PER_J)
        # radiation
        c1, ok1 = T.cell_at(x, y)
        a1 = T.attr[c1]
        ok1f = ok1.to(dt)
        shield = (p["shieldK"] * a1[:, 3]).clamp(max=0.95) * ok1f
        sep_on = self.sep_el >= 0
        rate = p["gcrRate"] + torch.where(sep_on, self.sep_rate(self.sep_el + self.t + DT / 2), zero)
        dInc = rate * (1 - shield) * DT / 3600
        dose = r32(self.dose + dInc)
        in_band = self.band_active & ok1 & (a1[:, 4] >= self.alpha)
        bandSec = self.bandSec + in_band.to(dt) * DT
        t = self.t + DT
        # termination
        ct1 = B.ct[base + c1]
        T1 = torch.where(ok1, ct1[:, 0].to(dt), inf)
        dg = torch.hypot(self.goal_x - x, self.goal_y - y)
        arrived = (dg <= ARRIVE_R) | (ok1 & (ct1[:, 1] <= 5))
        st = torch.full_like(self.status, WALKING)
        st = torch.where(t >= T_MAX, torch.full_like(st, TIMEOUT), st)
        st = torch.where(blockedRun >= STUCK_STEPS, torch.full_like(st, STUCK), st)
        st = torch.where(o2 <= 0, torch.full_like(st, O2OUT), st)
        st = torch.where(heat >= p["heatMaxKJ"], torch.full_like(st, HEAT), st)
        st = torch.where(arrived, torch.full_like(st, ARRIVED), st)
        st = torch.where(incap, torch.full_like(st, INCAPACITATED), st)
        fin = torch.isfinite(T00) & torch.isfinite(T1)
        progress = torch.where(fin, torch.nan_to_num(T00 - T1, nan=0.0, posinf=0.0, neginf=0.0), zero)
        new = dict(x=r32(x), y=r32(y), t=t, heat=heat, o2=o2, dose=dose, fallTimer=r32(fallTimer), falls=falls,
                   blockedRun=blockedRun, bandSec=bandSec, dist=r32(dist), heatPeak=heatPeak, status=st, lastV=r32(lastV))
        if active is None:
            for k_, v_ in new.items(): setattr(self, k_, v_)
        else:
            for k_, v_ in new.items(): setattr(self, k_, torch.where(active, v_, getattr(self, k_)))
        return dict(fell=fell, blocked=wasBlocked, progress=progress, doseInc=dInc, met=Mavg, in_band=in_band, sep_on=sep_on,
                    time0=torch.where(ok00, ct00[:, 1].to(dt), inf), time1=torch.where(ok1, ct1[:, 1].to(dt), inf))

    def reward(self, info):
        rw, p = self.rw, self.p
        dt = self.dtype
        st = self.status
        if rw.get("shaping", "spec") == "potential":
            # potential-based shaping (Ng et al. 1999): F = gamma * Phi(s') - Phi(s), Phi = -k * planner time-to-go [min],
            # Phi(terminal) = 0 -> cannot change which policy is optimal; behaviour is set by the explicit terms below
            t0, t1 = info["time0"], info["time1"]
            fin = torch.isfinite(t0) & torch.isfinite(t1)
            t1e = torch.where(st != WALKING, torch.zeros_like(t1), torch.nan_to_num(t1, posinf=0.0))
            shp = torch.where(fin, (torch.nan_to_num(t0, posinf=0.0) - rw["gamma"] * t1e) / 60.0, torch.zeros_like(t0))
            r = rw["shaping_k"] * shp - rw["time"]
        else:
            r = (info["progress"] * rw["progress"]).clamp(-rw["progress_clip"], rw["progress_clip"]) - rw["time"]
        r = r - torch.where(info["sep_on"], info["doseInc"] * rw["dose"], torch.zeros_like(r))
        r = r - rw["heat"] * (self.heat - 0.6 * p["heatWarnKJ"]).clamp_min(0) / p["heatWarnKJ"]
        r = r - rw["fall"] * info["fell"].to(dt) - rw["blocked"] * info["blocked"].to(dt) - rw["band"] * info["in_band"].to(dt)
        arrived = st == ARRIVED
        r = r + arrived.to(dt) * (rw["arrive"] + rw["in_rule"] * (self.t <= self.deadline).to(dt))
        r = r + ((st == INCAPACITATED) | (st == HEAT) | (st == O2OUT)).to(dt) * rw["casualty"]
        r = r + ((st == TIMEOUT) | (st == STUCK)).to(dt) * rw["timeout"]
        return r

    # ------------------------------------------------------------------ training API
    def step(self, hk, pk):
        u = torch.rand((3, self.n), generator=self.gen, device=self.device, dtype=self.dtype)
        info = self.step_dynamics(hk, pk, u[0], u[1], u[2])
        rew = self.reward(info)
        done = self.status != WALKING
        self.ep_ret = self.ep_ret + rew; self.ep_len = self.ep_len + 1
        self._account(done)
        if self.auto_reset:
            self.reset(done)
        return self.observe(), rew.float(), done

    def _account(self, done):
        st = self.status
        d = done.double()
        sep = (self.sep_el >= 0)
        arr = st == ARRIVED
        cols = [torch.ones_like(d), self.ep_ret.double(), self.ep_len.double(), arr.double(), (st == INCAPACITATED).double(),
                (st == HEAT).double(), (st == O2OUT).double(), (st == TIMEOUT).double(), (st == STUCK).double(),
                sep.double(), (sep & arr & (self.t <= self.deadline)).double(), self.falls.double(),
                arr.double() * self.t.double(), self.dose.double(), self.bandSec.double(), self.plan_time0.double()]
        self.acc += (torch.stack(cols, 0) * d).sum(1)

    def pop_stats(self):
        a = self.acc.cpu().numpy().copy(); self.acc.zero_()
        s = dict(zip(self.acc_names, a))
        n = max(s["episodes"], 1.0)
        return dict(episodes=int(s["episodes"]), ret=s["ret"] / n, len=s["len"] / n, arrive=s["arrived"] / n,
                    incap=s["incap"] / n, heat=s["heat"] / n, o2=s["o2"] / n, timeout=s["timeout"] / n, stuck=s["stuck"] / n,
                    in_rule=s["sep_in_rule"] / max(s["sep_eps"], 1.0), falls=s["falls"] / n,
                    t_arrive_min=s["t_arrived"] / max(s["arrived"], 1.0) / 60, dose=s["dose"] / n, band_min=s["band_s"] / n / 60,
                    plan_min=s["plan_time"] / n / 60)

    def sample_traits(self):
        n, dev, dt = self.n, self.device, self.dtype
        g = torch.randn((3, n), generator=self.gen, device=dev, dtype=dt)
        u = torch.rand((2, n), generator=self.gen, device=dev, dtype=dt)
        effM = torch.exp(0.12 * g[0]).clamp(0.72, 1.45)
        cool = (1 + 0.08 * g[1]).clamp(0.75, 1.2)
        vmul = (1 + 0.10 * g[2]).clamp(0.75, 1.25)
        return effM, cool, vmul, 20 + 70 * u[0], u[1] * 1000

    def reset(self, mask=None):
        """Sample a new episode (scenario + walker) for the envs in `mask` (all if None)."""
        n, dev, dt, B, sc, p = self.n, self.device, self.dtype, self.B, self.scen, self.p
        u = torch.rand((12, n), generator=self.gen, device=dev, dtype=dt)
        f = torch.randint(0, B.F, (n,), generator=self.gen, device=dev)
        si = torch.randint(0, B.starts.shape[1], (n,), generator=self.gen, device=dev)
        cell = B.starts[f, si]
        ci = torch.div(cell, self.T.n, rounding_mode="floor"); cj = cell % self.T.n
        x = (cj.to(dt) + 0.5) * CELL + (u[0] - 0.5) * sc["start_spread"]
        y = (ci.to(dt) + 0.5) * CELL + (u[1] - 0.5) * sc["start_spread"]
        sep = u[2] < sc["p_sep"]
        sep_el = torch.where(sep, u[3] * sc["sep_elapsed_max"], torch.full_like(x, -1.0))
        deadline = torch.where(sep, torch.full_like(x, sc["deadline"]), torch.full_like(x, math.inf))
        dust = torch.where(u[4] < sc["p_dust"], sc["dust_lo"] + (sc["dust_hi"] - sc["dust_lo"]) * u[5], torch.zeros_like(x))
        heat = u[6] * sc["heat_max"]
        o2 = sc["o2_lo"] + (sc["o2_hi"] - sc["o2_lo"]) * u[7]
        fall = p["fallPerKm"] * (sc["fall_mul"][0] + (sc["fall_mul"][1] - sc["fall_mul"][0]) * u[8])
        coolW = p["coolW"] * (sc["cool_mul"][0] + (sc["cool_mul"][1] - sc["cool_mul"][0]) * u[9])
        effM, cool, vmul, react, seed = self.sample_traits()
        plan_t = B.ct[f * self.T.N + cell, 1].to(dt)
        zero = torch.zeros_like(x); zl = torch.zeros_like(self.status)
        new = dict(x=x, y=y, t=zero, heat=heat, o2=o2, dose=zero, fallTimer=zero, falls=zl, blockedRun=zl, bandSec=zero,
                   dist=zero, heatPeak=heat, status=zl, lastV=zero, effM=effM, cool=cool, vmul=vmul, react=react, seed=seed,
                   fidx=f, goal_x=B.goal_x[f].to(dt), goal_y=B.goal_y[f].to(dt), sep_el=sep_el, deadline=deadline,
                   terr_err=sc["terr_err"] + sc["terr_err_dust"] * dust, dust=dust, band_active=B.band_active[f],
                   alpha=B.alpha[f].to(dt), fallPerKm=fall, coolW=coolW, plan_time0=plan_t, ep_ret=zero, ep_len=zero)
        if mask is None:
            for k_, v_ in new.items(): setattr(self, k_, v_)
        else:
            for k_, v_ in new.items(): setattr(self, k_, torch.where(mask, v_, getattr(self, k_)))

    def set_route(self, fidx, start, sep_elapsed, deadline, dust=0.0, terr_err=None, spread=4.0):
        """Walkers on concrete routes, initialised like makeAgents() in sim.ts. fidx, start["x"], start["y"] and
        sep_elapsed may be scalars or per-walker tensors (several routes in one batch).
        start = dict(x, y, heat, o2, dose). Parameters stay at their defaults (no domain randomisation)."""
        n, dev, dt, B, p = self.n, self.device, self.dtype, self.B, self.p
        u = torch.rand((4, n), generator=self.gen, device=dev, dtype=dt)
        zero = torch.zeros(n, device=dev, dtype=dt); zl = torch.zeros(n, device=dev, dtype=torch.long)
        tens = lambda v: v.to(dt) if torch.is_tensor(v) else zero + float(v)
        self.x = tens(start["x"]) + (u[0] - 0.5) * spread; self.y = tens(start["y"]) + (u[1] - 0.5) * spread
        self.heat = (start["heat"] * (0.7 + 0.6 * u[2])).clamp_min(0); self.o2 = start["o2"] * (0.92 + 0.16 * u[3])
        self.dose = zero + start.get("dose", 0.0)
        self.effM, self.cool, self.vmul, self.react, self.seed = self.sample_traits()
        self.t = zero; self.fallTimer = zero; self.bandSec = zero; self.dist = zero; self.lastV = zero
        self.heatPeak = self.heat.clone(); self.falls = zl; self.blockedRun = zl; self.status = zl
        self.fidx = fidx.long() if torch.is_tensor(fidx) else zl + int(fidx)
        self.goal_x = B.goal_x[self.fidx].to(dt); self.goal_y = B.goal_y[self.fidx].to(dt)
        self.sep_el = tens(sep_elapsed); self.deadline = zero + float(deadline)
        self.dust = zero + float(dust)
        self.terr_err = zero + (0.25 + 0.35 * float(dust) if terr_err is None else float(terr_err))
        self.band_active = B.band_active[self.fidx]
        self.alpha = B.alpha[self.fidx].to(dt)
        self.fallPerKm = zero + p["fallPerKm"]; self.coolW = zero + p["coolW"]
        self.ep_ret = zero; self.ep_len = zero
        c, _ = self.T.cell_at(self.x, self.y)
        self.plan_time0 = B.ct[self.fidx * self.T.N + c, 1].to(dt)


# ---------------------------------------------------------------------- scripted baseline (baselineAction)
_ORDER = [2, 1, 3, 0, 4]


def baseline_action(o):
    """Follow the planner, one pace (nominal; brisk under a solar-storm deadline). o: [n, 44] -> (heading, pace)."""
    dev = o.device
    order = torch.tensor(_ORDER, device=dev)
    free = o[:, 10:15][:, order] < 0.5
    score = torch.where(free, o[:, 15:20][:, order].double(), torch.full((o.shape[0], 5), -9.0, device=dev, dtype=torch.float64))
    score = score - 1e-9 * torch.arange(5, device=dev, dtype=torch.float64)      # ties -> first in the order (strict >)
    best = order[score.argmax(1)]
    none = ~free.any(1)
    alt = torch.where(none, torch.where(o[:, 42] > 0.6, 4, 0), best)
    trig = (o[:, 12] > 0.5) | (o[:, 42] > 0)
    h = torch.where(trig, alt, torch.full_like(alt, 2))
    pace = torch.where(o[:, 36] > 0.5, 3, 2)
    return h, pace


# ---------------------------------------------------------------------- field bank construction
DEMO_GOALS = [("A", 2598.0, 1858.0), ("C", 2343.0, 2083.0), ("R", 1700.0, 2600.0), ("H", 700.0, 3300.0)]
ALPHAS_ACTIVE = [21.8, 24.0, 26.0, 27.8, 31.4]


def _plan_one(args):
    g, blocked, gx, gy, active, alpha = args
    return P.plan(g, blocked, gx, gy, active, alpha)


def plan_many(g, blocked, specs, threads=6):
    """specs: list of (x, y, band_active, alpha). The numba planner releases the GIL."""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(threads) as ex:
        return list(ex.map(_plan_one, [(g, blocked, x, y, a, al) for (x, y, a, al) in specs]))


def choose_goals(g, blocked, n_random=30, seed=1234):
    """Terrain shelters (default threshold) + the app's habitat / rover positions + random walkable cells
    spread over the map (one per block of a jittered grid, inside the main reachable region)."""
    n = g["n"]
    rng = np.random.default_rng(seed)
    goals = [(nm, x, y) for nm, x, y in DEMO_GOALS]
    for k, s in enumerate(P.find_terrain_shelters(g, blocked)):
        if all(math.hypot(s["x"] - x, s["y"] - y) > 15 for _, x, y in goals):
            goals.append(("T%d" % k, s["x"], s["y"]))
    ref = P.plan(g, blocked, 1700.0, 2600.0, False, 27.8)
    reach = np.isfinite(ref["cost"]).reshape(n, n)
    side = int(math.ceil(math.sqrt(n_random)))
    blk = n // side
    cand = []
    for bi in range(side):
        for bj in range(side):
            ii, jj = np.nonzero(reach[bi * blk:(bi + 1) * blk, bj * blk:(bj + 1) * blk])
            if len(ii) < 200: continue
            q = rng.integers(len(ii))
            cand.append(((bi * blk + ii[q] + 0.5) * CELL, (bj * blk + jj[q] + 0.5) * CELL))
    rng.shuffle(cand)
    for k, (yy, xx) in enumerate(cand[:n_random]):
        goals.append(("W%d" % k, float(xx), float(yy)))
    return goals


def sample_starts(time_field, blocked, rng, n_starts=2048, t_lo=180.0, t_hi=5400.0, bins=29):
    """Start cells with planned time in [t_lo, t_hi], drawn roughly uniformly in planned time."""
    ok = np.isfinite(time_field) & (time_field >= t_lo) & (time_field <= t_hi) & (blocked == 0)
    idx = np.nonzero(ok)[0]
    if len(idx) < 500:
        return None
    b = np.minimum(((time_field[idx] - t_lo) / (t_hi - t_lo) * bins).astype(np.int64), bins - 1)
    cnt = np.bincount(b, minlength=bins)
    w = 1.0 / cnt[b]
    return rng.choice(idx, size=n_starts, replace=True, p=w / w.sum())


def build_bank(g, blocked, device, n_random=30, seed=1234, n_starts=2048, hazards=None, goals=None, threads=6, verbose=True):
    """Training / evaluation bank: goals x hazard states {standing (alpha default), active x ALPHAS_ACTIVE}."""
    import time as _t
    t0 = _t.time()
    if goals is None:
        goals = choose_goals(g, blocked, n_random, seed)
    if hazards is None:
        hazards = [(False, 27.8)] + [(True, a) for a in ALPHAS_ACTIVE]
    specs = [(x, y, act, al) for (_, x, y) in goals for (act, al) in hazards]
    names = ["%s|%s%.1f" % (nm, "act" if act else "std", al) for (nm, _, _) in goals for (act, al) in hazards]
    fields = plan_many(g, blocked, specs, threads)
    rng = np.random.default_rng(seed + 1)
    keep, starts = [], []
    for k, f in enumerate(fields):
        s = sample_starts(f["time"], blocked, rng, n_starts)
        if s is not None:
            keep.append(k); starts.append(s)
    bank = FieldBank([fields[k] for k in keep], [(specs[k][0], specs[k][1]) for k in keep], [specs[k][2] for k in keep],
                     [specs[k][3] for k in keep], device, g["n"], starts=np.stack(starts), names=[names[k] for k in keep])
    if verbose:
        print("bank: %d goals x %d hazard states -> %d fields kept (%d dropped), %.1f s, %.2f GB on device" % (
            len(goals), len(hazards), len(keep), len(fields) - len(keep), _t.time() - t0,
            (bank.ct.numel() * 4 + bank.codes.numel()) / 1e9), flush=True)
    return bank, goals


def make_world(device, dtype=torch.float32):
    from terrain import load_grid
    g, meta = load_grid()
    keep, blocked = P.statics(g)
    return g, blocked, Terrain(g, blocked, device, dtype)
