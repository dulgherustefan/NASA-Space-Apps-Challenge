import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { RefreshCw } from 'lucide-react'
import { useStore } from '@/lib/store'
import { loadTraining } from '@/lib/engine'
import { Button } from './ui/button'
import { num } from '@/lib/format'

type Row = Record<string, number>
const X_KEYS = ['timesteps', 'total_timesteps', 'global_step', 'step', 'steps', 'update', 'iteration', 'iter', 'epoch', 'episode', 'generation']
const Y_PREF = ['best_log_p', 'mean_log_p', 'robustness_nats', 'robustness', 'mean_reward', 'ep_rew_mean', 'reward', 'return', 'log_p', 'best', 'mean', 'loss']

/** Reads whatever table the training run wrote: array of records, or a record of arrays. */
export function parseTraining(d: unknown): { xKey: string; rows: Row[]; ys: string[] } | null {
  let recs: Row[] | null = null
  const isRecArr = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.length > 1 && typeof v[0] === 'object' && v[0] !== null && !Array.isArray(v[0])
  if (isRecArr(d)) recs = d as Row[]
  else if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>
    const arr = Object.values(o).find(isRecArr)
    if (arr) recs = arr as Row[]
    else {
      const cols = Object.entries(o).filter(([, v]) => Array.isArray(v) && v.length > 1 && v.every((x) => typeof x === 'number')) as [string, number[]][]
      if (cols.length) {
        const n = Math.min(...cols.map(([, v]) => v.length))
        recs = Array.from({ length: n }, (_, i) => Object.fromEntries(cols.map(([k, v]) => [k, v[i]])))
      }
    }
  }
  if (!recs || recs.length < 2) return null
  const numericKeys = Object.keys(recs[0]).filter((k) => typeof recs![0][k] === 'number')
  const xKey = X_KEYS.find((k) => numericKeys.includes(k)) ?? '__i'
  const rows = recs.map((r, i) => ({ ...r, __i: i + 1 }) as Row)
  const rest = numericKeys.filter((k) => k !== xKey)
  const ys = [...Y_PREF.filter((k) => rest.includes(k)), ...rest.filter((k) => !Y_PREF.includes(k))].slice(0, 2)
  if (!ys.length) return null
  return { xKey, rows, ys }
}
const human = (k: string) => k.replace(/_/g, ' ').replace(/\blog p\b/, 'log p')
const COLORS = ['var(--color-data)', 'var(--color-accent)']

export function LearningCurve() {
  const t = useStore((s) => s.training)
  const parsed = t.status === 'ready' ? parseTraining(t.data) : null
  return (
    <div>
      {t.status === 'ready' && parsed ? (
        <>
          <div className="h-[132px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={parsed.rows} margin={{ top: 6, right: 8, bottom: 0, left: -6 }}>
                <CartesianGrid vertical={false} stroke="var(--color-rule)" />
                <XAxis dataKey={parsed.xKey} type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 9, fill: 'var(--color-ink3)', fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={{ stroke: 'var(--color-rule2)' }} tickFormatter={(v) => num(v)} minTickGap={36} padding={{ left: 0, right: 14 }} />
                <YAxis tick={{ fontSize: 9, fill: 'var(--color-ink3)', fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false} width={34} tickCount={4} tickFormatter={(v) => num(v)} />
                <RTooltip
                  isAnimationActive={false}
                  cursor={{ stroke: 'var(--color-ink3)' }}
                  contentStyle={{ background: 'var(--color-panel3)', border: '1px solid var(--color-rule2)', borderRadius: 3, fontSize: 11, padding: '4px 8px' }}
                  labelStyle={{ color: 'var(--color-ink3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}
                  labelFormatter={(v) => `${human(parsed.xKey === '__i' ? 'row' : parsed.xKey)} ${num(Number(v))}`}
                  formatter={(v, n) => [num(Number(v), 2), human(String(n))]}
                />
                <Legend iconType="plainline" wrapperStyle={{ fontSize: 10.5, color: 'var(--color-ink2)', paddingTop: 2 }} formatter={(v) => <span style={{ color: 'var(--color-ink2)' }}>{human(String(v))}</span>} />
                {parsed.ys.map((y, i) => (
                  <Line key={y} dataKey={y} stroke={COLORS[i]} strokeWidth={2} strokeLinecap="round" dot={false} activeDot={{ r: 4, stroke: 'var(--color-panel)', strokeWidth: 2 }} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-ink3">Training run on the offline machine ({parsed.rows.length} rows from data/ast/ast_training.json). Model output.</p>
        </>
      ) : (
        <div className="flex items-start justify-between gap-3 rounded-[3px] border border-dashed border-rule2 px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[12px] text-ink2">{t.status === 'loading' ? 'Checking for the training curve' : t.status === 'ready' ? 'Training file has no table to plot' : t.status === 'idle' ? 'Waiting for the engine' : 'Not available yet'}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-ink3">
              {t.status === 'ready'
                ? 'data/ast/ast_training.json has no list of records or numeric columns.'
                : 'Shown once the offline stress-test run delivers data/ast/ast_training.json. Until then, results are labelled with their source, for example "local preview".'}
            </div>
          </div>
          <Button variant="quiet" size="sm" className="shrink-0" disabled={t.status === 'loading'} onClick={() => void loadTraining()}><RefreshCw size={12} />Check</Button>
        </div>
      )}
    </div>
  )
}
