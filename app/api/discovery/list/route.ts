import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

export async function GET() {
  const db = createServiceClient()
  const { data, error } = await db
    .from('tb_discoveries')
    .select('*')
    .order('sndk_score', { ascending: false })
    .limit(100)

  if (error) return NextResponse.json({ candidates: [], last_run: '', error: error.message })

  const last_run = data?.[0]?.screened_at ?? ''
  return NextResponse.json({ candidates: data ?? [], last_run })
}
