import { focusBundle, store, useStore } from '@/lib/store'
import { LAYERS, LAYER_LABEL, type Layer } from '@/lib/config'
import { cn } from '@/lib/utils'
import { Empty, PhaseColumn, Section } from './PhaseColumn'
import { Fig, KindBadge } from '../Kind'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function LayerSwitch({ compact }: { compact?: boolean }) {
  const layer = useStore((s) => s.overlay.layer)
  const bundle = useStore(focusBundle)
  const fromEngine = new Map((bundle?.assessment?.overlays ?? []).map((o) => [o.layer, o.label]))
  const set = (l: string | null) => store.set((s) => ({ overlay: { ...s.overlay, layer: l, userSet: true } }))
  const items: (Layer | null)[] = [null, ...LAYERS]
  return (
    <div className={cn('flex flex-wrap gap-1', compact && 'gap-0.5')} role="radiogroup" aria-label="Map overlay">
      {items.map((l) => {
        const on = layer === l
        const label = l ? LAYER_LABEL[l] : 'Off'
        const updated = l ? fromEngine.has(l) : false
        return (
          <Tooltip key={l ?? 'off'}>
            <TooltipTrigger asChild>
              <button
                role="radio" aria-checked={on} onClick={() => set(l)}
                className={cn('relative h-6 rounded-[2px] border px-2 font-mono text-[11px] transition-colors', on ? 'border-accent/60 bg-accent-dim text-accent' : 'border-rule2 text-ink2 hover:text-ink')}
              >
                {label}
                {updated && <span className={cn('absolute -right-[2px] -top-[2px] h-[5px] w-[5px] rounded-full', on ? 'bg-accent' : 'bg-ink2')} />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{l ? (fromEngine.get(l) ?? LAYER_LABEL[l]) + (updated ? ' (sent with this assessment)' : '') : 'Show the ortho image only'}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

export function AssessColumn() {
  const bundle = useStore(focusBundle)
  const places = useStore((s) => s.hello?.places)
  const a = bundle?.assessment
  const opacity = useStore((s) => s.overlay.opacity)
  const shelters = a?.shelters ?? []
  const known = new Set(shelters.map((x) => x.id))
  const unassessed = (places ?? []).filter((p) => p.kind === 'shelter' && !known.has(p.id))

  return (
    <PhaseColumn phase="assess">
      <Section title="What changed" first aside={a ? `${a.changes.length} lines` : undefined}>
        {!a ? (
          <Empty title="Nothing assessed yet">{bundle ? 'The hazard map is being updated for this incident.' : 'Each incident updates the hazard map. The changes are listed here with their kind and source.'}</Empty>
        ) : (
          <ul className="-mx-0.5">
            {a.changes.map((c, i) => (
              <li key={c.label + i} className="anim-rise rule-b py-2 last:border-b-0" style={{ animationDelay: `${i * 40}ms` }}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[12px] leading-snug text-ink2">{c.label}</span>
                  <Fig value={c.value} unit={c.unit} kind={c.kind} source={c.source} label={c.label} valueClassName="text-[14px] font-medium" />
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <KindBadge kind={c.kind} source={c.source} label={c.label} />
                  <Tooltip>
                    <TooltipTrigger asChild><span className="truncate text-[10.5px] text-ink3">{c.source}</span></TooltipTrigger>
                    <TooltipContent>{c.source}</TooltipContent>
                  </Tooltip>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Shelters" aside={shelters.length ? `${shelters.filter((s) => s.open).length} of ${shelters.length} open` : undefined}>
        {shelters.length === 0 && unassessed.length === 0 ? (
          <Empty title="Shelter status appears with the assessment" />
        ) : (
          <ul className="space-y-px">
            {shelters.map((sh) => (
              <li key={sh.id} className="flex items-start gap-2 py-1.5">
                <span className={cn('mt-[5px] h-2 w-2 shrink-0 rounded-full', sh.open ? 'bg-safe' : 'border border-hazard bg-hazard/25')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={cn('text-[12.5px]', sh.open ? 'text-ink' : 'text-ink2 line-through decoration-ink3')}>{sh.name}</span>
                    <span className={cn('font-mono text-[10px] uppercase tracking-wider', sh.open ? 'text-safe' : 'text-hazard')}>{sh.open ? 'open' : 'closed'}</span>
                  </div>
                  {sh.reason && <p className="text-[11.5px] leading-snug text-ink3">{sh.reason}</p>}
                </div>
              </li>
            ))}
            {unassessed.map((p) => (
              <li key={p.id} className="flex items-center gap-2 py-1.5 text-[12.5px] text-ink3"><span className="h-2 w-2 rounded-full border border-rule2" />{p.name}<span className="ml-auto font-mono text-[10px] uppercase">not assessed</span></li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Map overlay">
        <LayerSwitch />
        <label className="mt-2.5 flex items-center gap-2 text-[11.5px] text-ink3">
          <span className="w-12">Opacity</span>
          <input
            type="range" min={0.1} max={1} step={0.05} value={opacity}
            onChange={(e) => store.set((s) => ({ overlay: { ...s.overlay, opacity: Number(e.target.value) } }))}
            className="h-1 flex-1 cursor-pointer accent-[var(--color-accent)]"
          />
          <span className="num w-8 text-right text-ink2">{Math.round(opacity * 100)}%</span>
        </label>
        {a?.overlays && a.overlays.length > 0 && (
          <p className="mt-2 text-[11.5px] leading-snug text-ink3">Sent with this assessment: {a.overlays.map((o) => o.label ?? o.layer).join(', ')}.</p>
        )}
      </Section>
    </PhaseColumn>
  )
}
