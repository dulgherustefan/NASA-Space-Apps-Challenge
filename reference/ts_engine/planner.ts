// Route planner on the 5 m analysis grid (mirrored by rl/planner.py).
// Goal-rooted Dijkstra, 16-connected. Edge cost = walking time at the NASA planning speed, slowed by
// slope (Tobler-shaped), loose sand and roughness, multiplied by a risk weight. Hard constraints are
// never traded: impassable cells and the maximum grade along the direction of travel.

import { SIM, type Params } from './params'

export interface Grid {
  n: number
  z: Float32Array; slope: Float32Array; rough: Float32Array; sand: Float32Array
  beta: Float32Array; sky: Float32Array; pit: Float32Array
}

export interface HazardState {
  bandActive: boolean        // post-quake hold in force
  alphaDeg: number
}

export interface Field {
  cost: Float32Array         // weighted cost-to-go (s-equivalent), Infinity if unreachable
  time: Float32Array         // walking time (s) along the min-cost path
  next: Int32Array           // next cell toward the goal, -1 at goal / unreachable
  gx: Float32Array; gy: Float32Array   // unit guidance vector per cell (x east, y south)
}

const NB: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  [1, 2], [1, -2], [-1, 2], [-1, -2], [2, 1], [2, -1], [-2, 1], [-2, -1]]      // (di, dj) = (row, col)

export const speedFactor = (grade: number) => Math.exp(-3.5 * Math.abs(grade + 0.05)) / Math.exp(-0.175)

/** Cells that can never be entered: too steep, or planetary-protection keep-out. */
export function buildBlocked(g: Grid, p: Params, keepout?: Uint8Array): Uint8Array {
  const N = g.n * g.n
  const b = new Uint8Array(N)
  for (let i = 0; i < N; i++) b[i] = (g.slope[i] > p.slopeHardDeg || (keepout && keepout[i])) ? 1 : 0
  return b
}

/**
 * Planetary-protection keep-out. Recurring slope lineae form on large steep slopes (RSL bedrock
 * 35.5 +/- 9.9 deg, Chojnacki 2016) and are COSPAR "Special Regions until demonstrated otherwise".
 * We flag MAJOR slopes only: slope of the terrain smoothed over ~45 m >= slopeDeg, plus a buffer.
 * Rule-based candidate zones, not mapped RSL.
 */
export function buildKeepout(g: Grid, slopeDeg = 27, bufferCells = 3, smoothCells = 4): Uint8Array {
  const n = g.n, N = n * n
  // box-blurred heights (separable)
  const a = new Float32Array(N), zs = new Float32Array(N)
  const w = 2 * smoothCells + 1
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let j = -smoothCells; j <= smoothCells; j++) acc += g.z[i * n + Math.min(n - 1, Math.max(0, j))]
    for (let j = 0; j < n; j++) {
      a[i * n + j] = acc / w
      acc += g.z[i * n + Math.min(n - 1, j + smoothCells + 1)] - g.z[i * n + Math.max(0, j - smoothCells)]
    }
  }
  for (let j = 0; j < n; j++) {
    let acc = 0
    for (let i = -smoothCells; i <= smoothCells; i++) acc += a[Math.min(n - 1, Math.max(0, i)) * n + j]
    for (let i = 0; i < n; i++) {
      zs[i * n + j] = acc / w
      acc += a[Math.min(n - 1, i + smoothCells + 1) * n + j] - a[Math.max(0, i - smoothCells) * n + j]
    }
  }
  const tanT = Math.tan(slopeDeg * Math.PI / 180)
  const src = new Uint8Array(N)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(n - 1, j + 1)
    const gy = (zs[i1 * n + j] - zs[i0 * n + j]) / ((i1 - i0) * SIM.CELL)
    const gx = (zs[i * n + j1] - zs[i * n + j0]) / ((j1 - j0) * SIM.CELL)
    src[i * n + j] = Math.hypot(gx, gy) >= tanT ? 1 : 0
  }
  const tmp = new Uint8Array(N), out = new Uint8Array(N)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    let v = 0
    for (let d = -bufferCells; d <= bufferCells && !v; d++) { const jj = j + d; if (jj >= 0 && jj < n && src[i * n + jj]) v = 1 }
    tmp[i * n + j] = v
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    let v = 0
    for (let d = -bufferCells; d <= bufferCells && !v; d++) { const ii = i + d; if (ii >= 0 && ii < n && tmp[ii * n + j]) v = 1 }
    out[i * n + j] = v
  }
  return out
}

