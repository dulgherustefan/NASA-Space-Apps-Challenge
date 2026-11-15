// Live mode orchestrator: loads a site, runs the TypeScript engine in Web Workers, and turns an incident at a
// clicked crew position into candidate routes, Monte Carlo virtual crews and one chosen route.
// Every number it produces is a model output from the parameter registry (engine/params.ts) unless stated.
import { create } from 'zustand'
import { Engine } from './engine/engine'
import { loadSite, type SiteData } from './engine/site'
import { defaultParams, SIM, type Params } from './engine/params'
import { sepDose, STATUS_LABEL } from './engine/sim'
import { speedFactor, type TerrainShelter } from './engine/planner'
import type { Destination, RouteResult } from './engine/protocol'
import { FLAG, type Incident, type IncidentKind, type LiveRoute, type LoadedSite, type RouteSample, type Shelter, type SiteDescriptor, type Turn } from './types'

const BASE = import.meta.env.BASE_URL

/** The bundled site: HiRISE DTM of NE Melas Chasma, precomputed by pipeline/ (data/site). */
export function bundledDescriptor(site: SiteData): SiteDescriptor {
  const c = site.meta.core
  return {
    id: 'melas', name: 'NE Melas Chasma (Valles Marineris)',
    lon: c.centerLon < 0 ? c.centerLon + 360 : c.centerLon, lat: c.centerLat,
    sizeM: c.size, cellM: c.cell, n: c.na,
    source: 'HiRISE DTM DTEEC_028857_1700_028923_1700_A01 (USGS Astrogeology, CC0; NASA/JPL/University of Arizona/USGS)',
    sourceResM: 1, grade: 'eva',
    gradeReason: '1 m HiRISE stereo elevation model, resampled to the 5 m planner grid; per-cell 1 m slope kept as a layer.',
    bundled: true, orthoUrl: BASE + 'data/site/core_ortho.webp',
    orthoNote: 'HiRISE ESP_028857_1700 orthoimage (1 m), greyscale; colour in 3D is approximate.',
  }
}

export type Phase = 'boot' | 'loading' | 'ready' | 'planning' | 'planned' | 'error'
export type View = 'map' | '3d' | 'helmet'

export interface LiveState {
  phase: Phase
  progress: { label: string; frac: number }
  error: string | null
  loaded: LoadedSite | null
  params: Params
  shelters: Shelter[]
  terrainShelters: TerrainShelter[]
  terrainSheltersOutsideBand: TerrainShelter[]
  comms: Uint8Array | null
  crew: { x: number; y: number } | null
  incident: Incident | null
  routes: LiveRoute[]
  chosen: LiveRoute | null
  planMs: number
  view: View
  policyLoaded: boolean
  rerouting: boolean
  refining: boolean
  note: string | null
  mcN: number
}

let engine: Engine | null = null
let policyJson: unknown | null = null
let planSeq = 0
let blockedMask: Uint8Array | null = null

/** Nearest walkable cell centre (the planner cannot start inside a keep-out or never-enter cell). */
function snapWalkable(x: number, y: number): { x: number; y: number } {
  const l = S().loaded
  if (!l || !blockedMask) return { x, y }
  const n = l.site.meta.core.na, ci = Math.min(n - 1, Math.max(0, (y / SIM.CELL) | 0)), cj = Math.min(n - 1, Math.max(0, (x / SIM.CELL) | 0))
  if (!blockedMask[ci * n + cj]) return { x, y }
  for (let r = 1; r < 120; r++) {
    let best = -1, bd = Infinity
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
      const i = ci + di, j = cj + dj
      if (i < 0 || j < 0 || i >= n || j >= n || blockedMask[i * n + j]) continue
      const d = di * di + dj * dj
      if (d < bd) { bd = d; best = i * n + j }
    }
    if (best >= 0) return { x: ((best % n) + 0.5) * SIM.CELL, y: (((best / n) | 0) + 0.5) * SIM.CELL }
  }
  return { x, y }
}

