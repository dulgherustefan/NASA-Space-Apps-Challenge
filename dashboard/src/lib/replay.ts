// Plays a recorded run of the demo (tools/record_demo.py) in place of a live engine, so the dashboard can be
// shown from a static web page. The recording holds the engine's own messages with the second each was sent at.
import { REPLAY_BASE, setReplayFiles } from './config'
import { setConn, store, type ReplayState } from './store'
import type { EngineMsg, Hello } from './types'

type Frame = [number, EngineMsg | { type: '_files'; map: Record<string, string> }]
interface Recording { duration_s: number; hello: Hello; frames: Frame[] }
type Handler = (m: EngineMsg, quiet?: boolean) => void

let rec: Recording | null = null
let handle: Handler = () => {}
let settle: () => void = () => {}
let idx = 0
let elapsed = 0          // seconds of the recording already played
let last = 0             // performance.now() of the previous step
let timer: ReturnType<typeof setInterval> | null = null
let shown = -1           // position last written to the store, in quarter seconds

function apply(i: number, quiet = false) {
  const m = rec!.frames[i][1]
  if (m.type === '_files') setReplayFiles(m.map)
  else handle(m, quiet)
}

function publish(force = false) {
  const q = Math.floor(elapsed * 4)
  const cur = store.get().replay
  if (!cur || (!force && q === shown && cur.playing === !!timer)) return
  shown = q
  store.set({ replay: { ...cur, pos: Math.min(elapsed, cur.dur), playing: !!timer } })
}

/** Back to the state before the demo starts: hello, the first file map and the first snapshot. */
function rewind(quiet = false) {
  if (!rec) return
  stop()
  setReplayFiles(null)
  // the hello makes the page fetch parameters, the training curve and the arrival views, so the files come first
  for (const [t, m] of rec.frames) { if (t > 0) break; if (m.type === '_files') setReplayFiles(m.map) }
  handle(rec.hello, quiet)                             // quiet: the page already has the parameters and the views
  idx = 0
  elapsed = 0
  while (idx < rec.frames.length && rec.frames[idx][0] <= 0) apply(idx++, true)
  publish(true)
}

function stop() {
  if (timer) { clearInterval(timer); timer = null }
}

function step() {
  if (!rec) return
  const now = performance.now()
  elapsed += Math.min(0.5, (now - last) / 1000)       // a hidden tab resumes where it was, it does not jump ahead
  last = now
  while (idx < rec.frames.length && rec.frames[idx][0] <= elapsed) apply(idx++)
  if (idx >= rec.frames.length) { stop(); markPaused(true) }
  publish()
}

function play() {
  if (!rec || timer) return
  last = performance.now()
  timer = setInterval(step, 50)
  publish(true)
}

function markPaused(paused: boolean) {
  const s = store.get().snapshot
  if (s) store.set({ snapshot: { ...s, clock: { ...s.clock, paused } } })
}

/** Jump to a second of the recording. The messages up to it are applied without their sounds. */
export function replaySeek(to: number) {
  if (!rec) return
  const playing = !!timer
  const t = Math.min(rec.duration_s, Math.max(0, to))
  rewind(true)
  while (idx < rec.frames.length && rec.frames[idx][0] <= t) apply(idx++, true)
  elapsed = t
  settle()
  if (playing && idx < rec.frames.length) play()
  else markPaused(true)
  publish(true)
}

export async function startReplay(onMessage: Handler, afterSeek: () => void) {
  handle = onMessage
  settle = afterSeek
  store.set({ mode: 'replay' })
  setConn('connecting', 0)
  try {
    const r = await fetch(`${REPLAY_BASE}demo.json`, { cache: 'no-cache' })
    if (!r.ok) throw new Error(String(r.status))
    rec = (await r.json()) as Recording
  } catch {
    setConn('offline', 1)
    return
  }
  const marks: ReplayState['marks'] = []
  for (const [at, m] of rec.frames) if (m.type === 'incident') marks.push({ at, id: m.id, title: m.title, kind: m.kind })
  store.set({ replay: { pos: 0, dur: rec.duration_s, playing: false, marks } })
  setConn('online', 0)
  rewind()                                            // stays at the start: the run plays when the operator asks for it
}

/** The commands that make sense for a recording. Choosing a route or firing one incident needs a live engine. */
export function replayCmd(cmd: Record<string, unknown>): boolean {
  if (!rec) return false
  switch (cmd.cmd) {
    case 'demo':
    case 'start':
      rewind(); play(); return true
    case 'pause':
      stop(); markPaused(true); publish(true); return true
    case 'resume':
      if (idx >= rec.frames.length) rewind()
      play(); return true
    case 'reset':
      rewind(); return true
    case 'plan':
      // no engine behind a static page: the browser engine plans the walk and answers with the same message
      void import('@/live/bridge').then((m) => m.browserPlan(cmd, handle))
      return true
    default:
      return false
  }
}
