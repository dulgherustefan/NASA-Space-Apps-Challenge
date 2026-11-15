import { useState } from 'react'
import { focusBundle, focusIncidentId, useStore } from '@/lib/store'
import { useLayout } from '@/lib/derive'
import { ActionCard } from '@/components/console/ActionCard'
import { Crew } from '@/components/console/Crew'
import { Routes } from '@/components/console/Routes'
import { Situation } from '@/components/console/Situation'
import { MapView } from '@/components/MapView'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Tab = 'routes' | 'crew' | 'situation'

/**
 * Everything behind the decision, one group at a time. Routes open by themselves once the planner has
 * proposed them; a tab the operator picks stays until the next incident.
 */
function Detail() {
  const focusId = useStore(focusIncidentId)
  const routeCount = useStore((s) => focusBundle(s)?.routes?.length ?? 0)
  const crewAlert = useStore((s) => !!s.snapshot?.crew.some((c) => c.status >= 2 && c.status !== 6))
  const [pick, setPick] = useState<{ id: string | null; tab: Tab } | null>(null)
  const tab: Tab = pick && pick.id === focusId ? pick.tab : routeCount ? 'routes' : 'crew'
  return (
    <Tabs value={tab} onValueChange={(v) => setPick({ id: focusId, tab: v as Tab })}>
      <TabsList aria-label="Detail" className="sticky top-0 z-10 bg-panel">
        <TabsTrigger value="routes">Routes{routeCount > 0 && <span className="num text-[12px] font-normal text-ink3">{routeCount}</span>}</TabsTrigger>
        <TabsTrigger value="crew">Crew{crewAlert && <span className="h-1.5 w-1.5 rounded-full bg-hazard" aria-label="needs attention" />}</TabsTrigger>
        <TabsTrigger value="situation">Situation</TabsTrigger>
      </TabsList>
      <TabsContent value="routes"><Routes /></TabsContent>
      <TabsContent value="crew"><Crew /></TabsContent>
      <TabsContent value="situation"><Situation /></TabsContent>
    </Tabs>
  )
}

/**
 * One screen: the map and one rail.
 * wide, split: map | decision, then detail tabs   (habitat display, laptop)
 * field:       decision, map, detail tabs         (tablet or cuff display: one column, large targets)
 */
export function ConsolePage() {
  const layout = useLayout()
  if (layout === 'field') {
    return (
      <div className="h-full overflow-y-auto bg-panel" data-layout="field">
        <ActionCard compact />
        <div className="h-[52vh] min-h-[300px] border-y border-rule"><MapView /></div>
        <Detail />
      </div>
    )
  }
  return (
    <div className="grid h-full min-h-0" data-layout={layout} style={{ gridTemplateColumns: `minmax(0,1fr) ${layout === 'wide' ? 424 : 384}px` }}>
      <section className="min-h-0 min-w-0" aria-label="Map"><MapView /></section>
      <aside className="min-h-0 overflow-y-auto border-l border-rule bg-panel" aria-label="Response">
        <ActionCard />
        <Detail />
      </aside>
    </div>
  )
}