export const useLive = create<LiveState>(() => ({
  phase: 'boot', progress: { label: 'Starting', frac: 0 }, error: null, loaded: null, params: defaultParams(),
  shelters: [], terrainShelters: [], terrainSheltersOutsideBand: [], comms: null, crew: null, incident: null, routes: [], chosen: null,
  planMs: 0, view: 'map', policyLoaded: false, rerouting: false, refining: false, note: null, mcN: 1000,
}))
const S = useLive.getState
const set = useLive.setState

async function fetchPolicy() {
  if (policyJson !== null) return policyJson
  try {
    const r = await fetch(BASE + 'policy/policy.json')
    policyJson = r.ok ? await r.json() : null
  } catch { policyJson = null }
  return policyJson
}

/** Load the bundled HiRISE site. */
export async function bootBundled() {
  set({ phase: 'loading', error: null, progress: { label: 'Loading HiRISE terrain', frac: 0.01 } })
  try {
    const [site, policy] = await Promise.all([loadSite((label, frac) => set({ progress: { label, frac } })), fetchPolicy()])
    await useSite({ site, desc: bundledDescriptor(site) }, policy)
  } catch (e) {
    set({ phase: 'error', error: `Could not load the terrain: ${(e as Error).message}` })
  }
}

/** Switch the engine to a site (bundled or built in the browser from a fetched DEM). */
export async function useSite(loaded: LoadedSite, policy?: unknown | null) {
  set({ progress: { label: 'Starting engine workers', frac: 0.8 } })
  engine?.dispose()
  const prev = S().loaded?.desc.orthoUrl
  if (prev?.startsWith('blob:') && prev !== loaded.desc.orthoUrl) URL.revokeObjectURL(prev)
  const pol = policy === undefined ? await fetchPolicy() : policy
  engine = new Engine(loaded.site, pol)
  await engine.ready
  const p = S().params
  set({ progress: { label: 'Finding natural shelters', frac: 0.9 } })
  const st = await engine.statics(p)
  const shelters0 = engineeredShelters(loaded, st.blocked)
  blockedMask = connectedMask(loaded, st.blocked, shelters0)
  const shelters = shelters0
  const masts = shelters.map(s => ({ x: s.x, y: s.y, h: s.kind === 'habitat' ? 8 : 3 }))
  const comms = masts.length ? await engine.comms(masts) : null
  set({
    loaded, phase: 'ready', progress: { label: 'Ready', frac: 1 }, policyLoaded: !!pol,
    terrainShelters: st.shelters, terrainSheltersOutsideBand: st.sheltersOutsideBand, comms,
    shelters, crew: null, incident: null, routes: [], chosen: null, view: S().view === 'helmet' ? 'map' : S().view,
  })
}

/**
 * Cells a crew on foot can stand on: walkable AND connected over walkable ground to the rover or habitat
 * (they walked out from there). Returned as a "blocked" mask (1 = cannot stand here).
 */
function connectedMask(l: LoadedSite, blocked: Uint8Array, shelters: Shelter[]): Uint8Array {
  const n = l.site.meta.core.na
  const out = new Uint8Array(n * n).fill(1)
  const q = new Int32Array(n * n)
  let head = 0, tail = 0
  for (const sh of shelters) {
    const c = Math.min(n - 1, (sh.y / SIM.CELL) | 0) * n + Math.min(n - 1, (sh.x / SIM.CELL) | 0)
    // seed at the nearest walkable cell of each shelter
    let seed = -1
    for (let r = 0; r < 20 && seed < 0; r++) for (let di = -r; di <= r && seed < 0; di++) for (let dj = -r; dj <= r; dj++) {
      const k = c + di * n + dj
      if (k >= 0 && k < n * n && !blocked[k]) { seed = k; break }
    }
    if (seed >= 0 && out[seed]) { out[seed] = 0; q[tail++] = seed }
  }
  if (tail === 0) return blocked
  while (head < tail) {
    const c = q[head++], i = (c / n) | 0, j = c - i * n
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const ii = i + di, jj = j + dj
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue
      const k = ii * n + jj
      if (out[k] && !blocked[k]) { out[k] = 0; q[tail++] = k }
    }
  }
  return out
}

