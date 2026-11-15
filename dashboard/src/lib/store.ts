import { useSyncExternalStore } from 'react'
import type {
  Assessment, CrewState, Decision, EngineMsg, Hello, Incident, IncidentKind, ParamDef, Phase, PlanMsg, PovItem, RouteSummary, RoutesFile, RoutesMsg, Snapshot, Stress, TrajFile,
} from './types'
import { readTheme, type Theme } from './theme'

export type Conn = 'connecting' | 'online' | 'offline'

export interface IncidentBundle {
  id: string
  incident: Incident
  assessment?: Assessment
  routes?: RouteSummary[]
  stress: Record<number, Stress>
  decision?: Decision
  /** set when this bundle is a free plan, not an incident: routes and stress come from the plan message */
  plan?: PlanMsg
  /** mission time at which each stage message arrived */
  stageT: Partial<Record<Exclude<Phase, 'idle'>, number>>
}

export interface LogEntry {
  n: number
  t: number
  wall: number
  type: string
  level?: string
  title: string
  detail?: string
  source?: string
  incident_id?: string
  raw: unknown
}

export interface SensorPoint { t: number; dose_rate: number; seismic: number; tau: number }

/** One group of supporting detail under the response; only one is open at a time. */
export type DetailId = 'why' | 'routes' | 'crew' | 'hazard' | 'conditions' | 'places' | 'view'
/** Position in a recorded run, in seconds of the recording. */
export interface ReplayState { pos: number; dur: number; playing: boolean; marks: { at: number; id: string; title: string; kind: IncidentKind }[] }

export interface TrainingState { status: 'idle' | 'loading' | 'missing' | 'ready' | 'error'; data?: unknown }

export interface State {
  /** live: a running engine. replay: a recorded run played from static files. */
  mode: 'live' | 'replay'
  conn: Conn
  attempts: number
  lastMsgAt: number
  hello: Hello | null
  snapshot: Snapshot | null
  incidents: Record<string, IncidentBundle>
  order: string[]
  focusId: string | null
  sensors: SensorPoint[]
  log: LogEntry[]
  routesFile: RoutesFile | null
  routesV: number
  trajFile: TrajFile | null
  trajV: number
  overlayV: number
  params: { status: 'idle' | 'loading' | 'missing' | 'ready' | 'error'; items: ParamDef[] }
  training: TrainingState
  /** arrival views by place id; empty when the site has none */
  pov: Record<string, PovItem>
  overlay: { layer: string | null; opacity: number; userSet: boolean }
  contours: boolean
  selectedRoute: number | null
  showReplays: boolean
  routeChangedAt: Record<string, number>
  trails: Record<number, [number, number][]>
  /** wall time of the newest incident, for the alert cue */
  alertAt: number
  /** incident whose alert nobody has acknowledged yet */
  alertId: string | null
  /** the open detail group, or null when all are closed */
  detail: DetailId | null
  /** place picked on the map */
  selectedPlace: string | null
  theme: Theme
  /** set while a recorded run is loaded */
  replay: ReplayState | null
  /** "Plan a walk" is on: a click on the map asks the engine for a route to that point */
  planMode: boolean
  /** start point picked by the operator; null means the crew's position */
  planFrom: { e: number; s: number } | null
  /** destination sent to the engine and not answered yet */
  planPending: { e: number; s: number } | null
  /** the last plan the engine refused, with its reason */
  planFail: PlanMsg | null
}

const initial = (): State => ({
  mode: 'live', conn: 'connecting', attempts: 0, lastMsgAt: 0, hello: null, snapshot: null,
  incidents: {}, order: [], focusId: null, sensors: [], log: [],
  routesFile: null, routesV: 0, trajFile: null, trajV: 0, overlayV: 0,
  params: { status: 'idle', items: [] }, training: { status: 'idle' }, pov: {},
  overlay: { layer: 'hazard', opacity: 0.42, userSet: false }, contours: true, selectedRoute: null, showReplays: true,
  routeChangedAt: {}, trails: {}, alertAt: 0, alertId: null, detail: null, selectedPlace: null, theme: readTheme(), replay: null,
  planMode: false, planFrom: null, planPending: null, planFail: null,
})

let state: State = initial()
const listeners = new Set<() => void>()
let logN = 0

export const store = {
  get: () => state,
  set(patch: Partial<State> | ((s: State) => Partial<State>)) {
    const p = typeof patch === 'function' ? patch(state) : patch
    state = { ...state, ...p }
    listeners.forEach((l) => l())
  },
  subscribe(l: () => void) {
    listeners.add(l)
    return () => { listeners.delete(l) }
  },
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(state))
}

