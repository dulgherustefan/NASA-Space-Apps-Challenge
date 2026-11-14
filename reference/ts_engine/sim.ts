// Virtual-crew simulation: a suited walker on the real terrain grid, with Mars gravity, suit thermal
// limits, oxygen, falls, radiation dose and rockfall-band exposure.
// THIS FILE IS THE REFERENCE MODEL. rl/env.py mirrors it tensor-for-tensor for training
// (see rl/SPEC.md); keep the two in sync.

import { SIM, type Params } from './params'
import { speedFactor, type Field, type Grid, type HazardState } from './planner'

// ----------------------------------------------------------------------------- RNG
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r())

// ----------------------------------------------------------------------------- solar particle event
/** Idealised SEP dose-rate profile (µGy/h, unshielded) tau seconds after onset. */
export function sepRate(tauS: number, p: Params): number {
  if (tauS <= 0) return 0
  const tp = p.sepPeakMin * 60, td = p.sepDecayH * 3600
  const peak = p.sepTotal / ((tp / 2 + td) / 3600)
  return tauS < tp ? peak * tauS / tp : peak * Math.exp(-(tauS - tp) / td)
}
export function sepPeakRate(p: Params) { return p.sepTotal / ((p.sepPeakMin * 60 / 2 + p.sepDecayH * 3600) / 3600) }
/** Integral of the unshielded SEP dose (µGy) between two times after onset. */
export function sepDose(t0: number, t1: number, p: Params): number {
  const tp = p.sepPeakMin * 60, td = p.sepDecayH * 3600, peak = sepPeakRate(p) / 3600   // µGy/s
  const F = (t: number) => t <= 0 ? 0 : t < tp ? peak * t * t / (2 * tp) : peak * tp / 2 + peak * td * (1 - Math.exp(-(t - tp) / td))
  return F(t1) - F(t0)
}

// ----------------------------------------------------------------------------- environment
export interface SimEnv {
  grid: Grid
  blocked: Uint8Array
  field: Field
  params: Params
  hz: HazardState
  goal: { x: number; y: number; shield: number }
  sepElapsedS: number        // seconds since SEP onset at simulation start; < 0 => no event
  deadlineS: number          // shelter rule deadline (s from simulation start); Infinity if none
  terrainError: number       // 0..1 amplitude of unmapped-terrain slowdown (0.25 default)
  dust: number               // 0 clear .. 1 dust storm (visibility)
}

export const STATUS = { WALKING: 0, ARRIVED: 1, INCAPACITATED: 2, HEAT: 3, O2: 4, TIMEOUT: 5, STUCK: 6 } as const
export const STATUS_LABEL = ['en route', 'arrived', 'fall injury', 'heat casualty', 'out of oxygen', 'timeout', 'stuck']

export interface Agents {
  n: number
  x: Float32Array; y: Float32Array; t: Float32Array
  heat: Float32Array; o2: Float32Array; dose: Float32Array
  effM: Float32Array; cool: Float32Array; vmul: Float32Array; react: Float32Array; seed: Float32Array
  fallTimer: Float32Array; falls: Uint16Array; blockedRun: Uint8Array
  bandSec: Float32Array; dist: Float32Array; heatPeak: Float32Array
  status: Uint8Array; tEnd: Float32Array
  lastV: Float32Array
}

export interface StartState { x: number; y: number; heat: number; o2: number; dose: number }

