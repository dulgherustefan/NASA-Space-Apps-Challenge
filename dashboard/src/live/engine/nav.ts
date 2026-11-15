// Navigator v2 (rl/SPEC_NAV.md): ONE deterministic route per destination.
// The route is the greedy rollout of the trained policy under a hard-limit mask ("nominal walker":
// nominal crew traits, no random falls - the expected number of falls is integrated instead).
// The agent's only map knowledge is the STATIC time-to-go field (planner with riskMul = 1); it is not told
// which ground is dangerous today - band, dose, heat and falls only enter through the observation and J.
// rl/nav_env.py mirrors this file step for step in float64 (rl/nav_parity.py). Physics = sim.ts, unchanged.

import { SIM, type Params } from './params'
import { buildCellCosts, costToGo, speedFactor, PRESET_BALANCED, type Field, type Grid, type HazardState } from './planner'
import { sepRate, sepPeakRate, sepDose } from './sim'
import { NAV_FLAG, type NavRoute, type NavSource, type NavStatus, type NavSummary } from './navTypes'

// ----------------------------------------------------------------------------- constants (mirrored in rl/nav_env.py)
export const NAV = {
  NH: 16,                       // headings, 22.5 deg apart, index 0 = along the static guidance
  NP: 5,                        // paces = SIM.PACES
  STALL_STEPS: 12,              // run-time assist after this many decisions without a new best static time-to-go
  LOOK_PROG: 15,                // m, static-field progress probe
  LOOK_NEAR: 10,                // m, band / soil / sky probe
  LOOK_MID: 40, LOOK_FAR: 160,  // m, pooled band probes
  POOL_MID: 8, POOL_FAR: 32,    // cells per pooled tile (40 m, 160 m)
  F_HEAD: 9,                    // features per heading
  N_SCAL: 15,
  N_OBS: 16 * 9 + 15,           // 159
  NOISE_MEAN: 0.5,              // nominal walker: mean of the unmapped-terrain noise
  ASSIST_PACE: 2,               // pace index used by the run-time assist (0.65 m/s)
  STEEP_DEG: 15,                // NAV_FLAG.STEEP threshold
  CHAIN_HOPS: 4,                // max way-points consumed per sub-step when following a pointer chain
} as const

/** Objective J in equivalent seconds (lower is better). Same definition for rl, baseline and planner routes. */
export const NAV_COST = {
  bandActive: PRESET_BALANCED.wBandActive,      // extra seconds per second inside an ACTIVE rockfall band (8)
  bandStanding: PRESET_BALANCED.wBandStanding,  // ... inside a standing band (0.15)
  dosePerUGy: 3,                // s per uGy accumulated on the walk
  heat: 0.4,                    // s per s, times (heat - heatFrom * heatWarn) / heatWarn when positive
  heatFrom: 0.6,
  fall: 340,                    // s per expected fall (300 + 40 s mean recovery, which the nominal walker does not simulate)
  injury: 10800,                // s per expected incapacitating fall
  fail: 10800,                  // s, terminal: timeout / heat casualty / out of O2 / stuck
  ruleMiss: 900,                // s, terminal: SEP active and not inside the shelter within the rule
} as const

const HCOS = Array.from({ length: NAV.NH }, (_, k) => Math.cos(k * Math.PI / 8))
const HSIN = Array.from({ length: NAV.NH }, (_, k) => Math.sin(k * Math.PI / 8))

// ----------------------------------------------------------------------------- terrain access (same as sim.ts)
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
const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v

// ----------------------------------------------------------------------------- map knowledge
/** STATIC time-to-go field: hard limits and soil only, riskMul = 1 everywhere (cost == walking time). */
export function buildStaticField(grid: Grid, p: Params, blocked: Uint8Array, goals: number[]): Field {
  const { timeMul } = buildCellCosts(grid, p, { bandActive: false, alphaDeg: 90 }, PRESET_BALANCED)
  const ones = new Float32Array(grid.n * grid.n).fill(1)
  return costToGo(grid, p, blocked, timeMul, ones, goals)
}

export interface BandMaps {
  alphaDeg: number
  mask: Uint8Array              // 1 where beta >= alpha (rockfall runout band)
  nMid: number; mid: Float64Array   // band fraction per 40 m tile
  nFar: number; far: Float64Array   // band fraction per 160 m tile
}

