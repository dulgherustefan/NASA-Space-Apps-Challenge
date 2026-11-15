// Plays a recorded run of the demo (tools/record_demo.py) in place of a live engine, so the dashboard can be
// shown from a static web page. The recording holds the engine's own messages with the second each was sent at.
import { REPLAY_BASE, setReplayFiles } from './config'
import { setConn, store } from './store'
import type { EngineMsg, Hello } from './types'

type Frame = [number, EngineMsg | { type: '_files'; map: Record<string, string> }]
interface Recording { duration_s: number; hello: Hello; frames: Frame[] }

let rec: Recording | null = null
let handle: (m: EngineMsg) => void = () => {}
let idx = 0
let elapsed = 0          // seconds of the recording already played
let last = 0             // performance.now() of the previous step
let timer: ReturnType<typeof setInterval> | null = null

function apply(i: number) {
  const m = rec!.frames[i][1]
  if (m.type === '_files') setReplayFiles(m.map)
  else handle(m)
}

/** Back to the state before the demo starts: hello, the first file map and the first snapshot. */
function rewind() {
  if (!rec) return
  stop()
  setReplayFiles(null)
  handle(rec.hello)
  idx = 0
  elapsed = 0
  while (idx < rec.frames.length && rec.frames[idx][0] <= 0) apply(idx++)
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
  if (idx >= rec.frames.length) stop()
}

function play() {
  if (!rec || timer) return
  last = performance.now()
  timer = setInterval(step, 50)
}

function markPaused(paused: boolean) {
  const s = store.get().snapshot
  if (s) store.set({ snapshot: { ...s, clock: { ...s.clock, paused } } })
}

export async function startReplay(onMessage: (m: EngineMsg) => void) {
  handle = onMessage
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
  setConn('online', 0)
  rewind()
  // start on its own so a visitor sees the response without finding the button first
  setTimeout(() => { if (idx <= rec!.frames.findIndex((f) => f[0] > 0)) play() }, 1500)
}

/** The commands that make sense for a recording. Choosing a route or firing one incident needs a live engine. */
export function replayCmd(cmd: Record<string, unknown>): boolean {
  if (!rec) return false
  switch (cmd.cmd) {
    case 'demo':
    case 'start':
      rewind(); play(); return true
    case 'pause':
      stop(); markPaused(true); return true
    case 'resume':
      if (idx >= rec.frames.length) rewind()
      play(); return true
    case 'reset':
      rewind(); return true
    default:
      return false
  }
}