export function makeAgents(n: number, start: StartState, rng: () => number, spread = 4): Agents {
  const A: Agents = {
    n, x: new Float32Array(n), y: new Float32Array(n), t: new Float32Array(n),
    heat: new Float32Array(n), o2: new Float32Array(n), dose: new Float32Array(n),
    effM: new Float32Array(n), cool: new Float32Array(n), vmul: new Float32Array(n), react: new Float32Array(n), seed: new Float32Array(n),
    fallTimer: new Float32Array(n), falls: new Uint16Array(n), blockedRun: new Uint8Array(n),
    bandSec: new Float32Array(n), dist: new Float32Array(n), heatPeak: new Float32Array(n),
    status: new Uint8Array(n), tEnd: new Float32Array(n), lastV: new Float32Array(n),
  }
  for (let i = 0; i < n; i++) {
    A.x[i] = start.x + (rng() - 0.5) * spread
    A.y[i] = start.y + (rng() - 0.5) * spread
    A.heat[i] = Math.max(0, start.heat * (0.7 + 0.6 * rng()))
    A.o2[i] = start.o2 * (0.92 + 0.16 * rng())
    A.dose[i] = start.dose
    A.effM[i] = Math.min(1.45, Math.max(0.72, Math.exp(0.12 * gauss(rng))))      // metabolic cost multiplier
    A.cool[i] = Math.min(1.2, Math.max(0.75, 1 + 0.08 * gauss(rng)))             // suit cooling multiplier
    A.vmul[i] = Math.min(1.25, Math.max(0.75, 1 + 0.10 * gauss(rng)))            // pace capability
    A.react[i] = 20 + 70 * rng()                                                 // s before the crew starts moving
    A.seed[i] = rng() * 1000
  }
  return A
}

// ----------------------------------------------------------------------------- terrain access
function zAt(g: Grid, x: number, y: number): number {
  const n = g.n
  let fx = x / SIM.CELL - 0.5, fy = y / SIM.CELL - 0.5
  if (fx < 0) fx = 0; else if (fx > n - 1.001) fx = n - 1.001
  if (fy < 0) fy = 0; else if (fy > n - 1.001) fy = n - 1.001
  const j = fx | 0, i = fy | 0, tx = fx - j, ty = fy - i, k = i * n + j
  const z = g.z
  return (z[k] * (1 - tx) + z[k + 1] * tx) * (1 - ty) + (z[k + n] * (1 - tx) + z[k + n + 1] * tx) * ty
}
function cellAt(n: number, x: number, y: number): number {
  const j = Math.floor(x / SIM.CELL), i = Math.floor(y / SIM.CELL)
  if (i < 0 || i >= n || j < 0 || j >= n) return -1
  return i * n + j
}
function terrainNoise(seed: number, x: number, y: number): number {
  // smooth value noise, ~40 m wavelength, per-agent offset -> 0..1
  const fx = x / 40 + seed, fy = y / 40 + seed * 1.7
  const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy
  const h = (a: number, b: number) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s) }
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
  return (h(ix, iy) * (1 - sx) + h(ix + 1, iy) * sx) * (1 - sy) + (h(ix, iy + 1) * (1 - sx) + h(ix + 1, iy + 1) * sx) * sy
}

const COS = SIM.HEADINGS.map(d => Math.cos(d * Math.PI / 180))
const SIN = SIM.HEADINGS.map(d => Math.sin(d * Math.PI / 180))

/** Guidance direction (unit, x east / y south) at an agent position. */
function guidance(env: SimEnv, x: number, y: number, out: Float32Array) {
  const n = env.grid.n
  const c = cellAt(n, x, y)
  let gx = 0, gy = 0
  if (c >= 0) { gx = env.field.gx[c]; gy = env.field.gy[c] }
  if (gx === 0 && gy === 0) {
    const dx = env.goal.x - x, dy = env.goal.y - y, l = Math.hypot(dx, dy) || 1
    gx = dx / l; gy = dy / l
  }
  out[0] = gx; out[1] = gy
}

const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v

