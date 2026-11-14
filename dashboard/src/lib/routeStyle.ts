import type { FailureClass, RouteStatus } from './types'

export const ROUTE_STYLE: Record<RouteStatus, { label: string; color: string; hint: string }> = {
  candidate: { label: 'Candidate', color: '#c4cedb', hint: 'Found by the path planner, not stress-tested yet' },
  testing: { label: 'Testing', color: '#e3b472', hint: 'Virtual crews are walking it now' },
  tested: { label: 'Tested', color: '#7fa9cf', hint: 'Stress test finished' },
  rejected: { label: 'Rejected', color: '#ff5f57', hint: 'Dropped: the stress test or a rule ruled it out' },
  chosen: { label: 'Chosen', color: '#4fd1b0', hint: 'The route the crew is told to take' },
  infeasible: { label: 'Infeasible', color: '#6e7886', hint: 'Cannot be walked within the limits' },
}

export const FAIL_LABEL: Record<FailureClass, string> = { fall: 'Fall', heat: 'Overheating', oxygen: 'Oxygen', late: 'Too late', stuck: 'Stuck' }
export const OUTCOME_FAIL = (o: string) => !/^(arrived|ok|success|safe)$/i.test(o)
