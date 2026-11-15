import type { FailureClass, RouteStatus } from './types'

/** `map` is the line colour over the orbital image, `ink` the colour of the same state in the panel. */
export const ROUTE_STYLE: Record<RouteStatus, { label: string; map: string; ink: string; hint: string }> = {
  candidate: { label: 'Candidate', map: '#c4cedb', ink: 'var(--color-ink3)', hint: 'Found by the path planner, not stress-tested yet' },
  testing: { label: 'Testing', map: '#e3b472', ink: 'var(--color-accent)', hint: 'Virtual crews are walking it now' },
  tested: { label: 'Tested', map: '#7fa9cf', ink: '#7fa9cf', hint: 'Stress test finished' },
  rejected: { label: 'Rejected', map: '#ff5f57', ink: 'var(--color-hazard)', hint: 'Dropped: the stress test or a rule ruled it out' },
  chosen: { label: 'Chosen', map: '#4fd1b0', ink: 'var(--color-safe)', hint: 'The route the crew is told to take' },
  infeasible: { label: 'Infeasible', map: '#6e7886', ink: 'var(--color-ink3)', hint: 'Cannot be walked within the limits' },
}

/** Colours drawn on the map canvas. */
export const MAP = {
  ink: '#f4f1ea',
  line: 'rgba(12,11,10,.85)',
  route: '#4fd1b0',
  select: '#e3b472',
  hazard: '#ff5f57',
  open: '#4fd1b0',
  quiet: '#b9b2a7',
}

export const FAIL_LABEL: Record<FailureClass, string> = { fall: 'Fall', heat: 'Overheating', oxygen: 'Oxygen', late: 'Too late', stuck: 'Stuck' }
export const OUTCOME_FAIL = (o: string) => !/^(arrived|ok|success|safe)$/i.test(o)