// ---- derived helpers ---------------------------------------------------------------------------
export function focusIncidentId(s: State): string | null {
  return s.focusId ?? s.snapshot?.incident_id ?? s.order[s.order.length - 1] ?? null
}
export function focusBundle(s: State): IncidentBundle | null {
  const id = focusIncidentId(s)
  return id ? s.incidents[id] ?? null : null
}
export const PHASES: Exclude<Phase, 'idle'>[] = ['detect', 'assess', 'simulate', 'respond']

// ---- reducers ----------------------------------------------------------------------------------
function pushLog(e: Omit<LogEntry, 'n' | 'wall'>) {
  const entry: LogEntry = { ...e, n: ++logN, wall: Date.now() }
  const log = state.log.length > 2000 ? state.log.slice(-1500) : state.log
  return [...log, entry]
}

let lastSensorWall = 0

export function applyMessage(msg: EngineMsg) {
  const now = Date.now()
  switch (msg.type) {
    case 'hello': {
      // a hello starts a fresh session: the engine was (re)started or reset
      logN = 0
      lastSensorWall = 0
      const keepConn = state.conn
      state = { ...initial(), mode: state.mode, conn: keepConn, hello: msg, lastMsgAt: now, params: state.params, training: state.training, pov: state.pov, overlay: { ...state.overlay, userSet: false }, contours: state.contours, theme: state.theme, replay: state.replay }
      state.log = pushLog({ t: msg.t, type: 'hello', title: `Connected to ${msg.product} ${msg.version}`, detail: msg.site.name, source: 'engine', raw: msg })
      listeners.forEach((l) => l())
      return
    }
    case 'snapshot': {
      const prev = state.snapshot
      const patch: Partial<State> = { snapshot: msg, lastMsgAt: now }
      if (prev && msg.t < prev.t - 1) {
        // mission clock went backwards: treat as a reset
        Object.assign(patch, { incidents: {}, order: [], focusId: null, sensors: [], routesFile: null, trajFile: null, selectedRoute: null, trails: {}, routeChangedAt: {}, alertId: null, detail: null })
      }
      // one point per 0.5 s of wall time, and only while the mission clock moves
      const lastPt = (patch.sensors ?? state.sensors)[(patch.sensors ?? state.sensors).length - 1]
      if (now - lastSensorWall > 500 && (!lastPt || msg.t !== lastPt.t)) {
        lastSensorWall = now
        const base = patch.sensors ?? state.sensors
        const sensors = base.length >= 240 ? base.slice(-239) : base.slice()
        sensors.push({ t: msg.t, ...msg.sensors })
        patch.sensors = sensors
      }
      // short position trails for the map
      const trails = { ...state.trails }
      for (const c of msg.crew) {
        let tr = trails[c.id] ? trails[c.id].slice() : []
        const last = tr[tr.length - 1]
        const step = last ? Math.hypot(last[0] - c.e, last[1] - c.s) : Infinity
        // a jump (reset, trigger that moves the crew) starts a new trail instead of drawing a straight line
        if (last && step > 120) tr = []
        if (!last || step > 6) tr.push([c.e, c.s])
        if (tr.length > 140) tr.shift()
        trails[c.id] = tr
      }
      patch.trails = trails
      store.set(patch)
      return
    }
    case 'incident': {
      const b: IncidentBundle = { id: msg.id, incident: msg, stress: {}, stageT: { detect: msg.t } }
      const order = state.order.includes(msg.id) ? state.order : [...state.order, msg.id]
      // a late client receives old incidents again, before its first snapshot: only an incident that is live now raises the alert
      const fresh = !!state.snapshot && Math.abs(state.snapshot.t - msg.t) < 30
      store.set({
        incidents: { ...state.incidents, [msg.id]: b }, order, focusId: null, selectedRoute: null,
        overlay: { ...state.overlay, userSet: false }, detail: null,
        alertAt: fresh ? now : state.alertAt, alertId: fresh ? msg.id : state.alertId,
        log: pushLog({ t: msg.t, type: 'incident', title: msg.title, detail: msg.summary, source: msg.source, incident_id: msg.id, raw: msg }),
      })
      return
    }
    case 'assessment': {
      const b = state.incidents[msg.incident_id]
      if (!b) return
      const first = msg.overlays?.[0]?.layer
      const overlay = !state.overlay.userSet && first ? { ...state.overlay, layer: first } : state.overlay
      store.set({
        incidents: { ...state.incidents, [msg.incident_id]: { ...b, assessment: msg, stageT: { ...b.stageT, assess: msg.t } } },
        overlayV: state.overlayV + 1, overlay,
        log: pushLog({ t: msg.t, type: 'assessment', title: `Assessment: ${msg.changes.length} changes`, detail: msg.changes.map((c) => `${c.label} ${c.value}${c.unit ? ' ' + c.unit : ''} [${c.kind}]`).join('; '), incident_id: msg.incident_id, raw: msg }),
      })
      return
    }
    case 'routes': {
      const b = state.incidents[msg.incident_id]
      if (!b) return
      const changed = { ...state.routeChangedAt }
      for (const r of msg.routes) {
        const old = b.routes?.find((x) => x.id === r.id)
        if (old && old.status !== r.status) changed[`${msg.incident_id}:${r.id}`] = now
      }
      const first = !b.routes
      store.set({
        incidents: { ...state.incidents, [msg.incident_id]: { ...b, routes: msg.routes, stageT: { ...b.stageT, simulate: b.stageT.simulate ?? msg.t } } },
        routeChangedAt: changed,
        // the candidates open by themselves while the choice is still being made
        detail: first && !b.decision && state.detail === null ? 'routes' : state.detail,
        log: first ? pushLog({ t: msg.t, type: 'routes', title: `${msg.routes.length} candidate routes`, detail: msg.routes.map((r) => `${r.id}: ${r.label ?? r.shelter} ${r.length_m} m, ${Math.round(r.time_s / 60)} min`).join('; '), incident_id: msg.incident_id, raw: msg }) : state.log,
      })
      return
    }
    case 'stress': {
      const id = msg.incident_id ?? focusIncidentId(state)
      if (!id || !state.incidents[id]) return
      const b = state.incidents[id]
      store.set({
        incidents: { ...state.incidents, [id]: { ...b, stress: { ...b.stress, [msg.route_id]: msg } } },
        overlayV: state.overlayV + 1,
        log: pushLog({ t: msg.t, type: 'stress', title: `Stress result, route ${msg.route_id} (${msg.method})`, detail: `${msg.robustness_nats !== null ? `robustness ${msg.robustness_nats} nats; ` : ''}failure rate ${msg.mc_fail_rate ?? 'n/a'}; ${msg.failures.length} failure modes`, source: msg.source, incident_id: id, raw: msg }),
      })
      return
    }
    case 'decision': {
      const id = msg.incident_id ?? focusIncidentId(state)
      if (!id || !state.incidents[id]) return
      const b = state.incidents[id]
      store.set({
        incidents: { ...state.incidents, [id]: { ...b, decision: msg, stageT: { ...b.stageT, respond: msg.t } } },
        selectedRoute: null, detail: !b.decision && state.detail === 'routes' ? null : state.detail,
        log: pushLog({ t: msg.t, type: 'decision', title: `Route ${msg.route_id} chosen${msg.auto === false ? ' (operator)' : ''}`, detail: msg.reasons.join('; '), incident_id: id, raw: msg }),
      })
      return
    }
    case 'plan': {
      if (!msg.ok || !msg.routes) {
        store.set({ planPending: null, planFail: msg, log: pushLog({ t: msg.t, type: 'plan', level: 'warn', title: 'Plan refused', detail: msg.reason, source: 'engine', raw: msg }) })
        return
      }
      // A plan is kept beside the incidents, not in their order: it never shows in the incident list.
      const b: IncidentBundle = {
        id: msg.id, plan: msg, routes: msg.routes, stageT: {},
        stress: Object.fromEntries((msg.stress ?? []).map((s) => [s.route_id, { ...s, type: 'stress' as const, t: msg.t }])),
        incident: { type: 'incident', t: msg.t, id: msg.id, kind: 'science', title: 'Planned walk', scenario: false },
      }
      store.set({
        incidents: { ...state.incidents, [msg.id]: b }, focusId: msg.id, selectedRoute: msg.recommended ?? null,
        planPending: null, planFail: null, detail: null,
        log: pushLog({ t: msg.t, type: 'plan', title: `Planned walk to ${msg.to?.label ?? `e ${Math.round(msg.to?.e ?? 0)}, s ${Math.round(msg.to?.s ?? 0)}`}`, detail: msg.routes.map((r) => `${r.label ?? r.id}: ${r.length_m} m, ${Math.round(r.time_s / 60)} min`).join('; '), source: 'engine', raw: msg }),
      })
      return
    }
    case 'log':
      store.set({ log: pushLog({ t: msg.t, type: 'log', level: msg.level, title: msg.text, source: msg.source, raw: msg }) })
      return
  }
}

export function setConn(conn: Conn, attempts = 0) {
  store.set({ conn, attempts })
}
export function setRoutesFile(f: RoutesFile | null) { store.set((s) => ({ routesFile: f, routesV: s.routesV + 1 })) }
export function setTrajFile(f: TrajFile | null) { store.set((s) => ({ trajFile: f, trajV: s.trajV + 1 })) }

export function crewById(s: State, id: number): CrewState | undefined {
  return s.snapshot?.crew.find((c) => c.id === id)
}
export type { RoutesMsg }