/** Habitat and rover: scenario positions on the bundled site; elsewhere the rover is assumed parked near the box centre. */
function engineeredShelters(l: LoadedSite, blocked: Uint8Array): Shelter[] {
  const p = S().params
  if (l.desc.bundled) {
    return [
      { id: 'rover', kind: 'rover', name: 'Pressurized rover', x: 1700, y: 2600, shield: p.shieldRover, open: true },
      { id: 'habitat', kind: 'habitat', name: 'Habitat', x: 700, y: 3300, shield: p.shieldHabitat, open: true },
    ]
  }
  // nearest walkable cell to the centre for the rover (scenario assumption, stated in the UI)
  const n = l.site.meta.core.na, c = n / 2
  let best = -1, bd = Infinity
  for (let i = 0; i < n; i += 2) for (let j = 0; j < n; j += 2) {
    const k = i * n + j
    if (blocked[k] || l.site.slope[k] > 10) continue
    const d = (i - c) ** 2 + (j - c) ** 2
    if (d < bd) { bd = d; best = k }
  }
  if (best < 0) return []
  const i = (best / n) | 0, j = best % n
  return [{ id: 'rover', kind: 'rover', name: 'Pressurized rover (assumed parked here)', x: (j + 0.5) * SIM.CELL, y: (i + 0.5) * SIM.CELL, shield: p.shieldRover, open: true }]
}

export function setCrew(x: number, y: number) {
  const l = S().loaded
  if (!l) return
  const size = l.site.meta.core.size
  x = Math.min(size - 3, Math.max(3, x)); y = Math.min(size - 3, Math.max(3, y))
  const c = snapWalkable(x, y)
  const moved = Math.hypot(c.x - x, c.y - y)
  set({ crew: c, note: moved > 15 ? `Moved ${Math.round(moved)} m to the nearest ground a crew can reach on foot from the rover (the clicked spot is too steep or cut off).` : null })
  if (S().incident) void plan()
}

export function setView(view: View) { set({ view }) }
export function clearIncident() { set({ incident: null, routes: [], chosen: null, phase: S().loaded ? 'ready' : S().phase }) }

export function trigger(kind: IncidentKind) {
  const p = S().params
  const incident: Incident = { kind, startedAt: Date.now(), ruleS: kind === 'storm' ? p.shelterRuleMin * 60 : 0 }
  set({ incident })
  if (!S().crew) {
    // no crew yet: put them on a walkable cell about 1.2 km from the rover so there is something to plan
    const l = S().loaded!
    const r = S().shelters[0]
    const c = { x: Math.min(l.site.meta.core.size - 50, (r?.x ?? 2000) + 900), y: Math.max(50, (r?.y ?? 2000) - 800) }
    set({ crew: snapWalkable(c.x, c.y) })
  }
  return plan()
}

/** Candidate shelters for the current incident, nearest first. */
function candidates(): { dests: Destination[]; all: Shelter[] } {
  const s = S(), p = s.params, l = s.loaded!, crew = s.crew!
  const band = s.incident?.kind === 'quake'
  const beta = l.site.beta, n = l.site.meta.core.na
  const inBand = (x: number, y: number) => beta[Math.min(n - 1, (y / SIM.CELL) | 0) * n + Math.min(n - 1, (x / SIM.CELL) | 0)] >= p.alphaDeg
  const terr = (band ? s.terrainSheltersOutsideBand : s.terrainShelters)
    .map(t => ({ t, d: Math.hypot(t.x - crew.x, t.y - crew.y) }))
    .sort((a, b) => a.d - b.d).slice(0, 3)
  const named = new Map<string, string>()
  const terrainList: Shelter[] = terr.map(({ t }, k) => {
    const id = `T${Math.round(t.x)}_${Math.round(t.y)}`
    named.set(id, `Terrain shelter ${String.fromCharCode(65 + k)}`)
    return { id, kind: 'terrain', name: named.get(id)!, x: t.x, y: t.y, shield: Math.min(0.95, p.shieldK * t.sky), open: true }
  })
  const eng = s.shelters.map(sh => ({ ...sh, open: !(band && inBand(sh.x, sh.y)) }))
  const all = [...eng, ...terrainList]
  // in a storm, terrain shelters only count if they actually block sky; in a quake every shelter outside the band counts
  const dests: Destination[] = all.map(sh => ({ id: sh.id, kind: sh.kind, name: sh.name, x: sh.x, y: sh.y, shield: sh.shield }))
  return { dests, all }
}

