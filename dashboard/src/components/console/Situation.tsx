import { focusBundle, focusIncidentId, store, useStore } from '@/lib/store'
import type { Detection, Quantity } from '@/lib/types'
import { cn } from '@/lib/utils'
import { missionT } from '@/lib/format'
import { Fig } from '../Kind'
import { Conditions } from './Conditions'
import { Empty, INCIDENT_ICON, More, Section } from './parts'

function Figures({ items, first = 3 }: { items: Quantity[]; first?: number }) {
  const Row = ({ q }: { q: Quantity }) => (
    <div className="flex items-baseline justify-between gap-3 py-[5px] text-[13px]">
      <dt className="leading-snug text-ink2">{q.label}</dt>
      <dd className="shrink-0"><Fig value={q.value} unit={q.unit} kind={q.kind} source={q.source} label={q.label} /></dd>
    </div>
  )
  return (
    <dl>
      {items.slice(0, first).map((q) => <Row key={q.label} q={q} />)}
      {items.length > first && (
        <More label={`All ${items.length} figures`}>
          {items.slice(first).map((q) => <Row key={q.label} q={q} />)}
        </More>
      )}
    </dl>
  )
}

function Incidents() {
  const order = useStore((s) => s.order)
  const incidents = useStore((s) => s.incidents)
  const focusId = useStore(focusIncidentId)
  const liveId = useStore((s) => s.snapshot?.incident_id ?? null)
  const focus = focusId ? incidents[focusId]?.incident : undefined
  if (!order.length) return <Empty>Nothing detected. Dose rate and ground motion are watched under Conditions.</Empty>
  return (
    <>
      <ul className="-mx-2 space-y-0.5">
        {[...order].reverse().map((id) => {
          const inc = incidents[id].incident
          const Icon = INCIDENT_ICON[inc.kind]
          const sel = id === focusId
          return (
            <li key={id} className="anim-rise">
              <button type="button" onClick={() => store.set({ focusId: id === liveId ? null : id, selectedRoute: null })} aria-pressed={sel}
                className={cn('card-hover tap flex w-full items-start gap-2.5 rounded-[4px] px-2 py-2 text-left', sel && 'bg-panel2')}>
                <Icon size={16} strokeWidth={1.8} className={cn('mt-[2px] shrink-0', sel ? 'text-accent' : 'text-ink3')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={cn('text-[13.5px] font-medium leading-tight', sel ? 'text-ink' : 'text-ink2')}>{inc.title}</span>
                    <span className="num shrink-0 text-[11.5px] text-ink3">{missionT(inc.t)}</span>
                  </div>
                  {sel && inc.summary && <p className="mt-0.5 text-[12.5px] leading-snug text-ink2">{inc.summary}</p>}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
      {focus?.source && <p className="mt-2 text-[12px] leading-snug text-ink3">{focus.scenario ? 'Scripted from: ' : 'Source: '}{focus.source}</p>}
      {focus?.params && focus.params.length > 0 && <div className="mt-2 border-t border-rule pt-2"><Figures items={focus.params} /></div>}
    </>
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

function Shelters() {
  const bundle = useStore(focusBundle)
  const places = useStore((s) => s.hello?.places)
  const shelters = bundle?.assessment?.shelters ?? []
  const known = new Set(shelters.map((x) => x.id))
  const rest = (places ?? []).filter((p) => (p.kind === 'shelter' || p.kind === 'rover' || p.kind === 'habitat') && !known.has(p.id))
  if (!shelters.length && !rest.length) return <Empty>Shelter status arrives with the assessment.</Empty>
  return (
    <ul>
      {shelters.map((sh) => (
        <li key={sh.id} className="flex items-start gap-2.5 py-1.5">
          <span className={cn('mt-[6px] h-2 w-2 shrink-0 rounded-full', sh.open ? 'bg-safe' : 'border border-hazard bg-hazard/25')} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className={cn('text-[13px]', sh.open ? 'text-ink' : 'text-ink2 line-through decoration-ink3')}>{sh.name}</span>
              <span className={cn('text-[12px]', sh.open ? 'text-safe' : 'text-hazard')}>{sh.open ? 'open' : 'closed'}</span>
            </div>
            {sh.reason && <p className="text-[12px] leading-snug text-ink3">{sh.reason}</p>}
          </div>
        </li>
      ))}
      {rest.map((p) => (
        <li key={p.id} className="flex items-center gap-2.5 py-1.5 text-[13px] text-ink3"><span className="h-2 w-2 rounded-full border border-rule2" />{p.name}<span className="ml-auto text-[12px]">not assessed</span></li>
      ))}
    </ul>
  )
}

/** What happened and what it changed: the Detect and Assess side of the loop. */
export function Situation() {
  const bundle = useStore(focusBundle)
  const order = useStore((s) => s.order)
  const a = bundle?.assessment
  return (
    <div>
      <Section title="Incidents" aside={order.length > 1 ? `${order.length} so far` : undefined} className="border-t-0">
        <Incidents />
      </Section>
      {bundle?.plan && (
        <Section title="What the plan assumes">
          <Figures items={bundle.plan.conditions ?? []} first={5} />
        </Section>
      )}
      {bundle?.incident.detection && (
        <Section title="How it was detected" aside="on-site rule">
          <Detected d={bundle.incident.detection} />
        </Section>
      )}
      {bundle && !bundle.plan && (
        <Section title="What changed on the map" aside={a ? undefined : 'assessing'}>
          {a ? <Figures items={a.changes} first={4} /> : <Empty>The hazard map is being updated for this incident.</Empty>}
        </Section>
      )}
      <Section title="Shelters" aside={a?.shelters?.length ? `${a.shelters.filter((s) => s.open).length} of ${a.shelters.length} open` : undefined}>
        <Shelters />
      </Section>
      <Conditions />
    </div>
  )
}
