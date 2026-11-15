import type { ReactNode } from 'react'
import { focusBundle, store, useStore } from '@/lib/store'
import { bearingText, lineTo } from '@/lib/derive'
import type { Detection, Quantity } from '@/lib/types'
import { cn } from '@/lib/utils'
import { num } from '@/lib/format'
import { Fig } from '../Kind'
import { Empty, More } from './parts'

export function Figures({ items, first = 3 }: { items: Quantity[]; first?: number }) {
  const Line = ({ q }: { q: Quantity }) => (
    <div className="flex items-baseline justify-between gap-3 py-[5px] text-[13px]">
      <dt className="leading-snug text-ink2">{q.label}</dt>
      <dd className="shrink-0"><Fig value={q.value} unit={q.unit} kind={q.kind} source={q.source} label={q.label} /></dd>
    </div>
  )
  return (
    <dl>
      {items.slice(0, first).map((q) => <Line key={q.label} q={q} />)}
      {items.length > first && (
        <More label={`All ${items.length} figures`}>
          {items.slice(first).map((q) => <Line key={q.label} q={q} />)}
        </More>
      )}
    </dl>
  )
}

/** Why the alert fired: the on-site rule first, then what Earth-side monitoring recorded for the same storm. */
function Detected({ d }: { d: Detection }) {
  return (
    <>
      <p className="text-[13px] leading-snug text-ink">{d.rule}. Raised <span className="num">{d.delay_s.toFixed(1)} s</span> after the storm reached the site.</p>
      <div className="mt-1.5"><Figures items={d.readings} first={3} /></div>
      {d.earth.length > 0 && (
        <div className="mt-3 border-t border-rule pt-3">
          {d.earth_summary && <p className="text-[13px] leading-snug text-ink">{d.earth_summary}</p>}
          <More label="Earth-side record of this storm (NASA CCMC DONKI)">
            <Figures items={d.earth} first={d.earth.length} />
            {d.earth_note && <p className="mt-1.5 text-[12px] leading-snug text-ink3">{d.earth_note}</p>}
          </More>
        </div>
      )}
      <p className="mt-2 text-[12px] leading-snug text-ink3">{d.replay} Rule: {d.source}.</p>
    </>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-rule pt-3 first:border-t-0 first:pt-0">
      <h4 className="mb-1.5 text-[13px] font-bold text-ink">{title}</h4>
      {children}
    </div>
  )
}

/** How the incident was detected and what it changed on the map: the Detect and Assess side of the loop. */
export function Hazard() {
  const bundle = useStore(focusBundle)
  if (!bundle) return <div className="px-4 pb-4 pt-1"><Empty>Nothing detected. Dose rate and ground motion are watched under Conditions.</Empty></div>
  const a = bundle.assessment
  const inc = bundle.incident
  return (
    <div className="space-y-3 px-4 pb-4 pt-1">
      {bundle.plan ? (
        <Block title="What the plan assumes"><Figures items={bundle.plan.conditions ?? []} first={5} /></Block>
      ) : (
        <>
          <Block title={inc.detection ? 'Detected by the on-site rule' : inc.scenario ? 'Scripted incident' : 'Observed'}>
            {inc.detection ? <Detected d={inc.detection} /> : (
              <>
                {inc.summary && <p className="text-[13px] leading-snug text-ink">{inc.summary}</p>}
                {inc.source && <p className="mt-1.5 text-[12px] leading-snug text-ink3">{inc.scenario ? 'Scripted from: ' : 'Source: '}{inc.source}</p>}
                {inc.params && inc.params.length > 0 && <div className="mt-1.5"><Figures items={inc.params} /></div>}
              </>
            )}
          </Block>
          <Block title="What changed on the map">
            {a ? <Figures items={a.changes} first={4} /> : <Empty>The hazard map is being updated for this incident.</Empty>}
          </Block>
        </>
      )}
    </div>
  )
}

const COVER = new Set(['shelter', 'rover', 'habitat'])
export const KIND_NAME: Record<string, string> = { site: 'Work site', habitat: 'Habitat', rover: 'Pressurised rover', shelter: 'Terrain shelter', science: 'Science target', epicentre: 'Quake epicentre' }

/** Every place of the site, with whether it is open as cover right now. A row selects the place on the map. */
export function Places() {
  const bundle = useStore(focusBundle)
  const places = useStore((s) => s.hello?.places)
  const lead = useStore((s) => s.snapshot?.crew[0])
  const sel = useStore((s) => s.selectedPlace)
  const state = new Map((bundle?.assessment?.shelters ?? []).map((x) => [x.id, x]))
  if (!places?.length) return <div className="px-4 pb-4 pt-1"><Empty>No places yet. They arrive with the site.</Empty></div>
  const rows = places.map((p) => ({ p, sh: state.get(p.id), line: lead ? lineTo(lead.e, lead.s, p.e, p.s) : null }))
    .sort((x, y) => Number(COVER.has(y.p.kind)) - Number(COVER.has(x.p.kind)) || (x.line?.dist_m ?? 0) - (y.line?.dist_m ?? 0))
  return (
    <div className="pb-3">
      <ul>
        {rows.map(({ p, sh, line }) => (
          <li key={p.id}>
            <button type="button" aria-pressed={sel === p.id} onClick={() => store.set({ selectedPlace: sel === p.id ? null : p.id })}
              className={cn('card-hover flex min-h-[44px] w-full items-center gap-3 px-4 py-1.5 text-left', sel === p.id && 'bg-accent-dim')}>
              <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', sh ? (sh.open ? 'bg-safe' : 'border-[1.5px] border-hazard') : 'border-[1.5px] border-rule2')} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-[13.5px]', sh && !sh.open ? 'text-ink2 line-through decoration-ink3' : 'text-ink')}>{p.name}</span>
                <span className="block truncate text-[12px] text-ink3">{sh ? (sh.open ? 'Open' : `Closed${sh.reason ? ': ' + sh.reason : ''}`) : KIND_NAME[p.kind] ?? p.kind}</span>
              </span>
              {line && <span className="num shrink-0 text-right text-[12.5px] text-ink2">{num(Math.round(line.dist_m / 10) * 10)} m<span className="block text-[12px] text-ink3">{bearingText(line.bearing)}</span></span>}
            </button>
          </li>
        ))}
      </ul>
      <p className="px-4 pt-2 text-[12px] leading-snug text-ink3">Distance and bearing are a straight line from {lead?.name ?? 'the crew'}, not a route.</p>
    </div>
  )
}

export const isCover = (kind: string) => COVER.has(kind)
