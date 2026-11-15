import { ENGINE_URL, REPLAY, fileUrl } from './config'
import { replayCmd, startReplay } from './replay'
import { applyMessage, setConn, setRoutesFile, setTrajFile, store } from './store'
import type { EngineMsg, ParamDef, PovItem, RoutesFile, TrajFile } from './types'
import { chime } from './alert'

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

let midLoaded = false
function handle(msg: EngineMsg) {
  applyMessage(msg)
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
      if (store.get().alertAt > Date.now() - 500) chime(msg.kind !== 'science')
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

export function startEngine() {
  if (started) return
  started = true
  if (REPLAY) void startReplay(handle)
  else open()
}

export function sendCmd(cmd: Record<string, unknown>): boolean {
  if (REPLAY) return replayCmd(cmd)
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(cmd)); return true }
  return false
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
  if (REPLAY) { void startReplay(handle); return }
  if (retry) { clearTimeout(retry); retry = null }
  if (!ws) open()
}
