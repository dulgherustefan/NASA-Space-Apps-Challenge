/// <reference lib="webworker" />
// Engine worker: planner, virtual-crew rollouts, rockfall. One job at a time; the main thread runs a pool.
import { SIM } from './params'
import {
  buildBlocked, buildCellCosts, buildKeepout, cellOf, commsShadow, costToGo, findTerrainShelters, goalCells,
  PRESET_BALANCED, tracePath, type Grid,
} from './planner'
import { parsePolicy, rollout, STATUS, summarise, type PolicyNet, type SimEnv } from './sim'
import { simulateRockfall } from './rockfall'
import type { EvalJob, InitMsg, IsoJob, Reply, RockfallJob, RouteResult, StaticsJob, StaticsResult, ToWorker, CommsJob, NavJob } from './protocol'
import { parseNavPolicy, type NavPolicy } from './nav'
import { newNavCache, navTransfer, runNavJob } from './navJob'

let grid: Grid
let init: InitMsg
let policy: PolicyNet | null = null
let navPolicy: NavPolicy | null = null          // Navigator v2 policy; null => nav jobs return the scripted baseline
const navCache = newNavCache()
let keepout: Uint8Array | null = null

function statics(params: StaticsJob['params']) {

  if (!keepout) keepout = buildKeepout(grid)

  return { keepout, blocked: buildBlocked(grid, params, keepout) }
}

function heightWorld(x: number, z: number): number {
  // world x east / z south, origin at the EVA-box centre -> elevation (m)
  const half = init.size / 2
  if (x >= -half && x <= half && z >= -half && z <= half) {
    const n = init.n
    let fx = (x + half) / init.renderCell, fy = (z + half) / init.renderCell
    if (fx > n - 1.001) fx = n - 1.001
    if (fy > n - 1.001) fy = n - 1.001
    const j = fx | 0, i = fy | 0, tx = fx - j, ty = fy - i, k = i * n + j, a = init.coreH
    return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + n] * (1 - tx) + a[k + n + 1] * tx) * ty
  }
  const r = init.reg
  let fx = (x - r.x0) / r.cell - 0.5, fy = (z - r.z0) / r.cell - 0.5
  if (fx < 0) fx = 0; else if (fx > r.nx - 1.001) fx = r.nx - 1.001
  if (fy < 0) fy = 0; else if (fy > r.ny - 1.001) fy = r.ny - 1.001
  const j = fx | 0, i = fy | 0, tx = fx - j, ty = fy - i, k = i * r.nx + j, a = r.h
  return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + r.nx] * (1 - tx) + a[k + r.nx + 1] * tx) * ty
}

function doEval(job: EvalJob): { result: RouteResult; transfer: Transferable[] } {
  const p = job.params
  const { blocked } = statics(p)
  const hz = { bandActive: job.bandActive, alphaDeg: p.alphaDeg }
  const t0 = performance.now()
  const { timeMul, riskMul } = buildCellCosts(grid, p, hz, PRESET_BALANCED)
  const goals = goalCells(grid, blocked, job.dest.x, job.dest.y)
  const field = costToGo(grid, p, blocked, timeMul, riskMul, goals)
  const startCell = cellOf(grid.n, job.start.x, job.start.y)
  const path = tracePath(grid, field, startCell, p.alphaDeg)
  const planMs = performance.now() - t0
  const destCell = cellOf(grid.n, job.dest.x, job.dest.y)
  const inBand = grid.beta[destCell] >= p.alphaDeg
  const admissible = job.ignoreBandForDest ? true : !(job.bandActive && inBand)
  const usePolicy = job.useRL && policy ? policy : null
  const base: RouteResult = {
    destId: job.dest.id, reachable: !!path, admissible, inBand, path: null, stats: null, tracks: null, trackStatus: null, trackEnd: null,
    trackAgents: 0, steps: 0, failXY: null, planMs, simMs: 0, policy: usePolicy ? 'rl' : 'baseline',
  }
  if (!path) return { result: base, transfer: [] }
  const env: SimEnv = {
    grid, blocked, field, params: p, hz, goal: { x: job.dest.x, y: job.dest.y, shield: job.dest.shield },
    sepElapsedS: job.sepElapsedS, deadlineS: job.deadlineS, terrainError: 0.25 + 0.35 * job.dust, dust: job.dust,
  }
  const t1 = performance.now()
  // crews still walking after 2.5x the planner time (+10 min) count as 'timeout': caps the cost of hopeless routes
  const maxSteps = Math.ceil(Math.min(SIM.T_MAX, 2.5 * path.timeS + 600) / SIM.DT)
  const r = rollout(env, {
    n: job.n, seed: job.seed, start: job.start, policy: usePolicy, greedy: job.greedy, trackAgents: job.trackAgents, maxSteps,
  })
  const stats = summarise(r, env, admissible)
  const simMs = performance.now() - t1
  const fails: number[] = []
  for (let i = 0; i < r.n; i++) if (r.status[i] !== STATUS.ARRIVED) fails.push(r.endX[i], r.endY[i])
  const K = r.trackAgents
  const trackStatus = r.status.slice(0, K), trackEnd = r.tEnd.slice(0, K)
  const failXY = Float32Array.from(fails)
  const result: RouteResult = {
    ...base,
    path: { xy: path.xy, timeS: path.timeS, lengthM: path.lengthM, climbM: path.climbM, descentM: path.descentM, maxSlopeDeg: path.maxSlopeDeg, bandLengthM: path.bandLengthM, sandLengthM: path.sandLengthM },
    stats, tracks: r.tracks, trackStatus, trackEnd, trackAgents: K, steps: r.steps, failXY, simMs,
  }
  return { result, transfer: [path.xy.buffer, r.tracks.buffer, trackStatus.buffer, trackEnd.buffer, failXY.buffer] }
}

