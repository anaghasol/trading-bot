import { NextResponse } from 'next/server'
import { getPositions } from '@/lib/schwab'
import { createClient } from '@/lib/supabase-server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const positions = await getPositions()
  return NextResponse.json({ positions })
}
