import { PageShell, H2 } from './PageShell'

interface Row { name: string; credit: string; terms: string; use: string }

const DATA: Row[] = [
  { name: 'HiRISE DTM DTEEC_028857_1700_028923_1700_A01', credit: 'NASA/JPL/University of Arizona/USGS', terms: 'CC0. USGS Astrogeology STAC, collection mro_hirise_socet_dtms', use: 'Elevation, 1 m, 4 × 4 km core box. Slope, roughness, sky view and the walking model are derived from it.' },
  { name: 'HiRISE orthoimage ESP_028857_1700_RED_C_01_ORTHO', credit: 'NASA/JPL/University of Arizona', terms: 'Public domain', use: 'The greyscale base image of the tactical map. Surface colour in the app is an approximate tint.' },
  { name: 'CTX DTM D04_028857_1684_XN_11S069W and D04_028923_1684_XN_11S069W', credit: 'NASA/JPL/MSSS/USGS', terms: 'CC0. USGS Astrogeology STAC, collection mro_ctx_controlled_usgs_dtms', use: 'Regional elevation strip around the core box.' },
]
const INCIDENT_DATA: Row[] = [
  { name: 'MSL RAD solar particle event of 20 May 2024 (Loewe et al. 2025, arXiv:2502.02469)', credit: 'NASA/JPL, Curiosity RAD team', terms: 'Published results', use: 'Time to peak, 30 minute shelter rule, unshielded dose.' },
  { name: 'MSL RAD background dose (Hassler et al. 2014, Science 343)', credit: 'MSL RAD team', terms: 'Published results', use: 'Background dose rate from galactic cosmic rays.' },
  { name: 'Marsquake rockfall at Cerberus Fossae (Vijayan et al. 2026)', credit: 'Authors as cited', terms: 'Published results', use: 'Boulder count and rockfall rate after a marsquake. Observed at Cerberus Fossae, not at Melas Chasma.' },
  { name: 'InSight Mars Seismic Catalogue, MQS v14', credit: 'InSight Marsquake Service, ETH Zurich', terms: 'doi 10.12686/a21', use: 'Context for scenario marsquakes.' },
  { name: 'Mars Dust Activity Database (Battalio and Wang 2021, Icarus 354, 114059)', credit: 'Battalio and Wang', terms: 'CC BY 4.0, Zenodo record 7480334', use: 'Context for dust scenarios.' },
  { name: 'JPL Horizons system', credit: 'NASA/JPL Solar System Dynamics', terms: 'Public API', use: 'Sun position at the site and Earth to Mars light time.' },
]
const METHOD: Row[] = [
  { name: 'Adaptive Stress Testing: Finding Likely Failure Events with Reinforcement Learning (Lee et al. 2020, Journal of Artificial Intelligence Research 69)', credit: 'Lee, Mengshoel, Saksena, Gardner, Genin, Silbermann, Owen, Kochenderfer', terms: 'Published method', use: 'The search for the most likely failure of a route.' },
  { name: 'Exploration EVA testing and analogs (NTRS 20210000827)', credit: 'NASA', terms: 'Public', use: 'Planning speed, slope limit and oxygen reserve.' },
  { name: 'HRP evidence report on EVA (NTRS 20220004017)', credit: 'NASA', terms: 'Public', use: 'Suit cooling limit and stored-heat limits.' },
  { name: 'Apollo 16 Time and Motion Study (NTRS 19730008098)', credit: 'NASA', terms: 'Public', use: 'Nominal suited walking pace.' },
]
const MODELS: Row[] = [
  { name: 'Habitat Demonstration Unit (parts 1 and 2)', credit: 'NASA, from NASA-3D-Resources', terms: 'Free and without copyright (NASA media guidelines)', use: '3D view' },
  { name: 'Space Exploration Vehicle', credit: 'NASA, from NASA-3D-Resources', terms: 'Free and without copyright (NASA media guidelines)', use: '3D view' },
  { name: 'Astronaut, rigged, 24 animations', credit: 'Quaternius, poly.pizza/m/3hC2i0CTuO', terms: 'CC0 1.0', use: '3D view' },
  { name: 'moon_rock_01 to 04', credit: 'Greg Zaal, Rico Cilliers, Jenelle van Heerden, Dario Barresi (Poly Haven)', terms: 'CC0 1.0', use: '3D view. Earth and studio scans, not Mars data.' },
  { name: 'rock_09', credit: 'Jenelle van Heerden (Poly Haven)', terms: 'CC0 1.0', use: '3D view' },
  { name: 'namaqualand_boulder_03', credit: 'Jenelle van Heerden, Dario Barresi (Poly Haven)', terms: 'CC0 1.0', use: '3D view' },
  { name: 'red_laterite_soil_stones', credit: 'Amal Kumar (Poly Haven)', terms: 'CC0 1.0', use: 'Ground detail texture' },
  { name: 'sandy_gravel_02', credit: 'Dario Barresi (Poly Haven)', terms: 'CC0 1.0', use: 'Ground detail texture' },
  { name: 'dry_ground_rocks', credit: 'Rob Tuytel (Poly Haven)', terms: 'CC0 1.0', use: 'Ground detail texture' },
]
const SOFTWARE: Row[] = [
  { name: 'Instrument Sans and JetBrains Mono, bundled through Fontsource', credit: 'Instrument, JetBrains', terms: 'SIL Open Font License 1.1', use: 'Interface type' },
  { name: 'Electron, React, Recharts, Radix UI, Tailwind CSS, lucide icons', credit: 'Their authors', terms: 'MIT and ISC licences', use: 'This dashboard' },
]

function Table({ rows, head }: { rows: Row[]; head: [string, string, string, string] }) {
  return (
    <table className="w-full table-fixed border-collapse text-left text-[12.5px]">
      <colgroup><col style={{ width: '36%' }} /><col style={{ width: '20%' }} /><col style={{ width: '19%' }} /><col style={{ width: '25%' }} /></colgroup>
      <thead><tr className="border-y border-rule text-ink3">{head.map((h) => <th key={h} className="py-1.5 pr-3 font-mono text-[10px] font-medium uppercase tracking-wider">{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="rule-b align-top">
            <td className="py-2.5 pr-3 text-ink">{r.name}</td><td className="py-2.5 pr-3 text-ink2">{r.credit}</td><td className="py-2.5 pr-3 text-ink2">{r.terms}</td><td className="py-2.5 text-ink3">{r.use}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function SourcesPage() {
  return (
    <PageShell wide title="Sources" lede="The data, papers and assets behind what you see on the console.">
      <div className="mb-8 rounded-[3px] border border-rule2 bg-panel px-4 py-3 text-[13.5px] text-ink">
        Not affiliated with or endorsed by NASA. No NASA insignia or logos are used.
      </div>
      <H2>Terrain datasets</H2>
      <Table rows={DATA} head={['Dataset', 'Credit', 'Terms', 'Used for']} />
      <H2>Incident and environment data</H2>
      <Table rows={INCIDENT_DATA} head={['Source', 'Credit', 'Terms', 'Used for']} />
      <H2>Method and requirements</H2>
      <Table rows={METHOD} head={['Reference', 'Authors', 'Terms', 'Used for']} />
      <H2>3D asset credits</H2>
      <p className="mb-3 max-w-[680px] text-[13px] text-ink3">These appear in the separate 3D simulation window, not in this dashboard.</p>
      <Table rows={MODELS} head={['Asset', 'Author', 'Terms', 'Where used']} />
      <H2>Software and type</H2>
      <Table rows={SOFTWARE} head={['Component', 'Credit', 'Terms', 'Used for']} />
    </PageShell>
  )
}
