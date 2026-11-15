// Bridge between the main dashboard (recorded-run web build) and the browser engine: answers the dashboard's own
// `plan` command with the same message shapes the Python engine sends (docs/CONTRACT.md), so "Plan a walk" works
// live on the static site with the existing panel and map, unchanged.
import { setRoutesFile, store } from '@/lib/store'
import { CORE_DEFAULT } from '@/lib/config'
import type { EngineMsg, PlanMsg, RouteSummary, RoutesFile, Stress } from '@/lib/types'
import { SIM } from './engine/params'
import { buildSamples, buildTurns, planPoint, useLive } from './store'
import { FLAG, type Incident, type LiveRoute } from './types'

let seq = 0
const O2_FULL_MIN = SIM.O2_TANK_KG / (SIM.O2_NOMINAL_W * SIM.O2_KG_PER_J) / 60

function coreBox() { return store.get().hello?.site.core ?? CORE_DEFAULT }

export async function browserPlan(cmd: Record<string, unknown>, handle: (m: EngineMsg) => void) {
  const st = store.get()
  const t = st.snapshot?.t ?? 0
  const id = `plan-browser-${++seq}`
  const core = coreBox()
  const to = cmd.to as { e: number; s: number } | undefined
  const crew = st.snapshot?.crew?.[0]
  const from = (cmd.from as { e: number; s: number } | undefined) ?? (crew ? { e: crew.e, s: crew.s } : { e: core.e0 + 2800, s: core.s0 + 1500 })
  if (!to) return
  try {
    const r = await planPoint({ x: from.e - core.e0, y: from.s - core.s0 }, { x: to.e - core.e0, y: to.s - core.s0 })
    if (!r) {
      handle({ type: 'plan', t, id, ok: false, reason: 'No walkable route to that point under the hard slope limits (computed in your browser).' } as PlanMsg)
      return
    }
    const p = useLive.getState().params
    const last = r.samples[r.samples.length - 1]
    const gcr = p.gcrRate * last.t / 3600
    const doseMsv = (gcr * 3.05 + Math.max(0, last.doseUGy - gcr)) / 1000
    let heatPeak = 0, nolos = 0
    for (let i = 0; i < r.samples.length; i++) {
      heatPeak = Math.max(heatPeak, r.samples[i].heatKJ)
      if (i && r.samples[i].flags & FLAG.NO_COMMS) nolos += r.samples[i].d - r.samples[i - 1].d
    }
    const mc = r.mc
    const summary: RouteSummary = {
      id: 0, shelter: 'Chosen point', label: 'Planned in your browser', length_m: Math.round(r.lengthM), time_s: Math.round(r.timeS),
      ascent_m: Math.round(r.climbM), max_slope: Math.round(r.maxSlopeDeg * 10) / 10,
      o2_margin: Math.round(Math.max(0, last.o2Min / O2_FULL_MIN) * 1000) / 1000, heat_margin: Math.round(Math.max(0, 1 - heatPeak / p.heatMaxKJ) * 1000) / 1000,
      dose: Math.round(doseMsv * 10000) / 10000, robustness_nats: null, mc_fail_rate: mc ? Math.round(mc.failRate * 10000) / 10000 : null,
      status: 'chosen', band_m: Math.round(r.bandLengthM), rule_ok: true, nolos_m: Math.round(nolos),
    }
    const stress: Stress = {
      type: 'stress', t, incident_id: id, route_id: 0, method: 'mc',
      source: `browser Monte Carlo: ${mc?.n ?? 0} virtual crews, ${mc?.policy === 'rl' ? 'trained PPO walking policy' : 'scripted walker'} (Web Workers)`,
      robustness_nats: null, mc_fail_rate: summary.mc_fail_rate, mc_ci: mc ? [mc.ciLo, mc.ciHi] : undefined, n: mc?.n, failures: [],
    }
    const file: RoutesFile = {
      incident_id: id,
      routes: [{ id: 0, shelter: 'Chosen point', points: r.samples.map(s => [s.x + core.e0, s.y + core.s0, s.z] as [number, number, number]), time_s: summary.time_s, length_m: summary.length_m }],
    }
    const msg: PlanMsg = {
      type: 'plan', t, id, ok: true, from: { e: from.e, s: from.s, label: crew && !cmd.from ? 'Crew position' : 'Chosen start' }, to: { e: to.e, s: to.s, label: null },
      routes: [summary], stress: [stress], recommended: 0,
      note: `Planned live in your browser: Dijkstra planner on the 5 m HiRISE grid, then ${mc?.n ?? 0} virtual crews (${Math.round((mc?.ms ?? 0) + (mc?.planMs ?? 0))} ms).`,
    }
    handle(msg)
    setRoutesFile(file)
  } catch (e) {
    handle({ type: 'plan', t, id, ok: false, reason: `Browser engine failed: ${(e as Error).message}` } as PlanMsg)
  }
}

