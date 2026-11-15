import { KINDS, KIND_INFO, KindGlyph } from '@/components/Kind'
import { LearningCurve } from '@/components/LearningCurve'
import { PageShell, H2, P } from './PageShell'

export function MethodPage() {
  return (
    <PageShell title="Method and limits" lede="What the system computes, how it tests its own routes, and what the results do not tell you.">
      <H2>The loop</H2>
      <P>
        When something changes on the surface, the system works through four steps. It <b className="text-ink">detects</b> the incident, <b className="text-ink">assesses</b> what
        it changes on the terrain map, <b className="text-ink">simulates</b> crews walking the candidate routes, and then <b className="text-ink">responds</b> with the route it
        recommends, the time to shelter, and the margins left on arrival. The console shows the four steps above the recommendation.
      </P>

      <H2>How routes are found</H2>
      <P>
        A path planner searches the terrain for walkable routes from the crew to every open shelter. It works on a 5 m grid cut from the HiRISE elevation model of the
        core box. It avoids slopes the suit cannot take, loose sand, and rockfall runout bands, and it applies the rule of the current incident, such as the 30 minute
        limit to reach shelter during a solar particle event. The planner returns a handful of candidates, each with length, walking time, ascent and steepest slope.
      </P>

      <H2>How routes are stress-tested</H2>
      <P>
        A planned route says where to walk. It does not say how it can go wrong. For that we use Adaptive Stress Testing (Lee et al., 2020). A physics-based walk model
        simulates a suited astronaut on the route: pace, stored heat, oxygen use, stumbles on slopes and sand. Disturbances such as a stumble, weaker suit cooling or a small
        oxygen leak are fed into the model. A reinforcement learning agent searches over those disturbances for the most likely sequence that still ends in a failure.
      </P>
      <P>
        What comes back is that failure and how likely it is. <b className="text-ink">Robustness</b> is the negative log-probability of the most likely failure found, in nats.
        A larger number means the failure needs a more extreme combination of disturbances. The <b className="text-ink">failure rate</b> comes from plain Monte Carlo runs with random
        disturbances, shown with its confidence interval. Three methods can produce a result: PPO-AST and CEM search adversarially, Monte Carlo does not and reports no robustness.
      </P>
      <P>
        A result marked <b className="text-ink">trained offline</b> comes from a training run stored in the repository. A result marked <b className="text-ink">local preview</b> is a small run done
        by the engine just now. It is quicker and less reliable. The curve below shows how the offline search improved over training.
      </P>
      <div className="mb-3 max-w-[680px]"><LearningCurve /></div>

      <H2>Every number carries a kind</H2>
      <P>The small symbol after a number says what sort of number it is. Hover it to see the source.</P>
      <ul className="mb-3 divide-y divide-rule border-y border-rule">
        {KINDS.map((k) => (
          <li key={k} className="flex items-baseline gap-3 py-2.5">
            <span className="flex w-[130px] shrink-0 items-center gap-2 font-mono text-[11px] uppercase tracking-wide" style={{ color: KIND_INFO[k].color }}><KindGlyph kind={k} size={11} />{KIND_INFO[k].label}</span>
            <span className="text-[13px] text-ink2">{KIND_INFO[k].def}</span>
          </li>
        ))}
      </ul>

      <H2>What these results are not</H2>
      <ul className="max-w-[700px] list-disc space-y-2 pl-5 text-[13.5px] leading-relaxed text-ink2 marker:text-ink3">
        <li><b className="text-ink">Model-based, not crew-tested.</b> Every failure rate and margin comes from a model of a walking astronaut. No real crew has walked these routes. A low failure rate means the model rarely fails, not that a person would not.</li>
        <li><b className="text-ink">Parts of the physics are assumptions.</b> Fall rate, fall injury chance, suit mass and the sand penalty are team choices. They are listed with their kind on the Parameters page.</li>
        <li><b className="text-ink">The incidents are scripted.</b> The solar particle event follows the 20 May 2024 event seen by Curiosity. The marsquake follows a quake with rockfall observed at Cerberus Fossae, not at Melas Chasma. Marked <i>scenario</i> wherever they appear.</li>
        <li><b className="text-ink">The terrain is real, the surface colour is not.</b> Elevation and the greyscale orthoimage are HiRISE products. Surface colour in the 3D view is an approximate tint. Close-up ground detail and rocks in 3D are Earth scans used as set dressing.</li>
        <li><b className="text-ink">The sand layer is a proxy</b> taken from image brightness, and the slope limit is a lunar-derived suit requirement. Neither is established for Mars.</li>
        <li><b className="text-ink">Planning aid only.</b> It does not replace the judgement of a crew or of mission control, and it has not been checked for operational use.</li>
      </ul>
    </PageShell>
  )
}
