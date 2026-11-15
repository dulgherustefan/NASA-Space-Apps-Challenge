// Voice prompts. Recorded clips (public/audio/voice/manifest.json: key -> file) are played when a key exists;
// otherwise the Web Speech API speaks the text. Every call is guarded: no audio = silent, never a crash.
const BASE = import.meta.env.BASE_URL
const VOICE_DIR = BASE + 'audio/voice/'

type Manifest = Record<string, { url: string; text: string | null }>

let manifestP: Promise<Manifest> | null = null
function loadManifest(): Promise<Manifest> {
  if (!manifestP) {
    manifestP = fetch(VOICE_DIR + 'manifest.json')
      .then(r => (r.ok ? r.json() : {}))
      .then((m: unknown) => {
        const out: Manifest = {}
        if (m && typeof m === 'object') {
          // accept { key: "file.mp3" } or { key: { file | src | path } } or { clips: {...} }
          const src = (m as Record<string, unknown>).clips && typeof (m as Record<string, unknown>).clips === 'object'
            ? (m as Record<string, unknown>).clips as Record<string, unknown> : m as Record<string, unknown>
          for (const [k, v] of Object.entries(src)) {
            const f = typeof v === 'string' ? v : v && typeof v === 'object' ? ((v as Record<string, unknown>).file ?? (v as Record<string, unknown>).src ?? (v as Record<string, unknown>).path) : null
            const text = v && typeof v === 'object' && typeof (v as Record<string, unknown>).text === 'string' ? (v as Record<string, unknown>).text as string : null
            if (typeof f === 'string' && f) out[k] = { url: /^(https?:|\/|blob:|data:)/.test(f) ? f : VOICE_DIR + f.replace(/^\.\//, ''), text }
          }
        }
        return out
      })
      .catch(() => ({}))
  }
  return manifestP
}

/** "Bear left" -> "bear_left"; null when the manoeuvre has no recorded clip family. */
export function turnKey(text: string): string | null {
  const m = /^(bear|turn|sharp)\s+(left|right)/i.exec(text.trim())
  return m ? `${m[1].toLowerCase()}_${m[2].toLowerCase()}` : null
}

export class Voice {
  muted = false
  private voice: SpeechSynthesisVoice | null = null
  private ok = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
  private audio: HTMLAudioElement | null = null
  private queue: { key: string | null; text: string }[] = []
  private busy = false
  private manifest: Manifest | null = null
  private disposed = false
  private token = 0
  /** Called with the words being said (subtitles). */
  onCaption: ((text: string) => void) | null = null

  constructor() {
    void loadManifest().then(m => { this.manifest = m })
    if (!this.ok) return
    try {
      const pick = () => {
        const vs = window.speechSynthesis.getVoices()
        this.voice = vs.find(v => /en[-_]US/i.test(v.lang) && /female|zira|samantha|google us/i.test(v.name))
          ?? vs.find(v => /^en/i.test(v.lang)) ?? null
      }
      pick()
      window.speechSynthesis.addEventListener?.('voiceschanged', pick)
    } catch { this.ok = false }
  }

  /** Speak a prompt: recorded clip `key` if it exists, else `text`. `urgent` interrupts what is being said. */
  say(text: string, urgent = false, key: string | null = null) {
    if (this.muted || this.disposed) return
    if (urgent) { this.stop(); this.queue = [] }
    if (this.queue.length > 2) this.queue.shift()     // never let stale prompts pile up
    this.queue.push({ key, text })
    if (!this.busy) this.next()
  }

  private next() {
    const item = this.queue.shift()
    if (!item || this.muted || this.disposed) { this.busy = false; return }
    this.busy = true
    const token = ++this.token
    const done = () => { if (this.busy && token === this.token) { this.busy = false; this.next() } }
    const clip = item.key && this.manifest ? this.manifest[item.key] : undefined
    const url = clip?.url
    this.onCaption?.(clip?.text ?? item.text)
    if (url) {
      try {
        const a = new Audio(url)
        this.audio = a
        a.onended = done
        a.onerror = () => this.speak(item.text, done)
        void a.play().catch(() => this.speak(item.text, done))
        return
      } catch { /* fall through to speech */ }
    }
    this.speak(item.text, done)
  }

  private speak(text: string, done: () => void) {
    if (!this.ok) { done(); return }
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'en-US'; u.rate = 1.05; u.pitch = 1
      if (this.voice) u.voice = this.voice
      u.onend = done
      u.onerror = done
      window.speechSynthesis.speak(u)
      // some engines never fire onend: do not block the queue for long
      setTimeout(done, 2500 + text.length * 70)
    } catch { done() }
  }

  setMuted(m: boolean) {
    this.muted = m
    if (m) { this.stop(); this.queue = [] }
  }

  stop() {
    try { if (this.audio) { this.audio.onended = null; this.audio.onerror = null; this.audio.pause() } } catch { /* ignore */ }
    this.audio = null
    if (this.ok) { try { window.speechSynthesis.cancel() } catch { /* ignore */ } }
    this.busy = false
    this.token++
  }

  dispose() { this.disposed = true; this.stop(); this.queue = [] }
}
