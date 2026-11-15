# R3 - Helmet HUD design rules (local sources only)
Sources: STD = NASA-STD-3001 Vol 2 Rev C (`references/nasa_pdfs/std_c.pdf`, page = "x of 331"); JAR = Joint AR Visual Informatics ConOps, CTSD-ADV-1788 Rev A, Nov 2023 (`jointar_conops.pdf`, doc page); JETT3 = EHP-20021 JETT3 Report, Apr 2023 (`jett3.pdf`); notes G §3 and F §1. Rev C IDs may be renumbered in Rev D/E.

## 1. What the suit/helmet display should show (cited)
- Current position (filled circle) + heading as a forward beam showing estimated FOV - JAR §6.1.2 p.43, §6.1.4 p.45
- Next waypoint framed, with distance in metres - JAR §6.1.4 p.45 -> our "next turn" target
- Start/home point as waypoint "A" with distinct icon; distance gone vs remaining - JAR §6.1.11 p.53
- Lander/shelter direction + ETA as a *time differential* (planned vs estimated at current speed, mm:ss) - JAR §6.1.12 p.54 -> our "ETA vs 30-min rule"
- Compass/heading tape with icons for off-screen items; scan until item enters FOV, show distance + heading - JAR §5 hammer scenario p.40
- Allowed-region / boundary overlay ("what boundaries constrain my traverse") - JAR §6.3.4 p.98
- Selectable map layers (topo, illumination, comm LOS); active ones highlighted - JAR §6.1.13 p.56; note G §3
- Visible indication when route/content was updated (use on reroute) - JAR §6.1.6 p.47
- Suit telemetry vs expected ranges, "how close the value is to a lower or upper limit" - JAR §6.2.13 p.73; trend plots for consumables - §6.2.14 p.74
- Alert as visual pop-up - JAR §6.2.15 p.75; caution/warning near hazardous areas - §6.2.17 p.77 -> hazard callouts
- Suit pressure, ppO2, ppCO2 displayed and alarmed out of limits - STD [V2 11035]/[V2 11036] p.204; metabolic rate displayed - [V2 11038] p.205
- Consumables, suit status/alerts, biomedical data with trend insight to "act prospectively" - STD [V2 11023] p.199
- Units with every value - STD [V2 10046] p.172 (e.g. "O2 62 %", "1.2 km", "14:30 min")
- Shelter rule: stay <=30 min walk from shelter (SEP peak can arrive in 53 min); NASA: EVA termination within 2 h of dosimetry alert - note F §1 (arXiv 2502.02469; NASA SPE brief)

## 2. Colour meanings - NASA-STD-3001 Vol 2 Rev C
- RED = highest alert level, for text and/or graphics - [V2 10118], §10.7.2.5, p.190
- YELLOW = second-highest alert level - [V2 10119], §10.7.2.6, p.190-191
- Rev C defines NO meaning for green, cyan, white, amber or magenta. Only LED rationale: keep "yellow is not confusable with green" - [V2 10201] rationale, §10.1.6.6.
- Colour never the only cue: "For critical information and critical tasks when color is used to convey meaning, the system shall provide an additional cue" (labels, icons, speech) - [V2 10045], §10.3.2.7, p.172
- Alerts dual-coded ("be seen and heard"), speech alarms allowed - [V2 10114] p.189; manual silencing - [V2 10116] p.190
- JAR prototype assumes a *monocular, monochromatic* display - JAR §4 p.21 -> design must work without colour.
- GENERAL PRACTICE (not in STD Rev C): green = nominal/active route, cyan or white = info/neutral, amber = treat as yellow (caution). Mark as our convention.

## 3. Info density / clutter
- Show "only what is needed" to keep SA, decide and act; "too much information increases visual clutter" - STD [V2 10040] p.171
- All critical task info in the field of regard, no scrolling/page switching - STD [V2 10037] p.171
- Group by frequency, sequence, criticality - STD [V2 10042] p.171-172; shallow navigation - [V2 10043] p.172
- Helmet field of regard unencumbered, "prevent tunnel vision" - STD [V2 11022] p.199 -> keep centre clear
- JAR display sits offset right and slightly above horizontal FOV - JAR §4 Fig 4.5 p.21 -> peripheral placement
- Minimise discrete physical acts, time to change state, interference with voice/visual comms; redundant controls (voice + hand) - JAR design philosophy p.16
- Declutter: completed items dimmed, "not immediately decluttered upon completion" - JAR §6.2.26 p.86
- Minimise mental calculations and recall - STD [V2 10113] rationale p.189
- Visual redundancy: critical value at more than one place (lighting can wash out one) - note G §3 (NASA EVA informatics review)
- JETT3: crews misjudge distance by 33-37% in low-angle light (Concl. 2.8, p.102); location error of 10-100s of m without nav aids (Concl. 2.9, p.107); nav tech "worth the cost" (Concl. 2.12, p.108) -> always show metres, never rely on eyeballing.

## 4. Waze-style prompts
NASA-sourced:
- Next waypoint + distance; heading beam to confirm direction - JAR §6.1.2/6.1.4
- Speech allowed as alert channel; audio + visual for caution/warning - STD [V2 10114]
- Mark route updates visibly - JAR §6.1.6; deviation impact ("510 m from point of deviation") - JAR §5.1.4 (note G §3)
- Contingency walk-back: compare direct vs planned/backtrack path by distance, slope, terrain - JAR §5.1.6 (note G §3)
GENERAL NAV-UX PRACTICE (not NASA, adapt for walking speed ~1 m/s):
- Announce twice: early (~50-100 m / ~1 min before), then at the turn ("Bear left now"). Long legs: "Continue 300 m".
- One instruction at a time; chain only when two turns are <20 m apart ("Bear left, then right").
- Phrasing: verb + direction + distance: "Bear left in 40 m", "Turn right at the boulder". Round distances (10 m steps).
- Off-route >~15 m for a few seconds -> reroute silently, then one prompt "Rerouting - new ETA 12 min"; never spam.
- Hazard/shelter alerts interrupt navigation prompts; keep voice short, one subject per message.
