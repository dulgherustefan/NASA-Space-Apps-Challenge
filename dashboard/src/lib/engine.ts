import { ENGINE_URL, REPLAY, fileUrl } from './config'
import { replayCmd, startReplay } from './replay'
import { applyMessage, setConn, setRoutesFile, setTrajFile, store, type State } from './store'
import type { EngineMsg, ParamDef, PovItem, RoutesFile, TrajFile } from './types'

let ws: WebSocket | null = null
let retry: ReturnType<typeof setTimeout> | null = null
let attempts = 0
let started = false

async function getJson<T>(path: string): Promise<T | null> {
  const url = fileUrl(path, Date.now())
  if (!url) return null
  try {
    const r = await fetch(url, { cache: REPLAY ? 'default' : 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

export async function loadRoutes(path = 'runtime/routes.json') {
  const f = await getJson<RoutesFile>(path)
  if (f && Array.isArray(f.routes)) setRoutesFile(f)
}
export async function loadTrajectories(path = 'runtime/trajectories.json') {
  const f = await getJson<TrajFile>(path)
  if (f && Array.isArray(f.runs)) setTrajFile(f)
}
export async function loadParams() {
  store.set((s) => ({ params: { ...s.params, status: 'loading' } }))
  const j = await getJson<unknown>('runtime/params.json')
  if (j === null) return store.set({ params: { status: 'missing', items: [] } })
  const arr = Array.isArray(j) ? j : Array.isArray((j as { params?: unknown }).params) ? (j as { params: unknown[] }).params : Object.values(j as object)
  const items = (arr as ParamDef[]).filter((p) => p && typeof p === 'object' && 'label' in p)
  store.set({ params: { status: items.length ? 'ready' : 'error', items } })
}
export async function loadPov() {
  const j = await getJson<Record<string, PovItem> | { views?: Record<string, PovItem> }>('data/site/pov/pov.json')
  const views = j && typeof j === 'object' ? ((j as { views?: Record<string, PovItem> }).views ?? (j as Record<string, PovItem>)) : null
  const ok: Record<string, PovItem> = {}
  for (const [id, v] of Object.entries(views ?? {})) if (v && typeof v === 'object' && typeof v.file === 'string') ok[id] = v
  store.set({ pov: ok })
}
export async function loadTraining() {
  store.set((s) => ({ training: s.training.status === 'ready' ? s.training : { status: 'loading' } }))
  const j = await getJson<unknown>('data/ast/ast_training.json')
  store.set({ training: j === null ? { status: 'missing' } : { status: 'ready', data: j } })
}

/** A new warning is announced once by a recorded voice line (public/audio/voice); an advisory stays silent. */
function raiseAlarm(_id: string, urgent: boolean, kind?: string) {
  if (!urgent) return
  void import('@/live/hud/voice').then((v) => v.playClip(kind === 'quake' ? 'quake_alert' : 'storm_alert', 3))
}
function stopAlarm() { /* the voice line plays once; nothing repeats */ }
export function acknowledge() {
  stopAlarm()
  store.set({ alertId: null })
}

let midLoaded = false
/** quiet: a recorded run is being moved to another moment, so nothing sounds and files are fetched once at the end. */
function handle(msg: EngineMsg, quiet = false) {
  applyMessage(msg)
  if (quiet) return
  switch (msg.type) {
    case 'hello':
      midLoaded = false
      void loadParams()
      void loadPov()
      // Optional hint outside the contract: ast === false means the offline stress-test output has not
      // arrived, so there is no training file to ask for (saves a 404 on every connect).
      if ((msg as { ast?: unknown }).ast === false) store.set({ training: { status: 'missing' } })
      else void loadTraining()
      break
    case 'snapshot':
      // Joined mid-incident: pick up files already on disk. Before that they may not exist yet.
      if (!midLoaded && msg.phase && (msg.phase === 'simulate' || msg.phase === 'respond')) { midLoaded = true; void loadRoutes(); void loadTrajectories() }
      break
    case 'incident':
      if (store.get().alertId === msg.id) raiseAlarm(msg.id, msg.kind !== 'science', msg.kind)
      break
    case 'routes':
      void loadRoutes()
      break
    case 'plan':
      if (msg.ok && msg.file) { void loadRoutes(msg.file); if (msg.trajectories) void loadTrajectories(msg.trajectories) }
      break
    case 'stress':
      void loadTrajectories()
      break
  }
}

function open() {
  setConn('connecting', attempts)
  try {
    ws = new WebSocket(ENGINE_URL)
  } catch {
    schedule()
    return
  }
  ws.onopen = () => { attempts = 0; setConn('online', 0) }
  ws.onmessage = (ev) => {
    try { handle(JSON.parse(String(ev.data)) as EngineMsg) } catch (e) { console.warn('bad message', e) }
  }
  ws.onclose = () => { ws = null; setConn('offline', attempts); schedule() }
  ws.onerror = () => { /* onclose follows */ }
}
function schedule() {
  if (retry) return
  attempts += 1
  const wait = Math.min(4000, 500 * attempts)
  retry = setTimeout(() => { retry = null; open() }, wait)
}

/** After a jump in a recorded run: no alert pending, and the route files of that moment. */
export function settleAfterSeek() {
  acknowledge()
  const st = store.get()
  if (Object.values(st.incidents).some((b) => b.routes)) { void loadRoutes(); void loadTrajectories() }
}

export function startEngine() {
  if (started) return
  started = true
  if (REPLAY) void startReplay(handle, settleAfterSeek)
  else open()
}

export function sendCmd(cmd: Record<string, unknown>): boolean {
  if (REPLAY) return replayCmd(cmd)
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(cmd)); return true }
  return false
}

/** Nothing has run yet: the clock is at zero and no incident has come in. */
export function notStarted(s: State): boolean {
  if (s.replay) return s.replay.pos < 0.05 && !s.replay.playing
  return !s.snapshot || (s.snapshot.clock.paused && s.snapshot.t < 0.5 && s.order.length === 0)
}
export function isRunning(s: State): boolean {
  return s.replay ? s.replay.playing : !!s.snapshot && !s.snapshot.clock.paused
}
/** Play, pause or resume: the one transport action, shared by the button and the space bar. */
export function togglePlay() {
  const s = store.get()
  if (s.conn !== 'online') return
  if (s.replay) sendCmd({ cmd: s.replay.playing ? 'pause' : 'resume' })
  else if (notStarted(s)) sendCmd({ cmd: 'demo' })
  else sendCmd({ cmd: s.snapshot?.clock.paused ? 'resume' : 'pause' })
}

/** Ask the engine for a walking route to a point of the map (free planning, no incident). */
export function requestPlan(to: { e: number; s: number }) {
  const from = store.get().planFrom
  const cmd: Record<string, unknown> = { cmd: 'plan', to: { e: Math.round(to.e * 10) / 10, s: Math.round(to.s * 10) / 10 } }
  if (from) cmd.from = from
  if (sendCmd(cmd)) store.set({ planPending: to, planFail: null })
}

/** Leave the plan and go back to the live incident, whose route files the plan had replaced on the map. */
export function closePlan() {
  store.set({ focusId: null, selectedRoute: null, planFail: null })
  void loadRoutes()
  void loadTrajectories()
}

export function retryNow() {
  if (REPLAY) { void startReplay(handle, settleAfterSeek); return }
  if (retry) { clearTimeout(retry); retry = null }
  if (!ws) open()
}
