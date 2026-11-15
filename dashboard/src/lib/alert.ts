// Audible cue for a new incident: two short tones made with Web Audio, no sound file.
// Browsers keep audio locked until the first click or key press, so the first alert after a cold start may be silent.
const KEY = 'solway.muted'
let ctx: AudioContext | null = null

export function isMuted(): boolean {
  try { return window.localStorage.getItem(KEY) === '1' } catch { return false }
}
export function setMuted(m: boolean) {
  try { window.localStorage.setItem(KEY, m ? '1' : '0') } catch { /* private mode */ }
}

function tone(ac: AudioContext, freq: number, at: number, dur: number) {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  osc.connect(gain).connect(ac.destination)
  osc.start(at)
  osc.stop(at + dur + 0.02)
}

/** Urgent incidents get a rising pair repeated once; a science target gets a single soft tone. */
export function chime(urgent: boolean) {
  if (isMuted()) return
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const t = ctx.currentTime + 0.02
    if (urgent) { tone(ctx, 660, t, 0.16); tone(ctx, 880, t + 0.2, 0.2); tone(ctx, 660, t + 0.55, 0.16); tone(ctx, 880, t + 0.75, 0.2) }
    else tone(ctx, 587, t, 0.3)
  } catch { /* no audio device */ }
}
