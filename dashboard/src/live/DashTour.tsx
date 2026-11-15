// Guided tour over the main dashboard: storm alert -> routes and stress test -> helmet HUD walk -> try it yourself.
import { useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { store } from '@/lib/store'
import { sendCmd } from '@/lib/engine'

let caption = ''
let step = 0
let timers: number[] = []
let poll = 0
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())
const say = (n: number, text: string) => { step = n; caption = text; emit() }
export const openView = (v: '3d' | 'hud' | null) => window.dispatchEvent(new CustomEvent('solway:view', { detail: v }))

export function stopDashTour() {
  timers.forEach(clearTimeout); timers = []; clearInterval(poll); poll = 0
  caption = ''; emit()
}

export function startDashTour() {
  stopDashTour()
  openView(null)
  say(1, 'Real terrain: HiRISE elevation data of NE Melas Chasma, Mars. Two crew are on foot at the science site, far from their rover.')
  sendCmd({ cmd: 'demo' })
  const t0 = performance.now()
  poll = window.setInterval(() => {
    const s = store.get()
    const decided = Object.values(s.incidents).some(b => b.incident.kind === 'sep' && b.decision)
    if (decided || performance.now() - t0 > 30000) {
      clearInterval(poll); poll = 0
      say(2, 'Solar storm alert. Solway compares a route to every open shelter, stress-tests each with virtual crews, and gives one answer: where to go, time against the 30-minute rule, what is left on arrival.')
      timers.push(window.setTimeout(() => {
        sendCmd({ cmd: 'pause' })
        say(3, 'The crew walks it in a helmet display (simulated): the route on the ground ahead, one instruction at a time, the rule countdown, O₂, heat and dose, and the rover camera.')
        openView('hud')
      }, 10000))
      timers.push(window.setTimeout(() => say(4, 'Your turn: Plan a walk from any point to any point (computed in your browser), open the 3D map, or pick any place on Mars.'), 34000))
      timers.push(window.setTimeout(() => { openView(null); stopDashTour() }, 44000))
    }
  }, 250)
}

export function DashTourCaption() {
  const text = useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f) }, () => caption)
  if (!text) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex justify-center px-3" role="status" aria-live="polite">
      <div className="pointer-events-auto flex max-w-2xl items-start gap-3 rounded-[8px] border border-rule2 bg-panel px-4 py-3 shadow-float">
        <span className="num mt-0.5 rounded-[4px] bg-solid px-1.5 text-[12px] font-semibold text-on-solid">{step}/4</span>
        <p className="text-[14px] leading-snug text-ink">{text}</p>
        <button type="button" className="ml-1 text-ink3 hover:text-ink" aria-label="Stop the tour" onClick={() => { openView(null); stopDashTour() }}><X size={16} /></button>
      </div>
    </div>
  )
}