// ----------------------------------------------------------------------------- observation (44 floats)
const _g = new Float32Array(2)
export function observe(env: SimEnv, A: Agents, i: number, o: Float32Array) {
  const g = env.grid, n = g.n, p = env.params, f = env.field
  const x = A.x[i], y = A.y[i]
  guidance(env, x, y, _g)
  const gx = _g[0], gy = _g[1]
  const z0 = zAt(g, x, y)
  const c0 = cellAt(n, x, y)
  const T0 = c0 >= 0 ? f.cost[c0] : Infinity
  const active = env.hz.bandActive ? 1 : 0.3
  for (let k = 0; k < 5; k++) {
    const dx = gx * COS[k] - gy * SIN[k], dy = gx * SIN[k] + gy * COS[k]
    const x1 = x + dx * SIM.LOOK1, y1 = y + dy * SIM.LOOK1
    const x2 = x + dx * SIM.LOOK2, y2 = y + dy * SIM.LOOK2
    o[k] = clamp((zAt(g, x1, y1) - z0) / SIM.LOOK1, -0.6, 0.6) / 0.6
    o[5 + k] = clamp((zAt(g, x2, y2) - z0) / SIM.LOOK2, -0.6, 0.6) / 0.6
    const c1 = cellAt(n, x1, y1)
    const cn = cellAt(n, x + dx * SIM.LOOK0, y + dy * SIM.LOOK0)
    if (c1 < 0 || cn < 0 || env.blocked[c1] || env.blocked[cn]) {
      o[10 + k] = 1; o[15 + k] = -1; o[20 + k] = 0; o[25 + k] = 0
    } else {
      o[10 + k] = 0
      const T1 = f.cost[c1]
      o[15 + k] = (isFinite(T1) && isFinite(T0)) ? clamp((T0 - T1) / (SIM.LOOK1 / p.vPlan), -2, 2) / 2 : -1
      o[20 + k] = clamp(g.sand[c1] + clamp(g.rough[c1] - SIM.ROUGH0, 0, 1), 0, 1.5)
      o[25 + k] = g.beta[c1] >= env.hz.alphaDeg ? active : 0
    }
  }
  const sepOn = env.sepElapsedS >= 0
  o[30] = clamp(A.heat[i] / p.heatWarnKJ, 0, 2)
  o[31] = (A.effM[i] - 1) * 4
  o[32] = (A.cool[i] - 1) * 4
  o[33] = (A.vmul[i] - 1) * 4
  o[34] = clamp((c0 >= 0 && isFinite(f.time[c0]) ? f.time[c0] : 7200) / 1800, 0, 4) / 4
  o[35] = isFinite(env.deadlineS) ? clamp((env.deadlineS - A.t[i]) / 1800, -1, 3) / 3 : 1
  o[36] = sepOn ? 1 : 0
  o[37] = sepOn ? sepRate(env.sepElapsedS + A.t[i], p) / sepPeakRate(p) : 0
  o[38] = c0 >= 0 ? clamp(g.sky[c0] / 0.35, 0, 1.5) : 0
  o[39] = clamp(A.o2[i] / SIM.O2_TANK_KG, 0, 1)
  o[40] = A.heat[i] >= p.heatWarnKJ ? 1 : 0
  o[41] = c0 >= 0 ? clamp(g.slope[c0] / 25, 0, 1.5) : 0
  o[42] = Math.min(A.blockedRun[i], 4) / 4
  o[43] = env.dust
}

// ----------------------------------------------------------------------------- one decision step
export interface StepInfo { fell: boolean; blocked: boolean; progress: number; doseInc: number; met: number }

/**
 * Advance agent i by one decision (SIM.DT seconds) with action (heading index hk, pace index pk).
 * u1..u3 are uniform randoms in [0,1): fall test, injury test, recovery time.
 */
