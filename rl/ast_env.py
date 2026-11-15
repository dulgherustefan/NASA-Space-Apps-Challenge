"""Adaptive Stress Testing environment (Lee et al., JAIR 2020) around WalkEnv.

System under test: one suited walker that follows the planner's field to a shelter at the planned pace
(rl/env.py baseline_action), on the candidate routes of a scripted incident. The adversary controls the
disturbance channels of docs/research/U2_rl_design.md section 9.2 and the wrapper keeps the log-likelihood
of every disturbance under its nominal distribution:

  episode (first step)   z_eff, z_cool, z_nav_x, z_nav_y ~ N(0, 1), clipped to +/-3
                           metabolic multiplier exp(0.12 z), cooling multiplier max(0.65, 1 - 0.117 z),
                           navigation offset 53 m * (z_x, z_y), fading out inside the last 200 m
  every 10 s step        z_v ~ N(0, 1), clipped: pace multiplier exp(0.08 z)
                         stumble ~ Bernoulli(pFall), injury given a stumble ~ Bernoulli(pInj), where pFall and
                         pInj are the simulator's own probabilities for that step

  log p = -0.5 * sum(z^2) + sum(log pFall or log(1 - pFall)) + sum(log pInj or log(1 - pInj))
  (Gaussian constants dropped, so the undisturbed walk has log p = 0)

Crew protocol added by this wrapper (part of the system under test, not a disturbance): after a move that is
blocked, or after 90 s without getting closer to the goal in planned time, the walker re-localises (the navigation offset is cleared) and, for the rest of that leg, follows the
planner's own cell-to-cell path from where it stands (pursuit of the pointer chain, 7.5 m look-ahead). On that
path the planner's checks apply (20 degrees between cell centres, no impassable cell on the chain) instead of the
walker's 5 m look-ahead check; speed and fall risk still follow the slope. On ground the plan does not cover (no
planner pointer in that cell) it first walks back to its last on-plan position. Without this rule the field
follower freezes or oscillates where its look-ahead check disagrees with the planner, which is a simulator
artefact and not a crew failure (the engine's walker follows the drawn polyline and has a similar fallback).

Failure definitions (team assumptions): see FAILURE_DEFS. All numbers are model-based, not crew-validated.
"""
import json
import math
import os

import numpy as np
import torch

import planner as P
import env as E
from env import (WalkEnv, FieldBank, baseline_action, make_world, DT, SUB, PACES, MET_B, MET_C, MET_REST, ETA_UP, K_DOWN,
                 O2_KG_PER_J, O2_TANK_KG, O2_NOMINAL_W, K_ROUGH, K_SAND_MET, FALL_SLOPE_REF, FALL_T_MIN, FALL_T_MAX,
                 MOVE_LOOK, STUCK_STEPS, T_MAX, ARRIVE_R, DUST_SLOW, DUST_FALL,
                 WALKING, ARRIVED, INCAPACITATED, HEAT, O2OUT, TIMEOUT, STUCK)
from terrain import ROOT

RUNS = os.path.join(ROOT, "rl", "runs", "ast")
CASES_FILE = os.path.join(RUNS, "engine_cases.json")
SCEN_IDS = {"S1": "sep-1", "S2": "quake-1", "S3": "sci-1"}

SIG = dict(cool=0.117, eff=0.12, nav=53.0, pace=0.08)       # U2 section 9.2
COOL_FLOOR = 0.65
Z_CLIP = 3.0
NAV_DECAY_M = 200.0
CHAIN_LOOK_M = 7.5                                          # pursuit look-ahead on the planner's pointer chain
R_E = 100.0
BIG = 40.0
O2_RESERVE_MIN = 60.0
O2_W = O2_NOMINAL_W * O2_KG_PER_J                           # kg/s at the nominal 300 W
CLASSES = ["fall", "heat", "oxygen", "late", "stuck"]       # failure codes 1..5 (0 = no failure)
OK, F_FALL, F_HEAT, F_O2, F_LATE, F_STUCK = range(6)
N_AOBS = E.N_OBS + 12

