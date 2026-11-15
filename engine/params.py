"""Model parameters with provenance (ported from reference/ts_engine/params.ts) plus the engine's own
scenario and stress-test settings. Every number shown to a user comes from here with its kind and source.

kind: measured | model | requirement | assumption | scenario (contract section 6).
"""
import json
import os

from . import RUNTIME, write_atomic

NTRS_EVA = "https://ntrs.nasa.gov/api/citations/20210000827/downloads/Exporation%20EVA%20Testing%20and%20Analogs%2020210000827.pdf"
NTRS_HRP = "https://ntrs.nasa.gov/citations/20220004017"


def _p(key, label, value, unit, kind, group, note, source, url="", **rng):
    d = dict(key=key, label=label, value=value, unit=unit, kind=kind, group=group, note=note, source=source, url=url)
    d.update(rng)
    return d


PARAM_DEFS = [
    # ---------------------------------------------------------------- planning rules
    _p("slopeMaxDeg", "Max walking slope", 20, "deg", "requirement", "Planning rules",
       "Lunar-derived NASA suit requirement; Mars value not established.",
       "NASA EVA-EXP-0042 xEVA System ConOps / Artemis suit requirements (via NTRS 20210000827)", NTRS_EVA, min=10, max=30, step=1),
    _p("slopeHardDeg", "Never-enter slope (side-hill)", 25, "deg", "model", "Planning rules",
       "Cells steeper than this are impassable in any direction.", "Team model", min=20, max=35, step=1),
    _p("vPlan", "Planning walking speed", 0.56, "m/s", "requirement", "Planning rules",
       "2 km/h on fairly level regolith; slope and soil slow it further.", "NASA exploration EVA planning value (NTRS 20210000827)", NTRS_EVA,
       min=0.3, max=1.0, step=0.02),
    _p("shelterRuleMin", "Solar-storm rule: max time to shelter", 30, "min", "requirement", "Planning rules",
       "Derived from 16 surface SEP events seen by Curiosity/RAD: stay within 30 min of shelter.",
       "Nowcasting SEP events for Mars missions, arXiv 2502.02469", "https://arxiv.org/abs/2502.02469", min=10, max=60, step=5),
    _p("o2ReserveMin", "O2 reserve required on arrival", 60, "min", "requirement", "Planning rules",
       "8 h EVA + 1 h secondary oxygen.", "NASA exploration EVA ConOps", "https://ntrs.nasa.gov/citations/20210000827"),
    _p("kSand", "Loose sand: extra travel time", 0.8, "x", "model", "Planning rules",
       "Time multiplier (1 + k * sand likelihood). Sand layer is an image-based proxy.",
       "Team model; Pandolf terrain factor for loose sand = 2.1 (Soule & Goldman 1972)", min=0, max=2, step=0.1),
    # ---------------------------------------------------------------- suit & physiology
    _p("gMars", "Surface gravity", 3.71, "m/s2", "measured", "Suit & physiology", "", "NASA Mars fact sheet",
       "https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html"),
    _p("massKg", "Astronaut + suit mass", 200, "kg", "assumption", "Suit & physiology",
       "80 kg crew member + ~120 kg suit and life support.", "Team assumption", min=150, max=280, step=10),
    _p("coolW", "Suit cooling limit", 586, "W", "measured", "Suit & physiology",
       "About 2,000 BTU/h for the Apollo suit and the EMU: heat, not oxygen, caps speed.",
       "NASA HRP EVA evidence report (NTRS 20220004017)", NTRS_HRP, min=350, max=800, step=10),
    _p("heatWarnKJ", "Heat storage: performance drops", 506, "kJ", "measured", "Suit & physiology",
       "480 BTU of stored body heat.", "NASA HRP EVA evidence report (NTRS 20220004017)", NTRS_HRP),
    _p("heatMaxKJ", "Heat storage: tissue damage", 844, "kJ", "measured", "Suit & physiology",
       "800 BTU of stored body heat, treated as mission failure.", "NASA HRP EVA evidence report (NTRS 20220004017)", NTRS_HRP),
    _p("paceNominal", "Nominal suited pace", 0.65, "m/s", "measured", "Suit & physiology",
       "Apollo 16 long traverses: 0.61-0.91 m/s.", "Apollo 16 Time and Motion Study (NTRS 19730008098)",
       "https://ntrs.nasa.gov/api/citations/19730008098/downloads/19730008098.pdf"),
    _p("paceStorm", "Brisk pace toward shelter (solar storm)", 0.95, "m/s", "model", "Suit & physiology",
       "Pace the scripted crew uses under a shelter-rule deadline (reference baseline action).", "Team model (reference sim.ts baseline)"),
    _p("paceMax", "Fastest pace (walk-run limit)", 1.3, "m/s", "model", "Suit & physiology",
       "Froude number about 0.5 at Mars gravity.", "Walk-run transition scaling (research note F)"),
    _p("metBase", "Metabolic model: M = a + b*v + c*v^2 (a)", 120, "W", "model", "Suit & physiology",
       "With b = 240, c = 110: 0.65 m/s gives 322 W (Apollo walking: 230-350 W).",
       "Team fit to Apollo metabolic data (Waligora 1975 via NTRS 20220004017)", NTRS_HRP),
    _p("fallPerKm", "Fall rate on easy ground", 0.15, "per km", "assumption", "Suit & physiology",
       "Apollo crews fell 27 times, but no distance denominator exists; rate rises with slope, roughness and speed squared.",
       "Team assumption; Apollo fall counts (Chiou-Tan 2026)", "https://asma.kglmeridian.com/view/journals/amhp/97/10/article-p856.xml",
       min=0, max=1, step=0.05),
    _p("fallInjuryP", "Chance a fall is incapacitating", 0.01, "", "assumption", "Suit & physiology",
       "Suit damage or injury needing buddy rescue; grows with speed and downhill. Apollo: 27 falls, none incapacitating.",
       "Team assumption", min=0, max=0.2, step=0.005),
    # ---------------------------------------------------------------- rockfall
    _p("alphaDeg", "Rockfall reach angle", 27.8, "deg", "measured", "Rockfall",
       "Energy-line angle from source to stop. Lower = boulders travel farther = wider keep-out band.",
       "Grindrod et al. 2021 (Terra Sirenum, Mars): H/V 1.44-1.90", "https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2021GL094817",
       min=14, max=35, step=0.1),
    _p("sourceSlopeDeg", "Rockfall source slope", 32, "deg", "model", "Rockfall",
       "Cells at least this steep can release boulders (>30 deg in the Artemis hazard study; RSL bedrock 35.5 +/- 9.9 deg).",
       "LPSC 2025 #1410; Chojnacki et al. 2016", "https://www.hou.usra.edu/meetings/lpsc2025/pdf/1410.pdf"),
    _p("quakeBoulders", "Boulders released by the marsquake", 27, "", "scenario", "Rockfall",
       "Count of new boulder tracks after marsquake S0235b at Cerberus Fossae, not at Melas.", "Vijayan et al. 2026",
       "https://www.nature.com/articles/s44453-026-00052-x", min=5, max=120, step=1),
    _p("quakeRateX", "Post-quake rockfall rate vs. background", 10, "x", "measured", "Rockfall",
       "27 tracks observed where about 2.6 were expected (Cerberus Fossae).", "Vijayan et al. 2026",
       "https://www.nature.com/articles/s44453-026-00052-x"),
    _p("holdHours", "Post-quake hold on runout band", 24, "h", "assumption", "Rockfall",
       "Design rule: no entry into the band until the hold expires. No Mars aftershock decay law exists.", "Team design rule",
       min=1, max=72, step=1),
    # ---------------------------------------------------------------- radiation
    _p("gcrRate", "Background dose rate (GCR)", 8.75, "uGy/h", "measured", "Radiation",
       "0.210 +/- 0.040 mGy/day at Gale crater.", "Hassler et al. 2014, Science 343", "https://doi.org/10.1126/science.1244797"),
    _p("qGcr", "Quality factor, background (GCR)", 3.05, "Sv/Gy", "measured", "Radiation",
       "0.64 mSv/day dose equivalent over 0.21 mGy/day absorbed at Gale crater.", "Hassler et al. 2014, Science 343",
       "https://doi.org/10.1126/science.1244797"),
    _p("qSep", "Quality factor, solar particles", 1.0, "Sv/Gy", "assumption", "Radiation",
       "Proton-dominated event; used to report dose in mSv.", "Team assumption"),
    _p("sepPeakMin", "Solar storm: onset to peak", 53, "min", "measured", "Radiation",
       "Largest surface event on record, 20 May 2024 (Curiosity/RAD).", "Loewe et al. 2025, arXiv:2502.02469, Table 1",
       "https://arxiv.org/abs/2502.02469"),
    _p("sepTotal", "Solar storm: unshielded total dose", 8100, "uGy", "model", "Radiation",
       "NASA/JPL estimate, derived from the RAD data, of the dose an astronaut next to Curiosity would have received on 20 May 2024; "
       "not a measurement (RAD itself recorded 1730.55 uGy, Loewe Table 1). Used as the scripted storm's size. "
       "Time profile is idealised (linear rise, exponential decay).",
       "NASA/JPL, 2024", "https://www.jpl.nasa.gov/news/nasa-watches-mars-light-up-during-epic-solar-storm/", min=500, max=20000, step=100),
    _p("sepDecayH", "Solar storm: decay time", 6, "h", "assumption", "Radiation", "e-folding time after the peak.", "Team assumption",
       min=1, max=24, step=1),
    _p("nowcastPct", "Solar storm: alert threshold above background", 25, "%", "requirement", "Radiation",
       "The on-site rule raises the alert when the dose rate is this far above the background. Threshold of the published RAD "
       "nowcast; the engine applies it to its modelled dose rate.",
       "Loewe et al. 2025, arXiv:2502.02469", "https://arxiv.org/abs/2502.02469", min=10, max=200, step=5),
    _p("shieldK", "Terrain shielding per blocked sky", 0.63, "", "model", "Radiation",
       "RAD at Murray Buttes: 19% of sky blocked gives 12% less downward dose. Cliffs help a little.",
       "Guo et al. 2021 (RAD beside Murray Buttes)",
       "https://e-docs.geo-leo.de/server/api/core/bitstreams/b67cf051-a53f-4498-a33a-2f3c48813716/content", min=0, max=1, step=0.01),
    _p("shieldRover", "Pressurized rover shielding", 0.5, "", "assumption", "Radiation",
       "Fraction of dose removed inside the rover.", "Team assumption", min=0, max=0.95, step=0.05),
    _p("shieldHabitat", "Habitat storm-shelter shielding", 0.9, "", "assumption", "Radiation",
       "Fraction of dose removed inside the storm shelter.", "Team assumption", min=0, max=0.99, step=0.01),
    _p("skyShelterMin", "Natural shelter: min. blocked sky", 0.27, "", "model", "Radiation",
       "Terrain cells that hide at least this fraction of the sky are offered as stop-gap shelters.", "Team model",
       min=0.2, max=0.45, step=0.01),
    # ---------------------------------------------------------------- communications
    _p("antHabitatM", "Habitat antenna height", 6, "m", "assumption", "Communications",
       "Height above the ground of the habitat radio mast, for the line-of-sight layer.", "Team assumption", min=2, max=15, step=1),
    _p("antRoverM", "Rover antenna height", 3, "m", "assumption", "Communications",
       "Height above the ground of the rover antenna, for the line-of-sight layer.", "Team assumption", min=1, max=6, step=0.5),
    _p("antCrewM", "Suit antenna height", 1.8, "m", "assumption", "Communications",
       "Height above the ground of the antenna on a suit backpack.", "Team assumption", min=1, max=2.5, step=0.1),
    # ---------------------------------------------------------------- simulation (engine)
    _p("reactS", "Alert to first step", 60, "s", "assumption", "Simulation",
       "Time between the alert and the crew starting to walk; counted against the shelter rule.", "Team assumption"),
    _p("heat0KJ", "Stored heat at the start of the incident", 150, "kJ", "assumption", "Simulation",
       "Crew has been working at the science site.", "Team assumption"),
    _p("o2Start", "Usable O2 at the start of the incident", 0.82, "fraction", "assumption", "Simulation",
       "About 1.6 h into an 8 h + 1 h EVA.", "Team assumption"),
    _p("terrainError", "Unmapped-terrain slowdown amplitude", 0.25, "", "model", "Simulation",
       "Smooth 40 m value noise slows the walker by up to this fraction (reference sim.ts).", "Team model"),
    _p("navDecayM", "Navigation error vanishes within", 200, "m", "assumption", "Simulation",
       "The crew recognises the shelter in the final stretch, so the navigation offset fades out.", "Team assumption"),
    _p("tau", "Dust optical depth (sensor value)", 0.39, "", "model", "Simulation",
       "Daily mean dust column visible optical depth for the site in this season (Ls 22); no dust storm in this scenario.",
       "Mars Climate Database v6.2 (LMD/OU/IAA/ESA/CNES), climatology scenario, point query at lat -10.01, lon -69.96 E",
       "https://www-mars.lmd.jussieu.fr/mcd_python/"),
    _p("mcWalkers","Local preview: walkers per route", 2000, "", "model", "Simulation",
       "Small Monte Carlo run by the engine when no offline stress-test results are present.", "Engine setting"),
    _p("sigCool", "Disturbance: suit cooling multiplier per sigma", 0.117, "", "assumption", "Simulation",
       "Multiplier 1 - 0.117 z, z clipped to +/-3, floor 0.65 (380 W): SWME without sweep gas.",
       "U2 design section 9.2; NTRS 20160001058", "https://ntrs.nasa.gov/citations/20160001058"),
    _p("sigEff", "Disturbance: metabolic efficiency log-sigma", 0.12, "", "assumption", "Simulation",
       "Multiplier exp(0.12 z): x0.70 to x1.43.", "U2 design section 9.2"),
    _p("sigNav", "Disturbance: navigation error sigma", 53, "m", "assumption", "Simulation",
       "3 sigma = 160 m, the JETT3 mean position error.", "U2 design section 9.2 (JETT3)"),
    _p("sigPace", "Disturbance: pace drift log-sigma per step", 0.08, "", "assumption", "Simulation",
       "About +/-13% pace variation (ICES-2026-127).", "U2 design section 9.2"),
]