function doStatics(job: StaticsJob): { result: StaticsResult; transfer: Transferable[] } {
  const { keepout: k, blocked } = statics(job.params)
  const shelters = findTerrainShelters(grid, blocked, job.params.skyShelterMin)
  // shelters that stay admissible during a post-quake hold: only cells outside the rockfall band count
  const masked = new Uint8Array(blocked)
  for (let i = 0; i < masked.length; i++) if (grid.beta[i] >= job.params.alphaDeg) masked[i] = 1
  const out = findTerrainShelters(grid, masked, job.params.skyShelterMin)
  return { result: { keepout: k.slice(), blocked: blocked.slice(), shelters, sheltersOutsideBand: out }, transfer: [] }
}

function doIso(job: IsoJob): { result: Float32Array; transfer: Transferable[] } {
  const p = job.params
  const { blocked } = statics(p)
  const hz = { bandActive: job.bandActive, alphaDeg: p.alphaDeg }
  const { timeMul, riskMul } = buildCellCosts(grid, p, hz, PRESET_BALANCED)
  const goals: number[] = []
  for (const g of job.goals) for (const c of goalCells(grid, blocked, g.x, g.y)) goals.push(c)
  const out = new Float32Array(grid.n * grid.n).fill(-1)
  if (goals.length) {
    const f = costToGo(grid, p, blocked, timeMul, riskMul, goals)
    for (let i = 0; i < out.length; i++) out[i] = isFinite(f.time[i]) ? f.time[i] / 60 : 999
  }
  return { result: out, transfer: [out.buffer] }
}

function doRockfall(job: RockfallJob) {
  const p = job.params
  const half = init.size / 2
  const loc: number[] = []
  const n = grid.n
  // (a) local scarps above the focus point (the crew)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const c = i * n + j
    if (grid.slope[c] < p.sourceSlopeDeg) continue
    const x = (j + 0.5) * SIM.CELL, y = (i + 0.5) * SIM.CELL
    const d = Math.hypot(x - job.focus.x, y - job.focus.y)
    if (d < job.focus.r) { loc.push(x - half, y - half); if (d < job.focus.r * 0.45) loc.push(x - half, y - half, x - half, y - half) }
  }
  // (b) the canyon wall above the EVA box (region grid, 16 m)
  const r = init.reg
  const wall: number[] = []
  for (let i = 0; i < r.ny; i++) for (let j = 0; j < r.nx; j++) {
    if (r.slope[i * r.nx + j] / 3 < p.sourceSlopeDeg) continue
    const x = r.x0 + (j + 0.5) * r.cell, z = r.z0 + (i + 0.5) * r.cell
    if (x > -half - 200 && x < half + 200 && z > -half - 1500 && z < -half + 250) wall.push(x, z)
  }
  const runs = simulateRockfall(heightWorld, {
    count: job.count, seed: job.seed, gMars: p.gMars, alphaMin: Math.max(p.alphaDeg, 27.8), alphaMax: Math.max(p.alphaDeg + 7, 34.8),
    sources: Float32Array.from(wall), localSources: Float32Array.from(loc), localShare: 0.5,
  })
  return { result: runs, transfer: runs.map(b => b.path.buffer) }
}

/** Navigator v2: one deterministic route per destination (RL policy, or the scripted baseline if none is loaded). */
function doNav(job: NavJob) {
  const { blocked } = statics(job.params)
  const result = runNavJob(grid, blocked, job, navPolicy, navCache)
  return { result, transfer: navTransfer(result) as Transferable[] }
}

function doComms(job: CommsJob) {
  const out = commsShadow(grid, job.masts, 2)
  return { result: out, transfer: [out.buffer] }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data
  if (m.type === 'init') {
    init = m
    grid = { n: m.na, z: m.z, slope: m.slope, rough: m.rough, sand: m.sand, beta: m.beta, sky: m.sky, pit: m.pit }
    policy = m.policy ? parsePolicy(m.policy) : null
    ;(self as unknown as Worker).postMessage({ id: -1, ok: true } satisfies Reply)
    return
  }
  if (m.type === 'policy') { policy = m.policy ? parsePolicy(m.policy) : null; return }
  if (m.type === 'navPolicy') {
    try { navPolicy = m.policy ? parseNavPolicy(m.policy) : null } catch (e) { navPolicy = null; console.error('nav policy rejected', e) }
    return
  }
  try {
    let out: { result: unknown; transfer: Transferable[] }
    if (m.type === 'eval') out = doEval(m)
    else if (m.type === 'nav') out = doNav(m)
    else if (m.type === 'statics') out = doStatics(m)
    else if (m.type === 'iso') out = doIso(m)
    else if (m.type === 'rockfall') out = doRockfall(m)
    else out = doComms(m)
    ;(self as unknown as Worker).postMessage({ id: m.id, ok: true, result: out.result } satisfies Reply, out.transfer)
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ id: m.id, ok: false, error: String((e as Error)?.stack ?? e) } satisfies Reply)
  }
}
