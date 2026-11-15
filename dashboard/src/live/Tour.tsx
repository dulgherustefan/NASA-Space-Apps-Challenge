// 60-second guided tour: storm alert -> routes and virtual crews -> 3D -> helmet HUD walk. Runs the real engine.
import { useEffect } from 'react'
import { create } from 'zustand'
import { X } from 'lucide-react'
import { setCrew, setView, trigger, useLive } from './store'

interface TourState { active: boolean; step: number; caption: string }
export const useTour = create<TourState>(() => ({ active: false, step: 0, caption: '' }))
let timers: number[] = []

const STEPS: { at: number; caption: string; run?: () => void }[] = [
  { at: 0, caption: 'Real terrain: a 4 km box of HiRISE elevation data in NE Melas Chasma, Valles Marineris. Two crew are on foot, 1.3 km from their rover.',
    run: () => { setView('map'); const l = useLive.getState().loaded; if (l?.desc.bundled) setCrew(2560, 1640); else setCrew(2400, 1500) } },
  { at: 6000, caption: 'Solar storm alert. The rule: be under shelter within 30 minutes. Solway plans a route to every open shelter, right here in your browser.',
    run: () => { void trigger('storm') } },
  { at: 14000, caption: 'Each route is walked by 1,000 virtual crews with a trained walking policy. The answer: where to go, time against the rule, O₂ left, failure rate with its confidence interval.' },
  { at: 24000, caption: 'The same plan on the 3D terrain.', run: () => setView('3d') },
  { at: 32000, caption: 'Helmet HUD (simulated): the route on the ground ahead, one instruction at a time, ETA against the rule, O₂, heat and dose.', run: () => { if (useLive.getState().chosen) setView('helmet') } },
  { at: 56000, caption: 'Your turn: click anywhere to move the crew, trigger a marsquake, or pick any place on Mars.' },
  { at: 62000, caption: '', run: () => { setView('map'); stopTour() } },
]

export function startTour() {
  stopTour()
  useTour.setState({ active: true, step: 0, caption: STEPS[0].caption })
  timers = STEPS.map((s, i) => window.setTimeout(() => { s.run?.(); if (s.caption) useTour.setState({ step: i, caption: s.caption }) }, s.at))
}
export function stopTour() { timers.forEach(t => clearTimeout(t)); timers = []; useTour.setState({ active: false, caption: '' }) }

export function Tour() {
  const { caption, step } = useTour()
  useEffect(() => () => { /* keep timers when re-rendered */ }, [])
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-[60] flex justify-center px-3" role="status" aria-live="polite">
      <div className="pointer-events-auto flex max-w-2xl items-start gap-3 rounded-lg border border-accent/40 bg-black/85 px-4 py-3 shadow-[var(--shadow-float)] backdrop-blur">
        <span className="num mt-0.5 rounded bg-accent px-1.5 text-[12px] font-semibold text-on-accent">{step + 1}/{STEPS.length - 1}</span>
        <p className="text-[14px] leading-snug text-ink">{caption}</p>
        <button className="ml-1 text-ink3 hover:text-ink" aria-label="Stop the tour" onClick={stopTour}><X size={16} /></button>
      </div>
    </div>
  )
}