/** Plan + simulate every candidate in the workers, then choose. */
export async function plan(): Promise<void> {
  const s = S()
  if (!engine || !s.loaded || !s.crew || !s.incident) return
  const seq = ++planSeq
  set({ phase: 'planning' })
  const p = s.params, inc = s.incident
  const { dests, all } = candidates()
  const t0 = performance.now()
  const storm = inc.kind === 'storm'
  const elapsed = Math.max(0, (Date.now() - inc.startedAt) / 1000)
  const deadlineS = storm ? Math.max(60, inc.ruleS - elapsed) : Infinity
  const start = { x: s.crew.x, y: s.crew.y, heat: 60, o2: 0.46, dose: 0 }
  const common = { params: p, bandActive: !storm, start, sepElapsedS: storm ? elapsed : -1, deadlineS, dust: 0, useRL: p.useRL >= 0.5, greedy: false, trackAgents: 0 }
  const apply = (results: RouteResult[], final: boolean) => {
    const routes = results.map(r => toLiveRoute(r, all.find(a => a.id === r.destId)!, start, elapsed, storm, deadlineS)).filter(Boolean) as LiveRoute[]
    const chosen = choose(routes, storm, deadlineS)
    for (const r of routes) r.chosen = r === chosen
    set({
      routes, chosen, phase: 'planned', planMs: performance.now() - t0, rerouting: false, refining: !final,
      shelters: s.shelters.map(sh => ({ ...sh, open: all.find(a => a.id === sh.id)?.open ?? true })),
    })
  }
  // pass 1: a quick answer from 100 virtual crews per route; pass 2: the full stress test
  engine.cancelQueued()
  try {
    const quick = await engine.evaluateAll({ ...common, n: 100 }, dests, 1000 + seq)
    if (seq !== planSeq) return
    apply(quick, false)
    const full = await engine.evaluateAll({ ...common, n: s.mcN }, dests, 5000 + seq)
    if (seq !== planSeq) return
    apply(full, true)
  } catch (e) {
    if ((e as Error).message !== 'superseded') { console.warn('plan failed', e); if (seq === planSeq) set({ phase: 'error', error: String(e) }) }
  }
}

/** Re-plan from a new position (helmet view: the walker left the corridor). */
export async function reroute(x: number, y: number) {
  set({ rerouting: true })
  set({ crew: snapWalkable(x, y) })
  await plan()
}

function choose(routes: LiveRoute[], storm: boolean, deadlineS: number): LiveRoute | null {
  const ok = routes.filter(r => r.admissible && r.mc && (!storm || r.timeS <= deadlineS))
  const reach = routes.filter(r => r.admissible && r.mc)
  const fr = (r: LiveRoute) => Math.round((r.mc?.failRate ?? 1) * 1000)
  let chosen: LiveRoute | null = null
  if (ok.length) {
    chosen = [...ok].sort((a, b) => fr(a) - fr(b) || a.bandLengthM - b.bandLengthM || a.timeS - b.timeS)[0]
    chosen.reason = `Fails least often of the routes that meet ${storm ? 'the 30-minute rule' : 'the rules'}: ${pct(chosen.mc!.failRate)} of ${chosen.mc!.n.toLocaleString('en-US')} virtual crews (95% CI ${pct(chosen.mc!.ciLo)}–${pct(chosen.mc!.ciHi)}).`
  } else if (reach.length) {
    chosen = [...reach].sort((a, b) => a.timeS - b.timeS)[0]
    chosen.reason = storm
      ? `No open shelter can be reached inside the rule; fastest way under cover (${Math.round(chosen.timeS / 60)} min).`
      : `Fastest way out to a shelter outside the rockfall band (${Math.round(chosen.timeS / 60)} min).`
  }
  for (const r of routes) if (r !== chosen && !r.reason) {
    r.reason = !r.admissible ? 'Closed: inside the active rockfall band.'
      : !r.mc ? 'No walkable route under the hard slope limits.'
      : storm && r.timeS > deadlineS ? `Too slow: ${Math.round(r.timeS / 60)} min, past the rule.`
      : `Fails more often: ${pct(r.mc.failRate)} (95% CI ${pct(r.mc.ciLo)}–${pct(r.mc.ciHi)}).`
  }
  return chosen
}

