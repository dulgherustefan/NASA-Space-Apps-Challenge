import type { ReactNode } from 'react'
import type { Kind } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { num } from '@/lib/format'

export const KIND_INFO: Record<Kind, { label: string; color: string; def: string }> = {
  measured: { label: 'measured', color: 'var(--color-k-measured)', def: 'Observed by an instrument, or taken from a published measurement.' },
  model: { label: 'model', color: 'var(--color-k-model)', def: 'Computed by our planning or physics model. Not an observation.' },
  requirement: { label: 'requirement', color: 'var(--color-k-requirement)', def: 'A rule or limit taken from a NASA document or the mission design.' },
  assumption: { label: 'assumption', color: 'var(--color-k-assumption)', def: 'A team choice with no measurement behind it.' },
  scenario: { label: 'scenario', color: 'var(--color-k-scenario)', def: 'Scripted for this exercise. Not a real observation.' },
}
export const KINDS = Object.keys(KIND_INFO) as Kind[]

export function normKind(k: string | undefined): Kind {
  if (k && k in KIND_INFO) return k as Kind
  if (k === 'physics') return 'measured'
  return 'assumption'
}

/** Shape plus colour, so the kind never depends on colour alone. */
export function KindGlyph({ kind, size = 7, className }: { kind: Kind; size?: number; className?: string }) {
  const c = KIND_INFO[kind].color
  const s = size
  return (
    <svg width={s} height={s} viewBox="0 0 10 10" className={cn('shrink-0', className)} aria-hidden>
      {kind === 'measured' && <circle cx="5" cy="5" r="3.6" fill={c} />}
      {kind === 'model' && <path d="M5 .8 9.2 5 5 9.2.8 5Z" fill={c} />}
      {kind === 'requirement' && <rect x="1.4" y="1.4" width="7.2" height="7.2" fill={c} />}
      {kind === 'assumption' && <circle cx="5" cy="5" r="3.2" fill="none" stroke={c} strokeWidth="1.5" />}
      {kind === 'scenario' && <path d="M5 1 9.4 8.8H.6Z" fill={c} />}
    </svg>
  )
}

export function KindDetail({ kind, source, label }: { kind: Kind; source?: string; label?: string }) {
  const info = KIND_INFO[kind]
  return (
    <div className="space-y-1.5">
      {label && <div className="font-medium text-ink">{label}</div>}
      <div className="flex items-center gap-1.5">
        <KindGlyph kind={kind} size={10} />
        <span className="text-[12px] font-medium" style={{ color: info.color }}>{info.label}</span>
      </div>
      <div className="text-ink2">{info.def}</div>
      <div className="border-t border-rule2 pt-1.5 text-ink2">
        <span className="text-ink3">Source: </span>
        {source || 'not given by the engine'}
      </div>
    </div>
  )
}

/** Kind pill. Hover shows what the kind means. */
export function KindBadge({ kind, source, label, className }: { kind: Kind; source?: string; label?: string; className?: string }) {
  const info = KIND_INFO[kind]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn('inline-flex cursor-help items-center gap-1 whitespace-nowrap text-[12px] text-ink2', className)}>
          <KindGlyph kind={kind} size={8} />
          {info.label}
        </span>
      </TooltipTrigger>
      <TooltipContent><KindDetail kind={kind} source={source} label={label} /></TooltipContent>
    </Tooltip>
  )
}

/** A number with its kind glyph. Hover or focus shows kind and source. */
export function Fig({ value, unit, kind, source, label, digits, className, valueClassName, glyphFirst }: {
  value: number | string | null | undefined; unit?: string; kind: Kind; source?: string; label?: string
  digits?: number; className?: string; valueClassName?: string; glyphFirst?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn('inline-flex cursor-help items-baseline gap-1 whitespace-nowrap outline-offset-2', className)}>
          {glyphFirst && <KindGlyph kind={kind} className="self-center" />}
          <span className={cn('num text-ink', valueClassName)}>{num(value, digits)}</span>
          {unit && <span className="num text-[0.78em] text-ink3">{unit}</span>}
          {!glyphFirst && <KindGlyph kind={kind} className="self-center opacity-75" />}
        </span>
      </TooltipTrigger>
      <TooltipContent><KindDetail kind={kind} source={source} label={label} /></TooltipContent>
    </Tooltip>
  )
}

/** Inline mark that stands for a whole group of numbers of one kind (for dense rows). */
export function GroupKind({ kind, source, label, children }: { kind: Kind; source?: string; label?: string; children?: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex cursor-help items-center gap-1">
          {children}
          <KindGlyph kind={kind} />
        </span>
      </TooltipTrigger>
      <TooltipContent><KindDetail kind={kind} source={source} label={label} /></TooltipContent>
    </Tooltip>
  )
}