/** The route the dashboard shows now (incident decision or plan), as a LiveRoute for the 3D and helmet views. */
export function currentRoute(): { route: LiveRoute; incident: Incident | null } | null {
  const st = store.get()
  const f = st.routesFile
  const l = useLive.getState().loaded
  if (!f || !l || !f.routes.length) return null
  const core = coreBox()
  const bundle = st.incidents[f.incident_id]
  const decided = bundle?.decision?.route_id
  const want = st.selectedRoute ?? decided ?? bundle?.plan?.recommended ?? f.routes[0].id
  const rf = f.routes.find(r => r.id === want) ?? f.routes[0]
  const xy = new Float32Array(rf.points.length * 2)
  rf.points.forEach((p, i) => { xy[i * 2] = p[0] - core.e0; xy[i * 2 + 1] = p[1] - core.s0 })
  const kind = bundle?.incident?.kind
  const storm = kind === 'sep'
  const p = useLive.getState().params
  const samples = buildSamples(xy, l.site, p, { heat: 60, o2: 0.46, dose: 0 }, storm ? 0 : -1, kind === 'quake')
  if (samples.length < 2) return null
  // keep the engine's own walking time: scale the model clock to it
  const k = rf.time_s > 0 && samples[samples.length - 1].t > 0 ? rf.time_s / samples[samples.length - 1].t : 1
  for (const s of samples) s.t *= k
  const end = rf.points[rf.points.length - 1]
  const sh = bundle?.assessment?.shelters?.find(x => x.id === rf.shelter || x.name === rf.shelter)
  const name = sh?.name ?? rf.shelter
  const destKind: LiveRoute['destKind'] = /rover/i.test(name) ? 'rover' : /habitat/i.test(name) ? 'habitat' : 'terrain'
  const route: LiveRoute = {
    destId: String(rf.shelter), destName: name, destKind, destX: end[0] - core.e0, destY: end[1] - core.s0, shield: sh?.shield ?? 0,
    samples, turns: buildTurns(samples), lengthM: rf.length_m, timeS: rf.time_s, climbM: 0, maxSlopeDeg: Math.max(...samples.map(s => s.slopeDeg)),
    bandLengthM: 0, admissible: true, reason: '', mc: null, chosen: true, failXY: null,
  }
  const limit = bundle?.assessment?.limits?.shelter_s
  const incident: Incident | null = kind === 'sep' || kind === 'quake'
    ? { kind: storm ? 'storm' : 'quake', startedAt: Date.now(), ruleS: storm ? (limit ?? p.shelterRuleMin * 60) : 0 }
    : null
  return { route, incident }
}

// ------------------------------------------------------------------------------------------------ incident drill
// "Storm drill" / "Quake drill" on the main dashboard: the next click on the map places the crew there, the browser
// engine plans and stress-tests a route to every open shelter, and the dashboard shows it as an incident with the
// existing panel (incident, assessment, routes, stress, decision messages: docs/CONTRACT.md shapes).

