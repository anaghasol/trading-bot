import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { getCategoryMomentum } from '@/lib/category-rotation'

/**
 * GET /api/rotation — live theme ranking for the dashboard / sleeves UI.
 * Same engine the scanner uses to bias sizing, exposed read-only.
 */
export const runtime = 'nodejs'
export const revalidate = 0

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rotation = await getCategoryMomentum()
    return NextResponse.json(rotation)
  } catch (e) {
    return NextResponse.json({ categories: [], hottest: null, error: (e as Error).message }, { status: 200 })
  }
}
