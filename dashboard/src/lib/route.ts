import { useEffect, useState } from 'react'

export const PAGES = [
  { id: 'console', path: '/', label: 'Console' },
  { id: 'method', path: '/method', label: 'Method and limits' },
  { id: 'parameters', path: '/parameters', label: 'Parameters' },
  { id: 'log', path: '/log', label: 'Decision log' },
  { id: 'sources', path: '/sources', label: 'Sources' },
] as const
export type PageId = (typeof PAGES)[number]['id']

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
