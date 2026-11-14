import { AssessColumn } from '@/components/columns/Assess'
import { DetectColumn } from '@/components/columns/Detect'
import { COL_FR, LoopRail } from '@/components/columns/PhaseColumn'
import { RespondColumn } from '@/components/columns/Respond'
import { SimulateColumn } from '@/components/columns/Simulate'
import { MapView } from '@/components/MapView'

export function ConsolePage() {
  return (
    <div className="grid h-full min-h-0" style={{ gridTemplateColumns: 'minmax(0,1fr) clamp(440px, 33vw, 660px)' }}>
      <div className="flex min-h-0 min-w-0 flex-col">
        <LoopRail widths={COL_FR} />
        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: COL_FR.map((f) => `minmax(0,${f}fr)`).join(' ') }}>
          <DetectColumn />
          <AssessColumn />
          <SimulateColumn />
          <RespondColumn />
        </div>
      </div>
      <aside className="min-h-0 min-w-0 border-l border-rule2"><MapView /></aside>
    </div>
  )
}