/** Band mask and its average-pooled maps; rebuilt when the reach angle changes. */
export function buildBandMaps(grid: Grid, alphaDeg: number): BandMaps {
  const n = grid.n, N = n * n
  const mask = new Uint8Array(N)
  for (let i = 0; i < N; i++) mask[i] = grid.beta[i] >= alphaDeg ? 1 : 0
  const pool = (k: number) => {
    const m = Math.ceil(n / k)
    const out = new Float64Array(m * m)
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (mask[i * n + j]) out[((i / k) | 0) * m + ((j / k) | 0)] += 1
    for (let q = 0; q < out.length; q++) out[q] /= k * k
    return { m, out }
  }
  const a = pool(NAV.POOL_MID), b = pool(NAV.POOL_FAR)
  return { alphaDeg, mask, nMid: a.m, mid: a.out, nFar: b.m, far: b.out }
}

export interface NavEnv {
  grid: Grid
  blocked: Uint8Array
  params: Params
  hz: HazardState
  field: Field                  // STATIC time-to-go field of the destination
  band: BandMaps
  goal: { x: number; y: number; shield: number }
  sepElapsedS: number           // seconds since SEP onset at departure; < 0 => no event
  deadlineS: number             // shelter rule deadline (s from departure); Infinity if none
  dust: number
  terrainError: number
}

export interface NavStart { x: number; y: number; heat: number; o2: number }

// ----------------------------------------------------------------------------- walker
interface Walker {
  x: number; y: number; t: number; heat: number; o2: number; dose: number
  effM: number; cool: number; vmul: number
  falls: number; inj: number    // expected falls / expected incapacitating falls
  bandS: number; bandM: number; sandM: number; dist: number; heatPeak: number
  J: number
  status: number                // 0 walking, 1 arrived, 3 heat, 4 o2, 5 timeout  (sim.ts STATUS codes)
}

function newWalker(s: NavStart): Walker {
  return { x: s.x, y: s.y, t: 0, heat: s.heat, o2: s.o2, dose: 0, effM: 1, cool: 1, vmul: 1, falls: 0, inj: 0,
    bandS: 0, bandM: 0, sandM: 0, dist: 0, heatPeak: s.heat, J: 0, status: 0 }
}

const _g = [0, 0]
/** Static guidance direction (unit, x east / y south) at a position; straight to the goal where the field has none. */
function guidance(env: NavEnv, x: number, y: number) {
  const c = cellAt(env.grid.n, x, y)
  let gx = 0, gy = 0
  if (c >= 0) { gx = env.field.gx[c]; gy = env.field.gy[c] }
  if (gx === 0 && gy === 0) {
    const dx = env.goal.x - x, dy = env.goal.y - y, l = Math.hypot(dx, dy) || 1
    gx = dx / l; gy = dy / l
  }
  _g[0] = gx; _g[1] = gy
}

const nominalErr = (env: NavEnv) => (1 - env.terrainError * NAV.NOISE_MEAN) * (1 - SIM.DUST_SLOW * env.dust)

/** Metabolic rate (W) of one sub-step at speed v on cell c, and the expected-fall integral. */
function subPhysics(env: NavEnv, w: Walker, c: number, v: number, grade: number, impaired: boolean): number {
  const g = env.grid, p = env.params, dtS = SIM.DT / SIM.SUB
  if (!(v > 0)) return SIM.MET_REST * w.effM
  const sand = c >= 0 ? g.sand[c] : 0
  const r = c >= 0 ? clamp(g.rough[c] - SIM.ROUGH0, 0, 1) : 0
  let M = (p.metBase + SIM.MET_B * v + SIM.MET_C * v * v) * (1 + SIM.K_SAND_MET * sand + SIM.K_ROUGH * r)
  const wgt = p.massKg * p.gMars * v
  M += grade > 0 ? wgt * grade / SIM.ETA_UP : wgt * (-grade) * SIM.K_DOWN
  M *= w.effM
  const sl = c >= 0 ? g.slope[c] / SIM.FALL_SLOPE_REF : 0
  const vr = v / 0.65
  const downhill = grade < -0.12
  const lam = p.fallPerKm / 1000 * (1 + sl * sl) * (1 + 2 * r) * vr * vr * (downhill ? 1.6 : 1) * (impaired ? 2 : 1) * (1 + SIM.DUST_FALL * env.dust)
  const h = lam * v * dtS
  w.falls += h
  w.inj += h * Math.min(0.3, p.fallInjuryP * (1 + v / 0.65) * (downhill ? 1.5 : 1))
  w.dist += v * dtS
  return M
}

