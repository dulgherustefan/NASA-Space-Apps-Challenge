// Turn-by-turn guidance logic for the helmet display: where the walker is on the route, the next instruction,
// hazards ahead and suit values. Pure functions over a LiveRoute; no React, no three.js.
import { FLAG, type LiveRoute, type RouteSample, type Turn } from '../types'

export const OFF_ROUTE_M = 15
export const AHEAD_M = 150

/** Mutable walk state shared by the 3D scene (writer) and the HUD (reader). */
export interface WalkState {
  mode: 'auto' | 'manual'
  paused: boolean
  speed: number
  t: number            // planner time at the current position, relative to the first sample (s)
  elapsed: number      // walk clock since the helmet view opened (s, scaled)
  x: number; y: number // core metres
  d: number            // metres along the route (projection)
  i: number            // sample index (projection)
  yaw: number          // heading, radians clockwise from north
  look: number         // extra look-around offset (auto mode; decays back to 0)
  pitch: number
  off: number          // distance from the route line (m)
  offSince: number     // performance.now() when the walker left the corridor (0 = on route)
  arrived: boolean
  roverMain: boolean
  rerouting: boolean
  moving: boolean
  declutter: boolean
  keys: Set<string>
}

export function newWalkState(route: LiveRoute): WalkState {
  const s = route.samples[0]
  return {
    mode: 'auto', paused: false, speed: 10, t: 0, elapsed: 0, x: s?.x ?? 0, y: s?.y ?? 0, d: 0, i: 0,
    yaw: initialYaw(route), look: 0, pitch: -0.12, off: 0, offSince: 0, arrived: false, roverMain: false, rerouting: false, moving: false, declutter: false,
    keys: new Set(),
  }
}

export function initialYaw(route: LiveRoute): number {
  const s = route.samples
  if (s.length < 2) return 0
  const j = Math.min(s.length - 1, 4)
  return bearing(s[0].x, s[0].y, s[j].x, s[j].y)
}

/** Bearing from a to b, radians clockwise from north (core y runs south). */
export function bearing(ax: number, ay: number, bx: number, by: number) {
  return Math.atan2(bx - ax, -(by - ay))
}
export function wrapPi(a: number) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
export const deg = (r: number) => ((r * 180 / Math.PI) % 360 + 360) % 360

export const t0 = (route: LiveRoute) => route.samples[0]?.t ?? 0
export const routeDuration = (route: LiveRoute) => route.samples.length ? route.samples[route.samples.length - 1].t - t0(route) : 0
export const routeLength = (route: LiveRoute) => route.samples.length ? route.samples[route.samples.length - 1].d : 0

/** Interpolated position at planner time t (relative). */
export function atTime(route: LiveRoute, t: number) {
  const s = route.samples, base = t0(route)
  const tt = t + base
  let lo = 0, hi = s.length - 1
  if (hi <= 0 || tt <= s[0].t) return { i: 0, u: 0, x: s[0]?.x ?? 0, y: s[0]?.y ?? 0, d: 0 }
  if (tt >= s[hi].t) return { i: hi, u: 0, x: s[hi].x, y: s[hi].y, d: s[hi].d }
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].t <= tt) lo = m; else hi = m }
  const a = s[lo], b = s[lo + 1]
  const u = b.t > a.t ? (tt - a.t) / (b.t - a.t) : 0
  return { i: lo, u, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, d: a.d + (b.d - a.d) * u }
}

/** Interpolated position at distance d along the route. */
export function atDist(route: LiveRoute, d: number) {
  const s = route.samples
  let lo = 0, hi = s.length - 1
  if (hi <= 0 || d <= 0) return { i: 0, x: s[0]?.x ?? 0, y: s[0]?.y ?? 0, t: 0 }
  if (d >= s[hi].d) return { i: hi, x: s[hi].x, y: s[hi].y, t: s[hi].t - t0(route) }
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].d <= d) lo = m; else hi = m }
  const a = s[lo], b = s[lo + 1]
  const u = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0
  return { i: lo, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, t: a.t + (b.t - a.t) * u - t0(route) }
}