const pct = (v: number) => `${(100 * v).toFixed(v < 0.1 ? 1 : 0)}%`

// ------------------------------------------------------------------------------------------------ route building

function toLiveRoute(r: RouteResult, sh: Shelter, start: { heat: number; o2: number; dose: number }, sepElapsedS: number, storm: boolean, deadlineS: number): LiveRoute | null {
  const s = S(), l = s.loaded!, p = s.params
  const base: LiveRoute = {
    destId: sh.id, destName: sh.name, destKind: sh.kind, destX: sh.x, destY: sh.y, shield: sh.shield,
    samples: [], turns: [], lengthM: 0, timeS: Infinity, climbM: 0, maxSlopeDeg: 0, bandLengthM: 0,
    admissible: r.admissible, reason: '', mc: null, chosen: false, failXY: r.failXY,
  }
  if (!r.path) return base
  const samples = buildSamples(r.path.xy, l.site, p, start, storm ? sepElapsedS : -1, !storm)
  const st = r.stats
  const mc = st ? (() => {
    const fail = 1 - st.pSafe
    const modes = Object.entries(st.causes).filter(([, v]) => v > 0).map(([label, v]) => ({ label, count: Math.round(v * st.n) })).sort((a, b) => b.count - a.count)
    return { n: st.n, successRate: st.pSafe, failRate: fail, ciLo: 1 - st.pSafeHi, ciHi: 1 - st.pSafeLo, p50S: st.tP50, p90S: st.tP90, modes, policy: r.policy, ms: r.simMs, planMs: r.planMs }
  })() : null
  void STATUS_LABEL; void deadlineS
  return {
    ...base, samples, turns: buildTurns(samples), lengthM: r.path.lengthM, timeS: r.path.timeS, climbM: r.path.climbM,
    maxSlopeDeg: r.path.maxSlopeDeg, bandLengthM: r.path.bandLengthM, mc,
  }
}

