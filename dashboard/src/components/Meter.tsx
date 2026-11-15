import { cn } from '@/lib/utils'
import type { Kind } from '@/lib/types'
import { Fig } from './Kind'
import { pct } from '@/lib/format'

/** Display thresholds only: they mark the bar, they are not a safety rule. */
export function severity(frac: number): { color: string; name: 'ok' | 'low' | 'critical' } {
  if (frac < 0.2) return { color: 'var(--color-hazard)', name: 'critical' }
  if (frac < 0.35) return { color: 'var(--color-caution-fill)', name: 'low' }
  return { color: 'var(--color-ink2)', name: 'ok' }
}

/** Fraction left. A margin in hand stays neutral; colour and a word appear only when it runs low. */
export function Meter({ label, frac, kind = 'model', source, hint, className }: {
  label: string; frac: number | null | undefined; kind?: Kind; source?: string; hint?: string; className?: string
}) {
  const f = frac === null || frac === undefined || !Number.isFinite(frac) ? null : Math.min(1, Math.max(0, frac))
  const sev = f === null ? null : severity(f)
  return (
    <div className={cn('min-w-0', className)}>
      <div className="cap truncate">{label}</div>
      <div className="flex items-baseline gap-1.5">
        {f === null ? <span className="num text-[15px] text-ink3">-</span> : (
          <Fig value={pct(f)} kind={kind} source={source ?? 'Engine run-time model'} label={`${label}${hint ? ': ' + hint : ''}`} valueClassName="text-[15px] font-bold" />
        )}
        {sev && sev.name !== 'ok' && <span className={cn('text-[12px] font-bold', sev.name === 'critical' ? 'text-hazard' : 'text-caution')}>{sev.name}</span>}
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-[1px] bg-rule">
        {f !== null && <div className="h-full transition-[width] duration-500" style={{ width: `${f * 100}%`, background: sev!.color }} />}
      </div>
    </div>
  )
}