/** Nearest point of the route polyline to (x, y). `hint` limits the search to a window around a sample index. */
export function project(route: LiveRoute, x: number, y: number, hint = -1) {
  const s = route.samples
  const n = s.length
  let lo = 0, hi = n - 2
  if (hint >= 0) { lo = Math.max(0, hint - 80); hi = Math.min(n - 2, hint + 120) }
  let best = { i: 0, d: 0, t: 0, dist: Infinity }
  for (let k = lo; k <= hi; k++) {
    const a = s[k], b = s[k + 1]
    const ex = b.x - a.x, ey = b.y - a.y
    const L2 = ex * ex + ey * ey
    const u = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / L2)) : 0
    const px = a.x + ex * u, py = a.y + ey * u
    const dist = Math.hypot(x - px, y - py)
    if (dist < best.dist) best = { i: k, d: a.d + (b.d - a.d) * u, t: a.t + (b.t - a.t) * u - t0(route), dist }
  }
  if (n === 1) best = { i: 0, d: 0, t: 0, dist: Math.hypot(x - s[0].x, y - s[0].y) }
  // a windowed search that ends at the window edge may have missed a closer stretch: retry globally
  if (hint >= 0 && best.dist > 25) return project(route, x, y, -1)
  return best
}

export function suitAt(route: LiveRoute, t: number) {
  const s = route.samples
  const p = atTime(route, t)
  const a = s[p.i], b = s[Math.min(s.length - 1, p.i + 1)] ?? a
  const mix = (k: keyof RouteSample) => (a[k] as number) + (((b[k] as number) - (a[k] as number)) * p.u)
  return { o2Min: mix('o2Min'), heatKJ: mix('heatKJ'), doseUGy: mix('doseUGy'), slopeDeg: mix('slopeDeg') }
}

export interface Instruction {
  text: string          // "Bear left"
  dist: number          // metres to the manoeuvre
  angleDeg: number      // + right; 0 for "continue"
  then: string | null   // chained manoeuvre when two turns are < 20 m apart
  turnIndex: number     // index into route.turns, -1 = continue / arrive
  x: number; y: number  // where the manoeuvre is
}

export const round10 = (m: number) => m < 10 ? Math.max(0, Math.round(m)) : Math.round(m / 10) * 10

export function instruction(route: LiveRoute, d: number): Instruction {
  const turns = route.turns
  let k = turns.findIndex(tn => tn.d > d - 3)
  const total = routeLength(route)
  if (k < 0) {
    const end = route.samples[route.samples.length - 1]
    return { text: `Continue to ${route.destName}`, dist: Math.max(0, total - d), angleDeg: 0, then: null, turnIndex: -1, x: end?.x ?? 0, y: end?.y ?? 0 }
  }
  const tn: Turn = turns[k]
  const nx = turns[k + 1]
  const s = route.samples[Math.min(route.samples.length - 1, tn.i)]
  return {
    text: tn.text, dist: Math.max(0, tn.d - d), angleDeg: tn.angleDeg,
    then: nx && nx.d - tn.d < 20 ? nx.text.toLowerCase() : null, turnIndex: k, x: s.x, y: s.y,
  }
}

export function instructionLine(ins: Instruction): { main: string; sub: string } {
  if (ins.turnIndex < 0) return { main: ins.text, sub: `${fmtDist(ins.dist)}` }
  if (ins.dist <= 10) return { main: `${ins.text} now`, sub: ins.then ? `then ${ins.then}` : '' }
  return { main: ins.text, sub: `in ${fmtDist(round10(ins.dist))}${ins.then ? `, then ${ins.then}` : ''}` }
}