FAILURE_DEFS = [
    "Incapacitating fall (simulator fall and injury probabilities; base rate 0.15 per km is a team assumption).",
    "Stored heat at or above 844 kJ (params.ts heatMaxKJ).",
    "O2 exhausted, or below the 60-minute reserve on arrival.",
    "With a solar storm active: not under cover when the shelter rule runs out (30 min from the alert, alert-to-first-step "
    "time included); when no open shelter can meet that rule any more, not under cover at the expected dose-rate peak "
    "(53 min after the alert).",
    "Stuck (no legal move for 3 min) or not arrived after 3 h.",
]
ASSUMPTIONS = [
    "Fall base rate 0.15 per km on easy ground: team assumption (Apollo fall counts have no distance denominator).",
    "Chance that a fall is incapacitating 0.01 x (1 + v / 0.65) x 1.5 downhill, capped at 0.3: team assumption.",
    "Suit cooling multiplier 1 - 0.117 z, floor 0.65 (380 W, NTRS 20160001058): assumed distribution.",
    "Metabolic multiplier exp(0.12 z), x0.70 to x1.43: assumed distribution.",
    "Navigation offset sigma 53 m (3 sigma = 160 m, JETT3 mean position error), fading out in the last 200 m: assumed distribution.",
    "Pace drift exp(0.08 z) per 10 s step: assumed distribution.",
    "All z are standard normal, clipped to +/-3. Robustness in nats is a likelihood ratio under these assumed "
    "distributions, not a probability.",
    "Model-based results from one walk model on one site; not crew-validated.",
]
WORDING = ("Adaptive Stress Testing (Lee et al., 2020) uses reinforcement learning to search a simulator for the most likely "
           "failure. We apply it to a physics-based walk model with documented bounds. Results are model-based, not crew-validated.")


def wilson(k, n, z=1.96):
    if n <= 0:
        return [0.0, 1.0]
    p = k / n
    den = 1 + z * z / n
    mid = (p + z * z / (2 * n)) / den
    hw = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [max(0.0, mid - hw), min(1.0, mid + hw)]


# ---------------------------------------------------------------------------------------------- cases
class Case:
    """One scripted incident: the candidate routes the engine planned, as planner fields on the device."""

    def __init__(self, scenario, device, cases_file=CASES_FILE, world=None):
        with open(cases_file, encoding="utf8") as f:
            doc = json.load(f)
        self.scenario = scenario
        self.incident = SCEN_IDS[scenario]
        blk = doc[self.incident]
        self.ctx = blk["ctx"]
        self.routes = blk["routes"]
        self.core = doc["core"]
        self.g, self.blocked, self.T = world if world is not None else make_world(device)
        self.device = device
        alpha = float(self.ctx.get("alpha", 27.8))
        keys, fields, goals = [], [], []
        legs = []
        for r in self.routes:
            row = []
            for leg in r["legs"]:
                key = (round(leg["goal"][0], 2), round(leg["goal"][1], 2), bool(leg["band_weights"]))
                if key not in keys:
                    keys.append(key)
                    fields.append(P.plan(self.g, self.blocked, leg["goal"][0], leg["goal"][1], bool(leg["band_weights"]), alpha))
                    goals.append((leg["goal"][0], leg["goal"][1]))
                row.append(keys.index(key))
            legs.append(row)
        self.fields = fields
        self.bank = FieldBank(fields, goals, [bool(self.ctx["band_active"])] * len(fields), [alpha] * len(fields), device,
                              self.g["n"])
        R = len(self.routes)
        dl = self.ctx["deadline_peak"] if self.ctx.get("late_basis") == "peak" else self.ctx["deadline_walk"]
        self.deadline = float("inf") if dl is None else float(dl)
        self.late_basis = self.ctx.get("late_basis") or ("rule" if math.isfinite(self.deadline) else None)
        t = lambda v, dt=torch.float32: torch.as_tensor(np.asarray(v), device=device).to(dt)
        self.r_leg = t([[row[0], row[-1]] for row in legs], torch.long)
        self.r_nleg = t([len(row) for row in legs], torch.long)
        self.r_sx = t([r["start"][0] for r in self.routes])
        self.r_sy = t([r["start"][1] for r in self.routes])
        pace = float(self.ctx["pace"])
        self.pk = int(np.argmin([abs(pace - p) for p in PACES]))
        self.heat0 = float(self.ctx["heat0"])
        self.o2kg = float(self.ctx["o2_frac"]) * O2_TANK_KG
        self.sep0 = float(self.ctx["sep_elapsed0"])
        self.R = R
        self.nominal = None

    def route_name(self, k):
        r = self.routes[k]
        return "%s route %d (%s)" % (self.scenario, r["id"], r["label"])