export function stepAgent(env: SimEnv, A: Agents, i: number, hk: number, pk: number, u1: number, u2: number, u3: number): StepInfo {
  const g = env.grid, n = g.n, p = env.params, f = env.field
  const DT = SIM.DT, dtS = DT / SIM.SUB
  let x = A.x[i], y = A.y[i]
  const c00 = cellAt(n, x, y)
  const T00 = c00 >= 0 ? f.cost[c00] : Infinity
  const impaired = A.heat[i] >= p.heatWarnKJ
  let Msum = 0, pNoFall = 1, lastV = 0, downhill = false, wasBlocked = false, fell = false
  const tanHard = Math.tan((p.slopeMaxDeg + 6) * Math.PI / 180)

  if (A.fallTimer[i] > 0) {
    A.fallTimer[i] -= DT
    Msum = 250 * A.effM[i] * SIM.SUB
  } else if (A.t[i] < A.react[i]) {
    Msum = SIM.MET_REST * A.effM[i] * SIM.SUB
  } else {
    guidance(env, x, y, _g)
    const dx = _g[0] * COS[hk] - _g[1] * SIN[hk], dy = _g[0] * SIN[hk] + _g[1] * COS[hk]
    const vcmd = SIM.PACES[pk] * A.vmul[i] * (impaired ? 0.6 : 1)
    for (let s = 0; s < SIM.SUB; s++) {
      let v = 0, grade = 0
      const c = cellAt(n, x, y)
      const sand = c >= 0 ? g.sand[c] : 0
      const r = c >= 0 ? clamp(g.rough[c] - SIM.ROUGH0, 0, 1) : 0
      if (vcmd > 0) {
        const look = Math.max(vcmd * dtS, SIM.MOVE_LOOK)
        grade = (zAt(g, x + dx * look, y + dy * look) - zAt(g, x, y)) / look
        const soil = (1 + p.kSand * sand) * (1 + SIM.K_ROUGH * r)
        const err = (1 - env.terrainError * terrainNoise(A.seed[i], x, y)) * (1 - SIM.DUST_SLOW * env.dust)
        v = vcmd * speedFactor(grade) / soil * err
        let nx = x + dx * v * dtS, ny = y + dy * v * dtS
        let nc = cellAt(n, nx, ny)
        if (nc < 0 || env.blocked[nc] || Math.abs(grade) > tanHard) {
          // obstacle: fall back to the planner's own next cell (always a legal move), once
          wasBlocked = true
          v = 0
          const nxt = c >= 0 ? f.next[c] : -1
          if (nxt >= 0) {
            const ti = (nxt / n) | 0, tj = nxt - ti * n
            let ex = (tj + 0.5) * SIM.CELL - x, ey = (ti + 0.5) * SIM.CELL - y
            const el = Math.hypot(ex, ey)
            if (el > 0.01) {
              ex /= el; ey /= el
              const g2 = (zAt(g, x + ex * look, y + ey * look) - zAt(g, x, y)) / look
              const v2 = vcmd * speedFactor(g2) / soil * err
              nx = x + ex * v2 * dtS; ny = y + ey * v2 * dtS
              nc = cellAt(n, nx, ny)
              if (nc >= 0 && !env.blocked[nc] && Math.abs(g2) <= tanHard) { x = nx; y = ny; v = v2; grade = g2 }
            }
          }
        } else { x = nx; y = ny }
      }
      let M: number
      if (v > 0) {
        M = (p.metBase + SIM.MET_B * v + SIM.MET_C * v * v) * (1 + SIM.K_SAND_MET * sand + SIM.K_ROUGH * r)
        const w = p.massKg * p.gMars * v
        M += grade > 0 ? w * grade / SIM.ETA_UP : w * (-grade) * SIM.K_DOWN
        M *= A.effM[i]
        const sl = c >= 0 ? g.slope[c] / SIM.FALL_SLOPE_REF : 0
        const vr = v / 0.65
        const lam = p.fallPerKm / 1000 * (1 + sl * sl) * (1 + 2 * r) * vr * vr * (grade < -0.12 ? 1.6 : 1) * (impaired ? 2 : 1) * (1 + SIM.DUST_FALL * env.dust)
        pNoFall *= Math.exp(-lam * v * dtS)
        A.dist[i] += v * dtS
        lastV = v; downhill = grade < -0.12
      } else {
        M = SIM.MET_REST * A.effM[i]
      }
      Msum += M
    }
    if (wasBlocked && lastV === 0) A.blockedRun[i]++; else A.blockedRun[i] = 0
    // falls
    if (u1 < 1 - pNoFall) {
      A.falls[i]++
      A.fallTimer[i] = SIM.FALL_T_MIN + u3 * (SIM.FALL_T_MAX - SIM.FALL_T_MIN)
      const pInj = Math.min(0.3, p.fallInjuryP * (1 + lastV / 0.65) * (downhill ? 1.5 : 1))
      fell = true
      if (u2 < pInj) A.status[i] = STATUS.INCAPACITATED
    }
  }
  A.x[i] = x; A.y[i] = y; A.lastV[i] = lastV
  const Mavg = Msum / SIM.SUB
  // heat, oxygen
  A.heat[i] = Math.max(0, A.heat[i] + (Mavg - A.cool[i] * p.coolW) * DT / 1000)
  if (A.heat[i] > A.heatPeak[i]) A.heatPeak[i] = A.heat[i]
  A.o2[i] -= Mavg * DT * SIM.O2_KG_PER_J
  // radiation
  const c1 = cellAt(n, x, y)
  const shield = c1 >= 0 ? Math.min(0.95, p.shieldK * g.sky[c1]) : 0
  let rate = p.gcrRate
  if (env.sepElapsedS >= 0) rate += sepRate(env.sepElapsedS + A.t[i] + DT / 2, p)
  const dInc = rate * (1 - shield) * DT / 3600
  A.dose[i] += dInc
  if (env.hz.bandActive && c1 >= 0 && g.beta[c1] >= env.hz.alphaDeg) A.bandSec[i] += DT
  A.t[i] += DT
  // termination
  const T1 = c1 >= 0 ? f.cost[c1] : Infinity
  if (A.status[i] === STATUS.WALKING) {
    const dg = Math.hypot(env.goal.x - x, env.goal.y - y)
    if (dg <= SIM.ARRIVE_R || (c1 >= 0 && f.time[c1] <= 5)) A.status[i] = STATUS.ARRIVED
    else if (A.heat[i] >= p.heatMaxKJ) A.status[i] = STATUS.HEAT
    else if (A.o2[i] <= 0) A.status[i] = STATUS.O2
    else if (A.blockedRun[i] >= SIM.STUCK_STEPS) A.status[i] = STATUS.STUCK
    else if (A.t[i] >= SIM.T_MAX) A.status[i] = STATUS.TIMEOUT
  }
  if (A.status[i] !== STATUS.WALKING) A.tEnd[i] = A.t[i]
  return { fell, blocked: wasBlocked, progress: (isFinite(T00) && isFinite(T1)) ? T00 - T1 : 0, doseInc: dInc, met: Mavg }
}

