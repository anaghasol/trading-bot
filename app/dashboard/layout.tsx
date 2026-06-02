import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase-server'

/**
 * Dashboard = the immersive "Live Desk" — full-bleed, no sidebar (its own top
 * strip carries brand + nav). Growth / Sleeves / Learning / Trades / Settings
 * keep the sidebar via their own layouts. Overrides the prior sidebar layout.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return <main className="min-h-screen" style={{ background: 'var(--bg-1)' }}>{children}</main>
}