# ---------------------------------------------------------------------------------------------- environment
class ASTEnv(WalkEnv):
    """n walkers on fixed routes with disturbance hooks and likelihood bookkeeping.

    mode "mc": terrain-noise seed and fall recovery time are sampled (plain Monte Carlo).
    mode "adv": both are fixed at their nominal values (seed 0, 40 s), so a disturbance sequence replays exactly.
    """

    def __init__(self, case, n, seed=0, falls_terminal=True, sig_scale=1.0, mode="adv", record=False):
        super().__init__(case.T, case.bank, n, seed=seed, auto_reset=False)
        self.case = case
        self.falls_terminal = bool(falls_terminal)
        self.sig_scale = float(sig_scale)
        self.mode = mode
        dev, dt = self.device, self.dtype
        z = lambda: torch.zeros(n, device=dev, dtype=dt)
        self.offx, self.offy = z(), z()
        self.good_x, self.good_y = z(), z()
        self.rescue = torch.zeros(n, device=dev, dtype=torch.bool)
        self.lattice = torch.zeros(n, device=dev, dtype=torch.bool)
        self.tgt_x, self.tgt_y = z(), z()
        self.best_tt = z() + math.inf
        self.stall = torch.zeros(n, device=dev, dtype=torch.long)
        self.rescue_on = bool(getattr(case, "rescue", True))
        self.rid = torch.zeros(n, device=dev, dtype=torch.long)
        self.leg = torch.zeros(n, device=dev, dtype=torch.long)
        self.done = torch.zeros(n, device=dev, dtype=torch.bool)
        self.fail = torch.zeros(n, device=dev, dtype=torch.long)
        self.first = torch.ones(n, device=dev, dtype=torch.bool)
        self.logp = torch.zeros(n, device=dev, dtype=torch.float64)
        self.stress = z()
        self.fx, self.fy, self.ft = z(), z(), z()
        self.t_first_fall = z() - 1
        self.s_pFall, self.s_pInj = z(), z()
        self.s_fell = torch.zeros(n, device=dev, dtype=torch.bool)
        self.s_inj = torch.zeros(n, device=dev, dtype=torch.bool)
        self.s_can = torch.zeros(n, device=dev, dtype=torch.bool)
        self.s_lp = torch.zeros(n, device=dev, dtype=torch.float64)
        self.z_setup = torch.zeros((n, 4), device=dev, dtype=dt)
        self.steps_done = 0
        self.record = record
        self.rec = []
        self.o2_reserve_kg = O2_RESERVE_MIN * 60.0 * O2_W
        self.deadline_v = case.deadline

    # ------------------------------------------------------------------ episode start
    def reset_routes(self, rid=None, mask=None):
        """Put the walkers in `mask` (all if None) at the start of their route, undisturbed."""
        c, n, dev, dt, p = self.case, self.n, self.device, self.dtype, self.p
        if rid is not None:
            rid = rid.to(dev).long() if torch.is_tensor(rid) else torch.full((n,), int(rid), device=dev, dtype=torch.long)
            self.rid = rid if mask is None else torch.where(mask, rid, self.rid)
        rid = self.rid
        zero = torch.zeros(n, device=dev, dtype=dt); zl = torch.zeros(n, device=dev, dtype=torch.long)
        fidx = c.r_leg[rid, 0]
        if self.mode == "mc":
            tseed = torch.rand(n, generator=self.gen, device=dev, dtype=dt) * 1000
        else:
            tseed = zero
        new = dict(x=c.r_sx[rid].to(dt), y=c.r_sy[rid].to(dt), t=zero, heat=zero + c.heat0, o2=zero + c.o2kg, dose=zero,
                   fallTimer=zero, falls=zl, blockedRun=zl, bandSec=zero, dist=zero, heatPeak=zero + c.heat0, status=zl,
                   lastV=zero, effM=zero + 1, cool=zero + 1, vmul=zero + 1, react=zero, seed=tseed, fidx=fidx,
                   goal_x=self.B.goal_x[fidx].to(dt), goal_y=self.B.goal_y[fidx].to(dt), sep_el=zero + c.sep0,
                   deadline=zero + c.deadline, terr_err=zero + 0.25, dust=zero, band_active=self.B.band_active[fidx],
                   alpha=self.B.alpha[fidx].to(dt), fallPerKm=zero + p["fallPerKm"], coolW=zero + p["coolW"],
                   offx=zero, offy=zero, good_x=c.r_sx[rid].to(dt), good_y=c.r_sy[rid].to(dt),
                   rescue=torch.zeros(n, device=dev, dtype=torch.bool),
                   lattice=torch.zeros(n, device=dev, dtype=torch.bool), tgt_x=zero, tgt_y=zero, best_tt=zero + math.inf, stall=zl, leg=zl, done=torch.zeros(n, device=dev, dtype=torch.bool), fail=zl,
                   first=torch.ones(n, device=dev, dtype=torch.bool), logp=torch.zeros(n, device=dev, dtype=torch.float64),
                   stress=zero, fx=zero, fy=zero, ft=zero, t_first_fall=zero - 1, s_pFall=zero, s_pInj=zero,
                   z_setup=torch.zeros((n, 4), device=dev, dtype=dt))
        for k_, v_ in new.items():
            if mask is None:
                setattr(self, k_, v_)
            else:
                m = mask if v_.dim() == 1 else mask[:, None]
                setattr(self, k_, torch.where(m, v_, getattr(self, k_)))

    def setup(self, z, mask=None):
        """Episode disturbances z [n, 4] = (eff, cool, nav_x, nav_y). Returns their log-likelihood [n] (float64)."""
        z = z.clamp(-Z_CLIP, Z_CLIP).to(self.dtype)
        s = self.sig_scale
        effM = torch.exp(SIG["eff"] * s * z[:, 0])
        cool = (1 - SIG["cool"] * s * z[:, 1]).clamp_min(COOL_FLOOR)
        offx = SIG["nav"] * s * z[:, 2]; offy = SIG["nav"] * s * z[:, 3]
        lp = -0.5 * (z.double() ** 2).sum(1)
        if mask is None:
            self.effM, self.cool, self.offx, self.offy, self.z_setup = effM, cool, offx, offy, z
            self.logp = self.logp + lp
        else:
            self.effM = torch.where(mask, effM, self.effM); self.cool = torch.where(mask, cool, self.cool)
            self.offx = torch.where(mask, offx, self.offx); self.offy = torch.where(mask, offy, self.offy)
            self.z_setup = torch.where(mask[:, None], z, self.z_setup)
            self.logp = self.logp + torch.where(mask, lp, torch.zeros_like(lp))
            lp = torch.where(mask, lp, torch.zeros_like(lp))
        return lp

    # ------------------------------------------------------------------ hooks
    def _guidance(self, x, y, c, ok, base):
        """Planner guidance at the position the crew believes it is at (navigation offset, fading near the goal)."""
        dgx = self.goal_x - x; dgy = self.goal_y - y
        dg = torch.hypot(dgx, dgy)
        f = (dg / NAV_DECAY_M).clamp(max=1.0)
        cb, okb = self.T.cell_at(x + self.offx * f, y + self.offy * f)
        code = self.B.codes[base + cb, 1].long()
        g = self.B.lut[code].to(self.dtype)
        gx = torch.where(okb, g[:, 0], torch.zeros_like(x)); gy = torch.where(okb, g[:, 1], torch.zeros_like(x))
        zero = (gx == 0) & (gy == 0)
        l = torch.where(dg == 0, torch.ones_like(dg), dg)
        gx = torch.where(zero, dgx / l, gx); gy = torch.where(zero, dgy / l, gy)
        if self.rescue_on:
            # after a blocked move: pursue the planner's pointer chain (target kept in tgt_x, tgt_y)
            tx = self.tgt_x - x; ty = self.tgt_y - y
            tl = torch.hypot(tx, ty)
            use = self.lattice & (tl > 0.05)
            tl = tl.clamp_min(0.05)
            gx = torch.where(use, tx / tl, gx); gy = torch.where(use, ty / tl, gy)
            rx = self.good_x - x; ry = self.good_y - y
            rl = torch.hypot(rx, ry)
            back = self.rescue & (rl > 0.5)
            rl = rl.clamp_min(0.5)
            gx = torch.where(back, rx / rl, gx); gy = torch.where(back, ry / rl, gy)
        return gx, gy

    def step_dynamics(self, hk, pk, u1, u2, u3, active=None, d_fall=None, d_inj=None):
        """WalkEnv.step_dynamics with three additions: the stumble and injury draws can be tilted (d_fall, d_inj are
        logit offsets; +BIG forces, -BIG suppresses), their nominal probabilities and log-likelihood are kept, and a
        blocked move clears the navigation offset (the crew re-localises). With d_fall = d_inj = None and no offset it
        reproduces the parent step exactly (checked in ast_mc.py --smoke)."""
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
        # on the planner's cell-to-cell path the planner's checks apply, not the look-ahead ones; walking back to the
        # last on-plan position retraces ground the walker has just crossed
        lat = self.lattice | self.rescue
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
            k = B.codes[base + c, 0].long()
            has = okc & (k != P.NEXT_NONE)
            kk = torch.where(has, k, torch.full_like(k, 16))
            ti = torch.div(c, n_, rounding_mode="floor") + B.nb_di[kk]
            tj = c % n_ + B.nb_dj[kk]
            ex = (tj.to(dt) + 0.5) * E.CELL - x; ey = (ti.to(dt) + 0.5) * E.CELL - y
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
            bad1 = (~oks[:, 0]) | ((blk[:, 0] | (grade.abs() > tanHard)) & ~lat)
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
            hazard = hazard + lam * veff * dtS
            dist = dist + veff * dtS
            lastV = torch.where(mv, veff, lastV)
            downhill = torch.where(mv, dh, downhill)
            Msum = Msum + torch.where(mv, Mm, rest)
        blockedRun = torch.where(moving, torch.where(wasBlocked & (lastV == 0), self.blockedRun + 1, torch.zeros_like(self.blockedRun)),
                                 self.blockedRun)
        # falls (hooked)
        pFall = -torch.expm1(-hazard)
        can = moving & (pFall > 0)
        if d_fall is None:
            q = pFall
        else:
            q = torch.sigmoid(torch.logit(pFall.double().clamp(1e-12, 1 - 1e-9)) + d_fall.double()).to(dt)
        fell = can & (u1 < q)
        falls = self.falls + fell.long()
        fallTimer = torch.where(fell, FALL_T_MIN + u3 * (FALL_T_MAX - FALL_T_MIN), fallTimer)
        pInj = (p["fallInjuryP"] * (1 + lastV / 0.65) * torch.where(downhill, 1.5 * one, one)).clamp(max=0.3)
        if d_inj is None:
            qi = pInj
        else:
            qi = torch.sigmoid(torch.logit(pInj.double().clamp(1e-12, 1 - 1e-9)) + d_inj.double()).to(dt)
        if self.falls_terminal:
            inj = fell & (u2 < qi)
        else:
            inj = torch.zeros_like(fell)
        incap = inj
        pF = pFall.double().clamp(1e-12, 1 - 1e-9); pI = pInj.double().clamp(1e-12, 1 - 1e-9)
        z64 = torch.zeros_like(pF)
        lp = torch.where(can, torch.where(fell, pF.log(), torch.log1p(-pF)), z64)
        if self.falls_terminal:
            lp = lp + torch.where(fell, torch.where(inj, pI.log(), torch.log1p(-pI)), z64)
        Msum = torch.where(in_fall, 250 * self.effM * SUB, torch.where(in_react, rest * SUB, Msum))
        Mavg = Msum / SUB
        r32 = self.round32
        heat = r32((self.heat + (Mavg - self.cool * self.coolW) * DT / 1000).clamp_min(0))
        heatPeak = torch.maximum(self.heatPeak, heat)
        o2 = r32(self.o2 - Mavg * DT * O2_KG_PER_J)
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
        offx = torch.where(wasBlocked, zero, self.offx); offy = torch.where(wasBlocked, zero, self.offy)
        new = dict(x=r32(x), y=r32(y), t=t, heat=heat, o2=o2, dose=dose, fallTimer=r32(fallTimer), falls=falls,
                   blockedRun=blockedRun, bandSec=bandSec, dist=r32(dist), heatPeak=heatPeak, status=st, lastV=r32(lastV),
                   offx=offx, offy=offy, s_pFall=pFall, s_pInj=pInj)
        if active is None:
            for k_, v_ in new.items(): setattr(self, k_, v_)
            self.s_fell, self.s_inj, self.s_can, self.s_lp = fell, inj, can, lp
        else:
            for k_, v_ in new.items(): setattr(self, k_, torch.where(active, v_, getattr(self, k_)))
            self.s_fell, self.s_inj, self.s_can = fell & active, inj & active, can & active
            self.s_lp = torch.where(active, lp, z64)
        return dict(fell=fell, blocked=wasBlocked, progress=progress, doseInc=dInc, met=Mavg, in_band=in_band, sep_on=sep_on,
                    time0=torch.where(ok00, ct00[:, 1].to(dt), inf), time1=torch.where(ok1, ct1[:, 1].to(dt), inf))

    # ------------------------------------------------------------------ one adversary step
    def ast_step(self, z_v=None, d_fall=None, d_inj=None, obs=None):
        """Advance the walkers that are not done. z_v: pace-drift z [n] or None (no drift). d_fall, d_inj: logit
        tilts or None (nominal draws). Returns (log-likelihood of this step's disturbances [n] float64, newly done)."""
        c, p, dt = self.case, self.p, self.dtype
        act = ~self.done
        o = self.observe() if obs is None else obs
        hk, _ = baseline_action(o)
        hk = torch.where(self.rescue | self.lattice, torch.full_like(hk, 2), hk)
        pk = torch.full_like(hk, c.pk)
        lp = torch.zeros(self.n, device=self.device, dtype=torch.float64)
        if z_v is not None:
            zv = z_v.clamp(-Z_CLIP, Z_CLIP).to(dt)
            self.vmul = torch.exp(SIG["pace"] * self.sig_scale * zv)
            lp = lp - 0.5 * zv.double() ** 2
        else:
            self.vmul = torch.ones_like(self.x)
        if self.mode == "mc":
            u = torch.rand((3, self.n), generator=self.gen, device=self.device, dtype=dt)
            u1, u2, u3 = u[0], u[1], u[2]
        else:
            u = torch.rand((2, self.n), generator=self.gen, device=self.device, dtype=dt)
            u1, u2, u3 = u[0], u[1], torch.full_like(u[0], 0.5)
        self.step_dynamics(hk, pk, u1, u2, u3, active=act, d_fall=d_fall, d_inj=d_inj)
        lp = torch.where(act, lp + self.s_lp, torch.zeros_like(lp))
        self.logp = self.logp + lp
        self.t_first_fall = torch.where(self.s_fell & (self.t_first_fall < 0), self.t - DT, self.t_first_fall)
        self.first = self.first & ~act
        # next leg of an out-and-back route
        arr = act & (self.status == ARRIVED)
        more = arr & (self.leg + 1 < c.r_nleg[self.rid])
        if bool(more.any()):
            self.leg = torch.where(more, self.leg + 1, self.leg)
            fidx = c.r_leg[self.rid, 1]
            self.fidx = torch.where(more, fidx, self.fidx)
            self.goal_x = torch.where(more, self.B.goal_x[fidx].to(dt), self.goal_x)
            self.goal_y = torch.where(more, self.B.goal_y[fidx].to(dt), self.goal_y)
            self.status = torch.where(more, torch.zeros_like(self.status), self.status)
            self.lattice = self.lattice & ~more
            self.best_tt = torch.where(more, torch.full_like(self.best_tt, math.inf), self.best_tt)
            self.stall = torch.where(more, torch.zeros_like(self.stall), self.stall)
            arr = arr & ~more
        st = self.status
        fail = torch.zeros_like(self.fail)
        walking = act & (st == WALKING)
        fail = torch.where(walking & (self.t >= self.deadline), torch.full_like(fail, F_LATE), fail)
        fail = torch.where(arr & (self.o2 < self.o2_reserve_kg), torch.full_like(fail, F_O2), fail)
        fail = torch.where(arr & (self.t > self.deadline), torch.full_like(fail, F_LATE), fail)
        tout = act & (st == TIMEOUT)
        fail = torch.where(tout, torch.full_like(fail, F_LATE if math.isfinite(c.deadline) else F_STUCK), fail)
        fail = torch.where(act & (st == STUCK), torch.full_like(fail, F_STUCK), fail)
        fail = torch.where(act & (st == O2OUT), torch.full_like(fail, F_O2), fail)
        fail = torch.where(act & (st == HEAT), torch.full_like(fail, F_HEAT), fail)
        fail = torch.where(act & (st == INCAPACITATED), torch.full_like(fail, F_FALL), fail)
        newly = act & ((fail > 0) | arr)
        self.fail = torch.where(newly, fail, self.fail)
        self.fx = torch.where(newly, self.x, self.fx); self.fy = torch.where(newly, self.y, self.fy)
        self.ft = torch.where(newly, self.t, self.ft)
        # how close the walk came to a failure (0..1), for the miss distance of non-failing episodes
        s = torch.maximum(self.heat / p["heatMaxKJ"], ((c.o2kg - self.o2) / max(c.o2kg - self.o2_reserve_kg, 1e-6)).clamp(0, 1))
        if math.isfinite(c.deadline):
            tt = B_time(self)
            s = torch.maximum(s, ((self.t + tt) / c.deadline).clamp(0, 1.5) / 1.5)
        self.stress = torch.where(act, torch.maximum(self.stress, s.to(dt)), self.stress)
        self.done = self.done | newly
        self.steps_done += int(act.sum())
        self.update_rescue()
        if self.record:
            self.rec.append(torch.stack([self.t, self.x, self.y, self.heat, self.o2, self.dose, self.falls.to(dt),
                                         self.status.to(dt), self.fail.to(dt), self.done.to(dt), self.s_fell.to(dt),
                                         self.s_inj.to(dt), self.s_pFall, self.s_pInj, self.vmul, act.to(dt)], 1).cpu())
        return lp, newly

    def update_rescue(self):
        """Crew protocol after a blocked move or on ground the plan does not cover (see the module docstring)."""
        if not self.rescue_on:
            return
        T, B, dt = self.T, self.B, self.dtype
        base = self.fidx * T.N
        c0, ok0 = T.cell_at(self.x, self.y)
        tt = B.ct[base + c0, 1].to(dt)
        on = ok0 & torch.isfinite(tt)
        closer = on & (tt < self.best_tt - 1.0)
        self.best_tt = torch.where(closer, tt, self.best_tt)
        self.stall = torch.where(closer, torch.zeros_like(self.stall), self.stall + 1)
        start = on & ~self.lattice & ((self.blockedRun >= 1) | self.rescue | (self.stall >= 9))
        n_ = T.n
        cx = (c0 % n_).to(dt) * E.CELL + 2.5; cy = torch.div(c0, n_, rounding_mode="floor").to(dt) * E.CELL + 2.5
        self.tgt_x = torch.where(start, cx, self.tgt_x); self.tgt_y = torch.where(start, cy, self.tgt_y)
        self.lattice = self.lattice | start
        self.good_x = torch.where(on, self.x, self.good_x); self.good_y = torch.where(on, self.y, self.good_y)
        self.rescue = ~on & ~self.lattice
        zero = torch.zeros_like(self.offx)
        clear = self.rescue | self.lattice
        self.offx = torch.where(clear, zero, self.offx); self.offy = torch.where(clear, zero, self.offy)
        for _ in range(4):                                   # move the pursuit target down the pointer chain
            reach = self.lattice & (torch.hypot(self.tgt_x - self.x, self.tgt_y - self.y) < CHAIN_LOOK_M)
            ct, okt = T.cell_at(self.tgt_x, self.tgt_y)
            k = B.codes[base + ct, 0].long()
            adv = reach & okt & (k != P.NEXT_NONE)
            kk = torch.where(adv, k, torch.full_like(k, 16))
            self.tgt_x = self.tgt_x + B.nb_dj[kk].to(dt) * E.CELL; self.tgt_y = self.tgt_y + B.nb_di[kk].to(dt) * E.CELL

    def miss_distance(self):
        return (1 - self.stress.clamp(0, 1)).double()

    def adv_obs(self, o):
        """Adversary observation: the walker's 44 floats plus the disturbance state."""
        c, p, dt = self.case, self.p, self.dtype
        tt = B_time(self)
        dl = c.deadline if math.isfinite(c.deadline) else 3 * 3600.0
        ex = torch.stack([
            self.heat / p["heatMaxKJ"],
            (self.t / dl).clamp(0, 2),
            ((dl - self.t - tt) / 600).clamp(-3, 3) / 3 if math.isfinite(c.deadline) else torch.zeros_like(self.x),
            (torch.log10(self.s_pFall.clamp_min(1e-6)) + 6) / 6,
            self.s_pInj / 0.3,
            self.fallTimer / 60,
            self.falls.clamp(max=10).to(dt) / 10,
            self.offx / 160, self.offy / 160,
            self.first.to(dt),
            self.leg.to(dt),
            (self.lastV / 1.3),
        ], 1)
        return torch.cat([o, ex.float()], 1)


