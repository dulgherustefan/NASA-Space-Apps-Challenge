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
