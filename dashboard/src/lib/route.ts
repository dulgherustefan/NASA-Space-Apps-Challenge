import { useEffect, useState } from 'react'

/** Two destinations in the bar: the mission display, and the reference pages behind it. */
export const PAGES = [
  { id: 'console', path: '/', label: 'Mission' },
  { id: 'method', path: '/method', label: 'Method and limits' },
  { id: 'parameters', path: '/parameters', label: 'Parameters' },
  { id: 'sources', path: '/sources', label: 'Sources' },
  { id: 'log', path: '/log', label: 'Event log' },
] as const
export type PageId = (typeof PAGES)[number]['id']
export const REFERENCE = PAGES.filter((p) => p.id !== 'console')

function parse(): PageId {
  const p = window.location.hash.replace(/^#/, '') || '/'
  return PAGES.find((x) => x.path === p)?.id ?? 'console'
}
export function usePage(): PageId {
  const [page, setPage] = useState<PageId>(parse)
  useEffect(() => {
    const on = () => setPage(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return page
}
export const hrefFor = (id: PageId) => `#${PAGES.find((p) => p.id === id)!.path}`