export interface CostWeights { wSlope: number; wBandStanding: number; wBandActive: number }
export const PRESET_BALANCED: CostWeights = { wSlope: 0.5, wBandStanding: 0.15, wBandActive: 8 }

/** Per-cell multipliers: timeMul (soil), riskMul (slope risk, rockfall band). */
export function buildCellCosts(g: Grid, p: Params, hz: HazardState, w: CostWeights) {
  const N = g.n * g.n
  const timeMul = new Float32Array(N), riskMul = new Float32Array(N)
  const wb = hz.bandActive ? w.wBandActive : w.wBandStanding
  for (let i = 0; i < N; i++) {
    const r = Math.min(Math.max(g.rough[i] - SIM.ROUGH0, 0), 1)
    timeMul[i] = (1 + p.kSand * g.sand[i]) * (1 + SIM.K_ROUGH * r)
    const s = g.slope[i] / 20
    const inBand = g.beta[i] >= hz.alphaDeg ? 1 : 0
    riskMul[i] = 1 + w.wSlope * s * s + wb * inBand
  }
  return { timeMul, riskMul }
}

// --- binary heap on typed arrays (lazy deletion)
class Heap {
  key: Float32Array; val: Int32Array; size = 0
  constructor(cap: number) { this.key = new Float32Array(cap); this.val = new Int32Array(cap) }
  push(k: number, v: number) {
    if (this.size === this.key.length) {
      const nk = new Float32Array(this.size * 2), nv = new Int32Array(this.size * 2)
      nk.set(this.key); nv.set(this.val); this.key = nk; this.val = nv
    }
    let i = this.size++
    const key = this.key, val = this.val
    while (i > 0) {
      const p = (i - 1) >> 1
      if (key[p] <= k) break
      key[i] = key[p]; val[i] = val[p]; i = p
    }
    key[i] = k; val[i] = v
  }
  popKey = 0; popVal = 0
  pop() {
    const key = this.key, val = this.val
    this.popKey = key[0]; this.popVal = val[0]
    const n = --this.size
    if (n === 0) return
    const k = key[n], v = val[n]
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= n) break
      if (c + 1 < n && key[c + 1] < key[c]) c++
      if (key[c] >= k) break
      key[i] = key[c]; val[i] = val[c]; i = c
    }
    key[i] = k; val[i] = v
  }
}

