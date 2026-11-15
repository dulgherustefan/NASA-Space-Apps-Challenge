import { useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { RefreshCw } from 'lucide-react'
import { useStore } from '@/lib/store'
import { loadTraining } from '@/lib/engine'
import { Button } from './ui/button'
import { num } from '@/lib/format'
import { cn } from '@/lib/utils'

// data/ast/ast_training.json: scenarios[scenario][route][configuration][method] = [{ seed, curve: [[steps, logLikelihood], ...] }]
interface Run { seed: number; curve: [number, number][] }
type Methods = Record<string, Run[]>
interface TrainingFile {
  axes?: { x?: string; y?: string }
  note?: string
  scenarios: Record<string, Record<string, Record<string, Methods>>>
}

const METHOD_NAME: Record<string, string> = { mc: 'Monte Carlo', random: 'Random search', random_search: 'Random search', cem: 'Cross-entropy', cem_restart: 'Cross-entropy with restarts', ppo: 'PPO adversary', 'ppo-ast': 'PPO adversary' }
const METHOD_COLOR: Record<string, string> = { mc: 'var(--color-ink3)', random: 'var(--color-data)', random_search: 'var(--color-data)', cem: 'var(--color-ink)', cem_restart: 'var(--color-k-scenario)', ppo: 'var(--color-safe)', 'ppo-ast': 'var(--color-safe)' }
const CONFIG_NAME: Record<string, string> = { falls_terminal: 'A fall ends the walk', falls_penalty: 'A fall costs time and energy' }

function isTraining(d: unknown): d is TrainingFile {
  return !!d && typeof d === 'object' && typeof (d as TrainingFile).scenarios === 'object' && (d as TrainingFile).scenarios !== null
}
const hasCurves = (m: Methods | undefined) => !!m && Object.values(m).some((runs) => Array.isArray(runs) && runs.some((r) => Array.isArray(r.curve) && r.curve.length > 0))
const compact = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : Math.abs(v) >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v))

function Chips<T extends string>({ label, items, value, onChange, name }: { label: string; items: T[]; value: T; onChange: (v: T) => void; name: (v: T) => string }) {
  if (items.length < 2) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={label}>
      <span className="cap mr-1">{label}</span>
      {items.map((it) => (
        <button key={it} type="button" role="radio" aria-checked={it === value} onClick={() => onChange(it)}
          className={cn('h-7 rounded-[4px] border px-2 text-[12px] transition-colors', it === value ? 'border-ink bg-panel3 font-semibold text-ink' : 'border-rule2 text-ink2 hover:text-ink')}>
          {name(it)}
        </button>
      ))}
    </div>
  )
}