// ----------------------------------------------------------------------------- policies
export interface PolicyNet {
  layers: { W: Float32Array; b: Float32Array; nin: number; nout: number }[]
  meta?: Record<string, unknown>
}

export function parsePolicy(json: any): PolicyNet {
  return {
    layers: json.layers.map((l: any) => ({ W: Float32Array.from(l.W), b: Float32Array.from(l.b), nin: l.nin, nout: l.nout })),
    meta: json.meta,
  }
}

/** tanh MLP -> 10 logits (5 heading, 5 pace). */
function forward(net: PolicyNet, obs: Float32Array, bufA: Float32Array, bufB: Float32Array): Float32Array {
  let x = obs, out = bufA
  const L = net.layers.length
  for (let l = 0; l < L; l++) {
    const { W, b, nin, nout } = net.layers[l]
    for (let o = 0; o < nout; o++) {
      let s = b[o]
      const off = o * nin
      for (let k = 0; k < nin; k++) s += W[off + k] * x[k]
      out[o] = l < L - 1 ? Math.tanh(s) : s
    }
    x = out; out = out === bufA ? bufB : bufA
  }
  return x
}

function sampleLogits(lg: Float32Array, off: number, u: number, greedy: boolean): number {
  let m = -Infinity, am = 0
  for (let k = 0; k < 5; k++) if (lg[off + k] > m) { m = lg[off + k]; am = k }
  if (greedy) return am
  let s = 0
  const e = [0, 0, 0, 0, 0]
  for (let k = 0; k < 5; k++) { e[k] = Math.exp(lg[off + k] - m); s += e[k] }
  let acc = 0
  for (let k = 0; k < 5; k++) { acc += e[k] / s; if (u < acc) return k }
  return 4
}

/** Scripted baseline: follow the planner, one pace (nominal; brisk under a solar-storm deadline). */
export function baselineAction(o: Float32Array, out: Int32Array) {
  let h = 2
  if (o[12] > 0.5 || o[42] > 0) {
    // straight ahead is blocked (or the last move was): take the free heading with the best planner progress
    let best = -9
    h = -1
    for (const k of [2, 1, 3, 0, 4]) if (o[10 + k] < 0.5 && o[15 + k] > best) { best = o[15 + k]; h = k }
    if (h < 0) h = o[42] > 0.6 ? 4 : 0          // boxed in: sidestep hard
  }
  out[0] = h
  out[1] = o[36] > 0.5 ? 3 : 2
}

