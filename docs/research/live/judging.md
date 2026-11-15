# R1 - Judging: what scores, what the live link must show

Source: research note A (`A_challenge_landscape_tools_news.md`, Q1/Q2), which quotes the Space Apps
Judging & Awards Guide (spaceappschallenge.org/resources/judging-awards-guide) and the Project Submission Guide
(spaceappschallenge.org/resources/project-submission-guide). No extra web check was needed.
Process: Bucharest local judges score with the same NASA rubric (1-5 on each criterion, no stated weighting
between them) and pick the Global Nominees. Local awards are separate. Nominees announced 3 Dec 2026, finalists 17 Dec, winners 26 Jan 2027.

## 1. Criteria (each 1-5, same rubric locally and globally)
- **Impact**: a significant problem that benefits a large audience or "could change the world". (Guide) For Solway: crew survival during a solar storm or marsquake.
- **Creativity**: a new approach or a meaningful improvement on existing ideas. (Guide) For Solway: EVA-scale incident response plus a stress test, which Mars Trek and the USGS maps lack (challenge page names this gap).
- **Validity**: scientifically sound, technically feasible, fully developed, usable and user-friendly. (Guide) A working tool grounded in real limits: slope, rockfall, dose, suit, daylight, comms.
- **Relevance**: fully addresses the challenge and uses NASA data as a core part, not decoration. (Guide) The challenge suggests 3 or more data types, a route map, space weather and a HUD.
- **Presentation**: structure and storytelling. Judges score the demo and the full project together. (Guide) The guide warns teams not to underweight it.
- Submission guide: "the majority of judges' evaluation will be based on your project submission". The demo (7 slides max or a 30 s video max) adds to the score but counts for less.

## 2. First 2 minutes on the live link (in order)
1. 0-10 s: public URL loads with no login and no install. Header says in one line what it is and who it is for.
   Visible note: "Planning aid. Not tested with a crew. Simulated values are marked."
2. 10-20 s: map of the real site on HiRISE/CTX terrain, with a source badge (HiRISE DTM ID, CTX). One clear "Start incident" button. Nothing starts on its own.
3. 20-40 s: storm alert fires from the on-site dose-rate rule (RAD nowcast threshold). Next to it, the DONKI record timing (Earth-side notice 10.3 h). Shows that NASA data sets the timing.
4. 40-60 s: chosen route drawn to a shelter. Walk time against the 30-min rule, distance and bearing, what is left on arrival. Rejected routes and the hazard each one avoids are visible.
5. 60-80 s: Monte Carlo failure rate with its confidence interval. Most likely failure found by the adversary (e.g. a fall on a 21 deg slope). Each number tagged "model" or "simulated".
6. 80-100 s: marsquake. Rockfall band turns active, shelter inside it closes, route is replanned from the crew's current position.
7. 100-120 s: 3D helmet HUD walking the route with turn-by-turn steps. One click to the Sources page, which maps each NASA dataset to the decision it drives.
Fallback: if the live engine is down, a recorded run plays and is labeled "Recorded run".

## 3. Project page checklist
- [ ] Challenge selected: "Interplanetary Survival Guide: Martian Map". Team of 1-6, all registered for Bucharest and not waitlisted.
- [ ] Everything in English (a video may use English subtitles).
- [ ] Short description: problem, user (crew on foot), what it does, how it works (detect, assess, simulate, guide).
- [ ] Public final-project link (live tool) with no password, permission or registration. Repo link is public too.
- [ ] Demo: 7 slides max including the title, or a 30 s video max. Shows the live tool.
- [ ] NASA data and resources named, each with what it drives: HiRISE/CTX DTMs (terrain, slope), MSL RAD (dose rule), CCMC DONKI (storm timing), Mars Trek/USGS where used. A Global Award needs at least one NASA resource.
- [ ] References: every external dataset, paper (e.g. Lowe et al. 2025), library, font and asset. Tick the "original work / all external items listed" boxes.
- [ ] Generated-content ("SI") disclosure: generated code/data acknowledged in the description and metadata; generated images/video carry a visible watermark; generated content must not be the source of the idea.
- [ ] No NASA logos, flags or mission marks in our own or generated assets. Add a "not affiliated with or endorsed by NASA" line.
- [ ] Limits section: what is simulated or modelled, the known gap (batched sim vs engine walker lateness, 34.5 % vs 19.7 % on the quake route; PPO did not beat cross-entropy search), no crew testing.
- [ ] Screenshots or GIF of the map, the response panel and the HUD. Submit before Sun 15 Nov, 23:59 Bucharest time.

## 4. Pitfalls that lose points
1. **Unlabeled simulated values.** Dose, failure rates and the oxygen/heat budget shown as if measured. Hurts Validity and trust. Tag each one model, simulated or recorded.
2. **Overclaiming.** "Tested with crews", "NASA-validated", "safe route", or precise-looking numbers (0.59 %) with no confidence interval. Say "planning aid" and show the interval.
3. **Decorative NASA data.** Layers that do not change the route or the alert. Relevance asks for data as a core input, so show cause and effect (DTM to slope cost, RAD rule to alert, DONKI to timing).
4. **Broken or gated link.** Engine offline, a cold start over 10 s, a login wall, or a desktop-only layout. Judges see an empty map. Keep the recorded-run fallback and test the link in a private window on a phone.
5. **Missing disclosure or rule breaks.** No SI acknowledgement, unwatermarked generated imagery, NASA branding, a demo over 30 s or 7 slides, or non-English content. These risk eligibility, not just points.
