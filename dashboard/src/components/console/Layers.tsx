import { focusBundle, store, useStore } from '@/lib/store'
import { LAYERS, LAYER_LABEL, type Layer } from '@/lib/config'
import { ChevronDown, Layers } from 'lucide-react'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

// Colour ramps and ranges as the engine paints them (engine/hazards.py).
const INFERNO = 'linear-gradient(90deg, rgb(40,11,84), rgb(101,21,110), rgb(188,55,84), rgb(249,142,9), rgb(252,255,164))'
export const LAYER_INFO: Record<Layer, { what: string; ramp: string; lo: string; hi: string }> = {
  hazard: { what: 'Combined hazard: slope, rockfall runout band and loose sand. Model.', ramp: INFERNO, lo: 'lower', hi: 'higher' },
  slope: { what: 'Slope over 10 m from the HiRISE elevation model.', ramp: INFERNO, lo: '8°', hi: '35°' },
  rockfall: { what: 'Rockfall runout band below steep faces, reach angle 27.8°. Model.', ramp: 'linear-gradient(90deg, rgb(230,159,0), rgb(213,94,0))', lo: 'band edge', hi: 'deep in band' },
  sand: { what: 'Loose sand likelihood. A proxy from image brightness and smoothness, not a measurement.', ramp: 'linear-gradient(90deg, rgb(240,228,66), rgb(230,159,0))', lo: 'possible', hi: 'likely' },
  sky: { what: 'Share of the sky blocked by terrain. Blocked sky shields from particle radiation. Model.', ramp: 'linear-gradient(90deg, rgb(86,180,233), rgb(0,114,178))', lo: '15% blocked', hi: '45%' },
  dose: { what: 'Dose rate at each cell at the storm peak, after terrain shielding. Model.', ramp: 'linear-gradient(90deg, rgb(204,121,167), rgb(120,40,140))', lo: 'shielded', hi: 'exposed' },
  comm: { what: 'Dimmed ground has no direct radio line of sight to the habitat or the rover antenna. Geometric model on the HiRISE elevation; antenna heights are assumptions, diffraction and relay satellites are not included.', ramp: 'linear-gradient(90deg, rgba(16,20,28,.85), rgba(16,20,28,.85))', lo: 'dimmed:', hi: 'no line of sight' },
  failures: { what: 'Where virtual crews failed in the stress test, weighted by likelihood. Model.', ramp: 'linear-gradient(90deg, rgb(140,41,100), rgb(249,142,9), rgb(252,255,164))', lo: 'few', hi: 'many' },
}

const SHORT: Record<Layer, string> = {
  hazard: 'Slope, rockfall band and loose sand together',
  slope: 'Slope over 10 m',
  rockfall: 'Runout band below steep faces',
  sand: 'Loose sand likelihood, an image proxy',
  sky: 'Sky blocked by terrain, which shields from radiation',
  dose: 'Dose rate at the storm peak',
  comm: 'Ground without radio line of sight',
  failures: 'Where virtual crews failed in the stress test',
}

/** One control for what the map shows: the colour layer, and the two line overlays. */
export function LayerMenu() {
  const layer = useStore((s) => s.overlay.layer)
  const contours = useStore((s) => s.contours)
  const showReplays = useStore((s) => s.showReplays)
  const bundle = useStore(focusBundle)
  const fromEngine = new Set((bundle?.assessment?.overlays ?? []).map((o) => o.layer))
  const set = (l: string | null) => store.set((s) => ({ overlay: { ...s.overlay, layer: l, userSet: true } }))
  const current = layer && layer in LAYER_LABEL ? LAYER_LABEL[layer as Layer] : 'Image only'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Map layer: ${current}`}
          className="float flex h-10 items-center gap-2 rounded-[8px] pl-3 pr-2.5 text-[13.5px] text-ink transition-colors duration-150 hover:bg-panel2 data-[state=open]:bg-panel2">
          <Layers size={15} className="text-ink2" />
          <span className="text-ink3 max-sm:hidden">Layer</span>{current}
          <ChevronDown size={14} className="text-ink3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[304px]">
        <DropdownMenuLabel>Colour the map by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={layer ?? 'off'} onValueChange={(v) => set(v === 'off' ? null : v)}>
          {LAYERS.map((l) => (
            <DropdownMenuRadioItem key={l} value={l}>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 leading-tight">{LAYER_LABEL[l]}{fromEngine.has(l) && <span className="text-[12px] font-semibold text-ink2">updated by this incident</span>}</div>
                <div className="text-[12px] leading-snug text-ink3">{SHORT[l]}</div>
              </div>
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuRadioItem value="off">
            <div className="min-w-0">
              <div className="leading-tight">Image only</div>
              <div className="text-[12px] leading-snug text-ink3">HiRISE orthoimage, no colour layer</div>
            </div>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Also draw</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={contours} onCheckedChange={(v) => store.set({ contours: !!v })} onSelect={(e) => e.preventDefault()}>Elevation contours, every 20 m</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={showReplays} onCheckedChange={(v) => store.set({ showReplays: !!v })} onSelect={(e) => e.preventDefault()}>Virtual crews from the stress test</DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** What the colours of the current layer mean. Hover or tap for the full definition. */
export function LayerLegend() {
  const layer = useStore((s) => s.overlay.layer) as Layer | null
  if (!layer || !LAYER_INFO[layer]) return null
  const info = LAYER_INFO[layer]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div tabIndex={0} className="flex cursor-help items-center gap-2 text-[12px] text-ink2">
          <span className="hidden text-ink sm:inline">{LAYER_LABEL[layer]}</span>
          <span className="text-ink3">{info.lo}</span>
          <span className="h-2 w-20 rounded-[2px]" style={{ background: info.ramp }} />
          <span className="text-ink3">{info.hi}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">{info.what}</TooltipContent>
    </Tooltip>
  )
}