// ----------------------------------------------------------------------------- batch rollout
export interface RolloutOptions {
  n: number
  seed: number
  start: StartState
  policy: PolicyNet | null       // null => scripted baseline
  greedy: boolean
  trackAgents: number            // how many agents to record for 3D playback
  maxSteps?: number
}

export interface RolloutResult {
  n: number
  steps: number
  status: Uint8Array
  tEnd: Float32Array
  dose: Float32Array; heatPeak: Float32Array; o2: Float32Array; falls: Uint16Array; bandSec: Float32Array; dist: Float32Array
  endX: Float32Array; endY: Float32Array
  tracks: Float32Array           // trackAgents x (steps + 1) x 2  (core metres)
  trackAgents: number
}

export function rollout(env: SimEnv, opt: RolloutOptions): RolloutResult {
  const rng = mulberry32(opt.seed)
  const A = makeAgents(opt.n, opt.start, rng)
  const maxSteps = opt.maxSteps ?? Math.ceil(SIM.T_MAX / SIM.DT)
  const K = Math.min(opt.trackAgents, opt.n)
  const tracks = new Float32Array(K * (maxSteps + 1) * 2)
  const obs = new Float32Array(SIM.N_OBS), bufA = new Float32Array(128), bufB = new Float32Array(128)
  const act = new Int32Array(2)
  for (let i = 0; i < K; i++) { tracks[i * (maxSteps + 1) * 2] = A.x[i]; tracks[i * (maxSteps + 1) * 2 + 1] = A.y[i] }
  let steps = 0, alive = opt.n
  for (let s = 0; s < maxSteps && alive > 0; s++) {
    alive = 0
    for (let i = 0; i < opt.n; i++) {
      if (A.status[i] === STATUS.WALKING) {
        observe(env, A, i, obs)
        if (opt.policy) {
          const lg = forward(opt.policy, obs, bufA, bufB)
          act[0] = sampleLogits(lg, 0, rng(), opt.greedy)
          act[1] = sampleLogits(lg, 5, rng(), opt.greedy)
        } else baselineAction(obs, act)
        stepAgent(env, A, i, act[0], act[1], rng(), rng(), rng())
        if (A.status[i] === STATUS.WALKING) alive++
      }
      if (i < K) {
        const o = (i * (maxSteps + 1) + s + 1) * 2
        tracks[o] = A.x[i]; tracks[o + 1] = A.y[i]
      }
    }
    steps = s + 1
  }
  // compact tracks to the steps actually simulated
  const tr = new Float32Array(K * (steps + 1) * 2)
  for (let i = 0; i < K; i++) tr.set(tracks.subarray(i * (maxSteps + 1) * 2, i * (maxSteps + 1) * 2 + (steps + 1) * 2), i * (steps + 1) * 2)
  for (let i = 0; i < opt.n; i++) if (A.status[i] === STATUS.WALKING) { A.status[i] = STATUS.TIMEOUT; A.tEnd[i] = A.t[i] }
  return {
    n: opt.n, steps, status: A.status, tEnd: A.tEnd, dose: A.dose, heatPeak: A.heatPeak, o2: A.o2, falls: A.falls,
    bandSec: A.bandSec, dist: A.dist, endX: A.x, endY: A.y, tracks: tr, trackAgents: K,
  }
}

// ----------------------------------------------------------------------------- statistics
export interface RouteStats {
  n: number
  pSafe: number; pSafeLo: number; pSafeHi: number      // Wilson 95% interval
  pArrive: number; pInRule: number
  causes: Record<string, number>                        // fraction of crews
  tP10: number; tP50: number; tP90: number              // s, arrivals only
  doseArriveMean: number                                // µGy accumulated until arrival
  dose2hMean: number                                    // µGy by T+2 h (after arrival: inside the shelter)
  doseOpen2h: number                                    // µGy by T+2 h if staying in the open (reference)
  heatPeakMean: number; heatPeakP90: number
  o2MarginMinMean: number                               // minutes of O2 left at arrival (at 300 W)
  fallsPerCrew: number
  bandMinMean: number                                   // minutes inside the active rockfall band
  strikeOdds: number                                    // modelled chance of being hit (order of magnitude)
  distMean: number
}

