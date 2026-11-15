export const pad = (n: number, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0')

/** Mission seconds as T+hh:mm:ss */
export function missionT(t: number): string {
  const s = Math.max(0, Math.floor(t))
  return `T+${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`
}
/** Seconds as m:ss (or h:mm:ss) */
export function dur(s: number): string {
  if (!Number.isFinite(s)) return '-'
  const v = Math.max(0, Math.round(s))
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), r = v % 60
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`
}
/** Seconds as "3 h 38 min" or "42 min"; compact gives "3h 38m". */
export function hm(s: number, compact = false): string {
  const m = Math.max(0, Math.round(s / 60))
  if (compact) return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m}m`
  return m >= 60 ? `${Math.floor(m / 60)} h ${pad(m % 60)} min` : `${m} min`
}
export function lightTime(s?: number): string {
  if (s === undefined || !Number.isFinite(s)) return '-'
  return s >= 120 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(0)} s`
}
export function pct(x: number | null | undefined, d = 0): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '-' : `${(x * 100).toFixed(d)}%`
}
export function num(x: number | string | null | undefined, d?: number): string {
  if (x === null || x === undefined) return '-'
  if (typeof x === 'string') return x
  if (!Number.isFinite(x)) return '-'
  if (d !== undefined) return x.toFixed(d)
  const a = Math.abs(x)
  if (a >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (a >= 100) return x.toFixed(0)
  if (a >= 10) return x.toFixed(1).replace(/\.0$/, '')
  return x.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')
}
/** Planner settings as the scenario files name them, in plain words. */
const VARIANT: Record<string, string> = { 'band-avoiding weights': 'clear of the rockfall band', 'standing weights': 'direct' }
export const plainLabel = (s: string) => s.replace(/band-avoiding weights|standing weights/g, (m) => VARIANT[m])
/** "Boulder and back, band-avoiding weights" -> name and planner variant. */
export function splitLabel(label: string): { name: string; variant?: string } {
  const i = label.indexOf(', ')
  if (i <= 0) return { name: label }
  const v = label.slice(i + 2)
  return { name: label.slice(0, i), variant: VARIANT[v] ?? v }
}
export function pct1(x: number): string {
  const v = x * 100
  return v < 1 ? `${v.toFixed(2)}%` : `${v.toFixed(1)}%`
}

/** Log-probability with one decimal and no negative zero. */
export function logp(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '-'
  const v = Math.round(x * 10) / 10
  return (Object.is(v, -0) ? 0 : v).toFixed(1).replace('-', '\u2212')
}
