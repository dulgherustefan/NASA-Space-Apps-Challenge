import { useStore } from '@/lib/store'
import { hm, lightTime, num } from '@/lib/format'
import type { Kind, Spread } from '@/lib/types'
import { Fig } from '../Kind'
import { Sensors } from '../Sensors'
import { More } from './parts'

const SUN_NOTE = 'Geometric sunset of the Sun’s centre over a flat horizon. The canyon wall can shade the ground earlier.'
const minus = (x: number) => num(Math.round(x), 0).replace('-', '−')

function Tile({ label, value, unit, kind, source, digits }: { label: string; value: number | string | undefined | null; unit?: string; kind: Kind; source: string; digits?: number }) {
  return (
    <div className="min-w-0">
      <div className="cap truncate">{label}</div>
      {value === undefined || value === null
        ? <span className="num text-[14px] text-ink3">-</span>
        : <Fig value={value} unit={unit} digits={digits} kind={kind} source={source} label={label} valueClassName="text-[15px] font-semibold" />}
    </div>
  )
}

const range = (lo: Spread | null | undefined, hi: Spread | null | undefined) => (lo && hi ? `${minus(lo.median)} to ${minus(hi.median)}` : null)

/** Light at the site now, a measured weather reference for the season, then the live traces. */
export function Conditions() {
  const env = useStore((s) => s.snapshot?.env)
  const tau = useStore((s) => s.snapshot?.sensors.tau)
  const w = useStore((s) => s.hello?.weather)
  const light = useStore((s) => s.snapshot?.light_time_s)
  const sunSrc = `${env?.sun_source ?? 'Sun position'}. ${SUN_NOTE}`
  const wSrc = w ? `${w.source} (${w.sols} sols). ${w.credit}. ${w.note}` : ''
  const season = env?.mars_year !== undefined && env?.ls !== undefined ? `Mars Year ${env.mars_year} · Ls ${num(env.ls, 0)}°` : undefined
  return (
    <div className="px-4 pb-4 pt-1">
      {season && <p className="mb-2 text-[12.5px] text-ink3">{season}</p>}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Tile label="Daylight left" value={env?.daylight_s === undefined ? undefined : env.daylight_s > 0 ? hm(env.daylight_s, true) : 'Sun down'} kind="model" source={sunSrc} />
        <Tile label="Sun height" value={env?.sun_el} unit="°" digits={0} kind="model" source={sunSrc} />
        <Tile label="Dust opacity" value={tau} digits={2} kind="model" source="Daily mean dust optical depth for the site and season from a climate model (see Parameters). No dust storm in this scenario." />
        <Tile label="Earth, one way" value={light === undefined ? undefined : lightTime(light)} kind="model" source="One-way light time to Earth, from JPL Horizons distances. A question and its answer take twice this, so the crew decides locally." />
      </div>
      {w && (
        <More label="Season reference from Curiosity">
          <div className="cap mb-1 mt-1">Same season at Gale crater, measured by Curiosity. An analogue, not this site.</div>
          <dl>
            {([['Ground, night to day', range(w.ground_min_c, w.ground_max_c), '°C'], ['Air, night to day', range(w.air_min_c, w.air_max_c), '°C'], ['UV index', w.uv_index_usual, undefined]] as const).map(([label, value, unit]) => (
              <div key={label} className="flex items-baseline justify-between gap-3 py-[5px] text-[13px]">
                <dt className="text-ink2">{label}</dt>
                <dd className="shrink-0">{value ? <Fig value={value} unit={unit} kind="measured" source={wSrc} label={label} /> : <span className="num text-ink3">-</span>}</dd>
              </div>
            ))}
          </dl>
        </More>
      )}
      <div className="mt-2">
        <Sensors kind="scenario" kindSource="Sensor reading produced by the engine for this scenario. Not an instrument observation." />
      </div>
    </div>
  )
}
