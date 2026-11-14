import { Area, AreaChart, CartesianGrid, ReferenceDot, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { useStore } from '@/lib/store'
import { Fig } from './Kind'
import { missionT, num } from '@/lib/format'
import type { Kind } from '@/lib/types'

const SERIES = [
  { key: 'dose_rate' as const, label: 'Dose rate', unit: 'uGy/h', digits: 1 },
  { key: 'seismic' as const, label: 'Seismic', unit: 'm/s2', digits: 3 },
  { key: 'tau' as const, label: 'Dust tau', unit: '', digits: 2 },
]

function ChartTip({ active, payload, unit, digits }: { active?: boolean; payload?: { payload: { t: number; v: number } }[]; unit: string; digits: number }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="rounded-[3px] border border-rule2 bg-panel3 px-2 py-1 text-[11px] shadow-lg">
      <div className="num text-ink3">{missionT(p.t)}</div>
      <div className="num text-ink">{num(p.v, digits)} <span className="text-ink3">{unit}</span></div>
    </div>
  )
}

export function Sensors({ kind, kindSource }: { kind: Kind; kindSource: string }) {
  const sensors = useStore((s) => s.sensors)
  return (
    <div className="space-y-1">
      {SERIES.map((s) => {
        const data = sensors.map((p) => ({ t: p.t, v: p[s.key] }))
        const last = data[data.length - 1]
        const ys = data.map((d) => d.v)
        const lo = ys.length ? Math.min(...ys) : 0, hi = ys.length ? Math.max(...ys) : 1
        const pad = (hi - lo) * 0.15 || Math.max(Math.abs(hi) * 0.1, 0.01)
        return (
          <div key={s.key} className="rule-b pb-1.5 last:border-b-0">
            <div className="flex items-baseline justify-between pt-1.5">
              <span className="text-[11.5px] text-ink2">{s.label}</span>
              {last ? <Fig value={last.v} unit={s.unit} kind={kind} source={kindSource} label={s.label} digits={s.digits} valueClassName="text-[13px]" /> : <span className="num text-ink3">-</span>}
            </div>
            <div className="h-[46px]">
              {data.length > 1 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--color-rule)" />
                    <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} hide />
                    <YAxis domain={[lo - pad, hi + pad]} hide />
                    <RTooltip content={<ChartTip unit={s.unit} digits={s.digits} />} cursor={{ stroke: 'var(--color-ink3)', strokeWidth: 1 }} isAnimationActive={false} />
                    <Area dataKey="v" type="monotone" stroke="var(--color-data)" strokeWidth={2} strokeLinecap="round" fill="var(--color-data)" fillOpacity={0.1} dot={false} activeDot={{ r: 4, stroke: 'var(--color-panel)', strokeWidth: 2, fill: 'var(--color-data)' }} isAnimationActive={false} />
                    <ReferenceDot x={last.t} y={last.v} r={4} fill="var(--color-data)" stroke="var(--color-panel)" strokeWidth={2} ifOverflow="extendDomain" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="flex h-full items-center text-[11px] text-ink3">Trace starts when the mission clock runs</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
