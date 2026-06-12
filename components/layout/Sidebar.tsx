'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, TrendingUp, Layers, History, Brain, Settings, LogOut, Radio } from 'lucide-react'
import { createClient } from '@/lib/supabase-client'

const nav = [
  { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard',    pulse: false },
  { href: '/live',      icon: Radio,           label: 'Live Monitor', pulse: true  },
  { href: '/growth',    icon: TrendingUp,      label: 'Growth',       pulse: false },
  { href: '/sleeves',   icon: Layers,          label: 'Sleeves',      pulse: false },
  { href: '/trades',    icon: History,         label: 'Trade History',pulse: false },
  { href: '/learning',  icon: Brain,           label: 'Learning',     pulse: false },
  { href: '/settings',  icon: Settings,        label: 'Settings',     pulse: false },
]

export default function Sidebar() {
  const path = usePathname()
  const supabase = createClient()

  async function signOut() {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <aside className="w-56 shrink-0 flex flex-col bg-[#0b0f17] border-r border-[#1f2737] h-screen sticky top-0">
      {/* Brand */}
      <div className="px-5 py-5 border-b border-[#1f2737]">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--green-dim)', border: '1px solid rgba(16,185,129,0.3)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></svg>
          </div>
          <div>
            <div className="text-white font-semibold text-[15px] leading-none">MyTrade</div>
            <div className="text-[#5b6472] text-[10px] mt-1 tracking-wide uppercase">Autonomous · AI</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {nav.map(({ href, icon: Icon, label, pulse }) => {
          const active = path === href || path.startsWith(href + '/')
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                active ? 'text-[#10b981]' : 'text-[#848d97] hover:text-white hover:bg-[#141a26]'
              }`}
              style={active ? { background: 'var(--green-faint)', border: '1px solid rgba(16,185,129,0.2)' } : undefined}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {pulse && !active && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#13c98e', flexShrink: 0, animation: 'pulse 1.4s infinite', boxShadow: '0 0 6px #13c98e' }} />
              )}
            </Link>
          )
        })}
      </nav>

      {/* Status footer */}
      <div className="px-3 pb-3">
        <div className="rounded-lg px-3 py-2.5 mb-2" style={{ background: 'var(--bg-2)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 mb-1.5">
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'pulse 1.4s infinite' }} />
            <span className="text-[11px] text-[#9ca3af] font-medium">Engines live</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="chip down" style={{ fontSize: '0.62rem', padding: '2px 7px' }}>SCHWAB</span>
            <span className="chip blue" style={{ fontSize: '0.62rem', padding: '2px 7px' }}>PAPER</span>
          </div>
        </div>
      </div>

      {/* Sign out */}
      <div className="px-3 pb-5 border-t border-[#1f2737] pt-3">
        <button
          onClick={signOut}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-[#848d97] hover:text-[#ef4444] w-full transition-colors"
          style={{ background: 'transparent' }}
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Sign out
        </button>
      </div>
    </aside>
  )
}