/** Cost-to-go from every cell to the nearest goal cell. */
export function costToGo(
  g: Grid, p: Params, blocked: Uint8Array, timeMul: Float32Array, riskMul: Float32Array,
  goals: number[], maxCost = Infinity,
): Field {
  const n = g.n, N = n * n, z = g.z
  const cost = new Float32Array(N).fill(Infinity)
  const time = new Float32Array(N).fill(Infinity)
  const next = new Int32Array(N).fill(-1)
  const tanMax = Math.tan(p.slopeMaxDeg * Math.PI / 180)
  const CELL = SIM.CELL, vPlan = p.vPlan
  const dist = NB.map(([a, b]) => CELL * Math.hypot(a, b))
  const heap = new Heap(N)
  for (const gidx of goals) { cost[gidx] = 0; time[gidx] = 0; heap.push(0, gidx) }
  while (heap.size > 0) {
    heap.pop()
    const c = heap.popKey, u = heap.popVal
    if (c > cost[u]) continue
    if (c > maxCost) break
    const ui = (u / n) | 0, uj = u - ui * n
    const zu = z[u]
    const mul = timeMul[u], rk = riskMul[u]
    for (let k = 0; k < 16; k++) {
      const di = NB[k][0], dj = NB[k][1]
      const vi = ui + di, vj = uj + dj
      if (vi < 0 || vi >= n || vj < 0 || vj >= n) continue
      const v = vi * n + vj
      if (blocked[v]) continue
      const d = dist[k]
      const grade = (zu - z[v]) / d                    // the walker moves v -> u
      if (grade > tanMax || grade < -tanMax) continue
      if (k >= 8) {                                    // knight move: the two cells it passes between
        const ai = ui + (di === 2 || di === -2 ? di / 2 : di), aj = uj + (dj === 2 || dj === -2 ? dj / 2 : 0)
        const bi = ui + (di === 2 || di === -2 ? di / 2 : 0), bj = uj + (dj === 2 || dj === -2 ? dj / 2 : dj)
        if (blocked[ai * n + aj] || blocked[bi * n + bj]) continue
      }
      const t = d / (vPlan * speedFactor(grade)) * mul
      const nc = c + t * rk
      if (nc < cost[v]) {
        cost[v] = nc; time[v] = time[u] + t; next[v] = u
        heap.push(nc, v)
      }
    }
  }
  // guidance: direction to the cell three hops down the pointer chain
  const gx = new Float32Array(N), gy = new Float32Array(N)
  // (shortened to 2 or 1 hops when the straight line to that cell would clip an impassable cell)
  for (let c = 0; c < N; c++) {
    if (next[c] < 0) continue
    const ci = (c / n) | 0, cj = c - ci * n
    const h1 = next[c], h2 = next[h1] >= 0 ? next[h1] : h1, h3 = next[h2] >= 0 ? next[h2] : h2
    let t = h1
    for (const cand of [h3, h2]) {
      if (cand === h1) continue
      const ti = (cand / n) | 0, tj = cand - ti * n
      let clear = true
      for (let s = 1; s <= 5 && clear; s++) {
        const fi = Math.round(ci + (ti - ci) * s / 6), fj = Math.round(cj + (tj - cj) * s / 6)
        if (blocked[fi * n + fj]) clear = false
      }
      if (clear) { t = cand; break }
    }
    const ti = (t / n) | 0, tj = t - ti * n
    const dx = tj - cj, dy = ti - ci, l = Math.hypot(dx, dy)
    gx[c] = dx / l; gy[c] = dy / l
  }
  return { cost, time, next, gx, gy }
}

export interface RoutePath {
  cells: Int32Array
  xy: Float32Array           // core metres (x east, y south), cell centres
  timeS: number              // planning time
  lengthM: number
  climbM: number; descentM: number; maxSlopeDeg: number
  bandLengthM: number        // metres of the route inside the rockfall band
  sandLengthM: number
}

export function tracePath(g: Grid, f: Field, start: number, alphaDeg: number): RoutePath | null {
  if (!isFinite(f.cost[start])) return null
  const n = g.n, CELL = SIM.CELL
  const cells: number[] = [start]
  let u = start, guard = 0
  while (f.next[u] >= 0 && guard++ < 20000) { u = f.next[u]; cells.push(u) }
  const xy = new Float32Array(cells.length * 2)
  let L = 0, up = 0, dn = 0, maxS = 0, band = 0, sandL = 0
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k], i = (c / n) | 0, j = c - i * n
    xy[k * 2] = (j + 0.5) * CELL; xy[k * 2 + 1] = (i + 0.5) * CELL
    if (k > 0) {
      const d = Math.hypot(xy[k * 2] - xy[k * 2 - 2], xy[k * 2 + 1] - xy[k * 2 - 1])
      L += d
      const dz = g.z[c] - g.z[cells[k - 1]]
      if (dz > 0) up += dz; else dn -= dz
      maxS = Math.max(maxS, Math.atan(Math.abs(dz) / d) * 180 / Math.PI)
      if (g.beta[c] >= alphaDeg) band += d
      if (g.sand[c] > 0.5) sandL += d
    }
  }
  return { cells: Int32Array.from(cells), xy, timeS: f.time[start], lengthM: L, climbM: up, descentM: dn, maxSlopeDeg: maxS, bandLengthM: band, sandLengthM: sandL }
}

export const cellOf = (n: number, x: number, y: number) => {
  const j = Math.min(n - 1, Math.max(0, Math.floor(x / SIM.CELL)))
  const i = Math.min(n - 1, Math.max(0, Math.floor(y / SIM.CELL)))
  return i * n + j
}

