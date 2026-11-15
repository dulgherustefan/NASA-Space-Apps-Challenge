// Voice prompts: only the recorded ElevenLabs clips in public/audio/voice (manifest.json: key -> file + text).
// One audio channel for the whole page, so two prompts never play over each other. A prompt without a recorded
// clip is shown as a caption only (no synthetic speech). Every call is guarded: no audio = silent, never a crash.
import { isMuted } from '@/lib/alert'

const BASE = import.meta.env.BASE_URL
const VOICE_DIR = BASE + 'audio/voice/'

type Manifest = Record<string, { url: string; text: string | null }>

let manifestP: Promise<Manifest> | null = null
function loadManifest(): Promise<Manifest> {
  if (!manifestP) {
    manifestP = fetch(VOICE_DIR + 'manifest.json')
      .then(r => (r.ok ? r.json() : {}))
      .then((m: { clips?: Record<string, { file: string; text?: string }> }) => {
        const out: Manifest = {}
        for (const [k, v] of Object.entries(m?.clips ?? {})) if (v?.file) out[k] = { url: VOICE_DIR + v.file, text: v.text ?? null }
        return out
      })
      .catch(() => ({}))
  }
  return manifestP
}

// ---- the single page-wide channel
let current: HTMLAudioElement | null = null
let currentPriority = 0
let channelToken = 0
/** Play a clip on the page-wide channel. A clip of equal or higher priority cuts the one playing; lower waits/drops. */
export async function playClip(key: string, priority = 1, onEnd?: () => void): Promise<boolean> {
  if (isMuted()) { onEnd?.(); return false }
  const m = await loadManifest()
  const clip = m[key]
  if (!clip) { onEnd?.(); return false }
  if (current && !current.ended && !current.paused && priority < currentPriority) { onEnd?.(); return false }
  stopChannel()
  const token = ++channelToken
  try {
    const a = new Audio(clip.url)
    current = a; currentPriority = priority
    const end = () => { if (token === channelToken) { current = null; currentPriority = 0 } onEnd?.() }
    a.onended = end
    a.onerror = end
    await a.play().catch(end)
    return true
  } catch { onEnd?.(); return false }
}
export function stopChannel() {
  channelToken++
  try { if (current) { current.onended = null; current.onerror = null; current.pause() } } catch { /* ignore */ }
  current = null; currentPriority = 0
}
export async function clipText(key: string): Promise<string | null> { return (await loadManifest())[key]?.text ?? null }

/** "Bear left" -> "bear_left"; null when the manoeuvre has no recorded clip family. */
export function turnKey(text: string): string | null {
  const m = /^(bear|turn|sharp)\s+(left|right)/i.exec(text.trim())
  return m ? `${m[1].toLowerCase()}_${m[2].toLowerCase()}` : null
}

/** Helmet prompts: a small queue on the page-wide channel; captions for everything said or shown. */
export class Voice {
  muted = false
  private queue: { key: string | null; text: string }[] = []
  private busy = false
  private disposed = false
  onCaption: ((text: string) => void) | null = null

  constructor() { void loadManifest() }

  /** `urgent` interrupts what is being said. Prompts without a recorded clip only show as a caption. */
  say(text: string, urgent = false, key: string | null = null) {
    if (this.disposed) return
    if (!key) { this.onCaption?.(text); return }
    if (this.muted) { this.onCaption?.(text); return }
    if (urgent) { stopChannel(); this.queue = []; this.busy = false }
    if (this.queue.length > 1) this.queue.shift()
    this.queue.push({ key, text })
    if (!this.busy) this.next()
  }

  private next() {
    const item = this.queue.shift()
    if (!item || this.muted || this.disposed) { this.busy = false; return }
    this.busy = true
    void clipText(item.key!).then(t => this.onCaption?.(t ?? item.text))
    void playClip(item.key!, 1, () => { if (this.busy) { this.busy = false; this.next() } })
  }

  setMuted(m: boolean) { this.muted = m; if (m) { stopChannel(); this.queue = []; this.busy = false } }
  stop() { stopChannel(); this.busy = false }
  dispose() { this.disposed = true; this.queue = []; stopChannel() }
}