export function fmtDist(m: number) {
  if (!isFinite(m)) return '–'
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`
  return `${Math.round(m)} m`
}
export function fmtClock(s: number) {
  const neg = s < 0
  s = Math.abs(Math.round(s))
  const m = Math.floor(s / 60), ss = s % 60
  return `${neg ? '−' : ''}${m}:${ss.toString().padStart(2, '0')}`
}

export type HazardKind = 'band' | 'steep' | 'sand' | 'comms'
export interface HazardSeg {
  id: string
  kind: HazardKind
  i0: number; i1: number
  d0: number; d1: number
  x: number; y: number
  label: string
  level: 'warning' | 'caution' | 'info'
}

const KINDS: { bit: number; kind: HazardKind; level: HazardSeg['level'] }[] = [
  { bit: FLAG.BAND, kind: 'band', level: 'warning' },
  { bit: FLAG.STEEP, kind: 'steep', level: 'caution' },
  { bit: FLAG.SAND, kind: 'sand', level: 'caution' },
  { bit: FLAG.NO_COMMS, kind: 'comms', level: 'info' },
]

/** Contiguous runs of flagged samples (gaps up to 3 samples merged; runs shorter than 8 m dropped). */
export function hazards(route: LiveRoute): HazardSeg[] {
  const s = route.samples
  const out: HazardSeg[] = []
  for (const k of KINDS) {
    let start = -1, lastOn = -1
    const flush = () => {
      if (start < 0) return
      const d0 = s[start].d, d1 = s[lastOn].d
      if (d1 - d0 >= 8 || k.kind === 'band') {
        let maxSlope = 0
        for (let i = start; i <= lastOn; i++) maxSlope = Math.max(maxSlope, s[i].slopeDeg)
        const label = k.kind === 'band' ? 'Rockfall zone' : k.kind === 'steep' ? `Steep slope ${Math.round(maxSlope)}°`
          : k.kind === 'sand' ? 'Loose sand' : 'No radio contact'
        out.push({ id: `${k.kind}-${start}`, kind: k.kind, i0: start, i1: lastOn, d0, d1, x: s[start].x, y: s[start].y, label, level: k.level })
      }
      start = -1
    }
    for (let i = 0; i < s.length; i++) {
      if (s[i].flags & k.bit) { if (start < 0) start = i; lastOn = i }
      else if (start >= 0 && i - lastOn > 3) flush()
    }
    flush()
  }
  return out.sort((a, b) => a.d0 - b.d0)
}

export const HAZARD_VOICE: Record<HazardKind, (h: HazardSeg) => string> = {
  band: () => 'Warning. Rockfall zone ahead. Keep moving, do not stop inside.',
  steep: h => `Caution. ${h.label.replace('°', ' degrees')} ahead.`,
  sand: () => 'Caution. Loose sand ahead.',
  comms: () => 'Radio shadow ahead. No contact with the rover for a while.',
}

/** Elevation (m) at distance d along the route. */
export function zAtDist(route: LiveRoute, d: number): number {
  const s = route.samples
  if (!s.length) return 0
  let lo = 0, hi = s.length - 1
  if (d <= 0) return s[0].z
  if (d >= s[hi].d) return s[hi].z
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].d <= d) lo = m; else hi = m }
  const a = s[lo], b = s[lo + 1]
  const u = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0
  return a.z + (b.z - a.z) * u
}

/** Grade of the route between d0 and d1: percent (+ = uphill) and slope angle (deg). */
export function grade(route: LiveRoute, d0: number, d1: number) {
  const L = Math.max(1, d1 - d0)
  const dz = zAtDist(route, d1) - zAtDist(route, d0)
  return { pct: dz / L * 100, deg: Math.atan2(Math.abs(dz), L) * 180 / Math.PI }
}

export function fmtDuration(min: number) {
  if (!isFinite(min) || min <= 0) return 'now'
  const h = Math.floor(min / 60), m = Math.round(min % 60)
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}