/** Heat, O2, dose, band exposure, objective J and termination at the end of a decision. */
function finishStep(env: NavEnv, w: Walker, Msum: number, falls0: number, inj0: number, dist0: number) {
  const g = env.grid, p = env.params, DT = SIM.DT
  const Mavg = Msum / SIM.SUB
  w.heat = Math.max(0, w.heat + (Mavg - w.cool * p.coolW) * DT / 1000)
  if (w.heat > w.heatPeak) w.heatPeak = w.heat
  w.o2 -= Mavg * DT * SIM.O2_KG_PER_J
  const c1 = cellAt(g.n, w.x, w.y)
  const shield = c1 >= 0 ? Math.min(0.95, p.shieldK * g.sky[c1]) : 0
  let rate = p.gcrRate
  if (env.sepElapsedS >= 0) rate += sepRate(env.sepElapsedS + w.t + DT / 2, p)
  const dInc = rate * (1 - shield) * DT / 3600
  w.dose += dInc
  const moved = w.dist - dist0
  const inBand = c1 >= 0 && env.band.mask[c1] === 1
  if (inBand) { w.bandS += DT; w.bandM += moved }
  if (c1 >= 0 && g.sand[c1] > 0.5) w.sandM += moved
  w.t += DT
  const wb = env.hz.bandActive ? NAV_COST.bandActive : NAV_COST.bandStanding
  w.J += DT + (inBand ? wb * DT : 0) + NAV_COST.dosePerUGy * dInc
    + NAV_COST.heat * DT * Math.max(0, w.heat - NAV_COST.heatFrom * p.heatWarnKJ) / p.heatWarnKJ
    + NAV_COST.fall * (w.falls - falls0) + NAV_COST.injury * (w.inj - inj0)
  const dg = Math.hypot(env.goal.x - w.x, env.goal.y - w.y)
  if (dg <= SIM.ARRIVE_R || (c1 >= 0 && env.field.time[c1] <= 5)) w.status = 1
  else if (w.heat >= p.heatMaxKJ) w.status = 3
  else if (w.o2 <= 0) w.status = 4
  else if (w.t >= SIM.T_MAX) w.status = 5
}

/** One decision with a free heading (index hk relative to the static guidance) and pace index pk. */
function stepFree(env: NavEnv, w: Walker, hk: number, pk: number) {
  const g = env.grid, n = g.n, p = env.params, dtS = SIM.DT / SIM.SUB
  const impaired = w.heat >= p.heatWarnKJ
  const tanHard = Math.tan((p.slopeMaxDeg + 6) * Math.PI / 180)
  guidance(env, w.x, w.y)
  const dx = _g[0] * HCOS[hk] - _g[1] * HSIN[hk], dy = _g[0] * HSIN[hk] + _g[1] * HCOS[hk]
  const vcmd = SIM.PACES[pk] * w.vmul * (impaired ? 0.6 : 1)
  const err = nominalErr(env)
  const falls0 = w.falls, inj0 = w.inj, dist0 = w.dist
  let Msum = 0
  for (let s = 0; s < SIM.SUB; s++) {
    const c = cellAt(n, w.x, w.y)
    let v = 0, grade = 0
    if (vcmd > 0) {
      const sand = c >= 0 ? g.sand[c] : 0
      const r = c >= 0 ? clamp(g.rough[c] - SIM.ROUGH0, 0, 1) : 0
      const look = Math.max(vcmd * dtS, SIM.MOVE_LOOK)
      grade = (zAt(g, w.x + dx * look, w.y + dy * look) - zAt(g, w.x, w.y)) / look
      const soil = (1 + p.kSand * sand) * (1 + SIM.K_ROUGH * r)
      v = vcmd * speedFactor(grade) / soil * err
      const nx = w.x + dx * v * dtS, ny = w.y + dy * v * dtS
      const nc = cellAt(n, nx, ny)
      if (nc < 0 || env.blocked[nc] || Math.abs(grade) > tanHard) v = 0       // hard limit: no move this sub-step
      else { w.x = nx; w.y = ny }
    }
    Msum += subPhysics(env, w, c, v, grade, impaired)
  }
  finishStep(env, w, Msum, falls0, inj0, dist0)
}

