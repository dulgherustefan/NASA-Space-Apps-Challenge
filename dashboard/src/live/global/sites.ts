// Suggested places that load well through loadAnywhere (DTM coverage checked against USGS STAC).
// lon: planetocentric deg E (0..360), lat: deg N. The grade in each note was measured with the live loader.
export const READY_SITES: { id: string; name: string; lon: number; lat: number; note: string }[] = [
  { id: 'melas', name: 'NE Melas Chasma', lon: 290.0373, lat: -10.0116, note: 'HiRISE DTM: EVA-grade. Same DTM as the bundled site, fetched live.' },
  { id: 'jezero', name: 'Jezero crater delta', lon: 77.43, lat: 18.47, note: 'HiRISE DTM: EVA-grade. Perseverance landing area, western delta front.' },
  { id: 'gale', name: 'Gale crater, Mount Sharp', lon: 137.3947, lat: -4.7284, note: 'HiRISE DTM: EVA-grade. Lower Mount Sharp, Curiosity traverse.' },
  { id: 'olympus', name: 'Olympus Mons caldera rim', lon: 226.2, lat: 18.4, note: 'CTX DTM: route-planning grade. Summit caldera rim, shown for contrast with HiRISE sites.' },
]
