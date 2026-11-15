import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Fig } from '../Kind'
import { Meter } from '../Meter'
import { Empty } from './parts'

const CREW_STATUS = ['walking', 'holding', 'stumbled', 'incapacitated', 'heat limit', 'oxygen limit', 'arrived', 'arrived late']
const MODEL_SRC = 'Engine run-time model (walk physiology and suit model). Not a measurement of a real crew.'

/** Live suit state of each crew member. */
export function Crew() {
  const crew = useStore((s) => s.snapshot?.crew)
  return (
    <div className="px-4 pb-5 pt-4">
      {!crew?.length ? <Empty>No crew telemetry yet.</Empty> : (
        <ul className="space-y-5">
          {crew.map((c) => {
            const bad = c.status >= 2 && c.status !== 6
            return (
              <li key={c.id}>
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-[14px] font-medium text-ink">{c.name ?? `EV${c.id + 1}`}</span>
                  <span className={cn('text-[12.5px]', bad ? 'text-hazard' : c.status === 6 ? 'text-safe' : 'text-ink3')}>{CREW_STATUS[c.status] ?? `status ${c.status}`}</span>
                </div>
                <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-3">
                  <Meter label="Oxygen" frac={c.o2} source={MODEL_SRC} hint="usable oxygen left" />
                  <Meter label="Heat margin" frac={1 - c.heat} source={MODEL_SRC} hint="room left before the heat-storage limit" />
                  <div className="flex items-baseline gap-2">
                    <span className="text-[11.5px] text-ink2">Dose</span>
                    <Fig value={c.dose} unit="mSv" kind="model" source={MODEL_SRC} label={`${c.name ?? 'Crew'} dose on this walk`} digits={3} />
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {!!crew?.length && <p className="mt-4 text-[12px] text-ink3">Live suit state from the walk model, not from a real crew.</p>}
    </div>
  )
}