/**
 * One decision along the pointer chain of `chain` (cell centre to cell centre, always legal for the planner).
 * Used by the scripted baselines and by the run-time assist.
 */
function stepChain(env: NavEnv, w: Walker, chain: Field, pk: number) {
  const g = env.grid, n = g.n, p = env.params, dtS = SIM.DT / SIM.SUB, CELL = SIM.CELL
  const impaired = w.heat >= p.heatWarnKJ
  const vcmd = SIM.PACES[pk] * w.vmul * (impaired ? 0.6 : 1)
  const err = nominalErr(env)
  const falls0 = w.falls, inj0 = w.inj, dist0 = w.dist
  let Msum = 0
  for (let s = 0; s < SIM.SUB; s++) {
    const c = cellAt(n, w.x, w.y)
    let v = 0, grade = 0
    let tc = c >= 0 ? chain.next[c] : -1
    if (vcmd > 0 && tc >= 0) {
      let ti = (tc / n) | 0
      let tx = (tc - ti * n + 0.5) * CELL, ty = (ti + 0.5) * CELL
      let ex = tx - w.x, ey = ty - w.y
      const el = Math.hypot(ex, ey)
      if (el > 1e-9) { ex /= el; ey /= el } else { ex = 0; ey = 0 }
      const sand = g.sand[c]
      const r = clamp(g.rough[c] - SIM.ROUGH0, 0, 1)
      const look = Math.max(vcmd * dtS, SIM.MOVE_LOOK)
      grade = (zAt(g, w.x + ex * look, w.y + ey * look) - zAt(g, w.x, w.y)) / look
      const soil = (1 + p.kSand * sand) * (1 + SIM.K_ROUGH * r)
      v = vcmd * speedFactor(grade) / soil * err
      let d = v * dtS
      for (let hop = 0; hop < NAV.CHAIN_HOPS && d > 0; hop++) {
        const sx = tx - w.x, sy = ty - w.y
        const seg = Math.hypot(sx, sy)
        if (d >= seg) {
          w.x = tx; w.y = ty; d -= seg
          const nx = chain.next[tc]
          if (nx < 0) break                           // goal cell reached
          tc = nx; ti = (tc / n) | 0
          tx = (tc - ti * n + 0.5) * CELL; ty = (ti + 0.5) * CELL
        } else { w.x += sx / seg * d; w.y += sy / seg * d; d = 0 }
      }
      const nc = cellAt(n, w.x, w.y)
      if (nc < 0 || env.blocked[nc]) { w.x = tx; w.y = ty }    // never rest on an impassable cell: snap to the way-point
    }
    Msum += subPhysics(env, w, c, v, grade, impaired)
  }
  finishStep(env, w, Msum, falls0, inj0, dist0)
}

// ----------------------------------------------------------------------------- observation (159 floats) + mask
export const NAV_OBS_LAYOUT = {
  perHeading: ['progress15', 'grade7_5', 'grade20', 'blocked', 'band10', 'bandFrac40', 'bandFrac160', 'soil10', 'sky10'],
  scalars: ['heat', 'effM', 'cool', 'vmul', 'staticTimeToGo', 'deadline', 'sepOn', 'sepRate', 'skyHere', 'o2', 'impaired',
    'slopeHere', 'dust', 'bandHere', 'bandActive'],
  order: 'feature-major: obs[f * 16 + k] for feature f and heading k, then the 15 scalars',
} as const

/**
 * Observation and heading mask (mask[k] = 1 => heading k is not allowed).
 * A heading is masked when the cell 4 m or 7.5 m ahead is impassable / off the grid (the v1 hard flag), or when
 * the grade over the next 5 m exceeds the hard grade limit (the move would be rejected by the physics).
 */
