import type { FailureClass, RouteStatus } from './types'

/**
 * `map` is the line colour over the orbital image, `ink` the colour of the same state in the panel.
 * Only two states carry a hue: the route to follow (magenta) and a route ruled out (red). The rest is neutral.
 */
export const ROUTE_STYLE: Record<RouteStatus, { label: string; map: string; ink: string; hint: string }> = {
  candidate: { label: 'Candidate', map: '#e8ebee', ink: 'var(--color-ink3)', hint: 'Found by the path planner, not stress-tested yet' },
  testing: { label: 'Testing', map: '#ffffff', ink: 'var(--color-ink)', hint: 'Virtual crews are walking it now' },
  tested: { label: 'Tested', map: '#e8ebee', ink: 'var(--color-ink2)', hint: 'Stress test finished' },
  rejected: { label: 'Rejected', map: '#ff6a5f', ink: 'var(--color-hazard)', hint: 'Dropped: the stress test or a rule ruled it out' },
  chosen: { label: 'Chosen', map: '#ff4fb6', ink: 'var(--color-accent)', hint: 'The route the crew is told to take' },
  infeasible: { label: 'Infeasible', map: '#8a939b', ink: 'var(--color-ink3)', hint: 'Cannot be walked within the limits' },
}

/** Colours drawn on the map canvas. The image is dark in both displays, so these do not change with the theme. */
export const MAP = {
  ink: '#f4f6f7',
  line: 'rgba(8,11,13,.85)',
  route: '#ff4fb6',
  hazard: '#ff6a5f',
  open: '#4ad295',
  quiet: '#b9c1c8',
}

export const FAIL_LABEL: Record<FailureClass, string> = { fall: 'Fall', heat: 'Overheating', oxygen: 'Oxygen', late: 'Too late', stuck: 'Stuck' }
export const OUTCOME_FAIL = (o: string) => !/^(arrived|ok|success|safe)$/i.test(o)
