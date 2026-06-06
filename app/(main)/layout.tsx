import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase-server'
import TopNav from '@/components/layout/TopNav'

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-1)', color: 'var(--fg-1)', fontFamily: 'var(--font-sans)' }}>
      <TopNav />
      <main style={{ maxWidth: 1440, margin: '0 auto', width: '100%' }}>{children}</main>
    </div>
  )
}