export function navObserve(env: NavEnv, w: { x: number; y: number; t: number; heat: number; o2: number; effM: number; cool: number; vmul: number },
  o: Float64Array, mask: Uint8Array) {
  const g = env.grid, n = g.n, p = env.params, f = env.field, B = env.band
  const NH = NAV.NH
  const x = w.x, y = w.y
  guidance(env, x, y)
  const gx = _g[0], gy = _g[1]
  const z0 = zAt(g, x, y)
  const c0 = cellAt(n, x, y)
  const T0 = c0 >= 0 ? f.time[c0] : Infinity
  const act = env.hz.bandActive ? 1 : 0.3
  const tanHard = Math.tan((p.slopeMaxDeg + 6) * Math.PI / 180)
  for (let k = 0; k < NH; k++) {
    const dx = gx * HCOS[k] - gy * HSIN[k], dy = gx * HSIN[k] + gy * HCOS[k]
    // static-field progress per metre at 15 m (1 = planning speed on easy ground)
    const cp = cellAt(n, x + dx * NAV.LOOK_PROG, y + dy * NAV.LOOK_PROG)
    const Tp = cp >= 0 ? f.time[cp] : Infinity
    o[k] = (isFinite(Tp) && isFinite(T0)) ? clamp((T0 - Tp) / (NAV.LOOK_PROG / p.vPlan), -2, 2) / 2 : -1
    o[NH + k] = clamp((zAt(g, x + dx * SIM.LOOK1, y + dy * SIM.LOOK1) - z0) / SIM.LOOK1, -0.6, 0.6) / 0.6
    o[2 * NH + k] = clamp((zAt(g, x + dx * SIM.LOOK2, y + dy * SIM.LOOK2) - z0) / SIM.LOOK2, -0.6, 0.6) / 0.6
    const c1 = cellAt(n, x + dx * SIM.LOOK1, y + dy * SIM.LOOK1)
    const cn = cellAt(n, x + dx * SIM.LOOK0, y + dy * SIM.LOOK0)
    const gm = (zAt(g, x + dx * SIM.MOVE_LOOK, y + dy * SIM.MOVE_LOOK) - z0) / SIM.MOVE_LOOK
    const m = (c1 < 0 || cn < 0 || env.blocked[c1] === 1 || env.blocked[cn] === 1 || Math.abs(gm) > tanHard) ? 1 : 0
    mask[k] = m
    o[3 * NH + k] = m
    const cb = cellAt(n, x + dx * NAV.LOOK_NEAR, y + dy * NAV.LOOK_NEAR)
    o[4 * NH + k] = cb >= 0 && B.mask[cb] === 1 ? act : 0
    const xm = x + dx * NAV.LOOK_MID, ym = y + dy * NAV.LOOK_MID
    const jm = Math.floor(xm / (SIM.CELL * NAV.POOL_MID)), im = Math.floor(ym / (SIM.CELL * NAV.POOL_MID))
    o[5 * NH + k] = (im >= 0 && im < B.nMid && jm >= 0 && jm < B.nMid) ? B.mid[im * B.nMid + jm] * act : 0
    const xf = x + dx * NAV.LOOK_FAR, yf = y + dy * NAV.LOOK_FAR
    const jf = Math.floor(xf / (SIM.CELL * NAV.POOL_FAR)), jfi = Math.floor(yf / (SIM.CELL * NAV.POOL_FAR))
    o[6 * NH + k] = (jfi >= 0 && jfi < B.nFar && jf >= 0 && jf < B.nFar) ? B.far[jfi * B.nFar + jf] * act : 0
    o[7 * NH + k] = cb >= 0 ? clamp(g.sand[cb] + clamp(g.rough[cb] - SIM.ROUGH0, 0, 1), 0, 1.5) : 0
    o[8 * NH + k] = cb >= 0 ? clamp(g.sky[cb] / 0.35, 0, 1.5) : 0
  }
  const s = NAV.F_HEAD * NH
  const sepOn = env.sepElapsedS >= 0
  o[s] = clamp(w.heat / p.heatWarnKJ, 0, 2)
  o[s + 1] = (w.effM - 1) * 4
  o[s + 2] = (w.cool - 1) * 4
  o[s + 3] = (w.vmul - 1) * 4
  o[s + 4] = clamp((isFinite(T0) ? T0 : 7200) / 1800, 0, 4) / 4
  o[s + 5] = isFinite(env.deadlineS) ? clamp((env.deadlineS - w.t) / 1800, -1, 3) / 3 : 1
  o[s + 6] = sepOn ? 1 : 0
  o[s + 7] = sepOn ? sepRate(env.sepElapsedS + w.t, p) / sepPeakRate(p) : 0
  o[s + 8] = c0 >= 0 ? clamp(g.sky[c0] / 0.35, 0, 1.5) : 0
  o[s + 9] = clamp(w.o2 / SIM.O2_TANK_KG, 0, 1)
  o[s + 10] = w.heat >= p.heatWarnKJ ? 1 : 0
  o[s + 11] = c0 >= 0 ? clamp(g.slope[c0] / 25, 0, 1.5) : 0
  o[s + 12] = env.dust
  o[s + 13] = c0 >= 0 && B.mask[c0] === 1 ? act : 0
  o[s + 14] = env.hz.bandActive ? 1 : 0
}

