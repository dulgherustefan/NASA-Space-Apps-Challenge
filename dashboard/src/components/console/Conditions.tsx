import { useStore } from '@/lib/store'
import { hm, num } from '@/lib/format'
import type { Kind, Spread } from '@/lib/types'
import { Fig } from '../Kind'
import { Sensors } from '../Sensors'
import { Section } from './parts'

const SUN_NOTE = 'Geometric sunset of the Sun’s centre over a flat horizon. The canyon wall can shade the ground earlier.'
const minus = (x: number) => num(Math.round(x), 0).replace('-', '−')

function Tile({ label, value, unit, kind, source, digits }: { label: string; value: number | string | undefined | null; unit?: string; kind: Kind; source: string; digits?: number }) {
  return (
    <div className="min-w-0">
      <div className="cap truncate">{label}</div>
      {value === undefined || value === null
        ? <span className="num text-[14px] text-ink3">-</span>
        : <Fig value={value} unit={unit} digits={digits} kind={kind} source={source} label={label} valueClassName="text-[14px]" />}
    </div>
  )
}

const range = (lo: Spread | null | undefined, hi: Spread | null | undefined) => (lo && hi ? `${minus(lo.median)} to ${minus(hi.median)}` : null)

/** Light at the site now, a measured weather reference for the season, then the live traces. */
export function Conditions() {
  const env = useStore((s) => s.snapshot?.env)
  const tau = useStore((s) => s.snapshot?.sensors.tau)
  const w = useStore((s) => s.hello?.weather)
  const sunSrc = `${env?.sun_source ?? 'Sun position'}. ${SUN_NOTE}`
  const wSrc = w ? `${w.source} (${w.sols} sols). ${w.credit}. ${w.note}` : ''
  const season = env?.mars_year !== undefined && env?.ls !== undefined ? `Mars Year ${env.mars_year} · Ls ${num(env.ls, 0)}°` : undefined
  return (
    <Section title="Conditions" aside={season}>
      <div className="grid grid-cols-3 gap-x-3">
        <Tile label="Daylight left" value={env?.daylight_s === undefined ? undefined : env.daylight_s > 0 ? hm(env.daylight_s, true) : 'Sun down'} kind="model" source={sunSrc} />
        <Tile label="Sun height" value={env?.sun_el} unit="°" digits={0} kind="model" source={sunSrc} />
        <Tile label="Dust opacity" value={tau} digits={2} kind="model" source="Daily mean dust optical depth for the site and season from a climate model (see Parameters). No dust storm in this scenario." />
      </div>
      {w && (
        <div className="mt-3 border-t border-rule pt-3">
          <div className="cap mb-2">Same season at Gale crater, measured by Curiosity. An analogue, not this site.</div>
          <dl>
            {([['Ground, night to day', range(w.ground_min_c, w.ground_max_c), '°C'], ['Air, night to day', range(w.air_min_c, w.air_max_c), '°C'], ['UV index', w.uv_index_usual, undefined]] as const).map(([label, value, unit]) => (
              <div key={label} className="flex items-baseline justify-between gap-3 py-[5px] text-[13px]">
                <dt className="text-ink2">{label}</dt>
                <dd className="shrink-0">{value ? <Fig value={value} unit={unit} kind="measured" source={wSrc} label={label} /> : <span className="num text-ink3">-</span>}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className="mt-3 border-t border-rule pt-1">
        <Sensors kind="scenario" kindSource="Sensor reading produced by the engine for this scenario. Not an instrument observation." />
      </div>
    </Section>
  )
}