function quantile(sorted: Float32Array | number[], q: number): number {
  if (sorted.length === 0) return NaN
  const k = (sorted.length - 1) * q, i = Math.floor(k), f = k - i
  return sorted[i] + (sorted[Math.min(sorted.length - 1, i + 1)] - sorted[i]) * f
}

export function summarise(r: RolloutResult, env: SimEnv, destAdmissible: boolean): RouteStats {
  const p = env.params, n = r.n
  let arrive = 0, inRule = 0, safe = 0, heatSum = 0, fallsSum = 0, bandSum = 0, distSum = 0
  let doseArr = 0, dose2h = 0, o2Sum = 0
  const causes: Record<string, number> = { 'fall injury': 0, 'heat casualty': 0, 'out of oxygen': 0, timeout: 0, stuck: 0, 'late (after rule)': 0, 'low O₂ reserve': 0, 'shelter in rockfall band': 0 }
  const times: number[] = [], heats: number[] = []
  const sepOn = env.sepElapsedS >= 0
  const H2 = 7200
  for (let i = 0; i < n; i++) {
    heatSum += r.heatPeak[i]; heats.push(r.heatPeak[i]); fallsSum += r.falls[i]; bandSum += r.bandSec[i]; distSum += r.dist[i]
    const st = r.status[i]
    if (st === STATUS.ARRIVED) {
      arrive++
      times.push(r.tEnd[i])
      doseArr += r.dose[i]
      // after arrival the crew is inside the shelter until T+2h
      let d = r.dose[i]
      if (r.tEnd[i] < H2) {
        const gcr = p.gcrRate * (H2 - r.tEnd[i]) / 3600
        const sep = sepOn ? sepDose(env.sepElapsedS + r.tEnd[i], env.sepElapsedS + H2, p) : 0
        d += (gcr + sep) * (1 - env.goal.shield)
      }
      dose2h += d
      const o2Min = r.o2[i] / (SIM.O2_NOMINAL_W * SIM.O2_KG_PER_J) / 60
      o2Sum += o2Min
      const late = r.tEnd[i] > env.deadlineS
      const lowO2 = o2Min < p.o2ReserveMin
      if (!late) inRule++
      if (late) causes['late (after rule)']++
      else if (lowO2) causes['low O₂ reserve']++
      else if (!destAdmissible) causes['shelter in rockfall band']++
      else safe++
    } else {
      const key = st === STATUS.INCAPACITATED ? 'fall injury' : st === STATUS.HEAT ? 'heat casualty' : st === STATUS.O2 ? 'out of oxygen' : st === STATUS.STUCK ? 'stuck' : 'timeout'
      causes[key]++
    }
  }
  for (const k in causes) causes[k] /= n
  times.sort((a, b) => a - b); heats.sort((a, b) => a - b)
  const ps = safe / n, zc = 1.96
  const den = 1 + zc * zc / n, mid = (ps + zc * zc / (2 * n)) / den, hw = zc * Math.sqrt(ps * (1 - ps) / n + zc * zc / (4 * n * n)) / den
  const gcr2h = p.gcrRate * 2
  const open2h = gcr2h + (sepOn ? sepDose(env.sepElapsedS, env.sepElapsedS + H2, p) : 0)
  const bandH = bandSum / n / 3600
  return {
    n, pSafe: ps, pSafeLo: Math.max(0, mid - hw), pSafeHi: Math.min(1, mid + hw),
    pArrive: arrive / n, pInRule: inRule / n, causes,
    tP10: quantile(times, 0.1), tP50: quantile(times, 0.5), tP90: quantile(times, 0.9),
    doseArriveMean: arrive ? doseArr / arrive : NaN, dose2hMean: arrive ? dose2h / arrive : NaN, doseOpen2h: open2h,
    heatPeakMean: heatSum / n, heatPeakP90: quantile(heats, 0.9),
    o2MarginMinMean: arrive ? o2Sum / arrive : NaN,
    fallsPerCrew: fallsSum / n, bandMinMean: bandSum / n / 60,
    // order of magnitude: ~1e-6 per hour in a band at background rate (Cerberus Fossae analog), x post-quake factor
    strikeOdds: 1 - Math.exp(-1e-6 * (env.hz.bandActive ? p.quakeRateX : 1) * bandH),
    distMean: distSum / n,
  }
}
