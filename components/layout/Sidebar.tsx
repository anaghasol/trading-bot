'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, History, Settings, TrendingUp, LogOut } from 'lucide-react'
import { createClient } from '@/lib/supabase-client'

const nav = [
  { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { href: '/trades',    icon: History,          label: 'Trade History' },
  { href: '/settings',  icon: Settings,         label: 'Settings' },
]

export default function Sidebar() {
  const path = usePathname()
  const supabase = createClient()

  async function signOut() {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <aside className="w-56 shrink-0 flex flex-col bg-[#0d1117] border-r border-[#21262d] h-screen sticky top-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-[#21262d]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center">
            <TrendingUp className="w-4 h-4 text-accent" />
          </div>
          <div>
            <div className="text-white font-semibold text-sm leading-none">TradeBot</div>
            <div className="text-[#484f58] text-[10px] mt-0.5">Schwab AI</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {nav.map(({ href, icon: Icon, label }) => {
          const active = path === href || path.startsWith(href + '/')
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                active
                  ? 'bg-accent/10 text-accent border border-accent/20'
                  : 'text-[#848d97] hover:text-white hover:bg-[#161b22]'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Sign out */}
      <div className="px-3 pb-5 border-t border-[#21262d] pt-4">
        <button
          onClick={signOut}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-[#848d97] hover:text-loss hover:bg-loss/10 w-full transition-colors"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Sign out
        </button>
      </div>
    </aside>
  )
}
