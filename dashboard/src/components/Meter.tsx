import { cn } from '@/lib/utils'
import type { Kind } from '@/lib/types'
import { Fig } from './Kind'
import { pct } from '@/lib/format'

/** Display thresholds only: they colour the bar, they are not a safety rule. */
export function severity(frac: number): { color: string; name: 'ok' | 'low' | 'critical' } {
  if (frac < 0.2) return { color: 'var(--color-hazard)', name: 'critical' }
  if (frac < 0.35) return { color: 'var(--color-caution)', name: 'low' }
  return { color: 'var(--color-safe)', name: 'ok' }
}

/** Fraction left, with a same-hue track so the state reads across the whole bar. */
export function Meter({ label, frac, kind = 'model', source, hint, big, className }: {
  label: string; frac: number | null | undefined; kind?: Kind; source?: string; hint?: string; big?: boolean; className?: string
}) {
  const f = frac === null || frac === undefined || !Number.isFinite(frac) ? null : Math.min(1, Math.max(0, frac))
  const sev = f === null ? null : severity(f)
  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className={cn('text-ink2', big ? 'text-[12.5px]' : 'text-[11.5px]')}>{label}</span>
        {f === null ? <span className="num text-ink3">-</span> : (
          <Fig value={pct(f)} kind={kind} source={source ?? 'Engine run-time model'} label={`${label}${hint ? ': ' + hint : ''}`} valueClassName={cn(big && 'text-[15px] font-medium')} />
        )}
      </div>
      <div className={cn('overflow-hidden rounded-[1px]', big ? 'h-2' : 'h-1.5')} style={{ background: sev ? `color-mix(in srgb, ${sev.color} 16%, transparent)` : 'var(--color-rule)' }}>
        {f !== null && <div className="h-full rounded-[1px] transition-[width] duration-500" style={{ width: `${f * 100}%`, background: sev!.color }} />}
      </div>
    </div>
  )
}
