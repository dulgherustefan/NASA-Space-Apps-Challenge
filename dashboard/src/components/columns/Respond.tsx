import { focusBundle, useStore } from '@/lib/store'
import { dur, num } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Empty, PhaseColumn, Section } from './PhaseColumn'
import { Fig, KindBadge } from '../Kind'
import { Meter } from '../Meter'
import { Check, ShieldAlert } from 'lucide-react'

const CREW_STATUS = ['walking', 'idle', 'stumbled', 'incapacitated', 'heat limit', 'oxygen limit', 'arrived', 'late']
const MODEL_SRC = 'Engine run-time model (walk physiology and suit model). Not a measurement of a real crew.'

function CrewNow() {
  const crew = useStore((s) => s.snapshot?.crew)
  if (!crew?.length) return <Empty title="No crew telemetry yet" />
  return (
    <ul className="space-y-2.5">
      {crew.map((c) => {
        const bad = c.status >= 2 && c.status !== 6
        return (
          <li key={c.id}>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[12.5px] font-medium text-ink">{c.name ?? `Crew ${c.id}`}</span>
              <span className={cn('font-mono text-[10px] uppercase tracking-wider', bad ? 'text-hazard' : c.status === 6 ? 'text-safe' : 'text-ink3')}>{CREW_STATUS[c.status] ?? `status ${c.status}`}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3">
              <Meter label="O2 left" frac={c.o2} source={MODEL_SRC} hint="usable oxygen left" />
              <Meter label="Heat margin" frac={1 - c.heat} source={MODEL_SRC} hint="room left before the heat-storage limit" />
            </div>
            <div className="mt-1 flex items-baseline justify-between text-[11.5px] text-ink2">
              <span>Dose this walk</span>
              <Fig value={c.dose} unit="mSv" kind="model" source={MODEL_SRC} label={`${c.name ?? 'Crew'} dose this walk`} digits={3} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function RespondColumn() {
  const bundle = useStore(focusBundle)
  const d = bundle?.decision
  const route = bundle?.routes?.find((r) => r.id === d?.route_id)
  const shelterName = route?.label ?? d?.shelter

  return (
    <PhaseColumn phase="respond">
      {!d ? (
        <div className="pt-3.5">
          <Empty title="No decision yet">The safest route to shelter appears here once the stress tests are in. The crew follows it automatically unless you choose another.</Empty>
        </div>
      ) : (
        <>
          <Section title="Chosen route" first>
            <div key={`${bundle?.id}:${d.route_id}`} className="anim-rise relative overflow-hidden rounded-[4px] border border-safe/35 bg-safe/[0.06] px-3.5 pb-3 pt-2.5">
              <span className="absolute inset-y-0 left-0 w-[3px] bg-safe" />
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 text-[13.5px] font-medium leading-snug text-ink">Route {d.route_id}<span className="font-normal text-ink2"> to {shelterName}</span></span>
                <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-wider text-safe">{d.auto === false ? 'operator choice' : 'automatic'}</span>
              </div>
              <div className="eyebrow mt-2.5">Time to shelter</div>
              <div className="mt-1">
                <Fig value={dur(d.time_to_shelter_s)} unit={d.time_to_shelter_s >= 3600 ? 'h:mm:ss' : 'min:s'} kind="model" source={MODEL_SRC + ' Planner walking time plus stress-test margin.'} label="Time to shelter" valueClassName="text-[36px] font-medium leading-none tracking-tight" />
              </div>
              {route && (
                <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-safe/20 pt-2">
                  {([['Length', num(route.length_m), 'm'], ['Ascent', `+${num(route.ascent_m)}`, 'm'], ['Max slope', num(route.max_slope, 1), '°']] as const).map(([l, v, u]) => (
                    <div key={l} className="min-w-0">
                      <div className="font-mono text-[9px] uppercase tracking-wider text-ink3">{l}</div>
                      <div className="num text-[13px] text-ink">{v}<span className="ml-0.5 text-[10px] text-ink3">{u}</span></div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>

          <Section title="Margins on arrival" aside={<KindBadge kind="model" source={MODEL_SRC} label="Margins" />}>
            <div className="space-y-3">
              <Meter big label="Oxygen left" frac={d.margins.o2} source={MODEL_SRC} hint="usable oxygen left on arrival" />
              <Meter big label="Heat margin" frac={d.margins.heat} source={MODEL_SRC} hint="room left before the heat-storage limit on arrival" />
              <Meter big label="Dose margin" frac={d.margins.dose} source={MODEL_SRC} hint="dose margin on arrival as defined by the engine (fraction, higher is better)" />
            </div>
          </Section>

          <Section title="Why this route">
            <ul className="space-y-1.5">
              {d.reasons.map((r, i) => (
                <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-ink"><Check size={13} className="mt-[3px] shrink-0 text-safe" />{r}</li>
              ))}
            </ul>
          </Section>

          <Section title="Dangers avoided" aside={d.avoided.length ? `${d.avoided.length}` : undefined}>
            {d.avoided.length === 0 ? <p className="text-[12px] text-ink3">Nothing specific was routed around.</p> : (
              <ul className="space-y-2">
                {d.avoided.map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <ShieldAlert size={14} className="mt-[2px] shrink-0 text-hazard" strokeWidth={1.8} />
                    <div className="min-w-0"><div className="text-[12.5px] leading-snug text-ink">{a.label}</div>{a.detail && <div className="text-[11.5px] leading-snug text-ink3">{a.detail}</div>}</div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
      <Section title="Crew now" aside="live">
        <CrewNow />
      </Section>
    </PhaseColumn>
  )
}