function Curves({ file }: { file: TrainingFile }) {
  const scenarios = Object.keys(file.scenarios)
  const [scenario, setScenario] = useState(scenarios[0])
  const routes = Object.keys(file.scenarios[scenario] ?? {})
  const [route, setRoute] = useState(routes[0])
  const byConfig = file.scenarios[scenario]?.[routes.includes(route) ? route : routes[0]] ?? {}
  const configs = Object.keys(byConfig).filter((c) => hasCurves(byConfig[c]))
  const [config, setConfig] = useState(configs[0])
  const methods = byConfig[configs.includes(config) ? config : configs[0]] ?? {}
  const series = Object.entries(methods).flatMap(([m, runs]) => (runs ?? []).filter((r) => r.curve?.length).map((r) => ({
    key: `${m}:${r.seed}`, method: m, seed: r.seed, data: r.curve.map(([x, y]) => ({ x, y })),
  })))
  const shown = [...new Set(series.map((s) => s.method))]
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-2">
        <Chips label="Scenario" items={scenarios} value={scenario} onChange={(v) => { setScenario(v); setRoute(Object.keys(file.scenarios[v] ?? {})[0]) }} name={(v) => v} />
        <Chips label="Route" items={routes} value={routes.includes(route) ? route : routes[0]} onChange={setRoute} name={(v) => v} />
        <Chips label="Falls" items={configs} value={configs.includes(config) ? config : configs[0]} onChange={setConfig} name={(v) => CONFIG_NAME[v] ?? v} />
      </div>
      {series.length === 0 ? <p className="text-[13px] text-ink3">No curve stored for this route.</p> : (
        <>
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--color-rule)" />
                <XAxis dataKey="x" type="number" scale="log" domain={['dataMin', 'dataMax']} allowDuplicatedCategory={false} tick={{ fontSize: 11, fill: 'var(--color-ink3)', fontFamily: 'var(--font-sans)' }} tickLine={false} axisLine={{ stroke: 'var(--color-rule2)' }} tickFormatter={compact} minTickGap={40} />
                <YAxis type="number" domain={['auto', 'auto']} tick={{ fontSize: 11, fill: 'var(--color-ink3)', fontFamily: 'var(--font-sans)' }} tickLine={false} axisLine={false} width={40} tickCount={5} tickFormatter={(v) => num(Number(v), 1)} />
                <RTooltip isAnimationActive={false} cursor={{ stroke: 'var(--color-ink3)' }}
                  contentStyle={{ background: 'var(--color-panel3)', border: '1px solid var(--color-rule2)', borderRadius: 4, fontSize: 12, padding: '6px 10px' }}
                  labelStyle={{ color: 'var(--color-ink3)', fontFamily: 'var(--font-sans)', fontSize: 11 }}
                  labelFormatter={(v) => `${compact(Number(v))} simulator steps`}
                  formatter={(v, n) => [`${num(Number(v), 1)} nats`, String(n)]} />
                {series.map((s) => (
                  <Line key={s.key} data={s.data} dataKey="y" name={`${METHOD_NAME[s.method] ?? s.method}, seed ${s.seed}`} type="stepAfter" stroke={METHOD_COLOR[s.method] ?? 'var(--color-ink2)'} strokeWidth={2} strokeLinecap="round"
                    dot={s.data.length < 12 ? { r: 2.5, strokeWidth: 0, fill: METHOD_COLOR[s.method] ?? 'var(--color-ink2)' } : false} activeDot={{ r: 4, stroke: 'var(--color-panel)', strokeWidth: 2 }} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink2">
            {shown.map((m) => (
              <span key={m} className="flex items-center gap-1.5">
                <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke={METHOD_COLOR[m] ?? 'var(--color-ink2)'} strokeWidth="2.4" /></svg>
                {METHOD_NAME[m] ?? m}{methods[m].length > 1 ? `, ${methods[m].length} seeds` : ''}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[12px] leading-snug text-ink3">
            Across: {file.axes?.x ?? 'simulator steps used by the search'} (log scale). Up: {file.axes?.y ?? 'log-likelihood of the most likely failure found so far, in nats'}.
            Each curve runs as far as the simulator steps that search used. Model output from data/ast/ast_training.json.
          </p>
        </>
      )}
    </div>
  )
}

export function LearningCurve() {
  const t = useStore((s) => s.training)
  if (t.status === 'ready' && isTraining(t.data)) return <Curves file={t.data} />
  return (
    <div className="flex items-start justify-between gap-3 rounded-[4px] border border-dashed border-rule2 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] text-ink2">{t.status === 'loading' ? 'Checking for the training curve' : t.status === 'ready' ? 'Training file has no curves to plot' : t.status === 'idle' ? 'Waiting for the engine' : 'Not available yet'}</div>
        <div className="mt-0.5 text-[12px] leading-snug text-ink3">
          {t.status === 'ready'
            ? 'data/ast/ast_training.json does not hold per-method curves.'
            : 'Shown once the offline stress-test run delivers data/ast/ast_training.json. Until then, results are labelled with their source, for example "local preview".'}
        </div>
      </div>
      <Button variant="quiet" size="sm" className="shrink-0" disabled={t.status === 'loading'} onClick={() => void loadTraining()}><RefreshCw size={12} />Check</Button>
    </div>
  )
}
