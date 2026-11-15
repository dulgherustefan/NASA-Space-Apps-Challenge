// Runs one NavJob: static field for the destination -> navigator route (policy or scripted baseline),
// optional risk-weighted planner reference. Pure function, shared by the worker and the Node probes.
import { cellOf, goalCells, type Field, type Grid } from './planner'
import {
  BASELINE_PACE, buildBandMaps, buildRiskField, buildStaticField, navFollow, navRollout, plannerPace,
  type BandMaps, type NavEnv, type NavPolicy,
} from './nav'
import type { NavJob, NavResult } from './protocol'
import type { NavRoute } from './navTypes'

/** Per-worker cache: static fields per destination, band maps per reach angle. */
export interface NavCache {
  fields: Map<string, Field>
  band: Map<string, BandMaps>
}
export const newNavCache = (): NavCache => ({ fields: new Map(), band: new Map() })

const MAX_FIELDS = 24

function cached<T>(m: Map<string, T>, key: string, max: number, make: () => T): T {
  const hit = m.get(key)
  if (hit !== undefined) { m.delete(key); m.set(key, hit); return hit }      // refresh LRU order
  const v = make()
  m.set(key, v)
  if (m.size > max) m.delete(m.keys().next().value as string)
  return v
}

export function runNavJob(grid: Grid, blocked: Uint8Array, job: NavJob, policy: NavPolicy | null, cache: NavCache): NavResult {
  const p = job.params, n = grid.n
  const hz = { bandActive: job.bandActive, alphaDeg: p.alphaDeg }
  const t0 = performance.now()
  // the static field depends on the destination and the hard-limit / soil parameters only - not on the incident
  const key = [job.dest.x, job.dest.y, p.slopeMaxDeg, p.slopeHardDeg, p.vPlan, p.kSand].join('|')
  const goals = goalCells(grid, blocked, job.dest.x, job.dest.y)
  const field = cached(cache.fields, key, MAX_FIELDS, () => buildStaticField(grid, p, blocked, goals))
  const band = cached(cache.band, String(p.alphaDeg), 8, () => buildBandMaps(grid, p.alphaDeg))
  const startCell = cellOf(n, job.start.x, job.start.y)
  const destCell = cellOf(n, job.dest.x, job.dest.y)
  const inBand = band.mask[destCell] === 1
  const admissible = job.ignoreBandForDest ? true : !(job.bandActive && inBand)
  const reachable = isFinite(field.time[startCell])
  let planMs = performance.now() - t0
  const res: NavResult = { destId: job.dest.id, reachable, admissible, inBand, route: null, reference: null, planMs, navMs: 0 }
  if (!reachable) return res
  const env: NavEnv = {
    grid, blocked, params: p, hz, field, band,
    goal: { x: job.dest.x, y: job.dest.y, shield: job.dest.shield },
    sepElapsedS: job.sepElapsedS, deadlineS: job.deadlineS, dust: job.dust, terrainError: 0.25 + 0.35 * job.dust,
  }
  const start = { x: job.start.x, y: job.start.y, heat: job.start.heat, o2: job.start.o2 }
  const t1 = performance.now()
  res.route = (job.useRL && policy)
    ? navRollout(env, job.dest.id, start, policy)
    : navFollow(env, job.dest.id, start, field, BASELINE_PACE, 'baseline')
  res.navMs = performance.now() - t1
  if (job.withReference) {
    const t2 = performance.now()
    const risk = buildRiskField(grid, p, blocked, hz, goals)
    planMs += performance.now() - t2
    const t3 = performance.now()
    res.reference = navFollow(env, job.dest.id, start, risk, plannerPace(job.sepElapsedS >= 0), 'planner')
    res.navMs += performance.now() - t3
  }
  res.planMs = planMs
  return res
}

/** Typed-array buffers of a result, for zero-copy transfer out of the worker. */
export function navTransfer(r: NavResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = []
  const add = (q: NavRoute | null) => {
    if (!q) return
    for (const a of [q.x, q.y, q.t, q.v, q.elev, q.slope, q.heat, q.o2, q.dose, q.flags]) out.push(a.buffer as ArrayBuffer)
  }
  add(r.route); add(r.reference)
  return out
}
