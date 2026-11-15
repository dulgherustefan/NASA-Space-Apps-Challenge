import { useStore } from '@/lib/store'
import type { CrewState } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Fig } from '../Kind'
import { Meter } from '../Meter'
import { Empty } from './parts'

export const CREW_STATUS = ['walking', 'holding', 'stumbled', 'incapacitated', 'heat limit', 'oxygen limit', 'arrived', 'arrived late']
export const MODEL_SRC = 'Engine run-time model (walk physiology and suit model). Not a measurement of a real crew.'
export const crewName = (c: CrewState) => c.name ?? `EV${c.id + 1}`
export const crewBad = (c: CrewState) => c.status >= 2 && c.status !== 6

/** The consumable that runs out first: the one number to watch for a crew member. */
export function limiting(c: CrewState): { label: string; frac: number } {
  const heat = 1 - c.heat
  return c.o2 <= heat ? { label: 'Oxygen', frac: c.o2 } : { label: 'Heat margin', frac: heat }
}

/** Live suit state of each crew member. */
export function Crew() {
  const crew = useStore((s) => s.snapshot?.crew)
  return (
    <div className="px-4 pb-4 pt-1">
      {!crew?.length ? <Empty>No crew telemetry yet.</Empty> : (
        <ul className="space-y-4">
          {crew.map((c) => (
            <li key={c.id}>
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-[14px] font-bold text-ink">{crewName(c)}</span>
                <span className={cn('text-[12.5px]', crewBad(c) ? 'font-bold text-hazard' : 'text-ink3')}>{CREW_STATUS[c.status] ?? `status ${c.status}`}</span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <Meter label="Oxygen" frac={c.o2} source={MODEL_SRC} hint="usable oxygen left" />
                <Meter label="Heat margin" frac={1 - c.heat} source={MODEL_SRC} hint="room left before the heat-storage limit" />
                <div className="min-w-0">
                  <div className="cap">Dose</div>
                  <Fig value={c.dose} unit="mSv" kind="model" source={MODEL_SRC} label={`${crewName(c)} dose on this walk`} digits={3} valueClassName="text-[15px] font-bold" />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!!crew?.length && <p className="mt-3 text-[12px] text-ink3">Suit state from the walk model, not from a real crew. The suit's own warning system stays the authority.</p>}
    </div>
  )
}
