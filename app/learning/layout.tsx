import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase-server'

export default async function Layout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  return <div style={{ minHeight: '100vh', background: 'var(--bg-1)', color: 'var(--fg-1)' }}>{children}</div>
}