type DrillKind = 'storm' | 'quake'
let drillPick: DrillKind | null = null
let drillSeq = 0
const drillSubs = new Set<() => void>()
export function getDrillPick() { return drillPick }
export function setDrillPick(k: DrillKind | null) { drillPick = k; drillSubs.forEach(f => f()) }
export function subscribeDrill(f: () => void) { drillSubs.add(f); return () => { drillSubs.delete(f) } }

export async function runDrill(kind: DrillKind, at: { e: number; s: number }) {
  setDrillPick(null)
  const live = await import('./store')
  const { applyMessage } = await import('@/lib/store')
  const { sendCmd } = await import('@/lib/engine')
  const st = store.get()
  if (st.replay?.playing) sendCmd({ cmd: 'pause' })
  const core = coreBox()
  const t = store.get().snapshot?.t ?? 0
  const id = `drill-${kind}-${++drillSeq}`
  const storm = kind === 'storm'
  store.set({ planMode: false, selectedPlace: null })
  applyMessage({
    type: 'incident', t, id, kind: storm ? 'sep' : 'quake', scenario: true, source: 'browser engine (drill)',
    title: storm ? 'Solar storm drill' : 'Marsquake drill',
    summary: storm
      ? 'Drill: a solar particle event starts now with the crew at the point you clicked. The browser plans a route to every open shelter and stress-tests each one.'
      : 'Drill: a marsquake now; the rockfall runout band is active and shelters inside it are closed. The browser plans and stress-tests a way out.',
    e: at.e, s: at.s,
  })
  // the crew stands where you clicked for this drill
  const moveCrew = () => {
    const snap = store.get().snapshot
    if (snap) applyMessage({ ...snap, incident_id: id, phase: 'respond', crew: snap.crew.map((c, k) => ({ ...c, e: at.e + k * 3, s: at.s + k * 2, status: 0 })) })
  }
  moveCrew()
  store.set({ focusId: id })
  try {
    await live.ensureBundled()
    live.clearIncident()
    live.setCrew(at.e - core.e0, at.s - core.s0)
    await live.trigger(kind)
    // wait for the full stress test (pass 2)
    await new Promise<void>(res => {
      const chk = () => { const s = live.useLive.getState(); if (s.phase === 'planned' && !s.refining) { un(); res() } }
      const un = live.useLive.subscribe(chk); chk()
    })
  } catch (e) {
    applyMessage({ type: 'log', t, level: 'error', text: `Drill failed: ${(e as Error).message}` })
    return
  }
  const L = live.useLive.getState()
  const p = L.params
  const ruleS = storm ? p.shelterRuleMin * 60 : null
  const crew = L.crew!
  // reuse the dashboard's own place names; other terrain cover is named by where it is from the crew
  const places = store.get().hello?.places ?? []
  const routes = L.routes.map(r => {
    if (r.destKind !== 'terrain') return r
    const px = places.find(q => Math.hypot(q.e - core.e0 - r.destX, q.s - core.s0 - r.destY) < 80)
    if (px) return { ...r, destName: px.name }
    const dx = r.destX - crew.x, dy = r.destY - crew.y
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
    const b = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360
    return { ...r, destName: `Terrain cover ${Math.round(Math.hypot(dx, dy) / 10) * 10} m ${dirs[Math.round(b / 45) % 8]}` }
  })
  const shelters = routes.map(r => ({ id: r.destId, name: r.destName, e: r.destX + core.e0, s: r.destY + core.s0, open: r.admissible, reason: r.admissible ? undefined : 'inside the active rockfall band', shield: r.shield }))
  applyMessage({
    type: 'assessment', t, incident_id: id, shelters, limits: { shelter_s: ruleS, peak_s: null },
    changes: storm
      ? [{ label: 'Shelter rule', value: p.shelterRuleMin, unit: 'min', kind: 'requirement', source: 'arXiv 2502.02469' }]
      : [{ label: 'Rockfall reach angle', value: p.alphaDeg, unit: '°', kind: 'measured', source: 'site rockfall analysis (pipeline/)' }],
  })
  const summaries: RouteSummary[] = routes.map((r, i) => {
    const last = r.samples[r.samples.length - 1]
    let heatPeak = 0, nolos = 0
    r.samples.forEach((s, k) => { heatPeak = Math.max(heatPeak, s.heatKJ); if (k && s.flags & FLAG.NO_COMMS) nolos += s.d - r.samples[k - 1].d })
    const gcr = last ? p.gcrRate * last.t / 3600 : 0
    const late = storm && ruleS !== null && r.timeS > ruleS
    return {
      id: i, shelter: r.destName, label: r.destName, length_m: Math.round(r.lengthM || 0), time_s: isFinite(r.timeS) ? Math.round(r.timeS) : 0,
      ascent_m: Math.round(r.climbM), max_slope: Math.round(r.maxSlopeDeg * 10) / 10,
      o2_margin: last ? Math.round(Math.max(0, last.o2Min / O2_FULL_MIN) * 1000) / 1000 : 0,
      heat_margin: Math.round(Math.max(0, 1 - heatPeak / p.heatMaxKJ) * 1000) / 1000,
      dose: last ? Math.round((gcr * 3.05 + Math.max(0, last.doseUGy - gcr)) / 1000 * 10000) / 10000 : 0,
      robustness_nats: null, mc_fail_rate: r.mc ? Math.round(r.mc.failRate * 10000) / 10000 : null,
      status: !r.samples.length ? 'infeasible' : r.chosen ? 'chosen' : !r.admissible || late ? 'rejected' : 'tested',
      band_m: Math.round(r.bandLengthM), rule_ok: r.admissible && !late, rule_reasons: !r.admissible ? ['ends inside the active rockfall band'] : late ? [`takes ${Math.round(r.timeS / 60)} min, past the ${p.shelterRuleMin}-min rule`] : [],
      nolos_m: Math.round(nolos),
    }
  })
  applyMessage({ type: 'routes', t, incident_id: id, routes: summaries })
  setRoutesFile({
    incident_id: id,
    routes: routes.map((r, i) => ({ id: i, shelter: r.destName, points: r.samples.map(s => [s.x + core.e0, s.y + core.s0, s.z] as [number, number, number]), time_s: summaries[i].time_s, length_m: summaries[i].length_m })).filter(r => r.points.length > 1),
  })
  routes.forEach((r, i) => {
    if (!r.mc) return
    applyMessage({
      type: 'stress', t, incident_id: id, route_id: i, method: 'mc', source: `browser Monte Carlo, ${r.mc.n} virtual crews, ${r.mc.policy === 'rl' ? 'trained PPO walking policy' : 'scripted walker'}`,
      robustness_nats: null, mc_fail_rate: summaries[i].mc_fail_rate, mc_ci: [r.mc.ciLo, r.mc.ciHi], n: r.mc.n,
      failures: [],
    })
  })
  const ci = routes.findIndex(r => r.chosen)
  if (ci >= 0) {
    const c = routes[ci], s = summaries[ci]
    applyMessage({
      type: 'decision', t, incident_id: id, route_id: ci, shelter: c.destName, auto: true,
      reasons: [c.reason, `Computed in your browser from the clicked point (e ${Math.round(crew.x + core.e0)}, s ${Math.round(crew.y + core.s0)}).`],
      avoided: routes.filter(r => !r.chosen).map(r => ({ label: r.destName, detail: r.reason })),
      time_to_shelter_s: s.time_s, margins: { o2: s.o2_margin, heat: s.heat_margin, dose: s.dose }, dose_msv: s.dose,
    })
  }
  moveCrew()
  store.set({ focusId: id, selectedRoute: ci >= 0 ? ci : null })
}