// ----------------------------------------------------------------------------- policy network
export interface NavLayer { W: Float64Array; b: Float64Array; nin: number; nout: number }
export interface NavPolicy {
  layers: NavLayer[]            // tanh MLP: N_OBS -> ... -> 16 heading logits + 5 pace logits
  critic: NavLayer[] | null     // optional value network on the same observation
  meta: Record<string, unknown>
}

export function parseNavPolicy(json: any): NavPolicy {
  const conv = (ls: any[]): NavLayer[] => ls.map(l => ({ W: Float64Array.from(l.W), b: Float64Array.from(l.b), nin: l.nin, nout: l.nout }))
  const layers = conv(json.layers)
  if (layers[0].nin !== NAV.N_OBS || layers[layers.length - 1].nout !== NAV.NH + NAV.NP) {
    throw new Error(`nav policy shape ${layers[0].nin} -> ${layers[layers.length - 1].nout}, expected ${NAV.N_OBS} -> ${NAV.NH + NAV.NP}`)
  }
  return { layers, critic: json.critic ? conv(json.critic) : null, meta: json.meta ?? {} }
}

function forward(layers: NavLayer[], obs: Float64Array, bufA: Float64Array, bufB: Float64Array): Float64Array {
  let x = obs, out = bufA
  const L = layers.length
  for (let l = 0; l < L; l++) {
    const { W, b, nin, nout } = layers[l]
    for (let q = 0; q < nout; q++) {
      let s = b[q]
      const off = q * nin
      for (let k = 0; k < nin; k++) s += W[off + k] * x[k]
      out[q] = l < L - 1 ? Math.tanh(s) : s
    }
    x = out; out = out === bufA ? bufB : bufA
  }
  return x
}

/**
 * Greedy action under the masks. Heading: argmax over allowed headings (lowest index wins ties); -1 if all are
 * masked. Pace: argmax over paces 1..4; pace 0 (rest) is only allowed while heat-impaired.
 */
export function navGreedy(logits: Float64Array, mask: Uint8Array, impaired: boolean, out: Int32Array) {
  let h = -1, best = -Infinity
  for (let k = 0; k < NAV.NH; k++) if (!mask[k] && logits[k] > best) { best = logits[k]; h = k }
  let pk = -1; best = -Infinity
  for (let k = impaired ? 0 : 1; k < NAV.NP; k++) if (logits[NAV.NH + k] > best) { best = logits[NAV.NH + k]; pk = k }
  out[0] = h; out[1] = pk
}

// ----------------------------------------------------------------------------- route recording
class Recorder {
  x: number[] = []; y: number[] = []; t: number[] = []; v: number[] = []; elev: number[] = []; slope: number[] = []
  heat: number[] = []; o2: number[] = []; dose: number[] = []; flags: number[] = []
  constructor(private env: NavEnv) {}
  push(w: Walker, assist: boolean) {
    const g = this.env.grid, c = cellAt(g.n, w.x, w.y)
    this.x.push(w.x); this.y.push(w.y); this.t.push(w.t); this.v.push(0)
    this.elev.push(zAt(g, w.x, w.y)); this.slope.push(c >= 0 ? g.slope[c] : 0)
    this.heat.push(w.heat); this.o2.push(w.o2); this.dose.push(w.dose)
    let fl = 0
    if (c >= 0) {
      if (this.env.band.mask[c] === 1) fl |= NAV_FLAG.BAND
      if (g.sand[c] > 0.5) fl |= NAV_FLAG.SAND
      if (g.slope[c] > NAV.STEEP_DEG) fl |= NAV_FLAG.STEEP
      if (g.sky[c] >= this.env.params.skyShelterMin) fl |= NAV_FLAG.SHIELDED
    }
    if (assist) fl |= NAV_FLAG.ASSIST
    this.flags.push(fl)
  }
  setPace(v: number) { this.v[this.v.length - 1] = v }
}