/** Goal cells: every free cell within `radius` metres of (x, y). */
export function goalCells(g: Grid, blocked: Uint8Array, x: number, y: number, radius = 10): number[] {
  const n = g.n, out: number[] = []
  const r = Math.ceil(radius / SIM.CELL)
  const ci = Math.floor(y / SIM.CELL), cj = Math.floor(x / SIM.CELL)
  for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
    const i = ci + di, j = cj + dj
    if (i < 0 || i >= n || j < 0 || j >= n) continue
    if (Math.hypot(di, dj) * SIM.CELL > radius) continue
    if (!blocked[i * n + j]) out.push(i * n + j)
  }
  if (out.length === 0) out.push(Math.min(n - 1, Math.max(0, ci)) * n + Math.min(n - 1, Math.max(0, cj)))
  return out
}

// ----------------------------------------------------------------------------- natural shelters

export interface TerrainShelter { x: number; y: number; sky: number; cells: number; beta: number }

/** Terrain cells that hide a large part of the sky, clustered: stop-gap radiation shelters found by search. */
export function findTerrainShelters(g: Grid, blocked: Uint8Array, skyMin: number, minCells = 6): TerrainShelter[] {
  const n = g.n, N = n * n
  const mark = new Uint8Array(N)
  const out: TerrainShelter[] = []
  const stack: number[] = []
  for (let s = 0; s < N; s++) {
    if (mark[s] || blocked[s] || g.sky[s] < skyMin) continue
    stack.length = 0; stack.push(s); mark[s] = 1
    let cnt = 0, best = s
    while (stack.length) {
      const c = stack.pop()!
      cnt++
      if (g.sky[c] > g.sky[best]) best = c
      const i = (c / n) | 0, j = c - i * n
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const a = i + di, b = j + dj
        if (a < 0 || a >= n || b < 0 || b >= n) continue
        const q = a * n + b
        if (!mark[q] && !blocked[q] && g.sky[q] >= skyMin) { mark[q] = 1; stack.push(q) }
      }
    }
    if (cnt >= minCells) {
      const i = (best / n) | 0, j = best - i * n
      out.push({ x: (j + 0.5) * SIM.CELL, y: (i + 0.5) * SIM.CELL, sky: g.sky[best], cells: cnt, beta: g.beta[best] })
    }
  }
  out.sort((a, b) => b.sky - a.sky)
  return out
}

// ----------------------------------------------------------------------------- comms line of sight

/** 1 where a 1.7 m-tall receiver has no line of sight to any relay mast. Evaluated every `step` cells. */
export function commsShadow(g: Grid, masts: { x: number; y: number; h: number }[], step = 2): Uint8Array {
  const n = g.n, CELL = SIM.CELL
  const out = new Uint8Array(n * n)
  const zAt = (x: number, y: number) => {
    let fx = x / CELL - 0.5, fy = y / CELL - 0.5
    if (fx < 0) fx = 0; else if (fx > n - 1.001) fx = n - 1.001
    if (fy < 0) fy = 0; else if (fy > n - 1.001) fy = n - 1.001
    const j = fx | 0, i = fy | 0, tx = fx - j, ty = fy - i, k = i * n + j
    return (g.z[k] * (1 - tx) + g.z[k + 1] * tx) * (1 - ty) + (g.z[k + n] * (1 - tx) + g.z[k + n + 1] * tx) * ty
  }
  const mz = masts.map(m => zAt(m.x, m.y) + m.h)
  for (let i = 0; i < n; i += step) for (let j = 0; j < n; j += step) {
    const x = (j + 0.5) * CELL, y = (i + 0.5) * CELL
    const z0 = g.z[i * n + j] + 1.7
    let visible = false
    for (let m = 0; m < masts.length && !visible; m++) {
      const dx = masts[m].x - x, dy = masts[m].y - y
      const d = Math.hypot(dx, dy)
      const steps = Math.max(2, Math.ceil(d / 10))
      let clear = true
      for (let s = 1; s < steps; s++) {
        const t = s / steps
        if (zAt(x + dx * t, y + dy * t) > z0 + (mz[m] - z0) * t + 0.3) { clear = false; break }
      }
      visible = clear
    }
    const v = visible ? 0 : 1
    for (let a = 0; a < step; a++) for (let b = 0; b < step; b++) {
      if (i + a < n && j + b < n) out[(i + a) * n + (j + b)] = v
    }
  }
  return out
}
