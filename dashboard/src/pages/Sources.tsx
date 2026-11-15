import { PageShell, H2 } from './PageShell'

interface Row { name: string; credit: string; terms: string; use: string }

const DATA: Row[] = [
  { name: 'HiRISE DTM DTEEC_028857_1700_028923_1700_A01', credit: 'NASA/JPL/University of Arizona/USGS', terms: 'CC0. USGS Astrogeology STAC, collection mro_hirise_socet_dtms', use: 'Elevation, 1 m, 4 × 4 km core box. Slope, roughness, sky view and the walking model are derived from it.' },
  { name: 'HiRISE orthoimage ESP_028857_1700_RED_C_01_ORTHO', credit: 'NASA/JPL/University of Arizona', terms: 'Public domain', use: 'The greyscale base image of the tactical map. Surface colour in the app is an approximate tint.' },
  { name: 'CTX DTM D04_028857_1684_XN_11S069W and D04_028923_1684_XN_11S069W', credit: 'NASA/JPL/MSSS/USGS', terms: 'CC0. USGS Astrogeology STAC, collection mro_ctx_controlled_usgs_dtms', use: 'Regional elevation strip around the core box.' },
  { name: 'HiRISE merged colour product ESP_028857_1700_MRGB', credit: 'NASA/JPL/University of Arizona', terms: 'Public domain (HiRISE image usage policy)', use: 'Dust and sand pattern of the terrain colour in the 3D view. An approximate colour, not a measurement of the site.' },
  { name: 'Viking MDIM 2.1 colourised global mosaic, 232 m per pixel', credit: 'USGS Astrogeology Science Center / NASA Ames', terms: 'Public domain', use: 'Broad hue variation of the terrain colour in the 3D view.' },
]
const INCIDENT_DATA: Row[] = [
  { name: 'MSL RAD solar particle event of 20 May 2024 (Loewe et al. 2025, arXiv:2502.02469)', credit: 'NASA/JPL, Curiosity RAD team', terms: 'Published results', use: 'Time to peak, 30 minute shelter rule, unshielded dose.' },
  { name: 'MSL RAD background dose (Hassler et al. 2014, Science 343)', credit: 'MSL RAD team', terms: 'Published results', use: 'Background dose rate from galactic cosmic rays.' },
  { name: 'Marsquake rockfall at Cerberus Fossae (Vijayan et al. 2026)', credit: 'Authors as cited', terms: 'Published results', use: 'Boulder count and rockfall rate after a marsquake. Observed at Cerberus Fossae, not at Melas Chasma.' },
  { name: 'InSight Mars Seismic Catalogue, MQS v14', credit: 'InSight Marsquake Service, ETH Zurich', terms: 'doi 10.12686/a21', use: 'Context for scenario marsquakes.' },
  { name: 'Mars Dust Activity Database (Battalio and Wang 2021, Icarus 354, 114059)', credit: 'Battalio and Wang', terms: 'CC BY 4.0, Zenodo record 7480334', use: 'Context for dust scenarios.' },
  { name: 'JPL Horizons system', credit: 'NASA/JPL Solar System Dynamics', terms: 'Public API', use: 'Sun position at the site, daylight left and Earth to Mars light time.' },
  { name: 'Mars24 sunclock algorithm (Allison and McEwen 2000)', credit: 'NASA Goddard Institute for Space Studies', terms: 'Published algorithm', use: 'Local time, season and Sun position outside the Horizons table.' },
  { name: 'Curiosity REMS daily weather reports, sols at Ls 20 to 24', credit: 'NASA/JPL-Caltech/CAB (CSIC-INTA)', terms: 'Public feed', use: 'Ground and air temperature range and UV index for the season. Measured at Gale crater: an analogue, not the demo site.' },
  { name: 'Mars Climate Database v6.2, point query for the site at Ls 22', credit: 'LMD/OU/IAA/ESA/CNES', terms: 'Cited value', use: 'One number: the dust optical depth for the site and season (model).' },
]
const METHOD: Row[] = [
  { name: 'Adaptive Stress Testing: Finding Likely Failure Events with Reinforcement Learning (Lee et al. 2020, Journal of Artificial Intelligence Research 69)', credit: 'Lee, Mengshoel, Saksena, Gardner, Genin, Silbermann, Owen, Kochenderfer', terms: 'Published method', use: 'The search for the most likely failure of a route.' },
  { name: 'Exploration EVA testing and analogs (NTRS 20210000827)', credit: 'NASA', terms: 'Public', use: 'Planning speed, slope limit and oxygen reserve.' },
  { name: 'HRP evidence report on EVA (NTRS 20220004017)', credit: 'NASA', terms: 'Public', use: 'Suit cooling limit and stored-heat limits.' },
  { name: 'Apollo 16 Time and Motion Study (NTRS 19730008098)', credit: 'NASA', terms: 'Public', use: 'Nominal suited walking pace.' },
]
const NASA_TERMS = 'NASA 3D Resources: no copyright claimed, credit NASA, no endorsement implied'
const MODELS: Row[] = [
  { name: 'Z-2 planetary surface spacesuit prototype', credit: 'NASA/LaRC/Advanced Concepts Lab', terms: NASA_TERMS, use: 'Crew figures. Modified: given a skeleton and animation clips, insignia and mission emblem painted out.' },
  { name: 'Habitat Demonstration Unit (parts 1 and 2)', credit: 'NASA', terms: NASA_TERMS, use: 'Habitat. Modified: insignia and logos painted out.' },
  { name: 'Space Exploration Vehicle', credit: 'NASA', terms: NASA_TERMS, use: 'Rover' },
  { name: 'InSight lander (deployed)', credit: 'NASA/JPL-Caltech', terms: NASA_TERMS, use: 'Seismic station. Modified: logos painted out.' },
  { name: 'Ingenuity Mars Helicopter', credit: 'NASA/JPL-Caltech', terms: NASA_TERMS, use: 'Helicopter (set dressing). Modified: logos painted out.' },
  { name: 'Universal Animation Library [Standard] v3.0', credit: 'Quaternius', terms: 'CC0 1.0', use: 'Skeleton and the walk, idle, stumble, collapse, kneel, crouch and work clips of the crew.' },
  { name: 'namaqualand_boulder_03, 05 and 06', credit: 'Jenelle van Heerden, Dario Barresi, Greg Zaal (Poly Haven)', terms: 'CC0 1.0', use: 'Boulders, rockfall and stones. Earth scans used as set dressing, not Mars data.' },
  { name: 'rock_07', credit: 'Jenelle van Heerden (Poly Haven)', terms: 'CC0 1.0', use: 'Small stones (set dressing)' },
  { name: 'red_laterite_soil_stones', credit: 'Amal Kumar (Poly Haven)', terms: 'CC0 1.0', use: 'Ground detail texture' },
  { name: 'sandy_gravel_02', credit: 'Dario Barresi (Poly Haven)', terms: 'CC0 1.0', use: 'Ground detail texture' },
  { name: 'dry_ground_rocks', credit: 'Rob Tuytel (Poly Haven)', terms: 'CC0 1.0', use: 'Ground detail texture' },
]
const SOFTWARE: Row[] = [
  { name: 'Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono, bundled through Fontsource', credit: 'Braille Institute of America', terms: 'SIL Open Font License 1.1', use: 'Interface type' },
  { name: 'Electron, React, Recharts, Radix UI, Tailwind CSS, lucide icons', credit: 'Their authors', terms: 'MIT and ISC licences', use: 'This dashboard' },
]

function Table({ rows, head }: { rows: Row[]; head: [string, string, string, string] }) {
  return (
    <div className="overflow-x-auto"><table className="w-full min-w-[760px] table-fixed border-collapse text-left text-[13px]">
      <colgroup><col style={{ width: '36%' }} /><col style={{ width: '20%' }} /><col style={{ width: '19%' }} /><col style={{ width: '25%' }} /></colgroup>
      <thead><tr className="border-y border-rule text-ink3">{head.map((h) => <th key={h} className="py-1.5 pr-3 text-[12px] font-medium">{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="rule-b align-top">
            <td className="py-2.5 pr-3 text-ink">{r.name}</td><td className="py-2.5 pr-3 text-ink2">{r.credit}</td><td className="py-2.5 pr-3 text-ink2">{r.terms}</td><td className="py-2.5 text-ink3">{r.use}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  )
}

export function SourcesPage() {
  return (
    <PageShell wide title="Sources" lede="The data, papers and assets behind what you see on the console.">
      <div className="mb-8 rounded-[3px] border border-rule2 bg-panel px-4 py-3 text-[13.5px] text-ink">
        Not affiliated with or endorsed by NASA. No NASA insignia or logos are shown: the ones on the textures of the NASA 3D models are painted out.
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