const STATUS_NAME: Record<number, NavStatus> = { 0: 'timeout', 1: 'arrived', 3: 'heat', 4: 'o2', 5: 'timeout', 6: 'stuck' }

function finishRoute(env: NavEnv, destId: string, source: NavSource, start: NavStart, w: Walker, rec: Recorder,
  assistSteps: number, policyValue: number | null, t0: number): NavRoute {
  const p = env.params
  const status = STATUS_NAME[w.status] ?? 'timeout'
  const arrived = status === 'arrived'
  const sepOn = env.sepElapsedS >= 0
  // terminal terms of J
  let J = w.J
  if (!arrived) J += NAV_COST.fail
  if (sepOn && (!arrived || w.t > env.deadlineS)) J += NAV_COST.ruleMiss
  const nS = rec.x.length
  let up = 0, dn = 0, maxS = 0
  for (let i = 1; i < nS; i++) {
    const dz = rec.elev[i] - rec.elev[i - 1], d = Math.hypot(rec.x[i] - rec.x[i - 1], rec.y[i] - rec.y[i - 1])
    if (dz > 0) up += dz; else dn -= dz
    if (d > 1) maxS = Math.max(maxS, Math.atan(Math.abs(dz) / d) * 180 / Math.PI)
  }
  // dose by 2 h after SEP onset (2 h after departure when there is no event): walk + shelter vs staying in the open
  const H = Math.max(w.t, sepOn ? 7200 - env.sepElapsedS : 7200)
  let dose2h = w.dose
  if (arrived && H > w.t) {
    const gcr = p.gcrRate * (H - w.t) / 3600
    const sep = sepOn ? sepDose(env.sepElapsedS + w.t, env.sepElapsedS + H, p) : 0
    dose2h += (gcr + sep) * (1 - env.goal.shield)
  } else if (H > w.t) {
    dose2h += p.gcrRate * (H - w.t) / 3600 + (sepOn ? sepDose(env.sepElapsedS + w.t, env.sepElapsedS + H, p) : 0)
  }
  const doseOpen2h = p.gcrRate * H / 3600 + (sepOn ? sepDose(env.sepElapsedS, env.sepElapsedS + H, p) : 0)
  const summary: NavSummary = {
    timeS: w.t, lengthM: w.dist, climbM: up, descentM: dn, maxSlopeDeg: maxS, meanPace: w.t > 0 ? w.dist / w.t : 0,
    bandS: w.bandS, bandM: w.bandM, sandM: w.sandM, doseArrive: w.dose, dose2h, doseOpen2h, heatPeakKJ: w.heatPeak,
    o2UsedKg: start.o2 - w.o2, o2MarginMin: w.o2 / (SIM.O2_NOMINAL_W * SIM.O2_KG_PER_J) / 60, expectedFalls: w.falls,
    inRule: sepOn ? (arrived && w.t <= env.deadlineS) : null, cost: J,
  }
  return {
    destId, source, status, n: nS,
    x: Float32Array.from(rec.x), y: Float32Array.from(rec.y), t: Float32Array.from(rec.t), v: Float32Array.from(rec.v),
    elev: Float32Array.from(rec.elev), slope: Float32Array.from(rec.slope), heat: Float32Array.from(rec.heat),
    o2: Float32Array.from(rec.o2), dose: Float32Array.from(rec.dose), flags: Uint8Array.from(rec.flags),
    summary, policyValue, assistSteps, ms: performance.now() - t0,
  }
}

const maxSteps = () => Math.ceil(SIM.T_MAX / SIM.DT)

/** Trace hook for parity checks: called after every decision with the action taken (heading -1 = assist). */
export type NavTrace = (step: number, hk: number, pk: number, w: { x: number; y: number; t: number; heat: number; o2: number; dose: number; J: number }) => void