/** Resample the planner path every ~5 m and integrate the walker model along it (planner pace, model values). */
function buildSamples(xy: Float32Array, site: SiteData, p: Params, start: { heat: number; o2: number; dose: number }, sepElapsedS: number, bandActive: boolean): RouteSample[] {
  const n = site.meta.core.na, cell = SIM.CELL
  const idx = (x: number, y: number) => Math.min(n - 1, Math.max(0, (y / cell) | 0)) * n + Math.min(n - 1, Math.max(0, (x / cell) | 0))
  const comms = S().comms
  // smooth the cell-centre staircase a little (3-point moving average) so headings are stable
  const m = xy.length / 2
  const px: number[] = [], py: number[] = []
  for (let k = 0; k < m; k++) {
    const a = Math.max(0, k - 2), b = Math.min(m - 1, k + 2)
    let sx = 0, sy = 0
    for (let q = a; q <= b; q++) { sx += xy[q * 2]; sy += xy[q * 2 + 1] }
    px.push(k === 0 || k === m - 1 ? xy[k * 2] : sx / (b - a + 1)); py.push(k === 0 || k === m - 1 ? xy[k * 2 + 1] : sy / (b - a + 1))
  }
  const out: RouteSample[] = []
  let t = 0, d = 0, heat = start.heat, o2 = start.o2, dose = start.dose
  const coolJ = p.coolW
  for (let k = 0; k < m; k++) {
    const c = idx(px[k], py[k])
    if (k > 0) {
      const ds = Math.hypot(px[k] - px[k - 1], py[k] - py[k - 1])
      const dz = site.z[c] - site.z[idx(px[k - 1], py[k - 1])]
      const grade = ds > 0 ? dz / ds : 0
      const v = Math.max(0.15, p.vPlan * speedFactor(grade) / (1 + p.kSand * site.sand[c]))
      const dt = ds / v
      const met = p.metBase + SIM.MET_B * v + SIM.MET_C * v * v + (grade > 0 ? p.massKg * p.gMars * v * grade / SIM.ETA_UP / 4 : 0)
      heat = Math.max(0, heat + (met - coolJ) * dt / 1000)
      o2 = Math.max(0, o2 - met * SIM.O2_KG_PER_J * dt)
      const sep = sepElapsedS >= 0 ? sepDose(sepElapsedS + t, sepElapsedS + t + dt, p) : 0
      dose += p.gcrRate * dt / 3600 + sep
      t += dt; d += ds
    }
    let flags = 0
    if (site.beta[c] >= p.alphaDeg) flags |= FLAG.BAND
    if (site.slope[c] >= 15) flags |= FLAG.STEEP
    if (site.sand[c] > 0.5) flags |= FLAG.SAND
    if (comms && comms[c]) flags |= FLAG.NO_COMMS
    if (k === 0 || k === m - 1 || d - (out.length ? out[out.length - 1].d : 0) >= 4.5) {
      out.push({ x: px[k], y: py[k], z: site.z[c], d, t, o2Min: o2 / (SIM.O2_NOMINAL_W * SIM.O2_KG_PER_J) / 60, heatKJ: heat, doseUGy: dose, slopeDeg: site.slope[c], flags })
    } else if (flags) out[out.length - 1].flags |= flags
  }
  void bandActive
  return out
}

/** Turn-by-turn: simplify the route, then call out heading changes larger than 25°. */
function buildTurns(sm: RouteSample[]): Turn[] {
  if (sm.length < 3) return []
  // Douglas-Peucker on (x, y), 8 m tolerance
  const keep = new Uint8Array(sm.length); keep[0] = 1; keep[sm.length - 1] = 1
  const stack: [number, number][] = [[0, sm.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let best = -1, bd = 8
    const ax = sm[a].x, ay = sm[a].y, bx = sm[b].x, by = sm[b].y, L = Math.hypot(bx - ax, by - ay) || 1
    for (let i = a + 1; i < b; i++) {
      const dd = Math.abs((bx - ax) * (ay - sm[i].y) - (ax - sm[i].x) * (by - ay)) / L
      if (dd > bd) { bd = dd; best = i }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]) }
  }
  const v = [...keep.keys()].filter(i => keep[i])
  const turns: Turn[] = []
  for (let k = 1; k < v.length - 1; k++) {
    const a = sm[v[k - 1]], b = sm[v[k]], c = sm[v[k + 1]]
    // heading: x east, y south; bearing clockwise from north = atan2(dx, -dy)
    const h1 = Math.atan2(b.x - a.x, -(b.y - a.y)), h2 = Math.atan2(c.x - b.x, -(c.y - b.y))
    let da = (h2 - h1) * 180 / Math.PI
    while (da > 180) da -= 360
    while (da < -180) da += 360
    if (Math.abs(da) < 25) continue
    if (turns.length && b.d - turns[turns.length - 1].d < 25) continue
    const side = da > 0 ? 'right' : 'left'
    const word = Math.abs(da) < 50 ? 'Bear' : Math.abs(da) < 120 ? 'Turn' : 'Sharp'
    turns.push({ i: v[k], d: b.d, angleDeg: da, text: `${word} ${side}` })
  }
  return turns
}

// inspection hook for automated tests
;(globalThis as unknown as { __solwayLive: typeof useLive }).__solwayLive = useLive
