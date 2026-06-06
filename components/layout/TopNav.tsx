'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV = [
  ['/dashboard',  'Desk'],
  ['/growth',     'Growth'],
  ['/sleeves',    'Sleeves'],
  ['/portfolio',  'Portfolio'],
  ['/trades',     'Trades'],
  ['/learning',   'Learning'],
  ['/settings',   'Settings'],
] as const

export default function TopNav() {
  const path = usePathname()
  return (
    <header className="desk-top">
      <Link href="/dashboard" className="desk-brand" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="bmark">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" />
          </svg>
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', lineHeight: 1 }}>MyTrade</div>
          <div className="eyebrow" style={{ marginTop: 2 }}>Live Desk</div>
        </div>
      </Link>
      <nav className="desk-nav">
        {NAV.map(([href, label]) => (
          <Link key={href} href={href} className={path === href || path.startsWith(href + '/') ? 'on' : ''}>
            {label}
          </Link>
        ))}
      </nav>
    </header>
  )
}