def B_time(env):
    """Planner time-to-go (s) on the current leg, 7200 where the field has none."""
    c0, ok0 = env.T.cell_at(env.x, env.y)
    tt = env.B.ct[env.fidx * env.T.N + c0, 1].to(env.dtype)
    return torch.where(ok0 & torch.isfinite(tt), tt, torch.full_like(tt, 7200.0))


# ---------------------------------------------------------------------------------------------- rollouts
def run_episode(env, actor=None, max_steps=None):
    """Run until every walker is done. actor(env, obs, k) -> (z_v, d_fall, d_inj) or None for an undisturbed walk."""
    k = 0
    max_steps = max_steps or int(T_MAX / DT) * 2 + 4
    while not bool(env.done.all()) and k < max_steps:
        o = env.observe()
        if actor is None:
            env.ast_step(obs=o)
        else:
            zv, df, di = actor(env, o, k)
            env.ast_step(zv, df, di, obs=o)
        k += 1
    return k


def nominal_runs(case, falls_terminal=True):
    """Undisturbed walker per route, with stumbles suppressed (the expected walk). Returns a list of dicts."""
    env = ASTEnv(case, case.R, seed=0, falls_terminal=falls_terminal, mode="adv", record=True)
    env.reset_routes(torch.arange(case.R, device=case.device))
    neg = torch.full((case.R,), -BIG, device=case.device)
    run_episode(env, lambda e, o, k: (None, neg, neg))
    rec = torch.stack(env.rec, 0).numpy()                         # [steps, R, cols]
    out = []
    for r in range(case.R):
        steps = int(rec[:, r, 15].sum())
        tr = rec[:steps, r]
        f = int(env.fail[r])
        o2_min = float(env.o2[r]) / O2_W / 60.0
        out.append(dict(route=case.routes[r]["id"], arrived=bool(int(env.status[r]) == ARRIVED and f == OK),
                        failure=None if f == OK else CLASSES[f - 1], time_s=float(env.t[r]), dist_m=float(env.dist[r]),
                        heat_peak_kj=float(env.heatPeak[r]), heat_margin=1 - float(env.heatPeak[r]) / env.p["heatMaxKJ"],
                        o2_frac=float(env.o2[r]) / O2_TANK_KG, o2_reserve_min=o2_min, dose_ugy=float(env.dose[r]),
                        log_p=float(env.logp[r]),
                        slack_s=(case.deadline - float(env.t[r])) if math.isfinite(case.deadline) else None,
                        track=tr[:, :8].astype(np.float32)))
    return out


def feasible(nom):
    """A route is scored only if its undisturbed walker arrives with reserve."""
    return bool(nom["arrived"])
