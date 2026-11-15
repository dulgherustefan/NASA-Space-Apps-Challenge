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
/** "Boulder and back, band-avoiding weights" -> name and planner variant. */
export function splitLabel(label: string): { name: string; variant?: string } {
  const i = label.indexOf(', ')
  return i > 0 ? { name: label.slice(0, i), variant: label.slice(i + 2) } : { name: label }
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
