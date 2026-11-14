// Every number the engine uses, with its provenance. The UI renders this registry verbatim, so a
// value can never appear on screen without its kind (measured / requirement / model / assumption)
// and its source. Adjustable parameters carry a range.

export type Kind = 'measured' | 'requirement' | 'model' | 'assumption' | 'physics' | 'scenario'

export interface ParamDef {
  key: string
  label: string
  value: number
  unit: string
  kind: Kind
  group: 'Planning rules' | 'Suit & physiology' | 'Rockfall' | 'Radiation' | 'Simulation'
  note: string
  source: string
  url?: string
  min?: number; max?: number; step?: number      // present => adjustable in the UI
  presets?: { value: number; label: string }[]
}

export const PARAM_DEFS: ParamDef[] = [
  // ------------------------------------------------------------------ planning rules
  { key: 'slopeMaxDeg', label: 'Max walking slope', value: 20, unit: '°', kind: 'requirement', group: 'Planning rules',
    note: 'Lunar-derived NASA suit requirement; Mars value not established.', source: 'NASA EVA-EXP-0042 xEVA System ConOps / Artemis suit requirements (via NTRS 20210000827)',
    url: 'https://ntrs.nasa.gov/api/citations/20210000827/downloads/Exporation%20EVA%20Testing%20and%20Analogs%2020210000827.pdf', min: 10, max: 30, step: 1 },
  { key: 'slopeHardDeg', label: 'Never-enter slope (side-hill)', value: 25, unit: '°', kind: 'model', group: 'Planning rules',
    note: 'Cells steeper than this are impassable in any direction.', source: 'Team model', min: 20, max: 35, step: 1 },
  { key: 'vPlan', label: 'Planning walking speed', value: 0.56, unit: 'm/s', kind: 'requirement', group: 'Planning rules',
    note: '2 km/h on fairly level regolith; slope and soil slow it further.', source: 'NASA exploration EVA planning value (NTRS 20210000827)',
    url: 'https://ntrs.nasa.gov/api/citations/20210000827/downloads/Exporation%20EVA%20Testing%20and%20Analogs%2020210000827.pdf', min: 0.3, max: 1.0, step: 0.02 },
  { key: 'shelterRuleMin', label: 'Solar-storm rule: max time to shelter', value: 30, unit: 'min', kind: 'requirement', group: 'Planning rules',
    note: 'Derived from 16 surface SEP events seen by Curiosity/RAD: stay within 30 min of shelter.', source: 'Nowcasting SEP events for Mars missions, arXiv 2502.02469',
    url: 'https://arxiv.org/abs/2502.02469', min: 10, max: 60, step: 5 },
  { key: 'o2ReserveMin', label: 'O₂ reserve required on arrival', value: 60, unit: 'min', kind: 'requirement', group: 'Planning rules',
    note: '8 h EVA + 1 h secondary oxygen.', source: 'NASA exploration EVA ConOps', url: 'https://ntrs.nasa.gov/citations/20210000827' },
  { key: 'kSand', label: 'Loose sand: extra travel time', value: 0.8, unit: '×', kind: 'model', group: 'Planning rules',
    note: 'Time multiplier (1 + k·sand likelihood). Sand layer is an image-based proxy.', source: 'Team model; Pandolf terrain factor for loose sand = 2.1 (Soule & Goldman 1972)', min: 0, max: 2, step: 0.1 },

  // ------------------------------------------------------------------ suit & physiology
  { key: 'gMars', label: 'Surface gravity', value: 3.71, unit: 'm/s²', kind: 'physics', group: 'Suit & physiology', note: '', source: 'NASA Mars fact sheet',
    url: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html' },
  { key: 'massKg', label: 'Astronaut + suit mass', value: 200, unit: 'kg', kind: 'assumption', group: 'Suit & physiology',
    note: '80 kg crew member + ~120 kg suit and life support.', source: 'Team assumption', min: 150, max: 280, step: 10 },
  { key: 'coolW', label: 'Suit cooling limit', value: 586, unit: 'W', kind: 'measured', group: 'Suit & physiology',
    note: '≈ 2,000 BTU/h for the Apollo suit and the EMU: heat, not oxygen, caps speed.', source: 'NASA HRP EVA evidence report (NTRS 20220004017)',
    url: 'https://ntrs.nasa.gov/citations/20220004017', min: 350, max: 800, step: 10 },
  { key: 'heatWarnKJ', label: 'Heat storage: performance drops', value: 506, unit: 'kJ', kind: 'measured', group: 'Suit & physiology',
    note: '480 BTU of stored body heat.', source: 'NASA HRP EVA evidence report (NTRS 20220004017)', url: 'https://ntrs.nasa.gov/citations/20220004017' },
  { key: 'heatMaxKJ', label: 'Heat storage: tissue damage', value: 844, unit: 'kJ', kind: 'measured', group: 'Suit & physiology',
    note: '800 BTU of stored body heat — treated as mission failure.', source: 'NASA HRP EVA evidence report (NTRS 20220004017)', url: 'https://ntrs.nasa.gov/citations/20220004017' },
  { key: 'paceNominal', label: 'Nominal suited pace', value: 0.65, unit: 'm/s', kind: 'measured', group: 'Suit & physiology',
    note: 'Apollo 16 long traverses: 0.61–0.91 m/s.', source: 'Apollo 16 Time and Motion Study (NTRS 19730008098)',
    url: 'https://ntrs.nasa.gov/api/citations/19730008098/downloads/19730008098.pdf' },
  { key: 'paceMax', label: 'Fastest pace (walk→run limit)', value: 1.3, unit: 'm/s', kind: 'model', group: 'Suit & physiology',
    note: 'Froude number ≈ 0.5 at Mars gravity.', source: 'Walk–run transition scaling (research note F)' },
  { key: 'metBase', label: 'Metabolic model: M = a + b·v + c·v² (a)', value: 120, unit: 'W', kind: 'model', group: 'Suit & physiology',
    note: 'With b = 240, c = 110: 0.65 m/s → 322 W (Apollo walking: 230–350 W).', source: 'Team fit to Apollo metabolic data (Waligora 1975 via NTRS 20220004017)',
    url: 'https://ntrs.nasa.gov/citations/20220004017' },
  { key: 'fallPerKm', label: 'Fall rate on easy ground', value: 0.15, unit: 'per km', kind: 'assumption', group: 'Suit & physiology',
    note: 'Apollo crews fell 27 times, but no distance denominator exists; rate rises with slope, roughness and speed².', source: 'Team assumption; Apollo fall counts (Chiou-Tan 2026)',
    url: 'https://asma.kglmeridian.com/view/journals/amhp/97/10/article-p856.xml', min: 0, max: 1, step: 0.05 },
  { key: 'fallInjuryP', label: 'Chance a fall is incapacitating', value: 0.01, unit: '', kind: 'assumption', group: 'Suit & physiology',
    note: 'Suit damage or injury needing buddy rescue; grows with speed and downhill. Apollo: 27 falls, none incapacitating (so below ~10% at 95% confidence).', source: 'Team assumption', min: 0, max: 0.2, step: 0.005 },

  // ------------------------------------------------------------------ rockfall
  { key: 'alphaDeg', label: 'Rockfall reach angle', value: 27.8, unit: '°', kind: 'measured', group: 'Rockfall',
    note: 'Energy-line angle from source to stop. Lower = boulders travel farther = wider keep-out band.',
    source: 'Grindrod et al. 2021 (Terra Sirenum, Mars): H/V 1.44–1.90', url: 'https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2021GL094817',
    min: 14, max: 35, step: 0.1,
    presets: [
      { value: 34.8, label: 'Mars, least mobile large fall (Terra Sirenum)' },
      { value: 31.4, label: 'Mars, mean large fall (Terra Sirenum)' },
      { value: 27.8, label: 'Mars, most mobile large fall measured (Terra Sirenum)' },
      { value: 21.8, label: 'Mars, mean small falls at Jezero (Sinha 2020)' },
      { value: 18.4, label: 'Moon, mean of 687 rockfalls (Bickel 2021)' },
      { value: 14.0, label: 'Artemis study stand-off, 4 × height (LPSC 2025 #1410)' },
    ] },
  { key: 'sourceSlopeDeg', label: 'Rockfall source slope', value: 32, unit: '°', kind: 'model', group: 'Rockfall',
    note: 'Cells at least this steep can release boulders (>30° in the Artemis hazard study; RSL bedrock 35.5° ± 9.9°).', source: 'LPSC 2025 #1410; Chojnacki et al. 2016',
    url: 'https://www.hou.usra.edu/meetings/lpsc2025/pdf/1410.pdf' },
  { key: 'quakeBoulders', label: 'Boulders released by the marsquake', value: 27, unit: '', kind: 'scenario', group: 'Rockfall',
    note: 'Count of new boulder tracks after marsquake S0235b (Mw ≈ 3.6) at Cerberus Fossae — not at Melas.', source: 'Vijayan et al. 2026',
    url: 'https://www.nature.com/articles/s44453-026-00052-x', min: 5, max: 120, step: 1 },
  { key: 'quakeRateX', label: 'Post-quake rockfall rate vs. background', value: 10, unit: '×', kind: 'measured', group: 'Rockfall',
    note: '27 tracks observed where ~2.6 were expected (Cerberus Fossae).', source: 'Vijayan et al. 2026', url: 'https://www.nature.com/articles/s44453-026-00052-x' },
  { key: 'holdHours', label: 'Post-quake hold on runout band', value: 24, unit: 'h', kind: 'assumption', group: 'Rockfall',
    note: 'Design rule: no entry into the band until the hold expires. No Mars aftershock decay law exists.', source: 'Team design rule', min: 1, max: 72, step: 1 },

  // ------------------------------------------------------------------ radiation
  { key: 'gcrRate', label: 'Background dose rate (GCR)', value: 8.75, unit: 'µGy/h', kind: 'measured', group: 'Radiation',
    note: '0.210 ± 0.040 mGy/day at Gale crater.', source: 'Hassler et al. 2014, Science 343', url: 'https://doi.org/10.1126/science.1244797' },
  { key: 'sepPeakMin', label: 'Solar storm: onset → peak', value: 53, unit: 'min', kind: 'measured', group: 'Radiation',
    note: 'Largest surface event on record, 20 May 2024 (Curiosity/RAD).', source: 'arXiv 2502.02469', url: 'https://arxiv.org/abs/2502.02469' },
  { key: 'sepTotal', label: 'Solar storm: unshielded total dose', value: 8100, unit: 'µGy', kind: 'measured', group: 'Radiation',
    note: 'Dose an astronaut next to Curiosity would have received on 20 May 2024. Time profile is idealised (linear rise, exponential decay).', source: 'NASA/JPL, 2024',
    url: 'https://www.jpl.nasa.gov/news/nasa-watches-mars-light-up-during-epic-solar-storm/', min: 500, max: 20000, step: 100 },
  { key: 'sepDecayH', label: 'Solar storm: decay time', value: 6, unit: 'h', kind: 'assumption', group: 'Radiation',
    note: 'e-folding time after the peak.', source: 'Team assumption', min: 1, max: 24, step: 1 },
  { key: 'shieldK', label: 'Terrain shielding per blocked sky', value: 0.63, unit: '', kind: 'model', group: 'Radiation',
    note: 'RAD at Murray Buttes: 19% of sky blocked → 12% less downward dose (only −5% total, due to albedo). Cliffs help a little.', source: 'Guo et al. 2021 (RAD beside Murray Buttes)',
    url: 'https://e-docs.geo-leo.de/server/api/core/bitstreams/b67cf051-a53f-4498-a33a-2f3c48813716/content', min: 0, max: 1, step: 0.01 },
  { key: 'shieldRover', label: 'Pressurized rover shielding', value: 0.5, unit: '', kind: 'assumption', group: 'Radiation',
    note: 'Fraction of dose removed inside the rover.', source: 'Team assumption', min: 0, max: 0.95, step: 0.05 },
  { key: 'shieldHabitat', label: 'Habitat storm-shelter shielding', value: 0.9, unit: '', kind: 'assumption', group: 'Radiation',
    note: 'Fraction of dose removed inside the storm shelter.', source: 'Team assumption', min: 0, max: 0.99, step: 0.01 },
  { key: 'skyShelterMin', label: 'Natural shelter: min. blocked sky', value: 0.27, unit: '', kind: 'model', group: 'Radiation',
    note: 'Terrain cells that hide at least this fraction of the sky are offered as stop-gap shelters.', source: 'Team model', min: 0.2, max: 0.45, step: 0.01 },

  // ------------------------------------------------------------------ simulation
  { key: 'useRL', label: 'Navigator: 1 = trained RL policy, 0 = scripted baseline', value: 1, unit: '', kind: 'model', group: 'Simulation',
    note: 'The RL policy (PPO) chooses heading and pace at every 10 s step; the scripted baseline follows the static walking-time field at one pace. If no policy file is loaded the baseline is used and the route is labelled as such.',
    source: 'rl/ in the repository (rl/SPEC_NAV.md)', min: 0, max: 1, step: 1 },
]

export type Params = Record<string, number>

export function defaultParams(): Params {
  const p: Params = {}
  for (const d of PARAM_DEFS) p[d.key] = d.value
  return p
}

// ---- fixed model constants (documented in README; mirrored in rl/env.py) -------------------------
export const SIM = {
  CELL: 5,
  DT: 10,                 // s per decision
  SUB: 2,                 // movement sub-steps per decision
  PACES: [0, 0.4, 0.65, 0.95, 1.3],          // m/s
  HEADINGS: [-60, -30, 0, 30, 60],           // deg relative to planner guidance
  MET_B: 240, MET_C: 110, MET_REST: 110,     // W
  ETA_UP: 0.25, K_DOWN: 0.3,
  O2_KG_PER_J: 7.11e-8, O2_TANK_KG: 0.69, O2_NOMINAL_W: 300,
  ROUGH0: 0.15, K_ROUGH: 0.6, K_SAND_MET: 1.1,
  FALL_SLOPE_REF: 12, FALL_T_MIN: 20, FALL_T_MAX: 60,
  ARRIVE_R: 12, T_MAX: 3 * 3600,
  LOOK0: 4, LOOK1: 7.5, LOOK2: 20,
  MOVE_LOOK: 5,          // m, baseline of the grade felt by the walker
  STUCK_STEPS: 18,
  DUST_SLOW: 0.35, DUST_FALL: 1.5,   // dust storm: visibility slows the walker and raises fall risk
  N_OBS: 44,
} as const