/** The product path: greedy rollout of the policy under the hard-limit mask, nominal walker. */
export function navRollout(env: NavEnv, destId: string, start: NavStart, policy: NavPolicy, trace?: NavTrace): NavRoute {
  const t0 = performance.now()
  const n = env.grid.n, f = env.field
  const w = newWalker(start)
  const rec = new Recorder(env)
  rec.push(w, false)
  const obs = new Float64Array(NAV.N_OBS), mask = new Uint8Array(NAV.NH), act = new Int32Array(2)
  let width = NAV.N_OBS
  for (const l of policy.layers) width = Math.max(width, l.nout)
  if (policy.critic) for (const l of policy.critic) width = Math.max(width, l.nout)
  const bufA = new Float64Array(width), bufB = new Float64Array(width)
  let policyValue: number | null = null
  const c0 = cellAt(n, w.x, w.y)
  let bestT = c0 >= 0 ? f.time[c0] : Infinity
  let stall = 0, assistSteps = 0
  const N = maxSteps()
  for (let step = 0; step < N && w.status === 0; step++) {
    navObserve(env, w, obs, mask)
    if (step === 0 && policy.critic) policyValue = forward(policy.critic, obs, bufA, bufB)[0]
    const impaired = w.heat >= env.params.heatWarnKJ
    let hk = -1, pk: number = NAV.ASSIST_PACE
    if (stall < NAV.STALL_STEPS) {
      navGreedy(forward(policy.layers, obs, bufA, bufB), mask, impaired, act)
      hk = act[0]; if (hk >= 0) pk = act[1]
    }
    if (hk >= 0) {
      rec.setPace(SIM.PACES[pk] * w.vmul * (impaired ? 0.6 : 1))
      stepFree(env, w, hk, pk)
    } else {
      // run-time assist (stalled, or every heading masked): one decision along the static guidance chain
      pk = NAV.ASSIST_PACE
      rec.setPace(SIM.PACES[pk] * w.vmul * (impaired ? 0.6 : 1))
      stepChain(env, w, f, pk)
      assistSteps++
    }
    const c = cellAt(n, w.x, w.y)
    const T = c >= 0 ? f.time[c] : Infinity
    if (T < bestT) { bestT = T; stall = 0 } else stall++
    rec.push(w, hk < 0)
    trace?.(step, hk, pk, w)
  }
  return finishRoute(env, destId, 'rl', start, w, rec, assistSteps, policyValue, t0)
}

/**
 * Scripted reference walkers: follow the pointer chain of a field at a fixed pace.
 *  'baseline' (B1, "fastest path"): the static time-to-go field at 0.95 m/s.
 *  'planner'  (B2): the risk-weighted PRESET_BALANCED field at the v1 scripted pace (0.65 m/s, 0.95 m/s under a SEP).
 */
export function navFollow(env: NavEnv, destId: string, start: NavStart, chain: Field, pk: number, source: NavSource, trace?: NavTrace): NavRoute {
  const t0 = performance.now()
  const w = newWalker(start)
  const rec = new Recorder(env)
  rec.push(w, false)
  const N = maxSteps()
  for (let step = 0; step < N && w.status === 0; step++) {
    const impaired = w.heat >= env.params.heatWarnKJ
    rec.setPace(SIM.PACES[pk] * w.vmul * (impaired ? 0.6 : 1))
    stepChain(env, w, chain, pk)
    rec.push(w, false)
    trace?.(step, -1, pk, w)
  }
  return finishRoute(env, destId, source, start, w, rec, 0, null, t0)
}

export const BASELINE_PACE = 3                                   // B1: 0.95 m/s
export const plannerPace = (sepOn: boolean) => sepOn ? 3 : 2     // B2: v1 scripted pace

/** Risk-weighted planner field (PRESET_BALANCED) - used ONLY for the 'planner' reference route. */
export function buildRiskField(grid: Grid, p: Params, blocked: Uint8Array, hz: HazardState, goals: number[]): Field {
  const { timeMul, riskMul } = buildCellCosts(grid, p, hz, PRESET_BALANCED)
  return costToGo(grid, p, blocked, timeMul, riskMul, goals)
}