PARAMS = {d["key"]: float(d["value"]) for d in PARAM_DEFS}

# fixed model constants (reference/ts_engine/params.ts SIM), mirrored in rl/env.py
SIM = dict(
    CELL=5.0, DT=10.0, SUB=2,
    MET_B=240.0, MET_C=110.0, MET_REST=110.0,
    ETA_UP=0.25, K_DOWN=0.3,
    O2_KG_PER_J=7.11e-8, O2_TANK_KG=0.69, O2_NOMINAL_W=300.0,
    ROUGH0=0.15, K_ROUGH=0.6, K_SAND_MET=1.1,
    FALL_SLOPE_REF=12.0, FALL_T_MIN=20.0, FALL_T_MAX=60.0,
    ARRIVE_R=12.0, T_MAX=3 * 3600.0,
    MOVE_LOOK=5.0, STUCK_STEPS=18,
)


def param(key):
    for d in PARAM_DEFS:
        if d["key"] == key:
            return d
    raise KeyError(key)


def cite(key, label=None):
    """A number with its provenance in the contract's {label, value, unit, kind, source} form."""
    d = param(key)
    return dict(label=label or d["label"], value=d["value"], unit=d["unit"], kind=d["kind"], source=d["source"])


def write_params_json(path=None):
    path = path or os.path.join(RUNTIME, "params.json")
    groups = []
    for d in PARAM_DEFS:
        if d["group"] not in groups:
            groups.append(d["group"])
    doc = {"groups": groups, "params": PARAM_DEFS,
           "kinds": {"measured": "Measured on Mars or in tests", "model": "Model output or estimate (team or published), not a measurement", "requirement": "NASA requirement or rule",
                     "assumption": "Team assumption", "scenario": "Scripted for the demo, not an observation"}}
    write_atomic(path, json.dumps(doc, indent=1).encode())
    return path
